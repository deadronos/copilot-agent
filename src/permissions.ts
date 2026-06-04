import type {
  PermissionRequest,
  PermissionEvaluation,
  PermissionChoice,
  PermissionResponse,
  PermissionPrompt,
} from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('permissions');

// ── Tool-kind classification heuristics ─────────────────────────────

const READ_TOOLS = new Set([
  'read',
  'get',
  'list',
  'search',
  'find',
  'view',
  'show',
  'cat',
  'ls',
  'grep',
  'fetch',
  'head',
  'tail',
  'status',
  'whoami',
  'pwd',
  'glob',
  'which',
  'type',
  'print',
  'echo',
  'date',
]);

const WRITE_TOOLS = new Set([
  'write',
  'create',
  'edit',
  'delete',
  'remove',
  'update',
  'mkdir',
  'rm',
  'mv',
  'cp',
  'bash',
  'exec',
  'run',
  'npm',
  'pip',
  'git',
  'commit',
  'push',
  'docker',
  'kill',
  'chmod',
  'chown',
]);

// ── Public helpers ──────────────────────────────────────────────────

/** Classify a tool name as read or write based on keyword heuristics. */
export function classifyToolKind(toolName: string): 'read' | 'write' {
  const normalized = toolName.toLowerCase();
  const parts = normalized.split(/[_-]/);

  for (const part of parts) {
    if (READ_TOOLS.has(part)) return 'read';
    if (WRITE_TOOLS.has(part)) return 'write';
  }

  // Full-name fallback (e.g. "npm" won't split into parts)
  if (READ_TOOLS.has(normalized)) return 'read';
  if (WRITE_TOOLS.has(normalized)) return 'write';

  // Default: unknown tools are treated as write/destructive
  return 'write';
}

/** Returns true if the tool name is classified as read-kind. */
export function isReadTool(toolName: string): boolean {
  return classifyToolKind(toolName) === 'read';
}

/** Build a PermissionPrompt with the three standard choices. */
export function createPermissionPrompt(
  toolCallId: string,
  toolName: string,
  args: unknown | undefined,
  timeoutSeconds: number,
): PermissionPrompt {
  return {
    toolCallId,
    toolName,
    args,
    choices: [
      { kind: 'allow-once' },
      { kind: 'allow-session' },
      { kind: 'deny' },
    ],
    timeoutSeconds,
  };
}

/** Return a user-facing description of the tool permission request. */
export function formatPermissionText(
  toolName: string,
  args?: unknown,
): string {
  let text = `🔧 Tool \`${toolName}\` wants to run`;
  if (args !== undefined && args !== null) {
    const argsStr =
      typeof args === 'string' ? args : JSON.stringify(args);
    if (argsStr.length > 0 && argsStr !== '{}') {
      const truncated =
        argsStr.length > 200 ? `${argsStr.slice(0, 200)}…` : argsStr;
      text += `\nArgs: \`${truncated}\``;
    }
  }
  return text;
}

/**
 * Map internal PermissionChoice to the Copilot SDK's wire-protocol
 * PermissionDecision shape.
 */
export function toSdkPermissionResult(
  choice: PermissionChoice,
):
  | { kind: 'approve-once' }
  | { kind: 'approve-for-session' }
  | { kind: 'denied-interactively-by-user' } {
  switch (choice.kind) {
    case 'allow-once':
      return { kind: 'approve-once' };
    case 'allow-session':
      return { kind: 'approve-for-session' };
    case 'deny':
      return { kind: 'denied-interactively-by-user' };
  }
}

// ── Interfaces ──────────────────────────────────────────────────────

export interface PermissionGate {
  evaluate(req: PermissionRequest): PermissionEvaluation;
}

export interface PermissionSessionState {
  allowedTools: Set<string>;
  deniedTools: Set<string>;
}

/** Create a fresh session state. */
export function createPermissionSessionState(): PermissionSessionState {
  return {
    allowedTools: new Set<string>(),
    deniedTools: new Set<string>(),
  };
}

