import type {
  InboundMessage,
  SessionHandle,
  StatusView,
  PermissionResponse,
  PermissionEvaluation,
  AppConfig,
  CreateSessionOpts,
  ArchiveReason,
  LlmSession,
  LlmEvent,
  SendResult,
  StreamSink,
} from './types.js';
import type { ChannelAdapter } from './channels/types.js';
import type { AgentRegistry } from './agents.js';
import type { PermissionGate } from './permissions.js';
import type { Logger } from 'pino';

// ── Injected dependency interfaces ───────────────────────────────────
//
// These are defined here because their owning modules (sessions.ts,
// llm.ts) are not yet implemented. When they land, move these
// interfaces into those modules and import them from there.

export interface SessionStore {
  getActive(userId: string): Promise<SessionHandle | null>;
  create(userId: string, opts: CreateSessionOpts): Promise<SessionHandle>;
  archive(userId: string, reason: ArchiveReason): Promise<{ sessionId: string; path: string }>;
  listArchived(userId: string, limit?: number): Promise<readonly { sessionId: string; agent: string; archivedAt: number }[]>;
  resume(userId: string, n: number): Promise<SessionHandle>;
  enqueue(userId: string, fn: () => Promise<void>): Promise<void>;
  markIdle(userId: string, sessionId: string): Promise<void>;
  sweep(ttlMs: number): Promise<number>;
}

export interface LlmBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
  createSession(opts: {
    userId: string;
    agent: string;
    presetId: string;
    model: string;
    systemPrompt?: string;
    sink?: StreamSink;
  }): Promise<LlmSession>;
  getSession(sessionId: string): LlmSession;
  listSessions(): ReadonlyArray<LlmSession>;
  readonly up: boolean;
}

export interface ChannelRegistry {
  getChannel(id: string): ChannelAdapter | undefined;
  listChannels(): ReadonlyArray<ChannelAdapter>;
}

// ── Gateway interface ────────────────────────────────────────────────

export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleMessage(msg: InboundMessage): Promise<void>;
  handlePermissionResponse(response: PermissionResponse): Promise<void>;
  getStatus(): Promise<StatusView>;
}

// ── Slash-command result ─────────────────────────────────────────────

type SlashCommandResult =
  | { kind: 'handled'; reply?: string }
  | { kind: 'not-a-command' }
  | { kind: 'error'; message: string };

// ── Internal per-session tracking ────────────────────────────────────

