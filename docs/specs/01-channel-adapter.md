# 01 — Channel adapter

> **Status:** Draft
> **Owns:** The `ChannelAdapter` interface, the registration contract, the capability matrix, the IPC contract between gateway and adapter subprocesses, and the per-channel implementations (Telegram, TUI, Discord, future WebUI chat).
> **Pins:** ADR 001 (Telegram as the universal mobile interface), ADR 007 (type-safe SDK boundaries).

## Purpose

A channel adapter is the gateway's only window onto a user-facing surface (Telegram, TUI, Discord, etc.). It encapsulates everything channel-specific: long-polling or WebSocket or stdio, message formatting, length limits, permission-prompt UI, edit-throttling, callback handling, and the in-process `StreamSink` that drives its UI.

The gateway knows nothing about any of those. It only knows that *some* channel delivered a message tagged with user X, and that it can *ask* some channel to send a message to user X, optionally streaming, and to show a permission prompt with these choices.

## Interface

```typescript
// An inbound message as the gateway sees it. The adapter normalizes the
// channel-specific shape into this form before invoking the gateway's handler.
export interface InboundMessage {
  /** Channel-specific user identity, normalized to a stable user id by the adapter. */
  readonly userId: string;
  /** Channel-specific message id, used for stream sinks and permission callbacks. */
  readonly messageId: string;
  /** Channel identifier (e.g. "telegram", "tui", "discord"). */
  readonly channel: string;
  /** Raw text of the message. */
  readonly text: string;
  /** Optional reply-to context (for slash commands and quoted messages). */
  readonly replyTo?: { messageId: string; text: string };
  /** Per-channel extras (forwarded as opaque to the gateway). */
  readonly meta?: Record<string, unknown>;
}

export interface ChannelAdapter {
  /** Channel identifier; unique across all registered adapters. */
  readonly id: string;

  /** What this adapter can do. The gateway uses this to pick the right code path. */
  readonly capabilities: ChannelCapabilities;

  /** Called by the gateway at registration; the adapter should begin listening. */
  start(): Promise<void>;

  /** Called by the gateway on graceful shutdown; the adapter should stop cleanly. */
  stop(): Promise<void>;

  /** Deliver an inbound message to the gateway. The adapter invokes this on its
   *  message-received callback. The gateway handles it asynchronously. */
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;

  /** Deliver a permission-prompt response. The adapter invokes this on a button
   *  click or text reply. */
  onPermissionResponse(
    handler: (response: PermissionResponse) => Promise<void>,
  ): void;

  /** Send a final response to the user (atomic, no streaming). */
  send(message: OutboundMessage): Promise<void>;

  /** Start a streaming response. Returns a `StreamSink` the gateway can drive
   *  with delta events. The adapter is responsible for its own throttling,
   *  length caps, edit rate limits, and sink lifecycle. */
  startStream(replyToMessageId?: string): Promise<StreamSink>;

  /** Send a permission prompt to the user and await their response. The
   *  implementation is channel-specific: inline buttons, text reply, stdin, etc. */
  promptPermission(prompt: PermissionPrompt): Promise<PermissionResponse>;
}

export interface ChannelCapabilities {
  /** Can render streaming edits in place (vs. only atomic send). */
  streaming: boolean;
  /** Can render inline keyboard buttons for permission prompts. */
  inlineButtons: boolean;
  /** Can edit existing messages (vs. only send new ones). */
  messageEdit: boolean;
  /** Can fetch historical messages from the channel for context. */
  messageHistory: boolean;
  /** Can deliver messages of arbitrary length (vs. length-capped). */
  unlimitedLength: boolean;
}

export interface StreamSink {
  /** Append a text delta. Adapter throttles and truncates as needed. */
  append(delta: string): Promise<void>;
  /** Replace the stream content (e.g. on final-message reconciliation). */
  replace(content: string): Promise<void>;
  /** Finalize the stream (e.g. resolve any pending edit). */
  finish(): Promise<void>;
  /** Abort the stream (e.g. on timeout or new-message interruption). */
  abort(): Promise<void>;
}

export interface PermissionPrompt {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly choices: ReadonlyArray<PermissionChoice>;
  /** Seconds before the prompt auto-denies. */
  readonly timeoutSeconds: number;
}

export type PermissionChoice =
  | { kind: 'allow-once' }
  | { kind: 'allow-session' }
  | { kind: 'deny' };

export interface PermissionResponse {
  readonly toolCallId: string;
  readonly choice: PermissionChoice;
}
```

### Capability matrix (planned)

| Adapter | `streaming` | `inlineButtons` | `messageEdit` | `messageHistory` | `unlimitedLength` |
|---|---|---|---|---|---|
| Telegram | ✅ (750 ms throttle) | ✅ | ✅ | ❌ (v1) | ❌ (4096 chars) |
| TUI | ✅ (no throttle) | ❌ (readline prompts) | ✅ (terminal redraw) | ❌ (v1) | ✅ |
| Discord | ✅ (planned) | ✅ | ✅ | ❌ (v1) | ❌ (2000 chars) |
| WebUI chat | ✅ (SSE) | ✅ (HTML buttons) | ✅ (DOM update) | ✅ (planned) | ✅ |

## Lifecycle

