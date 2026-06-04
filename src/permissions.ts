import type {
  AppConfig,
  PendingPermission,
  PermissionDecision,
} from './types.js';
import { getChildLogger } from './logger.js';
import type { PermissionRequestResult } from '@github/copilot-sdk';
import type { SessionEntry } from './types.js';

const log = getChildLogger('permissions');

/**
 * Map our internal PermissionDecision (the three button outcomes plus
 * timeout) to the wire format the Copilot SDK expects. The SDK's
 * discriminated union is defined in
 * `node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts` under
 * `PermissionDecision` — note that `'approved'` is **not** a valid
 * protocol value. The protocol uses `'approve-once'`, `'approve-for-session'`,
 * `'denied-interactively-by-user'`, etc. Returning an unknown kind to
 * the JSON-RPC handler causes the SDK to silently drop the decision and
 * the pending tool call hangs until the permission timeout fires.
 */
export function toSdkPermissionResult(decision: PermissionDecision): PermissionRequestResult {
  switch (decision.kind) {
    case 'allow-once':
      return { kind: 'approve-once' };
    case 'allow-session':
      return { kind: 'approve-for-session' };
    case 'deny':
      return { kind: 'denied-interactively-by-user' };
  }
}

// Read-only tool kinds that auto-approve in readonly-default mode
const READONLY_KINDS = new Set(['read']);

/**
 * Check if a tool should be auto-approved based on permission mode and session state.
 */
export function shouldAutoApprove(
  config: AppConfig,
  session: SessionEntry,
  toolName: string,
  toolKind: string,
): boolean {
  const mode = config.permissions.mode;

  // deny-all: never auto-approve
  if (mode === 'deny-all') return false;

  // Check session-level "allow for session" approvals
  if (session.autoApprovedTools.has(toolName)) return true;

  // readonly-default: auto-approve read-only tools
  if (mode === 'readonly-default' && READONLY_KINDS.has(toolKind)) return true;

  return false;
}

/**
 * Create a permission decision promise that waits for user input via Telegram.
 */
export function createPermissionRequest(
  requestId: string,
  chatId: number,
  toolName: string,
  description: string,
  timeoutSeconds: number,
): {
  promise: Promise<PermissionDecision>;
  pending: PendingPermission;
} {
  let resolve!: (decision: PermissionDecision) => void;

  const promise = new Promise<PermissionDecision>((res) => {
    resolve = res;
  });

  const timeout = setTimeout(() => {
    log.warn({ requestId, chatId, toolName }, 'Permission request timed out');
    resolve({ kind: 'deny' });
  }, timeoutSeconds * 1000);

  const pending: PendingPermission = {
    requestId,
    chatId,
    messageId: 0, // Will be set after sending the Telegram message
    toolName,
    description,
    resolve,
    timeout,
  };

  return { promise, pending };
}

/**
 * Format a permission request as a user-friendly Telegram message.
 */
export function formatPermissionMessage(toolName: string, description: string): string {
  const toolDisplay = toolName.charAt(0).toUpperCase() + toolName.slice(1);
  let msg = `⚠️ Agent wants to run **${toolDisplay}**`;

  if (description) {
    // Truncate long descriptions
    const maxLen = 500;
    const truncated =
      description.length > maxLen ? description.slice(0, maxLen) + '…' : description;
    msg += `\n\n\`\`\`\n${truncated}\n\`\`\``;
  }

  return msg;
}
