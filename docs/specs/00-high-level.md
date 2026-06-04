# 00 — High-level spec

> **Status:** Draft (target architecture; current code may differ)
> **Date:** 2026-06-04
> **Scope:** The whole project. This doc describes the target architecture; the existing `docs/ARCHITECTURE/` ADRs describe the current implementation. The two will be reconciled as work lands. The boundary specs in this folder describe each layer in detail.

## Vision

`copilot-agent` is a personal AI assistant that runs as a **multi-channel bot with plug-in channels**. The user accesses it from whichever surface is most convenient — **Telegram (today), TUI, Discord, and a future WebUI dashboard with chat (planned)** — and the assistant's behavior, memory, and tool-use policy follow the user across surfaces. The system is single-user, self-hosted, BYOK, treats the GitHub Copilot SDK as the canonical agentic backend, and explicitly designs every boundary so that adding a new channel means adding a new file, not editing the gateway.

Three concrete consequences of this vision:

1. **User identity is primary, channel is secondary.** A session belongs to a user, not to a chat. If the same user messages from Telegram and TUI, they should see the same session history (subject to the per-channel identity mapping the adapter provides).
2. **Channels are plug-ins, not special.** The gateway never imports a channel-specific library (no `grammY`, no `discord.js`, no `blessed`). Adding a new channel = write an adapter + register it; the gateway is plug-in-agnostic.
3. **The agent loop is upstream.** We don't reimplement tool-calling or message history. The boundary between "what the Copilot SDK does" and "what we do" is the central architectural fact and is loud in every boundary spec.

## System architecture

```
                    ┌─────────────────────────────────────────────────────┐
                    │              Plugin registry                        │
                    │   channels: [TelegramAdapter, TuiAdapter,           │
                    │              DiscordAdapter, WebChatAdapter, ...]   │
                    └──────┬──────────────┬──────────────┬───────────────┘
                           │             │              │
                           ▼             ▼              ▼
                    ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
                    │ Telegram   │ │ TUI        │ │ Discord    │ │ Web chat   │
                    │ Adapter    │ │ Adapter    │ │ Adapter    │ │ Adapter    │
                    │ (subproc)  │ │ (subproc)  │ │ (subproc)  │ │ (in-proc)  │
                    └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
                          │ stdio + JSON-RPC over process boundary        │
                          └──────────────┬──────────────┴──────────────┘
                                         │
                                         ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                       Gateway                       │
                    │  • Talks to channels ONLY through ChannelAdapter   │
                    │  • Message dispatch + per-user serialization       │
                    │  • Slash-command router                            │
                    │  • Message-lifecycle orchestration                 │
                    └────┬──────────┬───────────┬────────────┬───────────┘
                         │          │           │            │
                         ▼          ▼           ▼            ▼
                   ┌──────────┐ ┌────────┐ ┌────────┐ ┌─────────────────┐
                   │ Session  │ │ Agent  │ │  LLM   │ │ Tool runtime    │
                   │  store   │ │registry│ │backend │ │ + Permission    │
                   └──────────┘ └────────┘ └────────┘ └────┬────────────┘
                                                           │
                                                           ▼
                                                  ┌──────────────────┐
                                                  │  Permission UI   │
                                                  │  (per-channel    │
                                                  │   adapter owns   │
                                                  │   its own UI)    │
                                                  └──────────────────┘

   ┌───────────────────────────────────────────────────────────────────────┐
   │                       WebUI control surface                          │
   │  Session history viewer • Agent editor • Log tail • Config editor    │
   │  Status dashboard • Provider/model switcher                           │
   │                                                                       │
   │  Talks to gateway over a separate `ControlAPI` (JSON-RPC over stdio) │
   │  Chat portion of the WebUI is just another `ChannelAdapter` (in-proc)│
   └───────────────────────────────────────────────────────────────────────┘
```

## Boundary index

| # | Spec | Owns | Doesn't own |
|---|---|---|---|
| 01 | [`channel-adapter.md`](01-channel-adapter.md) | `ChannelAdapter` interface, registration contract, capability matrix, IPC contract, per-channel implementations | Session state, agent logic, LLM calls |
| 02 | [`session-store.md`](02-session-store.md) | User-keyed session map, archive format, resume semantics, TTL policy, crash recovery, the in-memory + on-disk split | Channel I/O, agent prompts, tool policy |
| 03 | [`agent-registry.md`](03-agent-registry.md) | Agent definition format (markdown + frontmatter), validation at load, switch semantics; v2: skills, hot-reload | Session state, channel behavior |
| 04 | [`llm-backend.md`](04-llm-backend.md) | Copilot SDK wrapper, BYOK provider model, model + provider switching; v2: retry/fallback | Tool execution, agent prompts, channel formatting |
| 05 | [`tool-runtime-and-permission-gate.md`](05-tool-runtime-and-permission-gate.md) | The opaque SDK tool loop, the `PermissionRequest` callback contract, the three modes, timeout math, the channel permission UI contract | Agent content, channel formatting, LLM provider config |
| 06 | [`message-lifecycle.md`](06-message-lifecycle.md) | The state machine: incoming → queued → typing → streaming → permission-prompt → final → archived; the seam between gateway/session/channel/permission; channel-capability dispatch; IPC round-trips | Implementation details of any single layer |
| 07 | [`webui-control-surface.md`](07-webui-control-surface.md) | The `ControlAPI` the gateway exposes for the WebUI dashboard: session history, agent CRUD, log tail, config, status, provider/model switcher; the WebUI's chat is a `ChannelAdapter` implemented in-process with the dashboard | Chat adapter implementation details (covered in `01`), agent prompt design (covered in `03`) |

