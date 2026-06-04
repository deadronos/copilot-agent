# 05 — Tool runtime & permission gate

> **Status:** Draft
> **Owns:** The boundary between the opaque SDK tool loop and the channel-owned permission UI. Defines the `PermissionRequest` callback contract, the three permission modes, the timeout math, and the IPC round-trip between gateway and adapter subprocess.
> **Pins:** ADR 003 (permission gate with Telegram buttons), ADR 007 (type-safe SDK boundaries).

## Purpose

The Copilot SDK owns the agent's tool loop. The bot never sees individual tool calls — it only sees the SDK's `PermissionRequest` event when a tool needs approval, and the `tool.execution_start` / `tool.execution_complete` events for streaming UI feedback.

This spec defines the contract between the SDK and the gateway, and between the gateway and the channel adapter that ultimately renders the permission prompt to the user. It's a thin layer; most of the work happens in the SDK and in the adapter.

## Interface

```typescript
export interface PermissionGate {
  /** Evaluate a permission request against the configured mode. Returns the
   *  decision and, if needed, a callback the gateway can use to await a
   *  user-driven response. */
  evaluate(req: PermissionRequest): PermissionEvaluation;
}

export type PermissionEvaluation =
  | { kind: 'auto-allow' } // resolved silently
  | { kind: 'auto-deny'; reason: string } // resolved silently
  | {
      kind: 'needs-user-input';
      prompt: PermissionPrompt;
      /** Resolves with the user's choice, or with `{ kind: 'deny' }` on timeout. */
      awaitResponse: () => Promise<PermissionResponse>;
    };

export interface PermissionRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  /** Tools previously approved in this session (for the per-session memory). */
  readonly sessionAllowed: ReadonlySet<string>;
  /** Tools previously denied in this session. */
  readonly sessionDenied: ReadonlySet<string>;
}
```

The three modes (unchanged from ADR 003):

| Mode | Behavior |
|---|---|
| `approve-all` | All tool calls auto-allowed. No prompt. |
| `readonly-default` | Read-kind tools auto-allowed. Write/destructive tools prompt the user. |
| `deny-all` | All tool calls prompt the user (every single one). |

A **per-session memory** tracks tools the user has previously accepted or denied. Once a user clicks "allow for session" for a given tool name, subsequent calls to that tool in the same session are auto-allowed until the session is archived.

## The `PermissionRequest` lifecycle

```
   SDK tool loop
       │
       │  PermissionRequest
       ▼
   ┌─────────────────┐
   │ PermissionGate  │  ← evaluate(req)
   │  (in gateway)   │
   └────────┬────────┘
            │
   ┌────────┴────────────────┐
   │ auto-allow              │  → tell SDK "approved" → tool runs
   │ auto-deny               │  → tell SDK "denied" → agent sees denial
   │ needs-user-input        │
   │     │                   │
   │     ▼                   │
   │  IPC to adapter         │
   │     │                   │
   │     ▼                   │
   │  adapter.promptPermission(prompt)
   │     │                   │
   │     │  (user clicks     │
   │     │   a button or     │
   │     │   replies with    │
   │     │   /approve/deny)  │
   │     ▼                   │
   │  PermissionResponse     │
   │     │                   │
   │     ▼                   │
   │  translate to SDK       │
   │  { kind: 'approved' }    │
   │  or { kind: 'denied' }  │
   └─────────────────────────┘
```

## SDK ↔ gateway translation

The Copilot SDK uses a wire-protocol `PermissionDecision` shape: `approve-once` / `approve-for-session` / `denied-interactively-by-user`. The internal `PermissionChoice` shape (this spec) is `allow-once` / `allow-session` / `deny`. A `toSdkPermissionResult(choice: PermissionChoice): PermissionDecision` mapper lives in `src/permissions.ts` and is the only place that knows both shapes. *Per ADR 003 and the v0.1.1 changelog fix.*

## Channel permission UI contract

The channel adapter is responsible for rendering the prompt. The gateway just calls `adapter.promptPermission(prompt)` and awaits the response.

