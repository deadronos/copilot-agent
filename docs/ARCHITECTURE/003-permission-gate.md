# ADR 003 — Permission gate with three modes, deny-on-timeout, and per-channel UI

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** copilot-agent project

## Context

The Copilot SDK emits `permission.requested` events when a tool call needs user approval. The bot must decide whether to auto-allow, auto-deny, or prompt the user — and if prompting, it must render a channel-appropriate UI (inline buttons on Telegram, text prompts on TUI) and handle timeouts safely.

## Decision

### Three permission modes

Defined in `src/permissions.ts` (`PermissionGateImpl`), matching `config.permissions.mode`:

| Mode | Behavior |
|---|---|
| `approve-all` | Every tool call is auto-allowed. No prompts. |
| `readonly-default` | Read-kind tools (classified by `classifyToolKind()` heuristics) are auto-allowed. Write/destructive tools prompt the user. |
| `deny-all` | Every tool call prompts the user — no auto-allows. |

### Per-session memory

Once a user clicks "allow for session" for a given tool name, subsequent calls to that tool in the same session are auto-allowed until the session is archived. Tracked in `PermissionSessionState.allowedTools`. Symmetrically, tools denied for session are tracked in `deniedTools` and auto-denied on subsequent calls.

### Deny-on-timeout (never auto-approve on timeout)

A hung or ignored permission prompt is resolved with `{ kind: 'deny' }` after `permissions.timeout_seconds` (default 60s). The timeout is enforced by `setTimeout` in `buildNeedsUserInput()`. The decision principle: a hung prompt that auto-deny'd is safe (the tool doesn't run); a hung prompt that auto-approved could be destructive.

### Channel-owned permission UI

The gateway never specifies the UI shape. The channel adapter picks the right rendering based on `capabilities.inlineButtons`:

| Channel | UI |
|---|---|
| Telegram | Inline keyboard with `[Allow once] [Allow for session] [Deny]` buttons (`src/channels/telegram/format.ts`) |
| TUI (planned) | Readline prompt: `Tool {name} wants to run. [y/n/always]?` |
| Fallback (no buttons) | Text message with `/approve` and `/deny` instructions |

The gateway calls `adapter.promptPermission(prompt)` and awaits the response. The adapter handles timeout surface (e.g., Telegram's 30s callback TTL) and resolves with `deny` if the prompt expires.

### SDK boundary mapping

The Copilot SDK's wire-protocol `PermissionDecision` uses `approve-once`, `approve-for-session`, and `denied-interactively-by-user`. The bot's internal `PermissionChoice` uses `allow-once`, `allow-session`, and `deny`. `toSdkPermissionResult()` in `src/permissions.ts` translates between them — it is the only place that knows both shapes.

## Consequences

- **Positive:** The deny-on-timeout default is safe — a hung permission prompt never results in an unwanted tool execution.
- **Positive:** Per-session memory reduces prompt fatigue for repetitive tools.
- **Positive:** Channel-owned UI means adding a new channel doesn't require touching the permission gate.
- **Negative:** The `classifyToolKind()` heuristic in `src/permissions.ts` uses hardcoded tool-name keyword sets. If the SDK adds a tool whose name doesn't match the heuristics, it defaults to "write" (conservative, but may over-prompt).
- **Negative:** The permission gate's `resolve()` method is not on the `PermissionGate` interface — it's an implementation detail of `PermissionGateImpl`. If the gateway needs to resolve permissions from a different source (e.g., WebUI), it must cast to the implementation type.

## References

- `src/permissions.ts` — `PermissionGateImpl`, `classifyToolKind`, `toSdkPermissionResult`, `createPermissionPrompt`
- `src/channels/telegram/format.ts` — `formatPermissionKeyboard`
- `src/gateway.ts` — `handlePermissionRequest`, `handlePermissionResponse`
- `docs/specs/05-tool-runtime-and-permission-gate.md`
