# ADR 008 — Multi-channel plug-in architecture with subprocess isolation

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** copilot-agent project

## Context

The bot must support multiple user-facing surfaces (Telegram today, TUI and Discord planned, WebUI chat planned) without the core gateway knowing about any specific channel library. Adding a new channel should mean writing a new file, not editing the gateway.

## Decision

### `ChannelAdapter` as the universal contract

Every channel implements the `ChannelAdapter` interface defined in `src/channels/types.ts`:

```typescript
export interface ChannelAdapter {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  onPermissionResponse(handler: (response: PermissionResponse) => Promise<void>): void;
  send(message: OutboundMessage): Promise<void>;
  startStream(replyToMessageId?: string): Promise<StreamSink>;
  promptPermission(prompt: PermissionPrompt): Promise<PermissionResponse>;
}
```

The gateway (`src/gateway.ts`) never imports `grammY`, `discord.js`, or any channel-specific library. It only talks to `ChannelAdapter` instances obtained from the channel registry.

### Channel capability dispatch

The gateway uses `adapter.capabilities` to decide which code path to take — never which channel it's talking to:

| Capability | What the gateway does differently |
|---|---|
| `streaming` | If false, skip streaming; use atomic `adapter.send()` only |
| `inlineButtons` | If false, use text-based permission prompts instead of inline keyboards |
| `unlimitedLength` | If false, truncate live stream at the cap and send full content separately |
| `messageEdit` | If false, always send new messages instead of editing |

### Compile-time registration

Channels are registered at compile time via hardcoded `import` statements in `src/channels/registry.ts`:

```typescript
import { TelegramAdapter } from './telegram/index.js';
import { NoopChannelAdapter } from './noop.js';
registerChannel(new TelegramAdapter());
registerChannel(new NoopChannelAdapter());
```

Adding a new channel = add an import + a `registerChannel()` call. The registry validates unique IDs. The `config.channels.enabled` list selects which registered adapters to start at runtime.

### Telegram adapter implementation

`src/channels/telegram/` implements the full `ChannelAdapter` contract:

- **`bot.ts`** — grammY `Bot` with long-polling, allowlist middleware, callback handler, error boundary.
- **`sink.ts`** — `TelegramStreamSink` edits a single message in-place with 750ms throttle and 4096-character truncation.
- **`format.ts`** — `formatPermissionKeyboard()` for inline buttons, `escapeTelegramMarkdown()` for safe MarkdownV2.
- **`index.ts`** — `TelegramAdapter` class wiring everything together.

### IPC for subprocess isolation (planned)

The target architecture (per `docs/specs/01-channel-adapter.md`) isolates each channel adapter in its own subprocess over stdio + JSON-RPC. The IPC transport is implemented in `src/channels/_shared/ipc.ts` with JSON-RPC 2.0 semantics and newline-delimited JSON framing.

In v1, adapters run in-process with the gateway for simplicity. The `ChannelAdapter` interface is already process-boundary-safe (all methods return `Promise`), so the migration to subprocess isolation is a deployment change, not an interface change.

### NoopChannelAdapter

`src/channels/noop.ts` provides a no-op adapter for testing and disabled channels. All methods resolve immediately with safe defaults.

## Consequences

- **Positive:** The gateway is completely channel-agnostic. Adding Discord or TUI means writing a new module under `src/channels/<name>/` and registering it.
- **Positive:** The capability matrix means the gateway automatically adapts its behavior (streaming vs. atomic, buttons vs. text) without channel-specific code.
- **Positive:** The `BaseChannelAdapter` in `src/channels/_shared/base.ts` provides default implementations for common patterns (no-op `stop`, handler storage, etc.), so simple adapters need only implement `send` and `startStream`.
- **Negative:** The compile-time registration means enabling a new channel requires a rebuild. Runtime plugin discovery is deferred to v2.
- **Negative:** In-process adapters share the gateway's event loop — a hung adapter can block the gateway. Subprocess isolation in v2 will fix this.

## References

- `src/channels/types.ts` — `ChannelAdapter`, `StreamSink`, `ChannelCapabilities`
- `src/channels/registry.ts` — `registerChannel`, `getChannel`, `listChannels`
- `src/channels/telegram/` — full Telegram adapter
- `src/channels/_shared/ipc.ts` — IPC transport
- `src/gateway.ts` — channel-capability dispatch in `processMessage`
- `docs/specs/01-channel-adapter.md`