| Channel | UI shape |
|---|---|
| Telegram | Inline keyboard: `[Allow once] [Allow for session] [Deny]`. *Current behavior.* |
| TUI | Readline prompt: `Tool {name} wants to run. [y/n/always]?`. No buttons. |
| Discord | Inline buttons (when implemented). |
| WebUI chat | HTML buttons in the streamed message. |

The gateway never specifies the UI. The adapter picks based on its `capabilities.inlineButtons`.

## IPC round-trip

When the adapter is a subprocess, the `promptPermission` call crosses the process boundary:

```
gateway process                       adapter subprocess
─────────────────                     ────────────────────
adapter.promptPermission(prompt)
   │
   │  IPC: { method: 'promptPermission', params: prompt }
   ▼
                                     render UI (button, readline, etc.)
                                     │
                                     │  (user interacts)
                                     ▼
                                     IPC: { method: 'permissionResponse',
                                            params: response }
   │
   ▼
awaitResponse() resolves
```

**Timeouts.** The IPC layer must enforce a hard timeout on the round-trip equal to the prompt's `timeoutSeconds`. If the subprocess doesn't respond in time, the gateway resolves the prompt with `{ kind: 'deny' }` and tells the adapter to surface a "this prompt has expired" message to the user.

**Subprocess death mid-prompt.** If the adapter subprocess dies while a prompt is open, the gateway detects the death, resolves the prompt with `{ kind: 'deny' }`, and removes the prompt from its `pendingPermissions` map. The agent is told the tool was denied.

## Concurrency & ordering

- **One prompt per user.** The `pendingPermissions` map is keyed by `userId`. A new request for the same user cancels the previous one (the previous tool call receives a `deny`).
- **Cross-user parallelism.** Different users can have prompts open simultaneously. The map is per-user.
- **Auto-allow fast path.** Auto-allow and auto-deny decisions are returned synchronously by `evaluate(...)`; no IPC round-trip.

## Failure modes

| Failure | Boundary promise |
|---|---|
| Permission prompt times out | The prompt resolves with `{ kind: 'deny' }`; the user sees a "this prompt has expired" message; the agent is told the tool was denied. *Pins: ADR 003.* |
| Adapter subprocess dies mid-prompt | Prompt resolves with `{ kind: 'deny' }`; the user sees a "channel went offline" message; the agent is told the tool was denied. |
| User clicks "deny" | Tool execution is skipped; the agent sees a denial and continues (or surfaces an error if the tool was required). |
| User clicks "allow for session" for a tool | The tool name is added to `sessionAllowed` for the user's active session. Future calls in the same session auto-allow. |
| Bot restarts mid-prompt | The `pendingPermissions` map is lost. The new process sees the callback click, finds the (now-empty) map, and surfaces a "this prompt has expired" message. *Per the v0.1.1 changelog fix: persisted to disk and rehydrated on startup for in-progress prompts.* |
| User replies with `/approve` or `/deny` text | The slash-command handler in the gateway resolves the most recent prompt with the corresponding choice. *Pins: ADR 003.* |

## Cross-references

- **Pinned by:** ADR 003, ADR 007.
- **Depends on:** the LLM backend spec (`04-llm-backend.md`) for the `PermissionRequestPayload` event; the channel-adapter spec (`01-channel-adapter.md`) for the `promptPermission` method.
- **Depended on by:** the message lifecycle spec (`06-message-lifecycle.md`) for how permission prompts slot into the message state machine.

## Open questions

- **Auto-allow for "read" tools in `readonly-default` mode.** The current implementation uses the SDK's tool metadata to classify read vs. write. If a tool is misclassified, the user gets surprising behavior. v1 inherits the current heuristic; a future spec could formalize the classification. *YAGNI for v1.*
- **Per-tool policy.** Some users may want fine-grained rules ("always allow `web_search`, never allow `bash`") independent of the mode. v1 supports this via the per-session memory + the three modes. A v2 feature could add a `tools.policy` config block. *YAGNI for v1.*
