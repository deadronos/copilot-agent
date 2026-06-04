import { describe, it, expect, vi } from 'vitest';
import { SessionManager, POST_PERMISSION_BUFFER_MS } from './sessions.js';
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
  it('is at least permissions.timeout_seconds in milliseconds', () => {
    // Regression: previously this used the SDK default of 60s, which
    // caused the SDK to time out on the agent turn *before* the user
    // could click a permission button, orphaning the session.
    const mgr = new SessionManager({
      client: {} as CopilotClient,
      config: makeConfig({ timeout_seconds: 300 }),
      configDir: '/tmp',
      agents: makeAgents(),
    });
    // Access the private method via bracket notation for the assertion.
    const ms = (mgr as unknown as { sendAndWaitTimeoutMs: () => number }).sendAndWaitTimeoutMs();
    expect(ms).toBe(300_000 + POST_PERMISSION_BUFFER_MS);
  });

  it('grows with timeout_seconds so a longer permission window is respected', () => {
    const short = new SessionManager({
      client: {} as CopilotClient,
      config: makeConfig({ timeout_seconds: 60 }),
      configDir: '/tmp',
      agents: makeAgents(),
    });
    const long = new SessionManager({
      client: {} as CopilotClient,
      config: makeConfig({ timeout_seconds: 600 }),
      configDir: '/tmp',
      agents: makeAgents(),
    });
    const shortMs = (short as unknown as { sendAndWaitTimeoutMs: () => number }).sendAndWaitTimeoutMs();
    const longMs = (long as unknown as { sendAndWaitTimeoutMs: () => number }).sendAndWaitTimeoutMs();
    expect(longMs).toBeGreaterThan(shortMs);
    expect(longMs - shortMs).toBe((600 - 60) * 1000);
  });

  it('always exceeds the SDK default of 60s so permission flows never race the timeout', () => {
    // The SDK default is 60_000ms. The minimum config value (timeout_seconds: 1)
    // should still produce a value well above 60s thanks to the buffer.
    const mgr = new SessionManager({
      client: {} as CopilotClient,
      config: makeConfig({ timeout_seconds: 1 }),
      configDir: '/tmp',
      agents: makeAgents(),
    });
    const ms = (mgr as unknown as { sendAndWaitTimeoutMs: () => number }).sendAndWaitTimeoutMs();
    expect(ms).toBeGreaterThan(60_000);
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
