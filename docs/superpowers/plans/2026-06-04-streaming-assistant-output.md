# Streaming Assistant Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream the agent's text response and tool-execution activity live to the user via Telegram, so they see the bot is working even on slow providers and have the context they need to make permission decisions.

**Architecture:** Subscribe to the SDK's `assistant.message_delta` events on each new `CopilotSession`, accumulate chunks in a per-chat draft buffer, and edit a single Telegram message in place as the draft grows. Show a separate "🔧 running `<toolName>` …" status line while a tool is executing, hide it when the tool completes. The current `sendAndWait` call is replaced by an awaited `idle` event with the same timeout math, so we still get the final `assistant.message` for the simple non-streaming fallback path.

**Tech Stack:** TypeScript, Node 24, grammY (Telegram), `@github/copilot-sdk` event subscription API, vitest.

---

## File Structure

| File | Responsibility |
| --- | --- |
| [src/streaming.ts](src/streaming.ts) (new) | `StreamSink` interface, `TelegramStreamSink` implementation, draft buffer logic with telegram message-edit throttling |
| [src/sessions.ts](src/sessions.ts) | Wire `session.on('assistant.message_delta', ...)` etc. to a `StreamSink` passed in at session creation; keep `enqueueMessage` returning the final content unchanged for back-compat |
| [src/telegram.ts](src/telegram.ts) | Create a `TelegramStreamSink` per chat, expose `streamResponseStart(chatId)` to begin a draft, pass the sink into `enqueueMessage` |
| [src/telegram.ts](src/telegram.ts) `splitMessage` | No change — used by the existing sendLongMessage fallback |
| [src/sessions.test.ts](src/sessions.test.ts) | Test that `StreamSink` receives delta + tool events in order from a fake session |
| [src/streaming.test.ts](src/streaming.test.ts) (new) | Test draft-buffer accumulation, edit-throttle, chunk boundary handling |
| [docs/ARCHITECTURE/001-telegram-copilot-sdk-architecture.md](docs/ARCHITECTURE/001-telegram-copilot-sdk-architecture.md) | New "Streaming" section describing the event flow |
| [CHANGELOG.md](CHANGELOG.md) | Granular bullet under `## Unreleased` |

---

## Task 1: Define the `StreamSink` interface

**Files:**
- Create: `src/streaming.ts`
- Test: `src/streaming.test.ts`

- [ ] **Step 1: Write the failing test for `StreamSink` noop sink**

In `src/streaming.test.ts`, assert that `NoopStreamSink` ignores all events without throwing and produces no recorded calls.

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- streaming.test.ts`
Expected: FAIL — `NoopStreamSink` doesn't exist yet.

- [ ] **Step 3: Implement `StreamSink` interface and `NoopStreamSink`**

In `src/streaming.ts`:

```ts
export interface StreamSink {
  onAssistantDelta?(messageId: string, delta: string): void;
  onAssistantMessage?(messageId: string, fullContent: string): void;
  onToolStart?(toolCallId: string, toolName: string, args?: unknown): void;
  onToolEnd?(toolCallId: string, result?: unknown): void;
  onSessionError?(message: string): void;
  onSessionIdle?(): void;
  /** Abort the sink (e.g. on timeout / user cancel). Idempotent. */
  abort?(): void;
}

export const noopStreamSink: StreamSink = Object.freeze({});
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- streaming.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/streaming.ts src/streaming.test.ts
git commit -m "Add StreamSink interface and noop implementation"
```

---

## Task 2: Implement `TelegramStreamSink` (draft buffer + edit throttling)

**Files:**
- Modify: `src/streaming.ts`
- Modify: `src/streaming.test.ts`

- [ ] **Step 1: Write failing test for draft accumulation**

Test that calling `onAssistantDelta` three times in succession produces a single `editMessageText` call with the concatenated text (after throttle).

- [ ] **Step 2: Run, verify fails**

- [ ] **Step 3: Implement `TelegramStreamSink`**

```ts
import type { Bot } from 'grammy';
import type { StreamSink } from './streaming.js';
import { getChildLogger } from './logger.js';

const log = getChildLogger('streaming');

/** Minimum interval between Telegram message edits. */
const EDIT_THROTTLE_MS = 750;

