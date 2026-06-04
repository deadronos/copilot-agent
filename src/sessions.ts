import { writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type CopilotClient,
  type CopilotSession,
  type PermissionRequest,
  type PermissionRequestResult,
} from '@github/copilot-sdk';
import type {
  AppConfig,
  AgentDefinition,
  SessionEntry,
  ArchivedSession,
  PermissionDecision,
} from './types.js';
import { resolveProviderAuth } from './config.js';
import { getAgentSystemMessage } from './agents.js';
import { shouldAutoApprove, toSdkPermissionResult } from './permissions.js';
import { noopStreamSink, type StreamSink } from './streaming.js';
import { getChildLogger } from './logger.js';

const log = getChildLogger('sessions');

/**
 * Hard cap on the SDK `sendAndWait` timeout. The SDK waits for the
 * agent to finish its turn. When the agent is blocked on a permission
 * prompt, the SDK's wait timer does not include the user's think-time
 * separately — it just races against `session.idle`. We want:
 *
 *  - long enough to cover "agent is thinking, hasn't emitted `idle` yet"
 *  - short enough that a hung agent fails fast and the user gets feedback
 *
 * 90s is the empirical sweet spot: long enough for slow models on
 * large prompts, short enough that the user isn't left staring at
 * silence for 5+ minutes. The `permissions.timeout_seconds` config
 * controls how long the user has to CLICK a button, which is a
 * different concern and is enforced separately in the message handler
 * (see `TelegramBot.showPermissionPrompt` + the `pendingPermissions`
 * map). Exported for testing.
 */
export const MAX_SEND_AND_WAIT_MS = 90_000;

/** Floor for the SDK timeout so we never go below the SDK's 60s default. */
export const MIN_SEND_AND_WAIT_MS = 60_000;

export class SessionManager {
  private sessions = new Map<number, SessionEntry>();
  private sdkSessions = new Map<number, CopilotSession>();
  private queues = new Map<number, Promise<void>>();
  /**
   * The active `StreamSink` for each chat. Replaced on every user
   * message. The session-level `onEvent` handler dispatches to whichever
   * sink is currently set, so streaming output is always piped to the
   * right place even if the user sends messages faster than the agent
   * can respond.
   */
  private activeSinks = new Map<number, StreamSink>();
  private client: CopilotClient;
  private config: AppConfig;
  private configDir: string;
  private agents: Map<string, AgentDefinition>;
  private permissionPromptCallback!: (
    chatId: number,
    toolName: string,
    description: string,
    requestId: string,
  ) => Promise<PermissionDecision>;

  constructor(opts: {
    client: CopilotClient;
    config: AppConfig;
    configDir: string;
    agents: Map<string, AgentDefinition>;
  }) {
    this.client = opts.client;
    this.config = opts.config;
    this.configDir = opts.configDir;
    this.agents = opts.agents;
  }

  /** Set the permission prompt callback (called by TelegramBot after init). */
  setPermissionPromptCallback(
    cb: (
      chatId: number,
      toolName: string,
      description: string,
      requestId: string,
    ) => Promise<PermissionDecision>,
  ): void {
    this.permissionPromptCallback = cb;
  }

  /**
   * Set the active `StreamSink` for a chat. Subsequent SDK events for
   * this chat's session will be dispatched to this sink until the next
   * call. Callers MUST call `setActiveSink(chatId, noopStreamSink)` (or
   * another sink) before discarding the previous one, to avoid
   * cross-message leakage.
   */
  setActiveSink(chatId: number, sink: StreamSink): void {
    this.activeSinks.set(chatId, sink);
  }

  private getActiveSink(chatId: number): StreamSink {
    return this.activeSinks.get(chatId) ?? noopStreamSink;
  }

  /**
   * Dispatch a Copilot SDK session event to the chat's active sink.
   * Called from the `onEvent` hook registered at session creation. Each
   * event type maps to one `StreamSink` method; unknown event types are
   * silently ignored (the SDK may add new event types in the future).
   */
  private dispatchEvent(chatId: number, event: unknown): void {
    const sink = this.getActiveSink(chatId);
    if (!event || typeof event !== 'object') return;
    const e = event as { type?: string; data?: Record<string, unknown> };
    switch (e.type) {
      case 'assistant.message_delta': {
        const data = e.data as { messageId?: string; deltaContent?: string } | undefined;
        sink.onAssistantDelta?.(data?.messageId ?? '', data?.deltaContent ?? '');
        break;
      }
      case 'assistant.message': {
        const data = e.data as { messageId?: string; content?: string } | undefined;
        sink.onAssistantMessage?.(data?.messageId ?? '', data?.content ?? '');
        break;
      }
      case 'tool.execution_start': {
        const data = e.data as { toolCallId?: string; toolName?: string; arguments?: unknown };
        sink.onToolStart?.(data?.toolCallId ?? '', data?.toolName ?? '', data?.arguments);
        break;
      }
      case 'tool.execution_complete': {
        const data = e.data as { toolCallId?: string };
        sink.onToolEnd?.(data?.toolCallId ?? '');
        break;
      }
      case 'session.error': {
        const data = e.data as { message?: string } | undefined;
        sink.onSessionError?.(data?.message ?? 'unknown error');
        break;
      }
      case 'session.idle': {
        sink.onSessionIdle?.();
        break;
      }
      default:
        // Forward-compatible: ignore unknown event types.
        break;
    }
  }

