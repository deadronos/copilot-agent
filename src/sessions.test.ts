import { describe, it, expect, vi } from 'vitest';
import { SessionManager, MAX_SEND_AND_WAIT_MS } from './sessions.js';
import type { AppConfig, AgentDefinition } from './types.js';
import type { CopilotClient } from '@github/copilot-sdk';
import type { StreamSink } from './streaming.js';

function makeConfig(overrides: Partial<AppConfig['permissions']> = {}): AppConfig {
  return {
    active: { provider: 'openai', model: 'gpt-4o' },
    providers: {
      openai: {
        type: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key_env: 'OPENAI_API_KEY',
      },
    },
    telegram: { allowed_user_ids: [123], token_env: 'TELEGRAM_BOT_TOKEN' },
    agents: { dir: './agents', default: 'assistant' },
    session: { history_dir: './sessions', max_messages: 200 },
    permissions: { mode: 'approve-all', timeout_seconds: 300, ...overrides },
  };
}

function makeAgents(): Map<string, AgentDefinition> {
  return new Map();
}

describe('SessionManager.sendAndWaitTimeoutMs', () => {
  it('caps the SDK timeout at MAX_SEND_AND_WAIT_MS so a hung agent fails fast', () => {
    // Regression: previously the SDK timeout = permission_window + 30s
    // buffer, which meant a 5-minute permission window produced a
    // 5.5-minute SDK wait. When the agent hung, the user waited in
    // silence for 5+ minutes and any permission clicks after the SDK
    // timed out were silently dropped. The timeout is now a separate
    // concern from the permission window.
    const mgr = new SessionManager({
      client: {} as CopilotClient,
      config: makeConfig({ timeout_seconds: 300 }),
      configDir: '/tmp',
      agents: makeAgents(),
    });
    const ms = (mgr as unknown as { sendAndWaitTimeoutMs: () => number }).sendAndWaitTimeoutMs();
    expect(ms).toBe(MAX_SEND_AND_WAIT_MS);
    expect(ms).toBeLessThanOrEqual(MAX_SEND_AND_WAIT_MS);
  });

  it('honors a short timeout_seconds when it is greater than or equal to the SDK default', () => {
    // If the user configures timeout_seconds: 90, the SDK should
    // wait exactly 90s — the cap (90s) is an upper bound, not a lower
    // one. The floor (60s) only kicks in for very-short configs.
    const mgr = new SessionManager({
      client: {} as CopilotClient,
      config: makeConfig({ timeout_seconds: 90 }),
      configDir: '/tmp',
      agents: makeAgents(),
    });
    const ms = (mgr as unknown as { sendAndWaitTimeoutMs: () => number }).sendAndWaitTimeoutMs();
    expect(ms).toBe(90_000);
  });

  it('never goes below the SDK default of 60s', () => {
    // The SDK's own default is 60s. Passing a smaller value would
    // race the SDK's internal default, so we floor at 60s.
    const mgr = new SessionManager({
      client: {} as CopilotClient,
      config: makeConfig({ timeout_seconds: 1 }),
      configDir: '/tmp',
      agents: makeAgents(),
    });
    const ms = (mgr as unknown as { sendAndWaitTimeoutMs: () => number }).sendAndWaitTimeoutMs();
    expect(ms).toBeGreaterThanOrEqual(60_000);
  });
});

describe('SessionManager event dispatch', () => {
  function makeMgr(): SessionManager {
    return new SessionManager({
      client: {} as CopilotClient,
      config: makeConfig(),
      configDir: '/tmp',
      agents: makeAgents(),
    });
  }

  it('routes assistant.message_delta to the active sink', () => {
    const mgr = makeMgr();
    const sink: StreamSink = { onAssistantDelta: vi.fn() };
    mgr.setActiveSink(42, sink);
    (mgr as unknown as { dispatchEvent: (c: number, e: unknown) => void }).dispatchEvent(
      42,
      { type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'hi' } },
    );
    expect(sink.onAssistantDelta).toHaveBeenCalledWith('m1', 'hi');
  });

  it('routes assistant.message to the active sink', () => {
    const mgr = makeMgr();
    const sink: StreamSink = { onAssistantMessage: vi.fn() };
    mgr.setActiveSink(42, sink);
    (mgr as unknown as { dispatchEvent: (c: number, e: unknown) => void }).dispatchEvent(42, {
      type: 'assistant.message',
      data: { messageId: 'm1', content: 'final' },
    });
    expect(sink.onAssistantMessage).toHaveBeenCalledWith('m1', 'final');
  });

  it('routes tool.execution_start with tool name and args to the active sink', () => {
    const mgr = makeMgr();
    const sink: StreamSink = { onToolStart: vi.fn() };
    mgr.setActiveSink(42, sink);
    (mgr as unknown as { dispatchEvent: (c: number, e: unknown) => void }).dispatchEvent(42, {
      type: 'tool.execution_start',
      data: { toolCallId: 'tc1', toolName: 'read_file', arguments: { path: '/x' } },
    });
    expect(sink.onToolStart).toHaveBeenCalledWith('tc1', 'read_file', { path: '/x' });
  });

  it('routes tool.execution_complete to the active sink', () => {
    const mgr = makeMgr();
    const sink: StreamSink = { onToolEnd: vi.fn() };
    mgr.setActiveSink(42, sink);
    (mgr as unknown as { dispatchEvent: (c: number, e: unknown) => void }).dispatchEvent(42, {
      type: 'tool.execution_complete',
      data: { toolCallId: 'tc1' },
    });
    expect(sink.onToolEnd).toHaveBeenCalledWith('tc1');
  });

  it('routes session.idle to the active sink', () => {
    const mgr = makeMgr();
    const sink: StreamSink = { onSessionIdle: vi.fn() };
    mgr.setActiveSink(42, sink);
    (mgr as unknown as { dispatchEvent: (c: number, e: unknown) => void }).dispatchEvent(42, {
      type: 'session.idle',
    });
    expect(sink.onSessionIdle).toHaveBeenCalledOnce();
  });

  it('routes session.error with the message to the active sink', () => {
    const mgr = makeMgr();
    const sink: StreamSink = { onSessionError: vi.fn() };
    mgr.setActiveSink(42, sink);
    (mgr as unknown as { dispatchEvent: (c: number, e: unknown) => void }).dispatchEvent(42, {
      type: 'session.error',
      data: { message: 'boom' },
    });
    expect(sink.onSessionError).toHaveBeenCalledWith('boom');
  });

  it('falls back to noop when no sink is set so the dispatcher never throws', () => {
    const mgr = makeMgr();
    // No setActiveSink call. Should not throw.
    expect(() =>
      (mgr as unknown as { dispatchEvent: (c: number, e: unknown) => void }).dispatchEvent(42, {
        type: 'assistant.message_delta',
        data: { messageId: 'm1', deltaContent: 'hi' },
      }),
    ).not.toThrow();
  });

  it('ignores unknown event types forward-compatibly', () => {
    const mgr = makeMgr();
    const sink: StreamSink = { onAssistantDelta: vi.fn() };
    mgr.setActiveSink(42, sink);
    (mgr as unknown as { dispatchEvent: (c: number, e: unknown) => void }).dispatchEvent(42, {
      type: 'session.future_event_we_dont_know_about',
      data: { whatever: true },
    });
    expect(sink.onAssistantDelta).not.toHaveBeenCalled();
  });
});