**At registration (compile-time, per the cross-cutting principle):**
1. The gateway's entrypoint imports each enabled adapter module and calls `registerChannel(adapter)`.
2. The registry validates the adapter (unique `id`, capabilities object present, methods implemented) and stores it.
3. The gateway binds its message handler to `adapter.onMessage(...)`.

**At process startup:**
1. The gateway spawns one subprocess per enabled adapter via `child_process.spawn` with `stdio: ['pipe', 'pipe', 'inherit']` for IPC. TUI uses `stdio: 'inherit'` on its TTY-attached subprocess.
2. The gateway performs a JSON-RPC handshake with each subprocess: "what's your `id`? what are your `capabilities`? subscribe to inbound messages?".
3. The subprocess begins handling its I/O (long-polling, listening on stdin, WebSocket, etc.).
4. The gateway begins dispatching outbound messages and permission prompts over IPC.

**At runtime (per user message):**
1. The adapter receives a message from its channel, normalizes it to `InboundMessage` (user id, message id, text, etc.), and emits it to the gateway.
2. The gateway enqueues it (per-user serialization, owned by the session store), creates a session, calls the LLM backend, and starts streaming.
3. The gateway calls `adapter.startStream(replyTo)` to begin a stream sink.
4. The gateway drives the sink with delta events from the SDK.
5. The sink finalizes on `session.idle`; the gateway calls `adapter.send(...)` for any final content that exceeds the channel's length cap.
6. If a permission request arrives mid-stream, the gateway calls `adapter.promptPermission(...)` and awaits the response.

**At subprocess death:**
1. The gateway detects the subprocess exit via the `child_process.on('exit', ...)` event.
2. The gateway logs the death with the adapter id, exit code, and signal.
3. The gateway marks the channel as down and emits a "channel offline" event to the user via the *other* channels (or just logs it if all channels are down).
4. The gateway restarts the subprocess with exponential backoff (1s, 5s, 30s, 60s, max 5 min).
5. A future `/channels` command (not in v1) lets the user manually disable auto-restart.

**At graceful shutdown:**
1. The gateway sends `stop` to each adapter subprocess over IPC.
2. Each adapter flushes any pending streams, sends a "shutting down" message if appropriate, and exits cleanly.
3. The gateway waits up to N seconds for clean exits, then `SIGTERM`s any remaining subprocesses.

## Concurrency & ordering

- **Per-user serialization.** The gateway ensures that messages from the same `userId` are processed one at a time, even if they arrive on different channels. The session store owns the per-user queue; see `02-session-store.md`.
- **Subprocess IPC ordering.** All messages from a single subprocess are processed in the order they arrive. The gateway never assumes a particular arrival order across subprocesses.
- **Stream sink ownership.** At most one `StreamSink` is active per `(userId, channel, messageId)` tuple. Starting a new stream aborts the previous one for the same tuple.
- **Permission-prompt exclusivity.** At most one permission prompt is active per `userId`. A new prompt cancels any previous one (the previous tool call receives a `deny` response).

## Failure modes

| Failure | Boundary promise |
|---|---|
| Subprocess crashes | Gateway logs, auto-restarts with backoff, other channels unaffected |
| Subprocess hangs | Gateway enforces a per-IPC-call timeout; on timeout, `SIGTERM`, then `SIGKILL` after a grace period |
| Channel-specific API error (e.g. Telegram 429) | Adapter handles rate limit and backoff internally; surfaces a "rate-limited" state to the gateway if the backoff exceeds 30 s |
| Message exceeds channel length cap | Adapter truncates the live stream at the cap with a `…` suffix; the gateway calls `adapter.send(...)` for the full content after the stream ends |
| User deletes a message or revokes the bot | Adapter detects and emits a `user-removed` event; the gateway removes the user from the allowlist and archives their sessions |
| Adapter cannot parse inbound message | Adapter logs and drops the message; never crashes the subprocess |
| Permission-prompt response lost (e.g. button past Telegram's 30 s TTL) | Adapter resolves the prompt with `deny` and surfaces a "this prompt has expired" message to the user |

## Cross-references

- **Pinned by:** ADR 001, ADR 007.
- **Depends on:** none (lowest layer).
- **Depended on by:** `06-message-lifecycle.md` (drives the message state machine), `07-webui-control-surface.md` (the WebUI's chat is a `ChannelAdapter`).
- **Implements the user's three questions:**
  - "Streaming — Worth adding `sendStream` to the channel adapter?" → Yes, formalized as `ChannelAdapter.startStream()` returning a `StreamSink`. The current `TelegramStreamSink` becomes the Telegram adapter's stream implementation.
  - "TUI" → Second planned adapter; `capabilities.streaming = true`, `capabilities.unlimitedLength = true` (no 4096 cap), `capabilities.inlineButtons = false` (readline-style prompts).
  - "Discord" → Third planned adapter; capability matrix matches Telegram with `unlimitedLength = false` (Discord's 2000-char cap).

## Open questions

- **Permission-prompt UI per channel.** The `promptPermission(...)` interface is channel-agnostic; the actual rendering is the adapter's choice. Should the gateway ever care which UI is used? **My read: always the adapter's call. Document as a hard rule.**
- **Channel enablement per deployment.** In v1, enabled channels are determined at compile time by which adapter modules are imported. Future: a `channels:` config block selects which of the available adapters to start. *Defer to v2.*