export class TelegramStreamSink implements StreamSink {
  private draft = '';
  private lastEditAt = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private messageId: number | null = null;
  private currentMessageId: string | null = null;
  private aborted = false;

  constructor(
    private readonly bot: Bot,
    private readonly chatId: number,
    /** Pre-existing message to edit instead of sending a new one (optional). */
    private readonly seedMessageId: number | null = null,
  ) {}

  async start(): Promise<void> {
    if (this.seedMessageId != null) {
      this.messageId = this.seedMessageId;
      return;
    }
    try {
      const sent = await this.bot.api.sendMessage(this.chatId, '…', {
        disable_notification: true,
      });
      this.messageId = sent.message_id;
    } catch (err) {
      log.warn({ chatId: err, err }, 'Failed to seed stream message; sink will buffer only');
    }
  }

  onAssistantDelta(messageId: string, delta: string): void {
    if (this.aborted) return;
    if (this.currentMessageId && this.currentMessageId !== messageId) {
      // The SDK started a new assistant message mid-stream (rare). Flush
      // the current draft and start a new buffer.
      this.flushNow();
    }
    this.currentMessageId = messageId;
    this.draft += delta;
    this.scheduleEdit();
  }

  onAssistantMessage(messageId: string, fullContent: string): void {
    if (this.aborted) return;
    this.draft = fullContent;
    this.currentMessageId = messageId;
    this.flushNow();
  }

  onToolStart(toolCallId: string, toolName: string): void {
    if (this.aborted) return;
    // Show a status line above the current draft. Append to draft with
    // a clear separator; the user sees the live assistant text + the
    // tool that just started.
    this.draft = (this.draft ? this.draft + '\n\n' : '') + `🔧 running \`${toolName}\` …`;
    this.scheduleEdit();
  }

