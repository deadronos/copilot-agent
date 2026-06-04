# ADR 009: Deployment with Docker and Local Process Supervision

**Status:** Accepted  
**Date:** 2026-06-01  
**Deciders:** @deadronos

## Context

The bot must run persistently, survive process crashes, and be deployable on both a local machine and a server. We need:

- A reproducible build and runtime environment
- Persistence of config, agents, sessions, and logs across restarts and updates
- Graceful shutdown (archive sessions, disconnect SDK) on process termination
- No infrastructure dependencies (no cloud services, no databases)

## Decision

**Support two deployment modes sharing the same code and config layout: local (Node.js process managed by the host's supervisor) and Docker (multi-stage image with a persistent config volume).**

### Docker deployment

`Dockerfile` (multi-stage):
```dockerfile
FROM node:24-slim AS builder
# Build stage: TypeScript → dist/
FROM node:24-slim
# Runtime stage: production deps only, non-root user
RUN useradd -m -r copilot-agent
USER copilot-agent
ENV COPILOT_AGENT_CONFIG_DIR=/data/copilot-agent
ENTRYPOINT ["node", "dist/index.js"]
```

`docker-compose.yml`:
```yaml
services:
  bot:
    build: .
    restart: unless-stopped
    volumes:
      - ./copilot-agent-data:/data/copilot-agent
    environment:
      - COPILOT_AGENT_CONFIG_DIR=/data/copilot-agent
    env_file:
      - .env
```

Key design choices:
- **Multi-stage build**: TypeScript compilation in builder stage, production `node_modules` only in runtime stage. Final image ~150MB.
- **Non-root user**: `copilot-agent` user created at build time, no `sudo` or root access.
- **Config volume mounted**: `./copilot-agent-data:/data/copilot-agent` persists config, agents, sessions, and logs. Deleting the container doesn't delete state.
- **`restart: unless-stopped`**: Docker restarts the container if it crashes. The bot doesn't manage its own restarts.
- **`COPILOT_AGENT_CONFIG_DIR` env var**: Overrides config dir resolution, pointing to the mounted volume.

### Local deployment

```bash
npm start  # runs `node dist/index.js` (foreground)
```

Process supervision is external:
- macOS: `launchd` plist
- Linux: `systemd --user` unit
- Both run `npm start` from the cloned repo directory

### Graceful shutdown

Both modes use the same shutdown handler (`src/index.ts`):
```typescript
const shutdown = async (signal: string) => {
  telegramBot.stop();
  await sessionManager.archiveAll();
  try { await client.stop(); } catch { /* log */ }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

The shutdown is idempotent (guarded by `shuttingDown` flag). On `SIGTERM` (Docker stop/systemctl stop) or `SIGINT` (Ctrl+C):
1. Stop the Telegram bot (stop long-polling)
2. Archive all active sessions (call `session.getEvents()` and write to disk)
3. Stop the Copilot client (disconnect SDK sessions, kill CLI process)

## Rationale

1. **Multi-stage Docker produces the smallest possible image.** The builder stage has `devDependencies` and TypeScript; the runtime stage has only production deps and compiled JS. No unused toolchain in the final image.
2. **Non-root user follows security best practices.** If the bot is compromised (e.g., via a malicious tool call), the attacker can't escalate to root within the container.
3. **Config volume preserves state.** Agents, sessions, and logs survive `docker compose down && docker compose up`. Updates are `docker compose pull && docker compose up -d` — the volume persists.
4. **Process supervision is a host concern, not the bot's.** The bot doesn't fork, daemonize, or manage its own restarts. It's a simple foreground process. Docker, systemd, or launchd handle the lifecycle. This keeps the bot code simpler and avoids the pitfalls of `process.on('uncaughtException')` restart loops.
5. **XDG config dir resolution works in both modes.** Local mode uses `~/.config/copilot-agent`. Docker mode uses `COPILOT_AGENT_CONFIG_DIR=/data/copilot-agent`. The boot logic (`resolveConfigDir()`) handles both paths transparently.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| PM2 for process management | PM2 is fine, but it's an extra dependency. Docker's restart policy and systemd's `Restart=always` achieve the same result without an additional tool. |
| Single-stage Docker image | Larger image (~300MB+) due to devDependencies and TypeScript in the runtime layer. Multi-stage keeps it lean. |
| Webhook mode instead of long-polling | Requires TLS termination and a public-facing endpoint. Long-polling works behind NAT, on home networks, and in Docker without port mapping. |
| Kubernetes / Nomad | Overkill for a single-user bot. Docker Compose on a single machine is the right level of infrastructure. |
| Auto-update mechanism | Security risk and operational complexity. The user should explicitly choose when to update. |

## Consequences

### Positive
- Identical config layout in Docker and local mode — no divergent code paths
- Non-root user in Docker follows least-privilege principle
- Shutdown archives all sessions, so `/resume` works after restart
- Config volume survives container recreation (updates, restarts)
- No cloud dependencies — runs entirely on local hardware

### Negative
- The bot must be manually updated (`git pull && npm install` or `docker compose pull`)
- No built-in health-check or metrics endpoint (could be added later)
- Long-polling reconnects every few seconds, which is slightly less efficient than webhooks (but negligible for a single-user bot)

### Mitigations
- `docker-compose.yml` includes `restart: unless-stopped` for crash recovery
- Session archival on shutdown prevents data loss on intentional restarts
- The `shuttingDown` flag prevents double-archiving if multiple signals arrive
