import type { Logger } from 'pino';

import { CopilotClient } from '@github/copilot-sdk';
import type {
  CopilotSession,
  SessionConfig,
} from '@github/copilot-sdk';
import type {
  AssistantMessageDeltaEvent,
  AssistantMessageEvent,
  ErrorEvent,
  IdleEvent,
  PermissionRequestedEvent,
  ToolExecutionCompleteEvent,
  ToolExecutionStartEvent,
} from '@github/copilot-sdk';

import type {
  AgentRegistry,
} from './agents.js';
import type {
  CreateSessionOpts,
  LlmEvent,
  LlmSession,
  SendOpts,
  SendResult,
  StreamSink,
} from './types.js';
import {
  loadPreset,
} from './config.js';
import { createLogger } from './logger.js';
import type { ByokConfig, Provider, PresetConfig } from './providers/types.js';
import { presetToPresetConfig } from './providers/types.js';

// ── Logger ────────────────────────────────────────────────────────────

const log = createLogger('llm');

// ── Public interface ───────────────────────────────────────────────────

export interface LlmBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
  createSession(opts: CreateSessionOpts): Promise<LlmSession>;
  getSession(sessionId: string): LlmSession | undefined;
  listSessions(): ReadonlyArray<LlmSession>;
}

// ── Provider registry interface (subset used by LLM backend) ───────────

export interface ProviderRegistry {
  getProvider(id: string): Provider | undefined;
}

// ── Error mapping ──────────────────────────────────────────────────────

function mapError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    // HTTP status code in message
    if (msg.includes('401') || msg.includes('unauthorized')) {
      return '🔑 Your API key is invalid or expired';
    }
    if (msg.includes('429') || msg.includes('rate limit')) {
      return '⏳ Rate limited, try again in a moment';
    }
    // SDK timeout message pattern
    if (msg.includes('Timeout after') && msg.includes('waiting for session.idle')) {
      return '⏳ The model didn\'t respond in time';
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return '⏳ The model didn\'t respond in time';
    }
    return msg;
  }
  return String(err);
}

function mapSdkErrorToSendResult(err: unknown): SendResult {
  return { kind: 'error', message: mapError(err) };
}

// ── Internal session wrapper ───────────────────────────────────────────

class LlmSessionImpl implements LlmSession {
  readonly sessionId: string;
  presetId: string;
  model: string;

  private sdkSession: CopilotSession;
  private eventHandlers: Set<(event: LlmEvent) => void> = new Set();
  private sdkUnsubs: Array<() => void> = [];
  private destroyed = false;
  private configDir: string;
  private providerRegistry: ProviderRegistry;
  private agentRegistry: AgentRegistry;
  private _sink: StreamSink | undefined;

  constructor(
    sdkSession: CopilotSession,
    presetId: string,
    model: string,
    configDir: string,
    providerRegistry: ProviderRegistry,
    agentRegistry: AgentRegistry,
  ) {
    this.sessionId = sdkSession.sessionId;
    this.presetId = presetId;
    this.model = model;
    this.sdkSession = sdkSession;
    this.configDir = configDir;
    this.providerRegistry = providerRegistry;
    this.agentRegistry = agentRegistry;
  }

  // ── send ──────────────────────────────────────────────────────────

