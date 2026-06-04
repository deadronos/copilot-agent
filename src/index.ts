import { createLogger } from './logger.js';
import { resolveConfigDir, loadConfig } from './config.js';
import { SessionStoreImpl } from './sessions.js';
import type { SessionStore } from './sessions.js';
import { createAgentRegistry } from './agents.js';
import type { AgentRegistry } from './agents.js';
import { LlmBackendImpl } from './llm.js';
import type { LlmBackend } from './llm.js';
import { getProvider } from './providers/registry.js';
import { PermissionGateImpl, createPermissionSessionState } from './permissions.js';
import { getChannel, listChannels } from './channels/registry.js';
import { GatewayImpl } from './gateway.js';
import type {
  SessionHandle,
  CreateSessionOpts,
  ArchiveReason,
  ArchivedSession,
  LlmSession,
} from './types.js';

const log = createLogger('index');

// ── Session store adapter ──────────────────────────────────────────────
// The Gateway defines its own inline SessionStore interface. We create an
// adapter object that satisfies it structurally.

function createSessionStoreAdapter(inner: SessionStore) {
  return {
    async getActive(userId: string): Promise<SessionHandle | null> {
      return inner.getActive(userId);
    },
    async create(
      userId: string,
      opts: CreateSessionOpts,
    ): Promise<SessionHandle> {
      return inner.create(userId, opts);
    },
    async archive(
      userId: string,
      reason: ArchiveReason,
    ): Promise<{ sessionId: string; path: string }> {
      const archived = await inner.archive(userId, reason);
      return { sessionId: archived.sessionId, path: archived.path };
    },
    async listArchived(
      userId: string,
      limit?: number,
    ): Promise<readonly { sessionId: string; agent: string; archivedAt: number }[]> {
      const sessions = await inner.listArchived(userId, limit);
      return sessions.map((s: ArchivedSession) => ({
        sessionId: s.sessionId,
        agent: s.agent,
        archivedAt: s.archivedAt,
      }));
    },
    async resume(userId: string, n: number): Promise<SessionHandle> {
      return inner.resume(userId, n);
    },
    async enqueue(userId: string, fn: () => Promise<void>): Promise<void> {
      return inner.enqueue(userId, fn);
    },
    async markIdle(userId: string, sessionId: string): Promise<void> {
      inner.markIdle(userId, sessionId);
    },
    async sweep(ttlMs: number): Promise<number> {
      return inner.sweep(ttlMs);
    },
  };
}

// ── LLM backend adapter ─────────────────────────────────────────────────
// The Gateway defines its own inline LlmBackend interface. Create an
// adapter object that satisfies it structurally.

function createLlmBackendAdapter(inner: LlmBackend) {
  return {
    up: true,
    async start(): Promise<void> {
      return inner.start();
    },
    async stop(): Promise<void> {
      return inner.stop();
    },
    async createSession(opts: {
      userId: string;
      agent: string;
      presetId: string;
      model: string;
      systemPrompt?: string;
      sink?: Parameters<LlmBackend['createSession']>[0]['sink'];
    }): Promise<LlmSession> {
      return inner.createSession({
        userId: opts.userId,
        agent: opts.agent,
        presetId: opts.presetId,
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        sink: opts.sink ?? undefined,
      });
    },
    getSession(sessionId: string): LlmSession {
      const session = inner.getSession(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      return session;
    },
    listSessions(): ReadonlyArray<LlmSession> {
      return inner.listSessions();
    },
  };
}

// ── Channel registry ────────────────────────────────────────────────────

const channelRegistry = {
  getChannel,
  listChannels,
};

// ── Session creation hook ───────────────────────────────────────────────
// When the session store creates a new session handle, we also create
// the live LLM session and attach it.

function createSessionStoreWithLiveBacking(
  configDir: string,
  historyDir: string,
  llmBackend: LlmBackend,
  _agentRegistry: AgentRegistry,
): SessionStore {
  const inner = new SessionStoreImpl(configDir, historyDir);

  const originalCreate = inner.create.bind(inner);
  inner.create = function (
    userId: string,
    opts: CreateSessionOpts,
  ): SessionHandle {
    const handle = originalCreate(userId, opts);

    void llmBackend
      .createSession({
        userId,
        agent: opts.agent,
        presetId: opts.presetId,
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        sink: opts.sink,
      })
      .then((live) => {
        inner.setLive(userId, live);
      })
      .catch((err) => {
        log.error({ err, userId }, 'Failed to create LLM session');
      });

    return handle;
  };

  const originalResume = inner.resume.bind(inner);
  inner.resume = async function (
    userId: string,
    n: number,
  ): Promise<SessionHandle> {
    const handle = await originalResume(userId, n);

    try {
      const live = await llmBackend.createSession({
        userId,
        agent: handle.agent,
        presetId: handle.presetId,
        model: handle.model,
      });
      inner.setLive(userId, live);
    } catch (err) {
      log.error({ err, userId }, 'Failed to create LLM session on resume');
    }

    return handle;
  };

  return inner;
}

// ── Entrypoint ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configDir = resolveConfigDir();
  const config = await loadConfig(configDir);
  log.info({ configDir }, 'Configuration loaded');

  // Initialize subsystems
  const providerRegistry = { getProvider };
  const agentsDir = config.agents.dir;
  const agentRegistry = createAgentRegistry(
    configDir,
    agentsDir,
    config.agents.default,
  );
  await agentRegistry.load();
  log.info({ count: agentRegistry.list().length }, 'Agents loaded');

  const llmBackend = new LlmBackendImpl(configDir, providerRegistry, agentRegistry);
  await llmBackend.start();
  log.info('LLM backend started');

  const sessionStore = createSessionStoreWithLiveBacking(
    configDir,
    config.session.history_dir,
    llmBackend,
    agentRegistry,
  );

  const permissionGate = new PermissionGateImpl(
    config.permissions.mode,
    config.permissions.timeout_seconds,
    createPermissionSessionState(),
  );

  // Wire everything into the gateway
  const gateway = new GatewayImpl(
    config,
    configDir,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSessionStoreAdapter(sessionStore) as any,
    agentRegistry,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createLlmBackendAdapter(llmBackend) as any,
    permissionGate,
    channelRegistry,
    log,
  );

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down');
    await gateway.stop();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await gateway.start();
  log.info('copilot-agent is running');
}

// ── CLI dispatch ────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length > 0 && !args[0].startsWith('-')) {
  import('./cli.js')
    .then(({ runCli }) => runCli(args))
    .catch((err) => {
      console.error('CLI error:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else {
  main().catch((err) => {
    log.error({ err }, 'Fatal error');
    process.exit(1);
  });
}