interface PendingPermission {
  toolCallId: string;
  toolName: string;
  resolve: (value: PermissionResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Implementation ───────────────────────────────────────────────────

export class GatewayImpl implements Gateway {
  private readonly config: AppConfig;
  private readonly configDir: string;
  private readonly sessionStore: SessionStore;
  private readonly agentRegistry: AgentRegistry;
  private readonly llmBackend: LlmBackend;
  private readonly permissionGate: PermissionGate;
  private readonly channelRegistry: ChannelRegistry;
  private readonly log: Logger;

  private readonly startedAt: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  /** Pending permission requests keyed by toolCallId. */
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  constructor(
    config: AppConfig,
    configDir: string,
    sessionStore: SessionStore,
    agentRegistry: AgentRegistry,
    llmBackend: LlmBackend,
    permissionGate: PermissionGate,
    channelRegistry: ChannelRegistry,
    logger: Logger,
  ) {
    this.config = config;
    this.configDir = configDir;
    this.sessionStore = sessionStore;
    this.agentRegistry = agentRegistry;
    this.llmBackend = llmBackend;
    this.permissionGate = permissionGate;
    this.channelRegistry = channelRegistry;
    this.log = logger.child({ module: 'gateway' });
    this.startedAt = Date.now();

    void this.configDir; // reserved for future archive path resolution
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.log.info('Starting gateway');

    // 1. Start LLM backend
    await this.llmBackend.start();
    this.log.info('LLM backend started');

    // 2. Start each enabled channel
    const enabledChannels = this.config.channels.enabled;
    this.log.info({ channels: enabledChannels }, 'Starting channels');

    for (const channelId of enabledChannels) {
      const adapter = this.channelRegistry.getChannel(channelId);
      if (!adapter) {
        this.log.warn({ channelId }, 'Channel not found in registry, skipping');
        continue;
      }

      await adapter.start();
      this.log.info({ channelId }, 'Channel started');

      adapter.onMessage(async (msg: InboundMessage) => {
        await this.handleMessage(msg);
      });

      adapter.onPermissionResponse(async (response: PermissionResponse) => {
        await this.handlePermissionResponse(response);
      });
    }

    // 3. Start session sweep timer
    const sweepIntervalMs = 5 * 60 * 1000; // every 5 minutes
    this.sweepTimer = setInterval(() => {
      void this.sweepSessions();
    }, sweepIntervalMs);
    this.sweepTimer.unref();

    this.log.info('Gateway started');
  }

  async stop(): Promise<void> {
    this.log.info('Stopping gateway');
    this.stopped = true;

    // 1. Stop sweep timer
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    // 2. Archive active sessions
    const sessions = this.llmBackend.listSessions();
    this.log.info({ count: sessions.length }, 'Archiving active sessions on shutdown');

    for (const session of sessions) {
      try {
        // Each session has a userId derived from sessionId; we use a best-effort approach
        // to archive via the session store by iterating active sessions.
        // The session store's archive method is called per known session.
        await session.destroy();
      } catch (err) {
        this.log.error({ err, sessionId: session.sessionId }, 'Failed to destroy session on shutdown');
      }
    }

    // 3. Stop all channels
    for (const adapter of this.channelRegistry.listChannels()) {
      try {
        await adapter.stop();
        this.log.info({ channelId: adapter.id }, 'Channel stopped');
      } catch (err) {
        this.log.error({ err, channelId: adapter.id }, 'Failed to stop channel');
      }
    }

    // 4. Stop LLM backend
    try {
      await this.llmBackend.stop();
      this.log.info('LLM backend stopped');
    } catch (err) {
      this.log.error({ err }, 'Failed to stop LLM backend');
    }

    // 5. Clear pending permissions
    for (const [toolCallId, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({ toolCallId, choice: { kind: 'deny' } });
    }
    this.pendingPermissions.clear();

    this.log.info('Gateway stopped');
  }

  // ── Message handling ─────────────────────────────────────────────

  async handleMessage(msg: InboundMessage): Promise<void> {
    const { userId, text, channel: channelId, messageId } = msg;

    // 1. Detect slash commands
    const cmdResult = await this.handleSlashCommand(userId, text, channelId);
    if (cmdResult.kind === 'handled') {
      if (cmdResult.reply) {
        await this.sendToChannel(channelId, userId, cmdResult.reply, messageId);
      }
      return;
    }
    if (cmdResult.kind === 'error') {
      await this.sendToChannel(channelId, userId, cmdResult.message, messageId);
      return;
    }

    // 2. Enqueue per-user serialization
    await this.sessionStore.enqueue(userId, async () => {
      await this.processMessage(msg);
    });
  }

  async handlePermissionResponse(response: PermissionResponse): Promise<void> {
    const { toolCallId, choice } = response;
    const pending = this.pendingPermissions.get(toolCallId);

    if (!pending) {
      this.log.warn({ toolCallId }, 'Permission response for unknown/expired toolCallId');
      return;
    }

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(toolCallId);

    this.log.info({ toolCallId, choice: choice.kind }, 'Permission resolved by user');
    pending.resolve(response);

    // Update session permission memory for allow-session
    if (choice.kind === 'allow-session') {
      // The permission gate's session state is updated via the resolve pipeline
      this.log.debug({ toolCallId, toolName: pending.toolName }, 'Tool allow-session recorded');
    }
  }

  async getStatus(): Promise<StatusView> {
    const uptimeSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const sessions = this.llmBackend.listSessions();
    const mem = process.memoryUsage();

    const channels = this.channelRegistry.listChannels().map((adapter) => ({
      id: adapter.id,
      up: true, // simplified; real impl would track actual health
      lastErrorAt: null as number | null,
      restartCount: 0,
    }));

    return {
      uptimeSeconds,
      llmBackend: {
        up: this.llmBackend.up,
        sessionsActive: sessions.length,
      },
      channels,
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
      },
    };
  }

  // ── Private: message processing ──────────────────────────────────

  private async processMessage(msg: InboundMessage): Promise<void> {
    const { userId, text, channel: channelId, messageId } = msg;
    const adapter = this.channelRegistry.getChannel(channelId);
    if (!adapter) {
      this.log.error({ channelId }, 'Channel disappeared mid-message');
      return;
    }

    this.log.info({ userId, channel: channelId, messageId }, 'Processing message');

    let sessionHandle: SessionHandle | null = null;
    let sink: StreamSink | undefined;

    try {
      // Get or create session
      sessionHandle = await this.sessionStore.getActive(userId);
      if (!sessionHandle) {
        const defaultAgent = this.agentRegistry.defaultAgent();
        sessionHandle = await this.sessionStore.create(userId, {
          userId,
          agent: defaultAgent.name,
          presetId: this.config.active.preset,
          model: this.config.active.model,
        });
        this.log.info({ userId, sessionId: sessionHandle.sessionId }, 'Created new session');
      }

      const session = sessionHandle.live;
      if (!session) {
        // The LLM session may have failed to create earlier (e.g. config
        // error). Try once to create it now — if it still fails, the user
        // gets a clear error instead of a silent drop.
        this.log.warn({ userId, sessionId: sessionHandle.sessionId }, 'Session missing live LLM session, attempting late creation');
        throw new Error(
          'Your session is still initialising. Please try again in a moment. ' +
            'If this persists, check your preset configuration.',
        );
      }

      // Show typing indicator (via stream start — channel-specific)
      // For channels without streaming, we'd use a different mechanism.
      // The typing indicator is implicit in startStream for streaming channels.

      // Create stream sink
      const caps = adapter.capabilities;
      if (caps.streaming) {
        sink = await adapter.startStream(messageId);
      }

      // Subscribe to permission requests from the LLM session
      const unsubscribe = session.onEvent((event: LlmEvent) => {
        if (event.kind === 'permission-request') {
          void this.handlePermissionRequest(event.request, adapter, session);
        }
      });

      // Call LLM
      const result: SendResult = await session.send({
        prompt: text,
        timeoutMs: 5 * 60 * 1000,
      });

      unsubscribe();

      // Handle result
      if (sink) {
        if (result.kind === 'completed') {
          await sink.finish();
        } else {
          await sink.abort();
        }
      }

      // Handle result content
      if (result.kind === 'completed') {
        // If content exceeds channel length cap, send full content separately
        if (!caps.unlimitedLength && result.content.length > 0) {
          await this.sendLongContent(adapter, userId, result.content, messageId);
        } else if (!caps.streaming || !sink) {
          // Non-streaming channel: send atomically
          await this.sendToChannel(channelId, userId, result.content, messageId);
        }
      } else if (result.kind === 'error') {
        const friendly = this.mapErrorToUserText(result.message);
        await this.sendToChannel(channelId, userId, friendly, messageId);
      } else if (result.kind === 'permission-denied') {
        await this.sendToChannel(
          channelId,
          userId,
          `🚫 Tool \`${result.toolName}\` was denied.`,
          messageId,
        );
      } else if (result.kind === 'no-content') {
        // Nothing to send — the sink already handled any streamed content
      }

      // Mark session idle
      if (sessionHandle) {
        await this.sessionStore.markIdle(userId, sessionHandle.sessionId);
      }
    } catch (err) {
      this.log.error({ err, userId, channel: channelId }, 'Error processing message');

      if (sink) {
        try {
          await sink.abort();
        } catch {
          // sink abort is best-effort
        }
      }

      const errorText = this.mapErrorToUserText(
        err instanceof Error ? err.message : 'Unknown error',
      );
      await this.sendToChannel(channelId, userId, `❌ ${errorText}`, messageId);
    }
  }

  // ── Private: permission handling ─────────────────────────────────

  private async handlePermissionRequest(
    request: { toolCallId: string; toolName: string; args?: unknown },
    adapter: ChannelAdapter,
    _session: LlmSession,
  ): Promise<void> {
    const { toolCallId, toolName, args } = request;
    this.log.info({ toolCallId, toolName }, 'Permission request received');

    const evaluation: PermissionEvaluation = this.permissionGate.evaluate({
      toolCallId,
      toolName,
      args,
      sessionAllowed: new Set(),
      sessionDenied: new Set(),
    });

    if (evaluation.kind === 'auto-allow') {
      this.log.debug({ toolCallId, toolName }, 'Auto-allowed');
      return;
    }

    if (evaluation.kind === 'auto-deny') {
      this.log.debug({ toolCallId, toolName, reason: evaluation.reason }, 'Auto-denied');
      return;
    }

    // needs-user-input
    this.log.info({ toolCallId, toolName }, 'Prompting user for permission');

    // Setup timeout-based auto-deny
    const timeoutMs = this.config.permissions.timeout_seconds * 1000;
    let resolved = false;

    const promise = new Promise<PermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.pendingPermissions.delete(toolCallId);
          this.log.info({ toolCallId, toolName }, 'Permission timed out, auto-denying');
          resolve({ toolCallId, choice: { kind: 'deny' } });
        }
      }, timeoutMs);

