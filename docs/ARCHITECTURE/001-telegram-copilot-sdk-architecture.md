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

## Streaming Assistant Output

The Copilot SDK is configured with `streaming: true` on every `createSession` call. The SDK then emits `assistant.message_delta`, `tool.execution_start`, `tool.execution_complete`, `session.error`, and `session.idle` events as the agent produces output. The bot subscribes once at session creation via the SDK's `onEvent` hook and dispatches events to a per-chat `StreamSink`.

### The `StreamSink` interface

`src/streaming.ts` defines a small interface with optional methods for each event type:

````typescript
export interface StreamSink {
  onAssistantDelta?(messageId: string, delta: string): void;
  onAssistantMessage?(messageId: string, fullContent: string): void;
  onToolStart?(toolCallId: string, toolName: string, args?: unknown): void;
  onToolEnd?(toolCallId: string, result?: unknown): void;
  onSessionError?(message: string): void;
  onSessionIdle?(): void;
  abort?(): void;
}
```

A `noopStreamSink` is used as the default. The single concrete implementation today is `TelegramStreamSink`.

### `TelegramStreamSink`

This sink edits **one** Telegram message in place as the agent streams. Strategy:

1. `start()` seeds a new message containing "…" (or adopts an existing message id).
2. Each `onAssistantDelta` appends to an in-memory `draft` and schedules an edit. Edits are throttled to `EDIT_THROTTLE_MS` (750 ms) to stay well under Telegram's per-chat edit rate limit.
3. `onToolStart` appends a `🔧 running \`toolName\` …` status line so the user sees the tool that just started before any permission prompt arrives.
4. `onToolEnd` strips the most recent trailing tool-status line.
5. `onSessionIdle`, `onAssistantMessage`, and `onSessionError` all flush the pending draft immediately.
6. `onAssistantMessage` only replaces the draft when `fullContent` is non-empty. Some SDK streaming configurations emit `assistant.message` as a bare completion signal with an empty `content` field; unconditionally replacing the draft would erase everything accumulated from `assistant.message_delta` chunks.
7. `abort()` is idempotent and stops further edits. Called when a new user message arrives (so the user never sees two overlapping drafts) or when the message handler finishes.

The sink never throws — streaming errors are logged and swallowed so they cannot crash the agent loop.

### Fallback when streaming events are incomplete

The message handler in `src/telegram.ts` does not rely solely on streaming events. After `enqueueMessage` resolves, it calls `stream.flushNow()` and then checks the draft. If the draft is empty but `sendAndWait` returned a `response.content`, the handler edits the Telegram message with that content directly. This guards against two failure modes:

1. The SDK never emitted `assistant.message_delta` events (e.g. the provider ignores `streaming: true`).
2. An empty `assistant.message` completion signal wiped the draft (the guard in `onAssistantMessage` prevents this, but the fallback ensures the user still sees the answer even if it somehow happens).

### Wiring

- `SessionManager.createSession` registers an `onEvent` hook on every new session that dispatches events to `activeSinks.get(chatId)`.
- `SessionManager.enqueueMessage(chatId, prompt, sink)` accepts an optional sink. While the call is in flight the sink is the active sink for the chat; the previous one is detached in a `finally` block so queued messages don't leak.
- `TelegramBot` creates a fresh `TelegramStreamSink` per user message, seeds it, passes it into `enqueueMessage`, and aborts the previous sink if the user sends a new message while the agent is still working.