  async send(opts: SendOpts): Promise<SendResult> {
    if (this.destroyed) {
      return { kind: 'error', message: 'Session is destroyed' };
    }

    const sink: StreamSink | undefined = this._sink;
    let accumulatedContent = '';

    // Wire up event listeners for the duration of this send.
    const unsubs: Array<() => void> = [];

    // assistant.message_delta → append to sink
    const unsubDelta = this.sdkSession.on(
      'assistant.message_delta',
      (event: AssistantMessageDeltaEvent) => {
        const delta = event.data.deltaContent;
        accumulatedContent += delta;

        // Emit to subscribers
        for (const handler of this.eventHandlers) {
          try {
            handler({
              kind: 'delta',
              messageId: event.data.messageId,
              delta,
            });
          } catch {
            // subscriber errors must never break the pipeline
          }
        }

        // Append to stream sink
        if (sink) {
          void sink.append(delta);
        }
      },
    );
    unsubs.push(unsubDelta);

    // assistant.message → replace sink if non-empty
    const unsubMessage = this.sdkSession.on(
      'assistant.message',
      (event: AssistantMessageEvent) => {
        const content = event.data.content;
        if (content) {
          accumulatedContent = content;

          // Emit to subscribers
          for (const handler of this.eventHandlers) {
            try {
              handler({
                kind: 'message',
                messageId: event.data.messageId,
                content,
              });
            } catch {
              // subscriber errors must never break the pipeline
            }
          }

          // Replace sink content
          if (sink) {
            void sink.replace(content);
          }
        }
      },
    );
    unsubs.push(unsubMessage);

    // tool.execution_start → stream status + emit
    const unsubToolStart = this.sdkSession.on(
      'tool.execution_start',
      (event: ToolExecutionStartEvent) => {
        const toolName = event.data.toolName;
        const toolCallId = event.data.toolCallId;
        const args = event.data.arguments;

        // Emit to subscribers
        for (const handler of this.eventHandlers) {
          try {
            handler({
              kind: 'tool-start',
              toolCallId,
              toolName,
              args,
            });
          } catch {
            // subscriber errors must never break the pipeline
          }
        }

        // Stream status
        if (sink) {
          void sink.append(`🔧 running \`${toolName}\` …\n`);
        }
      },
    );
    unsubs.push(unsubToolStart);

    // tool.execution_complete → stream status + emit
    const unsubToolEnd = this.sdkSession.on(
      'tool.execution_complete',
      (event: ToolExecutionCompleteEvent) => {
        const toolCallId = event.data.toolCallId;
        const result = event.data.result as unknown;

        // Emit to subscribers
        for (const handler of this.eventHandlers) {
          try {
            handler({
              kind: 'tool-end',
              toolCallId,
              result,
            });
          } catch {
            // subscriber errors must never break the pipeline
          }
        }

        // Stream status
        if (sink) {
          void sink.append('Done.\n');
        }
      },
    );
    unsubs.push(unsubToolEnd);

    // permission.requested → emit to subscribers
    const unsubPermission = this.sdkSession.on(
      'permission.requested',
      (event: PermissionRequestedEvent) => {
        // Skip if already resolved by a hook
        if (event.data.resolvedByHook) return;

        const pr = event.data.permissionRequest;
        // Extract fields from the discriminated union.  The SDK types
        // don't expose a single common base with toolCallId/toolName,
        // so we cast through unknown first to satisfy strict checks.
        const raw = pr as unknown as Record<string, unknown>;
        const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined;
        const toolName =
          typeof raw.toolName === 'string'
            ? raw.toolName
            : typeof raw.kind === 'string'
              ? raw.kind
              : 'unknown';

        // Emit to subscribers
        for (const handler of this.eventHandlers) {
          try {
            handler({
              kind: 'permission-request',
              request: {
                toolCallId: toolCallId ?? '',
                toolName,
                args: raw.args,
              },
            });
          } catch {
            // subscriber errors must never break the pipeline
          }
        }
      },
    );
    unsubs.push(unsubPermission);

    // session.idle → handled by sendAndWait resolving, but also emit
    const unsubIdle = this.sdkSession.on(
      'session.idle',
      (_event: IdleEvent) => {
        for (const handler of this.eventHandlers) {
          try {
            handler({ kind: 'idle' });
          } catch {
            // subscriber errors must never break the pipeline
          }
        }
      },
    );
    unsubs.push(unsubIdle);

    // session.error → handle error events from SDK
    const unsubError = this.sdkSession.on(
      'session.error',
      (event: ErrorEvent) => {
        const errorMsg = event.data.message;
        for (const handler of this.eventHandlers) {
          try {
            handler({ kind: 'error', message: errorMsg });
          } catch {
            // subscriber errors must never break the pipeline
          }
        }
      },
    );
    unsubs.push(unsubError);

    // Send and wait for completion
    let result: SendResult;
    try {
      const response = await this.sdkSession.sendAndWait(
        opts.prompt,
        opts.timeoutMs,
      );

      if (response?.data?.content) {
        result = { kind: 'completed', content: response.data.content };
      } else if (accumulatedContent) {
        result = { kind: 'completed', content: accumulatedContent };
      } else {
        result = { kind: 'no-content' };
      }
    } catch (err) {
      log.warn({ err, sessionId: this.sessionId }, 'sendAndWait failed');
      result = mapSdkErrorToSendResult(err);
    } finally {
      // Always clean up event listeners
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // unsubscribe failures are non-fatal
        }
      }
    }

    // Finalise sink if provided
    if (sink) {
      try {
        await sink.finish();
      } catch {
        // sink errors must not break the promise
      }
    }

    return result;
  }

  // ── switchModel ───────────────────────────────────────────────────

  async switchModel(model: string): Promise<void> {
    if (this.destroyed) {
      throw new Error('Session is destroyed');
    }
    log.info({ sessionId: this.sessionId, model }, 'switching model');
    await this.sdkSession.setModel(model);
    this.model = model;
  }

  // ── switchPreset ──────────────────────────────────────────────────

  async switchPreset(presetId: string): Promise<void> {
    if (this.destroyed) {
      throw new Error('Session is destroyed');
    }

    log.info({ sessionId: this.sessionId, presetId }, 'switching preset');

    // Load new preset
    const preset = await loadPreset(this.configDir, presetId);

    // Resolve provider
    const providerId = preset.provider;
    if (!providerId || typeof providerId !== 'string') {
      throw new Error(
        `Preset "${presetId}" does not declare a provider; cannot switch.`,
      );
    }

    const provider = this.providerRegistry.getProvider(providerId);
    if (!provider) {
      throw new Error(
        `Provider "${providerId}" (required by preset "${presetId}") is not registered.`,
      );
    }

    // Build BYOK config
    const presetConfig: PresetConfig = presetToPresetConfig(preset, providerId);
    const byok = await provider.buildByokConfig(presetConfig);

    // Rebuild SDK ProviderConfig from ByokConfig
    const sdkProviderConfig = buildSdkProviderConfig(byok);

    // Switch model on the live session (SDK current limitation: provider
    // can't be changed mid-flight, so we switch model and note the preset
    // change; a full re-create would be needed for provider changes).
    this.presetId = presetId;

    const newModel = presetConfig.defaultModel ?? this.model;
    if (newModel !== this.model) {
      await this.sdkSession.setModel(newModel);
      this.model = newModel;
    }

    // If the provider changed and the SDK supports updating provider
    // mid-session, we would call that here. For now we log a warning
    // because the SDK's setModel doesn't accept provider changes.
    log.warn(
      { sessionId: this.sessionId, presetId },
      'preset switch applied to model only; provider change requires a new session',
    );

    // Store the new provider reference for next session recreation
    void sdkProviderConfig; // reserved
  }

  // ── onEvent ───────────────────────────────────────────────────────

  onEvent(handler: (event: LlmEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  // ── destroy ───────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    log.info({ sessionId: this.sessionId }, 'destroying session');

    // Clean up all external event handlers
    this.eventHandlers.clear();

    // Unsubscribe all SDK event listeners
    for (const unsub of this.sdkUnsubs) {
      try {
        unsub();
      } catch {
        // non-fatal
      }
    }
    this.sdkUnsubs = [];

    // Disconnect the SDK session
    try {
      await this.sdkSession.disconnect();
    } catch (err) {
      log.warn({ err, sessionId: this.sessionId }, 'error disconnecting SDK session');
    }
  }

  // ── internal helpers ──────────────────────────────────────────────

  /** Set the stream sink for the next send() call. Cleared after use. */
  setSink(sink: StreamSink | undefined): void {
    this._sink = sink;
  }
}

