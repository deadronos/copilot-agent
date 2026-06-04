import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { noopStreamSink, TelegramStreamSink } from './streaming.js';
import type { Bot } from 'grammy';

describe('noopStreamSink', () => {
  it('exists and is an object', () => {
    expect(noopStreamSink).toBeDefined();
    expect(typeof noopStreamSink).toBe('object');
  });

  it('has all optional methods undefined so callers can safely invoke them', () => {
    expect(noopStreamSink.onAssistantDelta).toBeUndefined();
    expect(noopStreamSink.onAssistantMessage).toBeUndefined();
    expect(noopStreamSink.onToolStart).toBeUndefined();
    expect(noopStreamSink.onToolEnd).toBeUndefined();
    expect(noopStreamSink.onSessionError).toBeUndefined();
    expect(noopStreamSink.onSessionIdle).toBeUndefined();
    expect(noopStreamSink.abort).toBeUndefined();
  });
});

function makeFakeBot(overrides: Partial<{
  editMessageText: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}> = {}): Bot {
  return {
    api: {
      editMessageText: overrides.editMessageText ?? vi.fn().mockResolvedValue(true),
      sendMessage: overrides.sendMessage ?? vi.fn().mockResolvedValue({ message_id: 100 }),
    },
  } as unknown as Bot;
}

describe('TelegramStreamSink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds a message on start() when no seedMessageId is given', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    const bot = makeFakeBot({ sendMessage });
    const sink = new TelegramStreamSink(bot, 123, null);
    await sink.start();
    expect(sendMessage).toHaveBeenCalledWith(123, '…', { disable_notification: true });
  });

  it('skips sending a seed message when seedMessageId is provided', async () => {
    const sendMessage = vi.fn();
    const bot = makeFakeBot({ sendMessage });
    const sink = new TelegramStreamSink(bot, 123, 99);
    await sink.start();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('accumulates deltas and edits the message on the throttle', async () => {
    const editMessageText = vi.fn().mockResolvedValue(true);
    const bot = makeFakeBot({ editMessageText });
    const sink = new TelegramStreamSink(bot, 123, 99);
    await sink.start();

    sink.onAssistantDelta!('m1', 'Hello, ');
    sink.onAssistantDelta!('m1', 'world!');
    // No edit yet (throttle pending)
    expect(editMessageText).not.toHaveBeenCalled();

    vi.advanceTimersByTime(750);
    // Drain microtasks
    await vi.runAllTimersAsync();

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledWith(123, 99, 'Hello, world!');
  });

  it('coalesces multiple deltas into a single edit within the throttle window', async () => {
    const editMessageText = vi.fn().mockResolvedValue(true);
    const bot = makeFakeBot({ editMessageText });
    const sink = new TelegramStreamSink(bot, 123, 99);
    await sink.start();

    sink.onAssistantDelta!('m1', 'a');
    sink.onAssistantDelta!('m1', 'b');
    sink.onAssistantDelta!('m1', 'c');
    vi.advanceTimersByTime(750);
    await vi.runAllTimersAsync();

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledWith(123, 99, 'abc');
  });

  it('onAssistantMessage flushes immediately and replaces the draft', async () => {
    const editMessageText = vi.fn().mockResolvedValue(true);
    const bot = makeFakeBot({ editMessageText });
    const sink = new TelegramStreamSink(bot, 123, 99);
    await sink.start();

    sink.onAssistantDelta!('m1', 'partial');
    sink.onAssistantMessage!('m1', 'final text');
    await vi.runAllTimersAsync();

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenLastCalledWith(123, 99, 'final text');
  });

  it('onAssistantMessage does not wipe draft when fullContent is empty', async () => {
    const editMessageText = vi.fn().mockResolvedValue(true);
    const bot = makeFakeBot({ editMessageText });
    const sink = new TelegramStreamSink(bot, 123, 99);
    await sink.start();

    sink.onAssistantDelta!('m1', 'preserved');
    sink.onAssistantMessage!('m1', '');
    await vi.runAllTimersAsync();

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenLastCalledWith(123, 99, 'preserved');
  });

  it('onToolStart appends a "🔧 running X …" status line', async () => {
    const editMessageText = vi.fn().mockResolvedValue(true);
    const bot = makeFakeBot({ editMessageText });
    const sink = new TelegramStreamSink(bot, 123, 99);
    await sink.start();

    sink.onAssistantDelta!('m1', 'Reading…');
    sink.onToolStart!('tc1', 'read_file');
    vi.advanceTimersByTime(750);
    await vi.runAllTimersAsync();

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenLastCalledWith(
      123,
      99,
      'Reading…\n\n🔧 running `read_file` …',
    );
  });

  it('onToolEnd strips the trailing "🔧 running X …" line', async () => {
    const editMessageText = vi.fn().mockResolvedValue(true);
    const bot = makeFakeBot({ editMessageText });
    const sink = new TelegramStreamSink(bot, 123, 99);
    await sink.start();

    sink.onAssistantDelta!('m1', 'Reading…');
    sink.onToolStart!('tc1', 'read_file');
    vi.advanceTimersByTime(750);
    await vi.runAllTimersAsync();
    sink.onToolEnd!('tc1');
    vi.advanceTimersByTime(750);
    await vi.runAllTimersAsync();

    const lastCall = editMessageText.mock.calls.at(-1);
    expect(lastCall?.[2]).toBe('Reading…');
  });

  it('getDraft returns the accumulated draft text', async () => {
    const bot = makeFakeBot();
    const sink = new TelegramStreamSink(bot, 123, 99);
    await sink.start();

    expect(sink.getDraft()).toBe('');
    sink.onAssistantDelta!('m1', 'hello');
    expect(sink.getDraft()).toBe('hello');
    sink.onAssistantDelta!('m1', ' world');
    expect(sink.getDraft()).toBe('hello world');
  });

  it('abort() stops further edits and is idempotent', async () => {
    const editMessageText = vi.fn().mockResolvedValue(true);
    const bot = makeFakeBot({ editMessageText });
    const sink = new TelegramStreamSink(bot, 123, 99);
    await sink.start();

    sink.abort!();
    sink.abort!(); // idempotent
    sink.onAssistantDelta!('m1', 'should not edit');
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();

    expect(editMessageText).not.toHaveBeenCalled();
  });

  it('swallows editMessageText errors (streaming must not crash the agent)', async () => {
    const editMessageText = vi.fn().mockRejectedValue(new Error('400 Bad Request'));
    const bot = makeFakeBot({ editMessageText });
    const sink = new TelegramStreamSink(bot, 123, 99);
    await sink.start();

    sink.onAssistantDelta!('m1', 'hi');
    vi.advanceTimersByTime(750);
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
  });
});

