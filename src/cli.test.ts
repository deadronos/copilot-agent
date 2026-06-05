import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We mock dependencies before importing the module under test.
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    access: vi.fn(),
    unlink: vi.fn(),
    readdir: vi.fn(),
  },
}));

vi.mock('./config.js', () => ({
  resolveConfigDir: vi.fn(() => '/fake/config'),
  loadConfig: vi.fn(),
  loadPreset: vi.fn(),
  listPresets: vi.fn(),
}));

vi.mock('./agents.js', () => ({
  createAgentRegistry: vi.fn(),
}));

vi.mock('./providers/registry.js', () => ({
  getProvider: vi.fn(),
  listProviders: vi.fn(),
}));

vi.mock('./providers/_shared/fs.js', () => ({
  atomicWriteFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('yaml', () => ({
  default: {
    stringify: vi.fn((obj: unknown) => JSON.stringify(obj)),
    parse: vi.fn(),
  },
}));

import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { runCli } from './cli.js';
import { loadConfig, loadPreset, listPresets } from './config.js';
import { createAgentRegistry } from './agents.js';
import { getProvider, listProviders } from './providers/registry.js';
import { atomicWriteFile } from './providers/_shared/fs.js';

// ── Test helpers ──────────────────────────────────────────────────────

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { spy, output: () => chunks.join(''), restore: () => spy.mockRestore() };
}

function captureStderr() {
  const chunks: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  });
  return { spy, output: () => chunks.join(''), restore: () => spy.mockRestore() };
}

