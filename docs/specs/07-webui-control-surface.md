# 07 — WebUI control surface

> **Status:** Draft
> **Owns:** The `ControlAPI` the gateway exposes for the WebUI dashboard. The WebUI's non-chat features (session history viewer, agent editor, log tail, config editor, status dashboard, provider/model switcher). The WebUI's chat portion is a `ChannelAdapter` (see `01-channel-adapter.md`) implemented in-process with the dashboard server.
> **Pins:** ADR 002 (XDG config), ADR 006 (structured logging).

## Purpose

The WebUI is a single-page app served by a Node.js backend. Its chat tab is one of the bot's channels (in-process with the dashboard server, per the open-question recommendation in `00-high-level.md`). Its other tabs are an admin/observability surface that talks to the gateway over a separate `ControlAPI` — a JSON-RPC interface over stdio (mirroring the adapter IPC transport), authenticated by a single-owner bearer token, that lets the WebUI read and mutate gateway-owned state.

This spec is about the `ControlAPI` contract and the WebUI's non-chat features. The chat tab is covered by `01-channel-adapter.md`; this spec only describes how the dashboard process hosts the chat adapter in-process.

## Interface (the `ControlAPI`)

```typescript
export interface ControlAPI {
  // ── Sessions ────────────────────────────────────────────────────────
  listSessions(opts?: { userId?: string; limit?: number }): Promise<ArchivedSession[]>;
  getSession(sessionId: string): Promise<ArchivedSession | null>;
  resumeSession(sessionId: string): Promise<{ ok: true } | { ok: false; reason: string }>;

  // ── Agents ──────────────────────────────────────────────────────────
  listAgents(): Promise<AgentDefinition[]>;
  getAgent(name: string): Promise<AgentDefinition | null>;
  createAgent(agent: AgentDefinitionInput): Promise<{ ok: true; name: string } | { ok: false; reason: string }>;
  updateAgent(name: string, agent: AgentDefinitionInput): Promise<{ ok: true } | { ok: false; reason: string }>;
  deleteAgent(name: string): Promise<{ ok: true } | { ok: false; reason: string }>;

  // ── Logs ────────────────────────────────────────────────────────────
  tailLogs(opts?: { since?: number; level?: LogLevel; limit?: number }): Promise<LogEntry[]>;
  subscribeLogs(handler: (entry: LogEntry) => void): () => void;

  // ── Config ──────────────────────────────────────────────────────────
  getConfig(): Promise<ConfigView>;
  updateConfig(patch: ConfigPatch): Promise<{ ok: true } | { ok: false; reason: string }>;

  // ── Status ──────────────────────────────────────────────────────────
  getStatus(): Promise<StatusView>;

  // ── Preset / model switching (mirrors /provider and /model) ───────────
  switchPreset(userId: string, presetId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  switchModel(userId: string, model: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface AgentDefinitionInput {
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly tools?: string[];
  readonly systemPrompt: string;
}

export interface LogEntry {
  readonly timestamp: number;
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly module: string;
  readonly msg: string;
  readonly fields?: Record<string, unknown>;
}

export interface ConfigView {
  /** The current `config.yaml` content as a structured object. Secrets are
   *  redacted (presence only, no values). */
  readonly providers: ReadonlyArray<{ name: string; configured: boolean; default: boolean }>;
  readonly agents: {
    readonly dir: string;
    readonly default: string;
    readonly count: number;
  };
  readonly telegram: { allowlist: ReadonlyArray<string> };
  readonly session: { historyDir: string; maxMessages: number; maxIdleSeconds: number };
  readonly permissions: { mode: 'approve-all' | 'readonly-default' | 'deny-all'; timeoutSeconds: number };
}

export type ConfigPatch =
  | { kind: 'set-preset-default'; presetId: string }
  | { kind: 'set-agent-default'; agent: string }
  | { kind: 'set-telegram-allowlist'; allowlist: string[] }
  | { kind: 'set-permission-mode'; mode: 'approve-all' | 'readonly-default' | 'deny-all' }
  | { kind: 'set-permission-timeout'; seconds: number };

export interface StatusView {
  readonly uptimeSeconds: number;
  readonly llmBackend: { up: boolean; sessionsActive: number };
  readonly channels: ReadonlyArray<{
    readonly id: string;
    readonly up: boolean;
    readonly lastErrorAt: number | null;
    readonly restartCount: number;
  }>;
  readonly memory: { rssBytes: number; heapUsedBytes: number };
}
```

## Process model

```
                    ┌────────────────────────────────────────────┐
                    │       WebUI dashboard server (one process)│
                    │                                            │
                    │   ┌────────────────────────────────────┐   │
                    │   │  SPA (HTML/JS served as static)    │   │
                    │   └────────────────────────────────────┘   │
                    │   ┌────────────────────────────────────┐   │
                    │   │  Chat adapter (in-proc ChannelAdapter)│
                    │   │  talks to gateway over IPC          │   │
                    │   └────────────────────────────────────┘   │
                    │   ┌────────────────────────────────────┐   │
                    │   │  ControlAPI client                  │   │
                    │   │  talks to gateway over IPC          │   │
                    │   └────────────────────────────────────┘   │
                    └────────────┬───────────────────────────────┘
                                 │ stdio + JSON-RPC
                                 ▼
                    ┌────────────────────────────────────────────┐
                    │   Gateway (separate process)               │
                    │   - hosts the ControlAPI server            │
                    │   - hosts the chat ChannelAdapter registry │
                    │   - owns sessions, agents, LLM, tools     │
                    └────────────────────────────────────────────┘
```