// ── Implementation ──────────────────────────────────────────────────

export class PermissionGateImpl implements PermissionGate {
  private readonly mode: 'approve-all' | 'readonly-default' | 'deny-all';
  private readonly timeoutSeconds: number;
  private readonly sessionState: PermissionSessionState;

  private readonly pendingResolvers = new Map<
    string,
    {
      resolve: (value: PermissionResponse) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    mode: 'approve-all' | 'readonly-default' | 'deny-all',
    timeoutSeconds: number,
    sessionState: PermissionSessionState,
  ) {
    this.mode = mode;
    this.timeoutSeconds = timeoutSeconds;
    this.sessionState = sessionState;
  }

  /**
   * Evaluate a permission request. Returns an auto-allow, auto-deny, or
   * needs-user-input evaluation depending on mode, session memory, and
   * tool-kind classification.
   */
  evaluate(req: PermissionRequest): PermissionEvaluation {
    const { toolCallId, toolName, args } = req;

    // 1. approve-all mode → everything is allowed
    if (this.mode === 'approve-all') {
      log.debug({ toolCallId, toolName }, 'auto-allow (approve-all mode)');
      return { kind: 'auto-allow' };
    }

    // 2. Already allowed for this session
    if (this.sessionState.allowedTools.has(toolName)) {
      log.debug({ toolCallId, toolName }, 'auto-allow (session memory)');
      return { kind: 'auto-allow' };
    }

    // 3. Already denied for this session
    if (this.sessionState.deniedTools.has(toolName)) {
      log.debug({ toolCallId, toolName }, 'auto-deny (session memory)');
      return {
        kind: 'auto-deny',
        reason: `Tool "${toolName}" was denied for this session`,
      };
    }

    // 4. deny-all mode → prompt for everything
    if (this.mode === 'deny-all') {
      return this.buildNeedsUserInput(toolCallId, toolName, args);
    }

    // 5. readonly-default mode → read tools auto-allowed, write tools prompt
    if (classifyToolKind(toolName) === 'read') {
      log.debug(
        { toolCallId, toolName },
        'auto-allow (read tool in readonly-default mode)',
      );
      return { kind: 'auto-allow' };
    }

    return this.buildNeedsUserInput(toolCallId, toolName, args);
  }

  /**
   * Resolve a pending permission prompt. Called by the channel adapter
   * when the user clicks a button or sends a text command.
   */
  resolve(toolCallId: string, choice: PermissionChoice): void {
    const entry = this.pendingResolvers.get(toolCallId);
    if (!entry) {
      log.warn(
        { toolCallId },
        'resolve called for unknown or already-resolved toolCallId',
      );
      return;
    }
    clearTimeout(entry.timer);
    this.pendingResolvers.delete(toolCallId);
    log.info({ toolCallId, choice: choice.kind }, 'permission resolved');
    entry.resolve({ toolCallId, choice });
  }

  // ── private ───────────────────────────────────────────────────────

  private buildNeedsUserInput(
    toolCallId: string,
    toolName: string,
    args: unknown | undefined,
  ): PermissionEvaluation {
    const prompt = createPermissionPrompt(
      toolCallId,
      toolName,
      args,
      this.timeoutSeconds,
    );

    let resolvePromise!: (value: PermissionResponse) => void;
    const promise = new Promise<PermissionResponse>((resolve) => {
      resolvePromise = resolve;
    });

    // Auto-deny on timeout
    const timer = setTimeout(() => {
      this.pendingResolvers.delete(toolCallId);
      log.info(
        { toolCallId, toolName },
        'permission timed out, auto-denying',
      );
      resolvePromise({
        toolCallId,
        choice: { kind: 'deny' },
      });
    }, this.timeoutSeconds * 1000);

    this.pendingResolvers.set(toolCallId, {
      resolve: resolvePromise,
      timer,
    });

    return {
      kind: 'needs-user-input',
      prompt,
      awaitResponse: () => promise,
    };
  }
}