function mockExit(expectedCode?: number) {
  return vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    if (expectedCode !== undefined && code !== expectedCode) {
      throw new Error(`Expected exit code ${expectedCode}, got ${code}`);
    }
    throw new Error(`process.exit(${code})`);
  }) as unknown as ReturnType<typeof vi.spyOn>;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('runCli', () => {
  let exitSpy: ReturnType<typeof mockExit>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = mockExit(undefined);
  });

  afterEach(() => {
    exitSpy?.mockRestore?.();
  });

  // ── Help ──────────────────────────────────────────────────────────

  describe('help', () => {
    it('prints usage on --help', async () => {
      const { output } = captureStdout();
      await runCli(['--help']);
      expect(output()).toContain('copilot-agent — personal AI assistant CLI');
      expect(output()).toContain('provider list');
    });

    it('prints usage on -h', async () => {
      const { output } = captureStdout();
      await runCli(['-h']);
      expect(output()).toContain('personal AI assistant CLI');
    });

    it('prints usage on help', async () => {
      const { output } = captureStdout();
      await runCli(['help']);
      expect(output()).toContain('personal AI assistant CLI');
    });

    it('prints usage on no args', async () => {
      const { output } = captureStdout();
      await runCli([]);
      expect(output()).toContain('personal AI assistant CLI');
    });
  });

  // ── Unknown subcommand ────────────────────────────────────────────

  it('errors on unknown subcommand', async () => {
    const { output: errOutput } = captureStderr();
    const exitMock = mockExit(1);
    try {
      await runCli(['bogus']);
    } catch {
      // expected
    }
    expect(errOutput()).toContain('Unknown subcommand: bogus');
    exitMock.mockRestore();
  });

  // ── Provider list ─────────────────────────────────────────────────

  describe('provider list', () => {
    it('prints empty message when no presets', async () => {
      vi.mocked(listPresets).mockResolvedValue([]);
      const { output } = captureStdout();
      await runCli(['provider', 'list']);
      expect(output()).toContain('No presets configured');
    });

    it('prints a table of presets', async () => {
      vi.mocked(listPresets).mockResolvedValue(['gh', 'openai']);
      vi.mocked(loadPreset).mockImplementation(async (_dir, id) => ({
        id,
        provider: id === 'gh' ? 'github-copilot' : 'openai',
        model: id === 'gh' ? 'claude-sonnet-4-6' : 'gpt-5',
        models: [{ id: 'm1', displayName: 'Model 1' }],
      }));
      vi.mocked(getProvider).mockReturnValue({
        id: 'github-copilot',
        displayName: 'GitHub Copilot',
        capabilities: { apiKey: false, deviceFlow: true, oauthFlow: false, dynamicModels: false, healthCheck: false },
        onboard: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
        buildByokConfig: vi.fn(),
      } as never);

      const { output } = captureStdout();
      await runCli(['provider', 'list']);
      const out = output();
      expect(out).toContain('NAME');
      expect(out).toContain('PROVIDER');
      expect(out).toContain('gh');
      expect(out).toContain('openai');
    });
  });

  // ── Provider add ──────────────────────────────────────────────────

  describe('provider add', () => {
    it('errors when no provider-id given', async () => {
      const { output: errOutput } = captureStderr();
      const exitMock = mockExit(1);
      try {
        await runCli(['provider', 'add']);
      } catch {
        // expected
      }
      expect(errOutput()).toContain('Usage:');
      exitMock.mockRestore();
    });

    it('errors when provider is unknown', async () => {
      vi.mocked(getProvider).mockReturnValue(undefined);
      vi.mocked(listProviders).mockReturnValue([
        { id: 'gh', displayName: 'GitHub Copilot', capabilities: {} } as never,
      ]);
      const { output: errOutput } = captureStderr();
      const exitMock = mockExit(1);
      try {
        await runCli(['provider', 'add', 'bogus']);
      } catch {
        // expected
      }
      expect(errOutput()).toContain('Unknown provider: bogus');
      exitMock.mockRestore();
    });

    it('errors when preset already exists', async () => {
      vi.mocked(getProvider).mockReturnValue({
        id: 'gh',
        displayName: 'GitHub Copilot',
        capabilities: { apiKey: false, deviceFlow: true, oauthFlow: false, dynamicModels: false, healthCheck: false },
      } as never);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      // access resolves = file exists
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const { output: errOutput } = captureStderr();
      const exitMock = mockExit(1);
      try {
        await runCli(['provider', 'add', 'gh']);
      } catch {
        // expected
      }
      expect(errOutput()).toContain('already exists');
      exitMock.mockRestore();
    });

    it('onboards and writes preset on success', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.access).mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }));
      vi.mocked(getProvider).mockReturnValue({
        id: 'gh',
        displayName: 'GitHub Copilot',
        capabilities: { apiKey: false, deviceFlow: true, oauthFlow: false, dynamicModels: false, healthCheck: false },
        onboard: vi.fn().mockResolvedValue({
          name: 'my-preset',
          provider: 'gh',
          auth: { kind: 'device_flow' as const, tokenFile: '/tmp/token', clientId: 'x' },
          models: [{ id: 'm1', displayName: 'Model 1' }],
          defaultModel: 'm1',
        }),
      } as never);
      vi.mocked(atomicWriteFile).mockResolvedValue();

      const { output } = captureStdout();
      await runCli(['provider', 'add', 'gh', 'my-preset']);

      expect(output()).toContain('created successfully');
      expect(output()).toContain('my-preset');
      expect(atomicWriteFile).toHaveBeenCalled();
    });
  });

  // ── Provider remove ───────────────────────────────────────────────

  describe('provider remove', () => {
    it('refuses to remove the active preset', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        active: { preset: 'my-preset', model: 'm1' },
      } as never);

      const { output: errOutput } = captureStderr();
      const exitMock = mockExit(1);
      try {
        await runCli(['provider', 'remove', 'my-preset']);
      } catch {
        // expected
      }
      expect(errOutput()).toContain('active preset');
      exitMock.mockRestore();
    });

    it('removes a non-active preset', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        active: { preset: 'other', model: 'm1' },
      } as never);
      vi.mocked(fs.unlink).mockResolvedValue();

      const { output } = captureStdout();
      await runCli(['provider', 'remove', 'my-preset']);
      expect(output()).toContain('removed');
    });
  });

  // ── Provider show ─────────────────────────────────────────────────

  describe('provider show', () => {
    it('prints preset details with secrets redacted', async () => {
      vi.mocked(loadPreset).mockResolvedValue({
        id: 'my-preset',
        provider: 'gh',
        model: 'm1',
        auth: { kind: 'device_flow', tokenFile: '/tmp/token', clientId: 'x' },
        apiKey: 'secret123',
      });

      const { output } = captureStdout();
      await runCli(['provider', 'show', 'my-preset']);
      const out = output();
      expect(out).toContain('my-preset');
      expect(out).not.toContain('secret123');
      expect(out).toContain('REDACTED');
    });
  });

  // ── Provider login ────────────────────────────────────────────────

  describe('provider login', () => {
    it('errors when auth kind is none', async () => {
      vi.mocked(loadPreset).mockResolvedValue({
        id: 'my-preset',
        provider: 'gh',
        auth: { kind: 'none' },
      });
      vi.mocked(getProvider).mockReturnValue({
        id: 'gh',
        displayName: 'GitHub Copilot',
        capabilities: {},
        login: vi.fn(),
      } as never);

      const { output: errOutput } = captureStderr();
      const exitMock = mockExit(1);
      try {
        await runCli(['provider', 'login', 'my-preset']);
      } catch {
        // expected
      }
      expect(errOutput()).toContain('no auth configured');
      exitMock.mockRestore();
    });

    it('calls provider.login on success', async () => {
      const mockLogin = vi.fn().mockResolvedValue(undefined);
      vi.mocked(loadPreset).mockResolvedValue({
        id: 'my-preset',
        provider: 'gh',
        auth: { kind: 'api_key', envVar: 'MY_KEY' },
      });
      vi.mocked(getProvider).mockReturnValue({
        id: 'gh',
        displayName: 'GitHub Copilot',
        capabilities: {},
        login: mockLogin,
      } as never);

      const { output } = captureStdout();
      await runCli(['provider', 'login', 'my-preset']);
      expect(mockLogin).toHaveBeenCalled();
      expect(output()).toContain('Login successful');
    });
  });

  // ── Provider logout ───────────────────────────────────────────────

  describe('provider logout', () => {
    it('calls provider.logout', async () => {
      const mockLogout = vi.fn().mockResolvedValue(undefined);
      vi.mocked(loadPreset).mockResolvedValue({
        id: 'my-preset',
        provider: 'gh',
        auth: { kind: 'api_key', envVar: 'MY_KEY' },
      });
      vi.mocked(getProvider).mockReturnValue({
        id: 'gh',
        displayName: 'GitHub Copilot',
        capabilities: {},
        logout: mockLogout,
      } as never);

      const { output } = captureStdout();
      await runCli(['provider', 'logout', 'my-preset']);
      expect(mockLogout).toHaveBeenCalled();
      expect(output()).toContain('Logout complete');
    });
  });

  // ── Provider refresh ──────────────────────────────────────────────

  describe('provider refresh', () => {
    it('errors when discoverModels is not available', async () => {
      vi.mocked(loadPreset).mockResolvedValue({
        id: 'my-preset',
        provider: 'gh',
        auth: { kind: 'api_key', envVar: 'MY_KEY' },
      });
      vi.mocked(getProvider).mockReturnValue({
        id: 'gh',
        displayName: 'GitHub Copilot',
        capabilities: {},
      } as never);

      const { output: errOutput } = captureStderr();
      const exitMock = mockExit(1);
      try {
        await runCli(['provider', 'refresh', 'my-preset']);
      } catch {
        // expected
      }
      expect(errOutput()).toContain('does not support dynamic model discovery');
      exitMock.mockRestore();
    });

    it('prints models on success', async () => {
      vi.mocked(loadPreset).mockResolvedValue({
        id: 'my-preset',
        provider: 'gh',
        auth: { kind: 'api_key', envVar: 'MY_KEY' },
      });
      vi.mocked(getProvider).mockReturnValue({
        id: 'gh',
        displayName: 'GitHub Copilot',
        capabilities: {},
        discoverModels: vi.fn().mockResolvedValue({
          models: [{ id: 'm1', displayName: 'Model 1', supportsTools: true, contextWindow: 128_000 }],
          fetchedAt: Date.now(),
          ttlMs: 3600_000,
        }),
      } as never);

      const { output } = captureStdout();
      await runCli(['provider', 'refresh', 'my-preset']);
      expect(output()).toContain('m1');
      expect(output()).toContain('Model 1');
    });
  });

  // ── Agent list ────────────────────────────────────────────────────

  describe('agent list', () => {
    it('prints table of agents', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        agents: { dir: 'agents', default: 'helper' },
      } as never);
      vi.mocked(createAgentRegistry).mockReturnValue({
        load: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockReturnValue([
          { name: 'helper', description: 'A helper', model: 'm1', tools: ['read'], systemPrompt: '', sourcePath: '/f/helper.md', loadedAt: 1 },
          { name: 'writer', description: 'A writer', model: undefined, tools: undefined, systemPrompt: '', sourcePath: '/f/writer.md', loadedAt: 1 },
        ]),
        get: vi.fn(),
        defaultAgent: vi.fn(),
      } as never);

      const { output } = captureStdout();
      await runCli(['agent', 'list']);
      const out = output();
      expect(out).toContain('NAME');
      expect(out).toContain('helper');
      expect(out).toContain('(default)');
      expect(out).toContain('writer');
    });
  });

  // ── Agent show ────────────────────────────────────────────────────

  describe('agent show', () => {
    it('prints agent source content', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        agents: { dir: 'agents', default: 'helper' },
      } as never);
      vi.mocked(fs.readFile).mockResolvedValue('---\nname: helper\n---\n\nYou are helpful.');
      vi.mocked(createAgentRegistry).mockReturnValue({
        load: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue({
          name: 'helper',
          systemPrompt: 'You are helpful.',
          sourcePath: '/fake/file.md',
        }),
        defaultAgent: vi.fn(),
      } as never);

      const { output } = captureStdout();
      await runCli(['agent', 'show', 'helper']);
      expect(output()).toContain('You are helpful.');
    });

    it('errors when agent not found', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        agents: { dir: 'agents', default: 'helper' },
      } as never);
      vi.mocked(createAgentRegistry).mockReturnValue({
        load: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue(null),
        defaultAgent: vi.fn(),
      } as never);

      const { output: errOutput } = captureStderr();
      const exitMock = mockExit(1);
      try {
        await runCli(['agent', 'show', 'missing']);
      } catch {
        // expected
      }
      expect(errOutput()).toContain('not found');
      exitMock.mockRestore();
    });
  });

  // ── Agent create ──────────────────────────────────────────────────

  describe('agent create', () => {
    it('scaffolds a new agent file', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        agents: { dir: 'agents', default: 'helper' },
      } as never);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.access).mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(spawnSync).mockReturnValue({ status: 0, error: undefined } as never);

      const { output } = captureStdout();
      await runCli(['agent', 'create', 'new-agent']);
      expect(output()).toContain('scaffolded');
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('new-agent.md'),
        expect.stringContaining('name: new-agent'),
        expect.any(Object),
      );
    });

    it('errors when agent already exists', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        agents: { dir: 'agents', default: 'helper' },
      } as never);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.access).mockResolvedValue(undefined); // file exists

      const { output: errOutput } = captureStderr();
      const exitMock = mockExit(1);
      try {
        await runCli(['agent', 'create', 'existing']);
      } catch {
        // expected
      }
      expect(errOutput()).toContain('already exists');
      exitMock.mockRestore();
    });
  });

  // ── Agent edit ────────────────────────────────────────────────────

  describe('agent edit', () => {
    it('opens editor for an agent', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        agents: { dir: 'agents', default: 'helper' },
      } as never);
      vi.mocked(createAgentRegistry).mockReturnValue({
        load: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue({
          name: 'helper',
          sourcePath: '/fake/helper.md',
          systemPrompt: '',
        }),
        defaultAgent: vi.fn(),
      } as never);
      vi.mocked(spawnSync).mockReturnValue({ status: 0, error: undefined } as never);

      const { output } = captureStdout();
      await runCli(['agent', 'edit', 'helper']);
      expect(output()).toContain('Opening');
      expect(spawnSync).toHaveBeenCalledWith(
        expect.any(String),
        ['/fake/helper.md'],
        { stdio: 'inherit' },
      );
    });

    it('refuses to edit built-in agent', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        agents: { dir: 'agents', default: 'helper' },
      } as never);
      vi.mocked(createAgentRegistry).mockReturnValue({
        load: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue({
          name: 'assistant',
          sourcePath: 'builtin',
          systemPrompt: '',
        }),
        defaultAgent: vi.fn(),
      } as never);

      const { output: errOutput } = captureStderr();
      const exitMock = mockExit(1);
      try {
        await runCli(['agent', 'edit', 'assistant']);
      } catch {
        // expected
      }
      expect(errOutput()).toContain('Cannot edit the built-in');
      exitMock.mockRestore();
    });
  });

  // ── Agent delete ──────────────────────────────────────────────────

  describe('agent delete', () => {
    it('refuses to delete the default agent', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        agents: { dir: 'agents', default: 'helper' },
      } as never);

      const { output: errOutput } = captureStderr();
      const exitMock = mockExit(1);
      try {
        await runCli(['agent', 'delete', 'helper']);
      } catch {
        // expected
      }
      expect(errOutput()).toContain('default agent');
      exitMock.mockRestore();
    });

    it('deletes a non-default agent', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        agents: { dir: 'agents', default: 'helper' },
      } as never);
      vi.mocked(createAgentRegistry).mockReturnValue({
        load: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue({
          name: 'writer',
          sourcePath: '/fake/writer.md',
          systemPrompt: '',
        }),
        defaultAgent: vi.fn(),
      } as never);
      vi.mocked(fs.unlink).mockResolvedValue();

      const { output } = captureStdout();
      await runCli(['agent', 'delete', 'writer']);
      expect(output()).toContain('deleted');
      expect(fs.unlink).toHaveBeenCalledWith('/fake/writer.md');
    });
  });

  // ── Config get ────────────────────────────────────────────────────

  describe('config get', () => {
    it('prints full config', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        active: { preset: 'gh', model: 'm1' },
        agents: { dir: 'agents', default: 'assistant' },
        telegram: { allowed_user_ids: [123], token_env: 'TELEGRAM_BOT_TOKEN' },
        session: { history_dir: 'sessions', max_messages: 50, max_idle_seconds: 1800 },
        permissions: { mode: 'readonly-default', timeout_seconds: 60 },
        channels: { enabled: ['telegram'] },
      } as never);

      const { output } = captureStdout();
      await runCli(['config', 'get']);
      const out = output();
      expect(out).toContain('active');
      expect(out).toContain('gh');
    });

    it('prints a single key value', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        active: { preset: 'gh', model: 'm1' },
      } as never);

      const { output } = captureStdout();
      await runCli(['config', 'get', 'active.preset']);
      expect(output()).toContain('gh');
    });

    it('errors on unknown key', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        active: { preset: 'gh', model: 'm1' },
      } as never);

      const { output: errOutput } = captureStderr();
      const exitMock = mockExit(1);
      try {
        await runCli(['config', 'get', 'bogus.key']);
      } catch {
        // expected
      }
      expect(errOutput()).toContain('Unknown config key');
      exitMock.mockRestore();
    });
  });

  // ── Config set ────────────────────────────────────────────────────

  describe('config set', () => {
    it('refuses to set unknown keys', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        active: { preset: 'gh', model: 'm1' },
      } as never);

      const { output: errOutput } = captureStderr();
      const exitMock = mockExit(1);
      try {
        await runCli(['config', 'set', 'telegram.token_env', 'NEW_VAR']);
      } catch {
        // expected
      }
      expect(errOutput()).toContain('Cannot set');
      exitMock.mockRestore();
    });

    it('updates a known config key', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        active: { preset: 'gh', model: 'm1' },
      } as never);
      vi.mocked(listPresets).mockResolvedValue(['new-preset']);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const { output } = captureStdout();
      await runCli(['config', 'set', 'active.preset', 'new-preset']);
      expect(output()).toContain('Config updated');
      expect(output()).toContain('active.preset');
    });

    it('validates numeric keys', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        session: { max_messages: 50 },
      } as never);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const { output } = captureStdout();
      await runCli(['config', 'set', 'session.max_messages', '100']);
      expect(output()).toContain('Config updated');
    });
  });
});
