import type { StreamSink } from '../../types.js';
import type { Api } from 'grammy';
import { truncateToLength } from '../_shared/stream-limits.js';
import { createLogger } from '../../logger.js';

const log = createLogger('telegram-sink');

/** Telegram's max message length */
const TELEGRAM_MAX_LENGTH = 4096;

/** Minimum time between edits, in ms */
const THROTTLE_MS = 750;

export class TelegramStreamSink implements StreamSink {
  private buffer = '';
  private currentContent = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isAborted = false;
  private lastFlushTime = 0;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly messageId: number,
  ) {}

  async append(delta: string): Promise<void> {
    this.buffer += delta;
    this.scheduleFlush();
  }

  async replace(content: string): Promise<void> {
    this.buffer = '';
    this.currentContent = content;
    this.scheduleFlush();
  }

  async finish(): Promise<void> {
    if (this.isAborted) return;
    this.cancelTimer();
    await this.flushNow();
  }

  async abort(): Promise<void> {
    this.isAborted = true;
    this.cancelTimer();
    this.buffer = '';
  }

  // ── Internal ─────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    const elapsed = Date.now() - this.lastFlushTime;
    const delay = Math.max(0, THROTTLE_MS - elapsed);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async flushNow(): Promise<void> {
    if (this.isAborted) return;

    // Build new content: existing content + buffered deltas
    const newContent = this.currentContent + this.buffer;
    this.buffer = '';

    if (newContent === this.currentContent) return;

    const capped = truncateToLength(newContent, TELEGRAM_MAX_LENGTH);
    this.lastFlushTime = Date.now();

    try {
      const result = await this.api.editMessageText(
        this.chatId,
        this.messageId,
        capped,
      );
      // Update currentContent to what Telegram actually stored
      if (typeof result === 'object' && 'text' in result) {
        this.currentContent = result.text;
      } else {
        this.currentContent = capped;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If the message hasn't changed, Telegram returns 400; that's harmless
      if (!msg.includes('message is not modified')) {
        log.warn({ err: msg }, 'Failed to edit Telegram message');
      } else {
        this.currentContent = capped;
      }
    }
  }
}