// ── SDK ProviderConfig builder ─────────────────────────────────────────

/**
 * Maps our internal {@link ByokConfig} shape to the SDK's
 * {@link import('@github/copilot-sdk').ProviderConfig} shape.
 */
function buildSdkProviderConfig(byok: ByokConfig): {
  type?: 'openai' | 'azure' | 'anthropic';
  baseUrl: string;
  apiKey?: string;
  wireApi?: 'completions' | 'responses';
} {
  return {
    type: (byok.providerType as 'openai' | 'azure' | 'anthropic') ?? 'openai',
    baseUrl: byok.baseUrl ?? 'https://api.openai.com/v1',
    apiKey: byok.apiKey,
    wireApi: (byok.wireApi as 'completions' | 'responses') ?? 'completions',
  };
}

// ── Backend implementation ─────────────────────────────────────────────

export class LlmBackendImpl implements LlmBackend {
  private client: CopilotClient | null = null;
  private started = false;
  private configDir: string;
  private providerRegistry: ProviderRegistry;
  private agentRegistry: AgentRegistry;
  private sessions: Map<string, LlmSessionImpl> = new Map();
  private logger: Logger;

  constructor(
    configDir: string,
    providerRegistry: ProviderRegistry,
    agentRegistry: AgentRegistry,
    logger?: Logger,
  ) {
    this.configDir = configDir;
    this.providerRegistry = providerRegistry;
    this.agentRegistry = agentRegistry;
    this.logger = logger ?? log;
  }

