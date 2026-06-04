# ADR 002: XDG-Style Configuration with YAML and dotenv

**Status:** Accepted  
**Date:** 2026-06-01  
**Deciders:** @deadronos

## Context

The bot needs configuration for providers (with API keys), Telegram credentials, agent definitions, and runtime behavior. We need:

- Separation of secrets from non-secret config (so config can be versioned in a private repo)
- Comments and multi-line strings for provider presets and agent metadata
- Runtime validation with clear error messages
- Support for multiple deployment modes (local, Docker) with the same config layout

## Decision

**Use two config files: `config.yaml` (non-secret, Zod-validated) and `.env` (secrets, dotenv-loaded), stored in an XDG-compliant config directory.**

Config directory resolution (first wins):
1. `COPILOT_AGENT_CONFIG_DIR` env var (explicit override; Docker uses this)
2. `$XDG_CONFIG_HOME/copilot-agent`
3. `~/.config/copilot-agent` (default)

Directory layout:
```
~/.config/copilot-agent/
├── config.yaml      # providers, models, allowlist, permissions
├── .env             # TELEGRAM_BOT_TOKEN, API keys
├── agents/*.md      # custom agent definitions
├── skills/**/*.md   # reusable agent skills
├── sessions/        # archived session history
└── logs/            # rotated log files
```

Key design choices in `config.yaml`:

```yaml
providers:
  openai:
    type: openai
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY    # references .env, never a literal key
```

- **`*_env` indirection**: Config references environment variable names, never literal API keys. This keeps `config.yaml` committable.
- **Zod schema**: The full config is validated at startup with `ConfigSchema.safeParse()`. Missing required fields, wrong types, and empty allowlists all produce readable errors before the bot starts.
- **Subdirectories auto-created**: `ensureDirs()` creates `agents/`, `skills/`, `sessions/`, and `logs/` if they don't exist.

## Rationale

1. **YAML is well-suited for nested config with comments.** JSON is too noisy for end-user editing; TOML doesn't handle deeply nested structures as cleanly. YAML with comments is the standard for tool configs (Docker Compose, GitHub Actions, etc.).
2. **`*_env` prevents secret leakage.** The config file never contains API keys. Users can share their config as a reference without exposing credentials.
3. **XDG compliance follows platform conventions.** Respects `XDG_CONFIG_HOME` on Linux and falls back to `~/.config` on macOS. The `COPILOT_AGENT_CONFIG_DIR` override gives Docker and custom setups full control.
4. **Zod gives compile-time types and runtime validation in one step.** `z.infer<typeof ConfigSchema>` produces the `AppConfig` type used throughout the codebase. No dual-maintenance of types and validators.
5. **Validation at startup fails fast.** Missing env vars, empty allowlists, malformed YAML — all surface immediately rather than as inscrutable runtime errors.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Single `.env` file for all config | No structured nesting. Adding a new provider or agent config would require manual key mangling. No comments in `.env` (portable implementation). |
| JSON config (`config.json`) | No comments. Multi-line strings require `\n`. Poor DX for end-user editing. |
| TOML | Less widely used for this kind of config. YAML's ecosystem (gray-matter for agents, yaml package for config) is more mature in Node.js. |
| Config in `package.json` | Mixes project metadata with runtime config. No support for secrets via env indirection. |
| Remote config service | Adds a network dependency and operational complexity. A personal assistant should work offline. |

## Consequences

### Positive
- One config layout works identically in Docker and local development
- Secrets are never in source control (`.gitignore` catches `.env`)
- Strict validation catches misconfigurations at startup, not at first use
- Adding a new provider or agent is just editing `config.yaml` — no code changes

### Negative
- Two files to maintain (config.yaml + .env), which must stay consistent
- YAML indentation errors can be confusing for new users (mitigated by Zod error messages)
- `*_env` indirection means an extra mental step: "which env var does this provider use?"

### Mitigations
- `npm run setup` generates both files with sensible defaults and inline comments
- Zod error messages include the path to the invalid field (e.g., `providers.openai.base_url: Required`)
- The bot refuses to start if `allowed_user_ids` is empty, preventing the most dangerous misconfiguration