The dashboard server is a regular Node.js process started by the user (e.g. `npm run webui` or as part of `npm start` if the WebUI is enabled in config). It serves the SPA on a configurable port, hosts an in-process chat adapter that registers with the gateway, and runs a `ControlAPI` client that proxies the dashboard's requests to the gateway.

**Why one process for the WebUI:** the chat and the dashboard share state (auth, cookies, the user's session, the current user identity). Splitting them into two processes would require duplicating that state. v1 keeps them together; the v2 escape hatch is documented below.

## CLI mirror

The `copilot-agent` binary's `config` subcommands mirror this spec's `ControlAPI` mutations. Both call into the same Zod-validated path so the two surfaces can't drift:

| CLI subcommand | ControlAPI equivalent |
|---|---|
| `copilot-agent config get [key]` | `getConfig()` (returns the structured view; secrets are presence-only) |
| `copilot-agent config set <key> <value>` | `updateConfig(patch)` (same `ConfigPatch` union, same validation, same audit log) |

The CLI does not implement its own config parser. It dispatches to the same handler the WebUI uses, over the same in-process function call (the CLI is part of the same binary; no IPC needed for config operations). Secrets are redacted in CLI output the same way the WebUI redacts them in `getConfig()`.

## Authentication

Single-owner model. The WebUI is not multi-tenant. Auth is a single bearer token generated on first startup and stored in `<configDir>/webui-token` with `0600` permissions. The user copies the token from the logs (or from the file) and pastes it into the SPA on first load. The SPA stores it in `localStorage` and includes it in a `Authorization: Bearer <token>` header on every `ControlAPI` request.

**Threat model:** the WebUI is meant to be run on `localhost` or behind a reverse proxy with TLS. The bearer token is the only protection; if the host is compromised, the attacker has the same control as the user. The WebUI does *not* protect against network attackers on its own. The README and the `setup` flow both warn about this.

**Audit log:** every `ControlAPI` mutation (createAgent, updateAgent, deleteAgent, updateConfig, switchProvider, switchModel) is logged with the mutation kind, the previous value, the new value, and the user identity. The user can review these in the `tailLogs` view. *Pins: ADR 006.*

## UI features

| Feature | `ControlAPI` calls used | Notes |
|---|---|---|
| Session history viewer | `listSessions`, `getSession` | Read-only list of archived sessions; click to expand. |
| Resume a session | `resumeSession` | The WebUI's chat tab then picks up the resumed session via the chat adapter. |
| Agent list | `listAgents`, `getAgent` | Shows all agents with description. |
| Agent editor | `createAgent`, `updateAgent`, `deleteAgent` | Form-based editor with frontmatter fields and a markdown body textarea. |
| Log tail | `tailLogs`, `subscribeLogs` | SSE or WebSocket for live tail; "since timestamp" for backfill. |
| Config editor | `getConfig`, `updateConfig` | Form for the patchable config fields. Secrets are shown as "configured: yes/no" only. |
| Status dashboard | `getStatus` | Per-channel up/down, restart counts, LLM backend up/down, memory usage. |
| Provider / model switcher | `switchProvider`, `switchModel` | Per-user (or global default). |

The chat tab is a `ChannelAdapter` and is covered by `01-channel-adapter.md`; the WebUI spec doesn't repeat that contract.

## Failure modes

| Failure | Boundary promise |
|---|---|
| Gateway dies while WebUI is open | The dashboard's `ControlAPI` client surfaces a "gateway offline" banner. The chat adapter's IPC fails; the chat shows "channel offline" messages. |
| WebUI token leaked | The user can rotate the token by deleting `<configDir>/webui-token` and restarting the dashboard. The gateway treats the old token as invalid. |
| Config patch invalid (e.g. unknown provider) | `updateConfig` returns `{ ok: false, reason }`; the UI shows the error inline. The previous config is unchanged. |
| Agent create/update with invalid frontmatter | Same as above: typed error from the Zod validator, returned to the UI. |
| Log tail backlog grows unbounded | The dashboard buffers at most N entries (default 10,000); older entries are dropped. `tailLogs({ since })` is the way to recover. |
| User has the WebUI open in two tabs | Both tabs see the same state; mutations from one tab are reflected in the other on the next refresh (no live sync in v1; v2 could add it). |

## Cross-references

- **Pinned by:** ADR 002, ADR 006.
- **Depends on:** the session store spec (`02-session-store.md`) for `ArchivedSession`; the agent registry spec (`03-agent-registry.md`) for `AgentDefinition`; the channel-adapter spec (`01-channel-adapter.md`) for the chat adapter contract.
- **Depended on by:** none.

## Open questions

- **Live state sync between tabs.** Should the dashboard push state updates from the gateway to all open tabs in real time, or rely on tab refresh? v1 recommendation: **tab refresh.** A future v2 could add SSE for live state.
- **Config validation depth.** `updateConfig` does shallow validation (e.g. "is this a known provider?"). Deep validation (e.g. "does this provider's model list include the user's selected default model?") is a v2 concern. v1 returns errors and lets the user fix them.
- **Multi-process WebUI escape hatch.** If we ever need to split the WebUI's chat from the dashboard (e.g. for security, or to run the dashboard on a different host from the bot), the seam is the `ControlAPI` IPC and the `ChannelAdapter` registration. The v1 design doesn't preclude this; it just doesn't do it.
- **Stream transport for the chat.** The chat adapter's `StreamSink` over the WebUI can use SSE, WebSocket, or long-polling. **Recommended: SSE** for v1 — one-way, no upgrade handshake, easy auto-reconnect. WebSocket and long-polling are fallback options if SSE proves insufficient.