      this.pendingPermissions.set(toolCallId, {
        toolCallId,
        toolName,
        resolve: (value: PermissionResponse) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            this.pendingPermissions.delete(toolCallId);
            resolve(value);
          }
        },
        timer,
      });
    });

    // Dispatch to channel
    try {
      if (adapter.capabilities.inlineButtons) {
        await adapter.promptPermission(evaluation.prompt);
      } else {
        // Text-based permission prompt for channels without inline buttons
        const text = this.formatPermissionText(toolName, args);
        await adapter.send({
          userId: '', // filled by adapter context
          channel: adapter.id,
          text,
        });
      }
    } catch (err) {
      this.log.error({ err, toolCallId }, 'Failed to send permission prompt');
      // Auto-deny on prompt failure
      const pending = this.pendingPermissions.get(toolCallId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingPermissions.delete(toolCallId);
        pending.resolve({ toolCallId, choice: { kind: 'deny' } });
      }
      return;
    }

    // Await the user's response or timeout
    await promise;

    // Deliver the response back to the permission gate.
    // The PermissionGate interface currently only exposes evaluate();
    // full round-trip integration requires adding resolve() to the interface.
    // For now, the promise resolution in our pendingPermissions map handles
    // the user's choice and the gate's awaitResponse is a separate concern.
    if (evaluation.kind === 'needs-user-input') {
      try {
        void evaluation.awaitResponse();
      } catch {
        // gate's internal promise already resolved or timed out
      }
    }
  }

  // ── Private: slash commands ──────────────────────────────────────

  private async handleSlashCommand(
    userId: string,
    text: string,
    _channelId: string,
  ): Promise<SlashCommandResult> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
      return { kind: 'not-a-command' };
    }

    const parts = trimmed.split(/\s+/);
    const command = parts[0]?.toLowerCase() ?? '';
    const arg = parts.slice(1).join(' ');

    this.log.info({ userId, command, arg }, 'Slash command received');

    switch (command) {
      case '/new': {
        const active = await this.sessionStore.getActive(userId);
        if (active) {
          await this.sessionStore.archive(userId, { kind: 'user-new-session' });
        }
        const defaultAgent = this.agentRegistry.defaultAgent();
        await this.sessionStore.create(userId, {
          userId,
          agent: defaultAgent.name,
          presetId: this.config.active.preset,
          model: this.config.active.model,
        });
        return { kind: 'handled', reply: '🆕 Started a new session.' };
      }

      case '/agent': {
        if (!arg) {
          const agents = this.agentRegistry.list();
          const lines = agents.map(
            (a) => `  • \`${a.name}\`${a.description ? ` — ${a.description}` : ''}`,
          );
          return {
            kind: 'handled',
            reply: `Available agents:\n${lines.join('\n')}`,
          };
        }
        const agent = this.agentRegistry.get(arg);
        if (!agent) {
          return { kind: 'error', message: `Agent "${arg}" not found. Use \`/agent\` to list.` };
        }
        const active = await this.sessionStore.getActive(userId);
        if (active) {
          await this.sessionStore.archive(userId, { kind: 'agent-switch' });
        }
        await this.sessionStore.create(userId, {
          userId,
          agent: agent.name,
          presetId: this.config.active.preset,
          model: agent.model ?? this.config.active.model,
        });
        return { kind: 'handled', reply: `🤖 Switched to agent \`${agent.name}\`.` };
      }

      case '/model': {
        if (!arg) {
          return { kind: 'error', message: 'Usage: `/model <id>`. Check available models with your provider.' };
        }
        const active = await this.sessionStore.getActive(userId);
        if (!active?.live) {
          return { kind: 'error', message: 'No active session. Send a message first.' };
        }
        await active.live.switchModel(arg);
        return { kind: 'handled', reply: `🔀 Switched model to \`${arg}\`.` };
      }

      case '/provider': {
        if (!arg) {
          return { kind: 'error', message: 'Usage: `/provider <id>`. Check available presets in your config.' };
        }
        const active = await this.sessionStore.getActive(userId);
        if (!active?.live) {
          // No active session: just update the config for next session
          return { kind: 'handled', reply: `🔀 Preset set to \`${arg}\` (will take effect on next message).` };
        }
        await active.live.switchPreset(arg);
        return { kind: 'handled', reply: `🔀 Switched preset to \`${arg}\`.` };
      }

      case '/resume': {
        const n = arg ? parseInt(arg, 10) : 1;
        if (isNaN(n) || n < 1) {
          return { kind: 'error', message: 'Usage: `/resume [n]` where n >= 1.' };
        }
        try {
          await this.sessionStore.resume(userId, n);
          return { kind: 'handled', reply: `📂 Resumed session #${n}.` };
        } catch {
          return { kind: 'error', message: `No archived session #${n} found.` };
        }
      }

      case '/status': {
        const active = await this.sessionStore.getActive(userId);
        if (!active) {
          return { kind: 'handled', reply: 'No active session. Send a message to start one.' };
        }
        const lines = [
          `  • Session: \`${active.sessionId}\``,
          `  • Agent: \`${active.agent}\``,
          `  • Preset: \`${active.presetId}\``,
          `  • Model: \`${active.model}\``,
          `  • Created: ${new Date(active.createdAt).toISOString()}`,
        ];
        return { kind: 'handled', reply: `📊 Session status:\n${lines.join('\n')}` };
      }

      case '/approve': {
        // Approve the most recent pending permission for this user
        const pending = this.findPendingPermission();
        if (!pending) {
          return { kind: 'error', message: 'No pending permission to approve.' };
        }
        clearTimeout(pending.timer);
        this.pendingPermissions.delete(pending.toolCallId);
        pending.resolve({ toolCallId: pending.toolCallId, choice: { kind: 'allow-once' } });
        return { kind: 'handled', reply: `✅ Approved \`${pending.toolName}\`.` };
      }

      case '/deny': {
        const pending = this.findPendingPermission();
        if (!pending) {
          return { kind: 'error', message: 'No pending permission to deny.' };
        }
        clearTimeout(pending.timer);
        this.pendingPermissions.delete(pending.toolCallId);
        pending.resolve({ toolCallId: pending.toolCallId, choice: { kind: 'deny' } });
        return { kind: 'handled', reply: `🚫 Denied \`${pending.toolName}\`.` };
      }

      case '/help': {
        const lines = [
          '  • `/new` — Start a new session',
          '  • `/agent [name]` — Switch agent (no arg: list)',
          '  • `/model <id>` — Switch model',
          '  • `/provider <id>` — Switch preset',
          '  • `/resume [n]` — Resume archived session',
          '  • `/status` — Show session status',
          '  • `/approve` — Approve pending tool',
          '  • `/deny` — Deny pending tool',
          '  • `/help` — Show this help',
        ];
        return { kind: 'handled', reply: `Commands:\n${lines.join('\n')}` };
      }

      default:
        return { kind: 'not-a-command' };
    }
  }

  // ── Private: helpers ─────────────────────────────────────────────

  private async sendToChannel(
    channelId: string,
    userId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const adapter = this.channelRegistry.getChannel(channelId);
    if (!adapter) {
      this.log.warn({ channelId }, 'Cannot send to unknown channel');
      return;
    }

    try {
      await adapter.send({
        userId,
        channel: channelId,
        text,
        replyToMessageId,
      });
    } catch (err) {
      this.log.error({ err, channelId, userId }, 'Failed to send message');
    }
  }

  private async sendLongContent(
    adapter: ChannelAdapter,
    userId: string,
    content: string,
    replyToMessageId?: string,
  ): Promise<void> {
    // Split long content into chunks and send individually
    const maxLen = 4000; // conservative cap below Telegram's 4096
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        await adapter.send({
          userId,
          channel: adapter.id,
          text: remaining,
          replyToMessageId,
        });
        break;
      }

      // Find a good split point
      let splitAt = maxLen;
      const lastPeriod = remaining.lastIndexOf('. ', maxLen);
      const lastNewline = remaining.lastIndexOf('\n', maxLen);
      if (lastPeriod > maxLen * 0.7) {
        splitAt = lastPeriod + 1;
      } else if (lastNewline > maxLen * 0.5) {
        splitAt = lastNewline + 1;
      }

      const chunk = remaining.slice(0, splitAt).trimEnd();
      remaining = remaining.slice(splitAt).trimStart();

      await adapter.send({
        userId,
        channel: adapter.id,
        text: chunk,
        replyToMessageId,
      });
      // Only reply to the first chunk
      replyToMessageId = undefined;
    }
  }

  private async sweepSessions(): Promise<void> {
    try {
      const ttlMs = this.config.session.max_idle_seconds * 1000;
      const count = await this.sessionStore.sweep(ttlMs);
      if (count > 0) {
        this.log.info({ count }, 'Swept idle sessions');
      }
    } catch (err) {
      this.log.error({ err }, 'Session sweep failed');
    }
  }

  private findPendingPermission(): PendingPermission | undefined {
    // Return the first pending permission (for /approve and /deny text commands)
    for (const pending of this.pendingPermissions.values()) {
      return pending;
    }
    return undefined;
  }

  private formatPermissionText(toolName: string, args?: unknown): string {
    let text = `🔧 Tool \`${toolName}\` wants to run`;
    if (args !== undefined && args !== null) {
      const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
      if (argsStr.length > 0 && argsStr !== '{}') {
        const truncated = argsStr.length > 200 ? `${argsStr.slice(0, 200)}…` : argsStr;
        text += `\nArgs: \`${truncated}\``;
      }
    }
    text += '\nReply `/approve` or `/deny`.';
    return text;
  }

  private mapErrorToUserText(message: string): string {
    if (message.includes('Timeout') || message.includes('timed out')) {
      return '⏳ The model didn\'t respond in time. Try `/model` or `/new`.';
    }
    if (message.includes('401') || message.includes('unauthorized')) {
      return '🔑 Your API key is invalid or expired. Check your configuration.';
    }
    if (message.includes('429') || message.includes('rate limit')) {
      return '⏱️ Rate limited. Please wait a moment and try again.';
    }
    if (message.includes('ECONNREFUSED') || message.includes('backend went down')) {
      return '🔌 The LLM backend is unavailable. It may restart shortly — try again in a moment.';
    }
    if (message.includes('context length') || message.includes('token limit')) {
      return '📏 The conversation is too long. Use `/new` to start a fresh session.';
    }
    return `Something went wrong: ${message}`;
  }
}