  onToolEnd(toolCallId: string): void {
    if (this.aborted) return;
    // Replace any "🔧 running X …" line for this toolCallId with ✅.
    // We don't track per-toolCallId in the draft — multiple tools can
    // run sequentially — so we just strip the trailing "🔧 running X …"
    // if present and the next delta arrives.
    this.draft = this.draft.replace(/🔧 running `[^`]+` …\n?$/, '');
    this.scheduleEdit();
  }

  onSessionIdle(): void {
    this.flushNow();
  }

  onSessionError(message: string): void {
    if (this.aborted) return;
    this.draft = (this.draft ? this.draft + '\n\n' : '') + `⚠️ ${message}`;
    this.flushNow();
  }

  abort(): void {
    this.aborted = true;
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }

  private scheduleEdit(): void {
    if (this.editTimer) return;
    const elapsed = Date.now() - this.lastEditAt;
    const delay = Math.max(0, EDIT_THROTTLE_MS - elapsed);
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      this.flushNow();
    }, delay);
  }

  private async flushNow(): Promise<void> {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    if (this.messageId == null || this.aborted) return;
    const text = this.draft.length === 0 ? '…' : this.draft;
    this.lastEditAt = Date.now();
    try {
      await this.bot.api.editMessageText(this.chatId, this.messageId, text);
    } catch (err) {
      // Common case: Markdown parse failure on partial content. Fall
      // back to plain text. Don't rethrow — streaming errors must not
      // crash the agent loop.
      log.debug({ chatId: err, err }, 'editMessageText failed; will retry next delta');
    }
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/streaming.ts src/streaming.test.ts
git commit -m "Implement TelegramStreamSink with draft buffer and edit throttling"
```

---

## Task 3: Wire `StreamSink` through `SessionManager.enqueueMessage`

**Files:**
- Modify: `src/sessions.ts`
- Modify: `src/sessions.test.ts`

- [ ] **Step 1: Write failing test**

In `src/sessions.test.ts`, add a test that constructs a `SessionManager` with a fake `StreamSink` and a fake `CopilotSession` that emits an `assistant.message_delta` event, and assert the sink received the delta.

- [ ] **Step 2: Run, verify fails**

- [ ] **Step 3: Refactor `createSession` to attach a sink-aware event handler**

Replace the current `onPermissionRequest` block with one that also subscribes to:

- `assistant.message_delta` → `sink.onAssistantDelta`
- `assistant.message` → `sink.onAssistantMessage`
- `tool.execution_start` → `sink.onToolStart`
- `tool.execution_complete` → `sink.onToolEnd`
- `session.error` → `sink.onSessionError`
- `session.idle` → `sink.onSessionIdle`

Store the unsubscribe functions on the `SessionEntry` so we can clean up on `endSession`.

Add an optional `sink` parameter to `enqueueMessage(chatId, prompt, sink?)`. When provided, attach it to the session for the duration of the call, then call `sink.abort()` (or equivalent) when the call resolves/rejects.

- [ ] **Step 4: Run test, verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/sessions.ts src/sessions.test.ts
git commit -m "Wire StreamSink into SessionManager event loop"
```

---

## Task 4: Use the sink from the Telegram message handler

**Files:**
- Modify: `src/telegram.ts`

- [ ] **Step 1: Replace `enqueueMessage` call site in the message handler**

Before awaiting `enqueueMessage`:
1. Create a `new TelegramStreamSink(bot, chatId)`.
2. Call `sink.start()` (sends the seed "…" message).
3. Pass `sink` as the third argument to `enqueueMessage`.
4. After the await completes (success or error), call `sink.flushNow()` so any pending text is shown, then `sink.abort()`.

Remove the now-unused `sendLongMessage` call for streaming responses, but keep `sendLongMessage` available as a fallback for non-streaming callers (e.g. `/status`).

- [ ] **Step 2: Run typecheck + lint + tests**

- [ ] **Step 3: Commit**

```bash
git add src/telegram.ts
git commit -m "Pipe assistant text and tool events to Telegram via TelegramStreamSink"
```

---

## Task 5: Cancel any in-flight stream when a new user message arrives

**Files:**
- Modify: `src/telegram.ts`

- [ ] **Step 1: Track per-chat `TelegramStreamSink` and abort on new message**

Add a `private activeStreams = new Map<number, TelegramStreamSink>()` field. On each new user message:
1. If there's an active stream for this chat, call `sink.abort()` and remove it from the map.
2. Create a new sink and store it.

This ensures the user never sees two overlapping draft messages.

- [ ] **Step 2: Add test that abort is called on consecutive messages**

- [ ] **Step 3: Run typecheck + lint + tests**

- [ ] **Step 4: Commit**

```bash
git add src/telegram.ts src/telegram.test.ts
git commit -m "Cancel in-flight stream when a new user message arrives"
```

---

## Task 6: Update architecture doc

**Files:**
- Modify: `docs/ARCHITECTURE/001-telegram-copilot-sdk-architecture.md`

- [ ] **Step 1: Add a "Streaming" section**

After the "Three-process architecture" diagram, add a new section describing:
- The `StreamSink` interface
- `assistant.message_delta` / `tool.execution_start` / `session.idle` events
- The draft-buffer + 750ms edit-throttle strategy
- Why we use `editMessageText` instead of sending many small messages
- The cancellation behavior on new user messages

- [ ] **Step 2: Commit**

```bash
git add docs/ARCHITECTURE/001-telegram-copilot-sdk-architecture.md
git commit -m "Document streaming architecture in ADR 001"
```

---

## Task 7: Update CHANGELOG and verify final gate

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add granular bullet under `## Unreleased`**

- [ ] **Step 2: Run final gate**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: 0 typecheck errors, same 13 pre-existing lint findings (none introduced), all tests pass (5 config + 10 permissions + 3 sessions + new streaming tests).

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "Add CHANGELOG entry for streaming output"
```

---

## Notes for the executor

- **`streaming: true` is already passed** to `createSession` in [src/sessions.ts](src/sessions.ts). The SDK will emit delta events. We just need to subscribe.
- **Do not change `sendAndWait`'s timeout math** — the `sendAndWaitTimeoutMs` helper stays as-is. The streaming sink is layered on top.
- **Markdown parse failures are common** during partial drafts (unclosed code blocks, unescaped underscores). `flushNow` already falls back to plain text on error — keep that behavior.
- **The `onToolStart`/`onToolEnd` "🔧 running X" status line** is intentionally part of the draft, not a separate message. This way a single message shows the live assistant text + the currently-running tool, and the user knows what's happening even before a permission prompt appears.
- **Cancel-on-new-message is critical** for UX. The current `enqueueMessage` is per-chat queued, so this only matters if a user message races the agent's reply (rare but possible).
- **Tests for `TelegramStreamSink`** should mock `Bot` and verify edit calls. Use vitest's fake timers for throttle tests.
