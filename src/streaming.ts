/**
 * StreamSink — receives assistant-output events from the Copilot SDK and
 * forwards them to wherever they need to go (Telegram, logs, a TUI, etc).
 *
 * The session manager subscribes to SDK events once at session creation
 * and dispatches them to the active `StreamSink`. The sink is replaced
 * per user message, so a long-running session can stream to different
 * sinks over its lifetime.
 *
 * All methods are optional. The default `noopStreamSink` is used when no
 * sink is provided (e.g. for the resume / archive flows that don't
 * produce user-visible output).
 */
export interface StreamSink {
  /** Streaming text chunk from the assistant's current message. */
  onAssistantDelta?(messageId: string, delta: string): void;
  /** Final accumulated text for the assistant's message. */
  onAssistantMessage?(messageId: string, fullContent: string): void;
  /** A tool invocation just started (about to run, or about to prompt). */
  onToolStart?(toolCallId: string, toolName: string, args?: unknown): void;
  /** A tool invocation just completed. */
  onToolEnd?(toolCallId: string, result?: unknown): void;
  /** The session emitted a recoverable error event. */
  onSessionError?(message: string): void;
  /** The session became idle (assistant finished its turn). */
  onSessionIdle?(): void;
  /**
   * Abort the sink. Called when the caller no longer cares about
   * further events (timeout, user cancel, new message arrived). Must
   * be idempotent and must NOT throw.
   */
  abort?(): void;
}

/** A sink that drops every event. Use as a default. */
export const noopStreamSink: StreamSink = Object.freeze({});

import type { Bot } from 'grammy';
import { getChildLogger } from './logger.js';

const log = getChildLogger('streaming');

/** Minimum interval between Telegram message edits during streaming. */
export const EDIT_THROTTLE_MS = 750;

/**
 * A `StreamSink` that edits a single Telegram message in place as the
 * assistant streams text and tool events. Strategy:
 *
 * 1. `start()` either seeds a new "…" message in the chat, or adopts an
 *    existing message (passed in as `seedMessageId`).
 * 2. `onAssistantDelta` appends to an in-memory `draft` and schedules
 *    an edit. Edits are throttled to `EDIT_THROTTLE_MS` to stay under
 *    Telegram's ~30 edits/minute-per-chat rate limit.
 * 3. `onToolStart` appends a `🔧 running \`toolName\` …` status line to
 *    the draft so the user sees what's happening before any permission
 *    prompt appears.
 * 4. `onToolEnd` strips the most-recent trailing tool status line.
 * 5. `onSessionIdle`, `onAssistantMessage`, and `onSessionError` all
 *    flush the pending draft immediately.
 *
 * The sink never throws — streaming errors are logged and swallowed so
 * they can't crash the agent loop.
 */
export class TelegramStreamSink implements StreamSink {
  private draft = '';
  private lastEditAt = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private messageId: number | null = null;
  private currentMessageId: string | null = null;
  private aborted = false;
  private started = false;

  constructor(
    private readonly bot: Bot,
    private readonly chatId: number,
    /** Pre-existing message to edit instead of sending a new one. */
    private readonly seedMessageId: number | null = null,
  ) {}

  /**
   * Send (or adopt) the seed message. Must be called before any other
   * method. Safe to call multiple times — only the first call does work.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
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
      log.warn(
        { chatId: this.chatId, err },
        'Failed to seed stream message; sink will buffer only',
      );
    }
  }

  /**
   * Return the message id used for editing. Returns `null` if the seed
   * message failed to send (in which case the sink silently buffers and
   * callers shouldn't try to edit). Exposed so the message handler can
   * post a final error / "no response" text into the same draft
   * message after the agent loop finishes.
   */
  messageIdForEdit(): number | null {
    return this.messageId;
  }

  onAssistantDelta(messageId: string, delta: string): void {
    if (this.aborted) return;
    if (this.currentMessageId !== null && this.currentMessageId !== messageId) {
      // The SDK started a new assistant message mid-stream. Flush the
      // current draft so the user sees the boundary, then start fresh.
      this.flushNow();
    }
    this.currentMessageId = messageId;
    this.draft += delta;
    this.scheduleEdit();
  }

  onAssistantMessage(messageId: string, fullContent: string): void {
    if (this.aborted) return;
    this.currentMessageId = messageId;
    this.draft = fullContent;
    void this.flushNow();
  }

  onToolStart(_toolCallId: string, toolName: string): void {
    if (this.aborted) return;
    this.draft =
      (this.draft.length > 0 ? this.draft + '\n\n' : '') + `🔧 running \`${toolName}\` …`;
    this.scheduleEdit();
  }

  onToolEnd(_toolCallId: string): void {
    if (this.aborted) return;
    // Strip the most recent trailing "🔧 running X …" line. We don't
    // track per-toolCallId in the draft because the SDK can interleave
    // multiple tools; the right-anchored regex matches the trailing one.
    this.draft = this.draft.replace(/\n*\n🔧 running `[^`]+` …\n?$/, '');
    this.scheduleEdit();
  }

  onSessionIdle(): void {
    void this.flushNow();
  }

  onSessionError(message: string): void {
    if (this.aborted) return;
    this.draft = (this.draft.length > 0 ? this.draft + '\n\n' : '') + `⚠️ ${message}`;
    void this.flushNow();
  }

  abort(): void {
    this.aborted = true;
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }

  private scheduleEdit(): void {
    if (this.editTimer || this.aborted) return;
    const elapsed = Date.now() - this.lastEditAt;
    const delay = Math.max(0, EDIT_THROTTLE_MS - elapsed);
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      void this.flushNow();
    }, delay);
  }

  /** Flush the draft to Telegram immediately. Bypasses the throttle. */
  async flushNow(): Promise<void> {
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
      // Common: Markdown parse failure on partial content. We log and
      // continue — the next flush will retry with possibly-fixed text.
      // Never throw — streaming errors must not crash the agent.
      log.debug(
        { chatId: this.chatId, err },
        'editMessageText failed; will retry on next delta',
      );
    }
  }
}

