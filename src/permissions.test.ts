import { describe, it, expect } from 'vitest';
import { shouldAutoApprove, formatPermissionMessage, toSdkPermissionResult } from './permissions.js';
import type { AppConfig, SessionEntry } from './types.js';

function makeConfig(mode: AppConfig['permissions']['mode']): AppConfig {
  return {
    active: { provider: 'openai', model: 'gpt-4o' },
    providers: {},
    telegram: { allowed_user_ids: [123], token_env: 'T' },
    agents: { dir: './agents', default: 'assistant' },
    session: { history_dir: './sessions', max_messages: 200 },
    permissions: { mode, timeout_seconds: 300 },
  };
}

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    chatId: 1,
    sessionId: 's1',
    provider: 'openai',
    model: 'gpt-4o',
    agentName: 'assistant',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    messageCount: 0,
    autoApprovedTools: new Set(),
    ...overrides,
  };
}

describe('shouldAutoApprove', () => {
  it('denies everything in deny-all mode', () => {
    const config = makeConfig('deny-all');
    const session = makeSession();
    expect(shouldAutoApprove(config, session, 'Read', 'read')).toBe(false);
    expect(shouldAutoApprove(config, session, 'Bash', 'shell')).toBe(false);
  });

  it('denies everything in approve-all mode', () => {
    const config = makeConfig('approve-all');
    const session = makeSession();
    expect(shouldAutoApprove(config, session, 'Read', 'read')).toBe(false);
    expect(shouldAutoApprove(config, session, 'Bash', 'shell')).toBe(false);
  });

  it('auto-approves read-only tools in readonly-default mode', () => {
    const config = makeConfig('readonly-default');
    const session = makeSession();
    expect(shouldAutoApprove(config, session, 'Read', 'read')).toBe(true);
    expect(shouldAutoApprove(config, session, 'Bash', 'shell')).toBe(false);
  });

  it('auto-approves tools in session auto-approve set', () => {
    const config = makeConfig('approve-all');
    const session = makeSession({ autoApprovedTools: new Set(['Bash']) });
    expect(shouldAutoApprove(config, session, 'Bash', 'shell')).toBe(true);
    expect(shouldAutoApprove(config, session, 'Edit', 'write')).toBe(false);
  });
});

describe('formatPermissionMessage', () => {
  it('formats a tool name and description', () => {
    const msg = formatPermissionMessage('bash', 'rm -rf /tmp/build');
    expect(msg).toContain('Bash');
    expect(msg).toContain('rm -rf /tmp/build');
  });

  it('truncates long descriptions', () => {
    const longDesc = 'a'.repeat(1000);
    const msg = formatPermissionMessage('bash', longDesc);
    expect(msg.length).toBeLessThan(longDesc.length + 200);
    expect(msg).toContain('…');
  });

  it('handles empty description', () => {
    const msg = formatPermissionMessage('read', '');
    expect(msg).toContain('Read');
  });
});

describe('toSdkPermissionResult', () => {
  it('maps "allow-once" to the SDK protocol "approve-once"', () => {
    // Regression: previously this returned { kind: 'approved' }, which the
    // Copilot SDK silently rejected (no matching decision kind) and the
    // pending tool call hung until timeout.
    expect(toSdkPermissionResult({ kind: 'allow-once' })).toEqual({ kind: 'approve-once' });
  });

  it('maps "allow-session" to the SDK protocol "approve-for-session"', () => {
    expect(toSdkPermissionResult({ kind: 'allow-session' })).toEqual({
      kind: 'approve-for-session',
    });
  });

  it('maps "deny" to "denied-interactively-by-user"', () => {
    expect(toSdkPermissionResult({ kind: 'deny' })).toEqual({
      kind: 'denied-interactively-by-user',
    });
  });
});
