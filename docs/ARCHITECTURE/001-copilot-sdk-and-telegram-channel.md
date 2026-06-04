# ADR 001 — Copilot SDK as the agentic backend; Telegram as the initial channel

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** copilot-agent project

## Context

We need an agentic backend that handles tool-calling, streaming, and message history so the bot itself doesn't reimplement a full agent loop. We also need an initial user-facing channel that works on mobile with minimal setup.

## Decision

### Copilot SDK as the canonical agentic backend

The bot delegates the entire agent loop to the [GitHub Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk) (`@github/copilot-sdk`). The SDK runs as a subprocess over JSON-RPC; the bot never reimplements tool-calling or message history.

**How it works in `src/llm.ts`:**
- `LlmBackendImpl.start()` instantiates the SDK in `"empty"` mode so the SDK doesn't inject its own default system prompt, tools, or extensions — the bot provides all of these via the agent registry and BYOK config.
- `LlmBackendImpl.createSession()` builds a `CopilotSession` for each user, wiring SDK events (`assistant.message_delta`, `tool.execution_start`, `permission.requested`, `session.idle`, etc.) into the bot's streaming sink and permission gate.
- The bot never sees raw tool calls except through the `permission.requested` event.

**Pinned by:** the _SDK owns the agent loop_ cross-cutting principle in `docs/specs/00-high-level.md`.

### Telegram as the initial channel (long-polling only)

The first channel adapter is Telegram, implemented in `src/channels/telegram/` using the [grammY](https://grammy.dev/) library. The bot uses long-polling (`bot.start()`) — not webhooks — because the project is single-user and self-hosted behind NAT/firewalls where webhooks add unnecessary complexity.

**How it works in `src/channels/telegram/bot.ts`:**
- `createTelegramBot()` reads the token from `COPILOT_AGENT_TELEGRAM_TOKEN` (env var, per the secrets-only-in-env-vars principle).
- An allowlist middleware checks `ctx.from.id` against `config.telegram.allowed_user_ids`; non-authorized users are silently ignored.
- A callback query handler normalizes button clicks into `PermissionResponse` objects.
- A `bot.catch` error boundary prevents unhandled grammY rejections from crashing the process.

**Pinned by:** the _Webhook mode for Telegram_ non-goal in `docs/specs/00-high-level.md`.

## Consequences

- **Positive:** The bot gets streaming, tool-calling, and agent history for free from the SDK. The `LlmSessionImpl` in `src/llm.ts` is only ~400 lines — the SDK does the heavy lifting.
- **Positive:** Long-polling eliminates the need for a public HTTPS endpoint, TLS certificates, and webhook registration.
- **Negative:** The bot is coupled to the Copilot SDK's event model and wire protocol. If the SDK changes its event names or `PermissionDecision` shape, the bot must be updated (see `toSdkPermissionResult` in `src/permissions.ts` for the current translation layer).
- **Negative:** Long-polling means messages arrive with ~1-2s of added latency vs. webhooks, and the bot cannot receive messages when the process is down.

## References

- `src/llm.ts` — `LlmBackendImpl`, `LlmSessionImpl`
- `src/channels/telegram/bot.ts` — `createTelegramBot`
- `src/channels/telegram/sink.ts` — `TelegramStreamSink`
- `docs/specs/04-llm-backend.md`
- `docs/specs/01-channel-adapter.md`