  /**
   * Get or create a session for a chat.
   */
  async getOrCreateSession(chatId: number): Promise<{
    entry: SessionEntry;
    session: CopilotSession;
  }> {
    const existing = this.sdkSessions.get(chatId);
    if (existing) {
      const entry = this.sessions.get(chatId)!;
      entry.lastActivityAt = Date.now();
      return { entry, session: existing };
    }

    return this.createSession(chatId, this.config.active.provider, this.config.active.model);
  }

  /**
   * Create a new session for a chat with the given provider/model.
   */
  async createSession(
    chatId: number,
    providerName: string,
    model: string,
    agentName?: string,
  ): Promise<{ entry: SessionEntry; session: CopilotSession }> {
    // End existing session if any
    await this.endSession(chatId);

    const provider = this.config.providers[providerName];
    if (!provider) {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    const auth = resolveProviderAuth(provider);
    const activeAgent = agentName ?? this.config.agents.default;
    const agent = this.agents.get(activeAgent);

    // Build provider config for SDK
    const providerConfig = {
      type: provider.type as 'openai' | 'azure' | 'anthropic',
      baseUrl: provider.base_url,
      apiKey: auth.apiKey,
      bearerToken: auth.bearerToken,
      wireApi: provider.wire_api as 'completions' | 'responses' | undefined,
    };

    // Use agent's model if specified, otherwise use the provided model
    const effectiveModel = agent?.model ?? model;

    const sessionId = `tg-${chatId}-${Date.now()}`;

    log.info(
      { chatId, provider: providerName, model: effectiveModel, agent: activeAgent, sessionId },
      'Creating new session',
    );

    const session = await this.client.createSession({
      sessionId,
      model: effectiveModel,
      provider: providerConfig,
      streaming: true,
      systemMessage: agent ? getAgentSystemMessage(agent) : undefined,
      onEvent: (event) => this.dispatchEvent(chatId, event),
      onPermissionRequest: (
        request: PermissionRequest,
        _invocation: { sessionId: string },
      ): Promise<PermissionRequestResult> => {
        const toolName = 'toolName' in request ? request.toolName : request.kind;
        const description =
          'fullCommandText' in request
            ? request.fullCommandText
            : 'fileName' in request
              ? request.fileName
              : '';

        return this.handlePermissionRequest(
          chatId,
          toolName,
          description,
          request.toolCallId ?? `${chatId}-${Date.now()}`,
        );
      },
    });

    const entry: SessionEntry = {
      chatId,
      sessionId,
      provider: providerName,
      model: effectiveModel,
      agentName: activeAgent,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      messageCount: 0,
      autoApprovedTools: new Set(),
    };

    this.sessions.set(chatId, entry);
    this.sdkSessions.set(chatId, session);

    return { entry, session };
  }

  /**
   * Handle a permission request from the SDK.
   */
  private async handlePermissionRequest(
    chatId: number,
    toolName: string,
    description: string,
    toolCallId: string,
  ): Promise<PermissionRequestResult> {
    const entry = this.sessions.get(chatId);
    if (!entry) {
      return { kind: 'denied-no-approval-rule-and-could-not-request-from-user' };
    }

    // Check auto-approve
    if (shouldAutoApprove(this.config, entry, toolName, toolName)) {
      log.debug({ chatId, toolName }, 'Auto-approved tool');
      return toSdkPermissionResult({ kind: 'allow-once' });
    }

    // deny-all mode
    if (this.config.permissions.mode === 'deny-all') {
      // The "rule" lives in app config, not the SDK's per-tool rule registry,
      // so we return an empty rule list and let the SDK surface the denial.
      return { kind: 'denied-by-rules', rules: [] };
    }

    // Ask user via Telegram
    const decision = await this.permissionPromptCallback(chatId, toolName, description, toolCallId);

    // Translate our internal decision (allow-once / allow-session / deny) to
    // the SDK's wire protocol. Returning the wrong `kind` here causes the
    // SDK to silently drop the decision and the tool call hangs.
    return toSdkPermissionResult(decision);
  }

  /**
   * Enqueue a message for a chat (serializes per-chat).
   *
   * If `sink` is provided, it becomes the active sink for the duration
   * of this call: the session's `onEvent` hook will route streaming
   * events to it. When the call resolves or rejects, the sink is
   * replaced with `noopStreamSink` so subsequent activity in the queue
   * doesn't accidentally stream to a sink the caller has already
   * detached.
   */
  async enqueueMessage(
    chatId: number,
    prompt: string,
    sink: StreamSink = noopStreamSink,
  ): Promise<{ content: string; sessionId: string } | undefined> {
    const prev: Promise<void> = this.queues.get(chatId) ?? Promise.resolve();

    const task = prev.then(
      async (): Promise<{ content: string; sessionId: string } | undefined> => {
        this.setActiveSink(chatId, sink);
        try {
          const { entry, session } = await this.getOrCreateSession(chatId);
          entry.messageCount++;
          entry.lastActivityAt = Date.now();

          // Check soft cap
          if (entry.messageCount >= this.config.session.max_messages) {
            log.info({ chatId, count: entry.messageCount }, 'Session hit max messages');
          }

          const response = await session.sendAndWait(
            {
              prompt,
            },
            this.sendAndWaitTimeoutMs(),
          );
          return response
            ? { content: response.data?.content ?? '', sessionId: entry.sessionId }
            : undefined;
        } finally {
          // Detach the sink so it doesn't receive events from later
          // (queued) work in the same session.
          this.setActiveSink(chatId, noopStreamSink);
        }
      },
    );

    // Keep the queue going but don't let errors propagate to next message
    this.queues.set(
      chatId,
      task.then(
        () => {},
        () => {},
      ),
    );

    return task;
  }

  /**
   * Switch provider for a chat. Carries forward history.
   */
  async switchProvider(chatId: number, providerName: string): Promise<string> {
    const entry = this.sessions.get(chatId);
    const oldModel = entry?.model ?? this.config.active.model;
    const oldProvider = entry?.provider ?? this.config.active.provider;

    if (providerName === oldProvider) {
      return `Already using **${providerName}**.`;
    }

    const provider = this.config.providers[providerName];
    if (!provider) {
      return `Unknown provider: **${providerName}**. Available: ${Object.keys(this.config.providers).join(', ')}`;
    }

    await this.createSession(chatId, providerName, oldModel);
    return `Switched to **${providerName}** (was ${oldProvider}).`;
  }

  /**
   * Switch model for a chat.
   */
  async switchModel(chatId: number, model: string): Promise<string> {
    const entry = this.sessions.get(chatId);
    const provider = entry?.provider ?? this.config.active.provider;

    await this.createSession(chatId, provider, model);
    return `Switched to model **${model}**.`;
  }

  /**
   * Switch agent for a chat (always starts a fresh session).
   */
  async switchAgent(chatId: number, agentName: string): Promise<string> {
    if (!this.agents.has(agentName)) {
      return `Unknown agent: **${agentName}**. Available: ${[...this.agents.keys()].join(', ')}`;
    }

    const provider = this.sessions.get(chatId)?.provider ?? this.config.active.provider;
    const model = this.sessions.get(chatId)?.model ?? this.config.active.model;

    await this.createSession(chatId, provider, model, agentName);
    return `Switched to agent **${agentName}**.`;
  }

  /**
   * Start a new session (archive current one first).
   */
  async newSession(chatId: number): Promise<string> {
    await this.archiveAndEnd(chatId);
    const { entry } = await this.getOrCreateSession(chatId);
    return `New session started with **${entry.agentName}** (${entry.provider}/${entry.model}).`;
  }

  /**
   * Resume an archived session.
   */
  async resumeSession(chatId: number, index: number = 1): Promise<string> {
    const archives = this.listArchives(chatId);
    if (archives.length === 0) {
      return 'No archived sessions found.';
    }

    const idx = Math.min(index - 1, archives.length - 1);
    const archive = archives[idx];

    // Recreate session with archived settings
    await this.createSession(chatId, archive.provider, archive.model, archive.agentName);

    // Replay history as a synthetic prompt
    const history = archive.messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');

    const session = this.sdkSessions.get(chatId)!;

    await session.sendAndWait(
      {
        prompt: `Continuing from a previous session:\n\n${history}`,
      },
      this.sendAndWaitTimeoutMs(),
    );

    return `Resumed session from ${new Date(archive.archivedAt).toLocaleString()}.`;
  }

  /**
   * Get status for a chat.
   */
  getStatus(chatId: number): string {
    const entry = this.sessions.get(chatId);
    if (!entry) return 'No active session. Send a message to start one.';

    const uptime = Math.floor((Date.now() - entry.createdAt) / 60000);
    return [
      `**Session Status**`,
      `Provider: ${entry.provider}`,
      `Model: ${entry.model}`,
      `Agent: ${entry.agentName}`,
      `Messages: ${entry.messageCount}`,
      `Uptime: ${uptime}m`,
    ].join('\n');
  }

  /**
   * Archive and end a session.
   */
  private async archiveAndEnd(chatId: number): Promise<void> {
    const entry = this.sessions.get(chatId);
    const session = this.sdkSessions.get(chatId);

    if (entry && session) {
      try {
        const events = await session.getEvents();
        const archive: ArchivedSession = {
          chatId,
          provider: entry.provider,
          model: entry.model,
          agentName: entry.agentName,
          createdAt: entry.createdAt,
          archivedAt: Date.now(),
          messages: events.flatMap((e) => {
            switch (e.type) {
              case 'assistant.message':
                return [{ role: 'assistant', content: e.data.content, timestamp: Date.now() }];
              case 'user.message':
                return [{ role: 'user', content: e.data.content, timestamp: Date.now() }];
              default:
                return [];
            }
          }),
        };

        this.saveArchive(archive);
      } catch (err) {
        log.warn({ chatId, err }, 'Failed to get messages for archiving');
      }
    }

    await this.endSession(chatId);
  }

  /**
   * End a session without archiving.
   */
  private async endSession(chatId: number): Promise<void> {
    const session = this.sdkSessions.get(chatId);
    if (session) {
      try {
        await session.disconnect();
      } catch (err) {
        log.warn({ chatId, err }, 'Error disconnecting session');
      }
      this.sdkSessions.delete(chatId);
    }
    this.sessions.delete(chatId);
  }

  /**
   * Save an archived session to disk.
   */
  private saveArchive(archive: ArchivedSession): void {
    const historyDir = resolve(this.configDir, this.config.session.history_dir);
    if (!existsSync(historyDir)) {
      mkdirSync(historyDir, { recursive: true });
    }

    const filename = `${archive.chatId}-${archive.archivedAt}.json`;
    const filepath = join(historyDir, filename);
    writeFileSync(filepath, JSON.stringify(archive, null, 2));
    log.info({ chatId: archive.chatId, filepath }, 'Session archived');
  }

  /**
   * List archived sessions for a chat.
   */
  private listArchives(chatId: number): ArchivedSession[] {
    const historyDir = resolve(this.configDir, this.config.session.history_dir);
    if (!existsSync(historyDir)) return [];

    const files = readdirSync(historyDir)
      .filter((f) => f.startsWith(`${chatId}-`) && f.endsWith('.json'))
      .sort()
      .reverse();

    return files.map((f) => {
      const raw = readFileSync(join(historyDir, f), 'utf-8');
      return JSON.parse(raw) as ArchivedSession;
    });
  }

  /**
   * Archive all active sessions (called on shutdown).
   */
  async archiveAll(): Promise<void> {
    const chatIds = [...this.sessions.keys()];
    log.info({ count: chatIds.length }, 'Archiving all sessions');

    for (const chatId of chatIds) {
      await this.archiveAndEnd(chatId);
    }
  }

  /**
   * Get the current entry for a chat (for permission prompts).
   */
  getEntry(chatId: number): SessionEntry | undefined {
    return this.sessions.get(chatId);
  }

  /**
   * Compute the timeout (in ms) to pass to `session.sendAndWait`.
   *
   * Note: this is **not** the user's permission window. That's a
   * separate concern — `permissions.timeout_seconds` controls how
   * long a permission prompt stays on screen before the user is
   * considered to have ignored it. The two used to be coupled (the
   * SDK timeout = permission window + 30s buffer), but that meant
   * the user waited in silence for 5+ minutes when the agent hung.
   *
   * The right value here is: "how long do we wait for the agent to
   * make progress before declaring it stuck?" Hard-capped at
   * `MAX_SEND_AND_WAIT_MS` (90s) so a hung model fails fast. If
   * `permissions.timeout_seconds` is configured shorter than 90s we
   * honor that as a floor.
   */
  private sendAndWaitTimeoutMs(): number {
    const permissionWindowMs = this.config.permissions.timeout_seconds * 1000;
    return Math.max(
      Math.min(permissionWindowMs, MAX_SEND_AND_WAIT_MS),
      MIN_SEND_AND_WAIT_MS,
    );
  }
}
