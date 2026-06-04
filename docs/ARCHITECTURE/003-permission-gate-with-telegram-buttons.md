# ADR 003: Permission Gate with Telegram Inline Buttons

**Status:** Accepted  
**Date:** 2026-06-01  
**Deciders:** @deadronos

## Context

The Copilot SDK can invoke tools (Bash, Read, Write, Edit, WebFetch, etc.) that modify the user's filesystem or access the network. We need a permission system that:

- Gives the user control over every tool call
- Doesn't require the user to stay glued to the chat (timeout)
- Supports "allow for this session" to reduce prompt fatigue
- Has sensible defaults for different trust levels (read-only, deny-all)
- Works entirely through the Telegram interface (no side channel)

## Decision

**Implement a three-mode permission gate that pauses tool execution and shows inline Telegram buttons (Allow once / Allow for session / Deny).**

Architecture:
```
SDK calls onPermissionRequest()
  → SessionManager.handlePermissionRequest()
    → Check auto-approve rules (mode + session set)
    → If not auto-approved, call permissionPromptCallback()
      → TelegramBot.showPermissionPrompt()
        → Send inline keyboard message
        → Resolve promise when user clicks button or timeout fires
```

Three modes from `config.yaml → permissions.mode`:

| Mode | Behavior |
|---|---|
| `approve-all` (default) | Every tool call shows a permission prompt. Nothing is auto-approved. |
| `readonly-default` | Read-only tools auto-approve; everything else prompts. |
| `deny-all` | Hard refusal on every tool call. Returns `denied-by-rules` to the SDK. |

States involved:
- **Pending permissions**: `Map<requestId, { chatId, resolve, messageId, toolName }>` in `TelegramBot`
- **Session auto-approvals**: `Set<toolName>` on `SessionEntry` — populated when user clicks "Allow for session"
- **Timeout**: Configurable via `permissions.timeout_seconds` (default 300). On timeout, resolves with `denied-interactively-by-user`.

## Rationale

1. **Inline buttons are the most natural Telegram interaction.** The user sees the tool call and the choices simultaneously. No need for text commands (though `/approve` and `/deny` exist as fallback).
2. **Promise-based gate keeps the SDK's async flow.** The `onPermissionRequest` handler returns a `Promise<PermissionRequestResult>`. We hold that promise unresolved until the user clicks — the SDK simply awaits it. No polling, no state machine.
3. **"Allow for session" reduces fatigue without losing control.** Pure "allow once" would be too noisy for multi-step tool workflows. Pure "allow all" is dangerous. Session-scoped approvals are the right middle ground.
4. **Three modes map to trust levels.** `deny-all` for chat-only mode, `readonly-default` for cautious use, `approve-all` for full control.
5. **Text-based fallback (`/approve`, `/deny`) handles edge cases.** If inline buttons fail to render or the user's Telegram client doesn't support them, text commands still work.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| No permission gate (always allow) | Unsafe. The agent could run destructive commands without user knowledge. |
| Text-only permission prompts (no buttons) | Slower interaction. Buttons are one-tap; text commands require typing. |
| Per-tool config rules (e.g., "always allow Read, always deny Bash") | Over-engineering for v1. The three-mode system + session approvals covers the common cases. Can be added later. |
| Web dashboard for permission management | Adds a second interface to build and maintain. Telegram is the only interface. |
| Blocking the user's message input until permission is resolved | Bad UX. The user might want to send another message while a tool is pending. |

## Consequences

### Positive
- Every tool call is gated by user intent
- Inline buttons provide one-tap approval
- Session auto-approve eliminates repetitive prompts for trusted workflows
- Timeout ensures the conversation doesn't hang indefinitely
- Works entirely within Telegram (no external dashboard or CLI)

### Negative
- The user must be present to approve tool calls (by design — this is a feature)
- If the bot process crashes mid-prompt, the pending promise is lost and the agent gets a permission error
- Two simultaneous tool calls only show one prompt at a time (the second is queued)

### Mitigations
- Timeout default of 5 minutes prevents indefinite hangs
- Session auto-approve reduces chattiness for repeated tools
- `/approve` and `/deny` text commands work even if inline buttons fail
- The "allow for session" button adds the tool name to `autoApprovedTools`, so subsequent calls skip the prompt