  // ── start ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;

    this.logger.info('starting LLM backend');

    // Instantiate CopilotClient in "empty" mode so the SDK doesn't
    // inject its own default system prompt, tools, or extensions.
    this.client = new CopilotClient({ mode: 'empty' });

    // The client auto-starts on first session creation, but we call
    // start() explicitly to catch startup errors early.
    await this.client.start();

    this.started = true;
    this.logger.info('LLM backend started');
  }

  // ── stop ──────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    if (!this.started) return;

    this.logger.info('stopping LLM backend');

    // Destroy all live sessions first
    const destroyOps = [...this.sessions.values()].map((s) =>
      s.destroy().catch((err) =>
        this.logger.warn({ err, sessionId: s.sessionId }, 'error destroying session during stop'),
      ),
    );
    await Promise.all(destroyOps);
    this.sessions.clear();

    // Stop the SDK client
    if (this.client) {
      try {
        await this.client.stop();
      } catch (err) {
        this.logger.warn({ err }, 'error stopping CopilotClient');
      }
      this.client = null;
    }

    this.started = false;
    this.logger.info('LLM backend stopped');
  }

  // ── createSession ─────────────────────────────────────────────────

  async createSession(opts: CreateSessionOpts): Promise<LlmSession> {
    if (!this.started || !this.client) {
      throw new Error('LLM backend not started. Call start() first.');
    }

    const { userId, agent: agentName, presetId, model, systemPrompt, sink } = opts;

    this.logger.info(
      { userId, agent: agentName, presetId, model },
      'creating session',
    );

    // Resolve agent definition for system prompt
    const agentDef = this.agentRegistry.get(agentName);
    if (!agentDef) {
      throw new Error(`Agent "${agentName}" not found in registry.`);
    }

    // Load preset config
    const preset = await loadPreset(this.configDir, presetId);

    // Resolve provider from preset
    const providerId = preset.provider;
    if (!providerId || typeof providerId !== 'string') {
      throw new Error(
        `Preset "${presetId}" does not declare a "provider" field. Add "provider: <id>" to the preset YAML.`,
      );
    }

    const provider = this.providerRegistry.getProvider(providerId);
    if (!provider) {
      throw new Error(
        `Provider "${providerId}" (required by preset "${presetId}") is not registered. ` +
        'Ensure the provider plugin is loaded in providers/registry.ts.',
      );
    }

    // Build BYOK config from provider
    const presetConfig: PresetConfig = presetToPresetConfig(preset, providerId);
    const byok = await provider.buildByokConfig(presetConfig);
    const sdkProvider = buildSdkProviderConfig(byok);

    // Determine final model (opts override preset override agent)
    const effectiveModel =
      model ?? presetConfig.defaultModel ?? agentDef.model ?? 'gpt-5';

    // Determine system prompt (Preset.systemPrompt may carry a custom override)
    const effectiveSystemPrompt =
      systemPrompt ??
      (preset.systemPrompt as string | undefined) ??
      agentDef.systemPrompt;

    // Build SessionConfig for the SDK
    const sdkConfig: SessionConfig = {
      model: effectiveModel,
      streaming: true,
      provider: sdkProvider,
      // Use replace mode with the agent's system prompt so the SDK
      // doesn't inject its own coding-agent system prompt.
      systemMessage: effectiveSystemPrompt
        ? { mode: 'replace' as const, content: effectiveSystemPrompt }
        : undefined,
    };

    // Create the SDK session
    const sdkSession = await this.client.createSession(sdkConfig);

    this.logger.info(
      { sessionId: sdkSession.sessionId, model: effectiveModel, presetId },
      'SDK session created',
    );

    // Build and track the wrapper
    const session = new LlmSessionImpl(
      sdkSession,
      presetId,
      effectiveModel,
      this.configDir,
      this.providerRegistry,
      this.agentRegistry,
    );

    // Set the initial sink
    if (sink) {
      session.setSink(sink);
    }

    this.sessions.set(session.sessionId, session);

    return session;
  }

  // ── getSession ────────────────────────────────────────────────────

  getSession(sessionId: string): LlmSession | undefined {
    return this.sessions.get(sessionId);
  }

  // ── listSessions ──────────────────────────────────────────────────

  listSessions(): ReadonlyArray<LlmSession> {
    return [...this.sessions.values()];
  }
}