## Cross-cutting principles

These rules apply to every boundary spec and must be respected by every implementation.

- **Secrets only in env vars.** All API keys, tokens, and credentials go through `config.ts` and the pino redaction list. No secrets in YAML, in archives, in logs, in frontmatter, or in HTTP query strings. *Pins: ADR 002, ADR 006.*
- **The SDK owns the agent loop.** We never see tool calls except through the `PermissionRequest` callback. We never see raw message history except through SDK events. *Pins: ADR 007.*
- **Process isolation per channel adapter.** Each enabled channel adapter runs in its own subprocess, communicating with the gateway over **stdio + JSON-RPC** — the same transport the Copilot SDK uses to talk to the CLI subprocess. A crashed, hung, or misbehaving adapter takes down its own channel only; the gateway detects subprocess death via process-exit events, logs it, optionally restarts with backoff, and continues serving the other channels. The gateway itself never imports a channel-specific library. *New principle derived from the multi-channel plug-in goal.*
- **Compile-time plugin loading (v1).** The gateway has a hardcoded list of `import` statements for each enabled adapter, registered at startup via a `registerChannel(adapter)` API. The API is clean enough that a future runtime loader could be added without changing the gateway. *YAGNI for runtime discovery in v1.*
- **All I/O is async, all state transitions are logged.** Every cross-boundary call (`channel → gateway`, `gateway → session`, `session → llm`, subprocess IPC) gets a structured log line with the user/channel id, action, and outcome. *Pins: ADR 006.*
- **Type-safe at the boundary, validated at the edge.** External data (config, frontmatter, archived sessions, SDK responses, IPC messages) is Zod-validated at the boundary. Inside the boundary, plain TypeScript types. *Pins: ADR 007.*
- **One user = one session per agent.** `/agent` always creates a new session because the system prompt and tool set change. `/model` and `/provider` keep history because only the model changes. *Pins: ADR 004, ADR 005.*
- **Permission requests deny on timeout.** A hung permission prompt is safer than an auto-approve. *Pins: ADR 003.*
- **Tests live next to source.** Vitest, TDD, no exceptions for "glue code." *Pins: ADR 010.*

## Non-goals

- **Multi-tenant hosting.** Single-user, self-hosted. No per-tenant config, no usage metering, no admin panel beyond the WebUI's owner-only control surface.
- **Custom LLM tool implementations.** We let the SDK handle the tool loop. If we ever need a tool the SDK doesn't provide, we contribute it upstream rather than shadow-forking the loop.
- **Channel-agnostic session merging across user identities.** A user on Telegram and a different user on CLI see *separate* sessions. (Unified-identity multi-channel is a v2 project, not a tweak.)
- **Webhook mode for Telegram.** Long-polling only. *Pins: ADR 001.*
- **Runtime channel discovery.** Compile-time imports only in v1.

## Open questions (recommendations baked in; push back at review)

| # | Question | Recommendation | Lands in |
|---|---|---|---|
| 1 | Session expiry policy | **Soft-TTL with cold archive** — keep active sessions in memory with a configurable idle timeout; archive on `/new` or eviction; resume from archive on user request | `02-session-store.md` |
| 2 | Channel priority | TUI → Discord → WebUI in that order of likelihood | `01-channel-adapter.md` |
| 3 | Skills system | **Defer to v2** — v1 ships with agent `.md` files only; the `skills/` folder exists in the scaffold but is unused | `03-agent-registry.md` |
| 4 | Hot-reload of agent definitions | **YAGNI for v1** — restart on change; add a file watcher in v2 if there's demand | `03-agent-registry.md` |
| 5 | Plugin loading | **Compile-time** for v1 | this doc, § "Compile-time plugin loading" |
| 6 | TUI TTY attachment | **`npm run tui` spawns a TUI subprocess on demand**, using `stdio: 'inherit'` to attach to the calling TTY; the subprocess talks to the gateway over its IPC socket. The gateway never owns a TTY in v1. | `01-channel-adapter.md` |
| 7 | WebUI chat process model | **In-process with the dashboard server** for v1 — the dashboard server implements a `ChannelAdapter` for chat and a `ControlAPI` client for the control surface. Split into separate processes later if a real reason shows up. | `07-webui-control-surface.md` |
