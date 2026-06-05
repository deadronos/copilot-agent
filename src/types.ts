// ── Channel identity ──────────────────────────────────────────────

export interface InboundMessage {
  readonly userId: string;
  readonly messageId: string;
  readonly channel: string;
  readonly text: string;
  readonly replyTo?: { messageId: string; text: string };
  readonly meta?: Record<string, unknown>;
}

export interface OutboundMessage {
  readonly userId: string;
  readonly channel: string;
  readonly text: string;
  readonly replyToMessageId?: string;
  readonly inlineButtons?: InlineButton[][];
}

export interface InlineButton {
  readonly text: string;
  readonly callbackData: string;
}

// ── Channel capabilities ──────────────────────────────────────────

export interface ChannelCapabilities {
  streaming: boolean;
  inlineButtons: boolean;
  messageEdit: boolean;
  messageHistory: boolean;
  unlimitedLength: boolean;
}

// ── Stream sink (channel-agnostic) ─────────────────────────────────

export interface StreamSink {
  append(delta: string): Promise<void>;
  replace(content: string): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

// ── Permission types ───────────────────────────────────────────────

export interface PermissionPrompt {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly choices: ReadonlyArray<PermissionChoice>;
  readonly timeoutSeconds: number;
}

export type PermissionChoice =
  | { kind: 'allow-once' }
  | { kind: 'allow-session' }
  | { kind: 'deny' };

export interface PermissionResponse {
  readonly toolCallId: string;
  readonly choice: PermissionChoice;
}

export interface PermissionRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly sessionAllowed: ReadonlySet<string>;
  readonly sessionDenied: ReadonlySet<string>;
}

export type PermissionEvaluation =
  | { kind: 'auto-allow' }
  | { kind: 'auto-deny'; reason: string }
  | {
      kind: 'needs-user-input';
      prompt: PermissionPrompt;
      awaitResponse: () => Promise<PermissionResponse>;
    };

// ── Agent definition (loaded from markdown files) ──────────────────

export interface AgentDefinition {
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly tools?: ReadonlyArray<string>;
  readonly systemPrompt: string;
  readonly sourcePath: string;
  readonly loadedAt: number;
}

// ── Session types ──────────────────────────────────────────────────

export interface SessionHandle {
  readonly sessionId: string;
  readonly userId: string;
  readonly agent: string;
  readonly presetId: string;
  readonly model: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly live: LlmSession | null;
}

export interface CreateSessionOpts {
  readonly userId: string;
  readonly agent: string;
  readonly presetId: string;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly sink?: StreamSink;
}

export type ArchiveReason =
  | { kind: 'user-new-session' }
  | { kind: 'agent-switch' }
  | { kind: 'ttl-eviction' }
  | { kind: 'shutdown' };

export interface ArchivedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly agent: string;
  readonly presetId: string;
  readonly model: string;
  readonly createdAt: number;
  readonly archivedAt: number;
  readonly archiveReason: ArchiveReason['kind'];
  readonly path: string;
}

// ── LLM types ──────────────────────────────────────────────────────

export interface LlmSession {
  readonly sessionId: string;
  readonly presetId: string;
  readonly model: string;
  send(opts: SendOpts): Promise<SendResult>;
  switchModel(model: string): Promise<void>;
  switchPreset(presetId: string): Promise<void>;
  resolvePermission(toolCallId: string, choice: PermissionChoice): void;
  onEvent(handler: (event: LlmEvent) => void): () => void;
  destroy(): Promise<void>;
}

export interface SendOpts {
  readonly prompt: string;
  readonly timeoutMs: number;
}

export type SendResult =
  | { kind: 'completed'; content: string }
  | { kind: 'no-content' }
  | { kind: 'permission-denied'; toolName: string }
  | { kind: 'error'; message: string };

export type LlmEvent =
  | { kind: 'delta'; messageId: string; delta: string }
  | { kind: 'message'; messageId: string; content: string }
  | { kind: 'tool-start'; toolCallId: string; toolName: string; args?: unknown }
  | { kind: 'tool-end'; toolCallId: string; result?: unknown }
  | { kind: 'permission-request'; request: PermissionRequestPayload }
  | { kind: 'idle' }
  | { kind: 'error'; message: string };

export interface PermissionRequestPayload {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
}

// ── Config types ───────────────────────────────────────────────────

export interface AppConfig {
  active: {
    preset: string;
    model: string;
  };
  agents: {
    dir: string;
    default: string;
  };
  telegram: {
    allowed_user_ids: number[];
    token_env: string;
  };
  session: {
    history_dir: string;
    max_messages: number;
    max_idle_seconds: number;
  };
  permissions: {
    mode: 'approve-all' | 'readonly-default' | 'deny-all';
    timeout_seconds: number;
  };
  channels: {
    enabled: string[];
  };
}

export interface Preset {
  readonly id: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly provider?: string;
  readonly [key: string]: unknown;
}

// ── Status ─────────────────────────────────────────────────────────

export interface StatusView {
  readonly uptimeSeconds: number;
  readonly llmBackend: { up: boolean; sessionsActive: number };
  readonly channels: ReadonlyArray<{
    readonly id: string;
    readonly up: boolean;
    readonly lastErrorAt: number | null;
    readonly restartCount: number;
  }>;
  readonly memory: { rssBytes: number; heapUsedBytes: number };
}

// ── Gateway message states ─────────────────────────────────────────

export type MessageState =
  | 'idle'
  | 'queued'
  | 'typing'
  | 'streaming'
  | 'permission-prompt'
  | 'tool-ran'
  | 'finalizing'
  | 'archived';
