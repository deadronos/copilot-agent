# ADR 001: Telegram Bot Powered by GitHub Copilot SDK

**Status:** Accepted  
**Date:** 2026-06-01  
**Deciders:** @deadronos

## Context

We need a personal AI assistant accessible from mobile devices. The assistant must support tool use (file operations, shell commands, web searches), multiple LLM providers (BYOK), and custom agent personalities. We evaluated:

- Building a custom agent loop with direct provider API calls
- Using existing agent frameworks (LangChain, etc.)
- Using the GitHub Copilot SDK which wraps Copilot CLI in server mode

## Decision

**Use the GitHub Copilot SDK as the agentic backend, exposed through a Telegram bot powered by grammY.**

Three-process architecture:

```
Telegram user  <──>  copilot-agent (Node.js)  <──JSON-RPC──>  Copilot CLI (SDK)
                       ├─ Telegram layer (grammY)
                       ├─ Command router
                       ├─ Session manager
                       ├─ Permission gate
                       ├─ Provider/model registry
                       └─ Agent loader
```

The bot process (`copilot-agent`) is the single Node.js process that owns Telegram integration, config, session state, and permission handling. The Copilot CLI is spawned by the SDK and communicates via JSON-RPC over stdio.

## Rationale

1. **SDK handles the agent loop.** We don't implement tool-calling, message history, or streaming. The SDK does it. This shrinks our core logic to ~600 lines of TypeScript.
2. **BYOK is built in.** The SDK accepts provider configs for OpenAI, Anthropic, Azure, and OpenAI-compatible endpoints. We just pass through the user's config.
3. **Telegram is the universal mobile interface.** No native app needed. Push notifications, typing indicators, inline keyboards — all available through grammY.
4. **Three-process model is simple and debuggable.** The SDK spawns Copilot CLI as a child process. If it dies, we detect it and restart. No network ports or service discovery needed between bot and agent.
5. **Separation of concerns.** The Telegram layer knows nothing about sessions or permissions. The session manager knows nothing about Telegram. The only coupling point is the permission callback — a single typed function interface.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Custom agent loop with OpenAI/Anthropic APIs directly | Would need to implement tool-calling, streaming, history management, and permission handling from scratch. Hundreds of lines of reinvention. |
| LangChain/LlamaIndex | Heavy dependency for what the SDK provides. Adds abstraction layers we don't need. |
| Discord instead of Telegram | Discord's mobile experience isn't as lightweight. Telegram has better bot APIs (typing indicators, inline keyboards). |
| Webhook mode instead of long-polling | Adds TLS termination requirement. Long-polling works fine for a single-user bot and requires no infrastructure. |

## Consequences

### Positive
- Agent logic is offloaded to the SDK — we only handle integration, config, and user interaction
- Provider switching requires zero code changes in the bot
- Custom agent `.md` files work across Telegram, CLI, and VS Code (SDK compatibility)

### Negative
- SDK version lock-in: breaking SDK API changes require bot updates
- The CLI process is a second runtime to monitor, restart, and debug
- No direct control over the agent's internal loop (e.g., can't inject custom tool implementations)

### Mitigations
- The SDK's `PermissionRequest` handler gives us a hook into every tool call, which is sufficient for our needs
- The `client.stop()` and recreation path provide recovery from CLI crashes
- The bot exposes provider/model switching at runtime so users aren't stuck on a broken provider
