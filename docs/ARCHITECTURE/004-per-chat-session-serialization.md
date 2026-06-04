# ADR 004: Per-Chat Session Management with Serialized Message Queue

**Status:** Accepted  
**Date:** 2026-06-01  
**Deciders:** @deadronos

## Context

The Copilot SDK manages conversation state internally (message history, tool context, agent loop). We need to:

- Maintain one SDK session per Telegram chat ID
- Prevent re-entrant calls to the same SDK session (Telegram can deliver messages rapidly)
- Archive sessions on `/new`, shutdown, or configuration change
- Support `/resume` to replay history into a new session
- Enforce a soft cap on message count to prevent unbounded growth

## Decision

**Maintain one SDK `CopilotSession` per Telegram chat in memory, serialized by a per-chat promise queue. Archive sessions to disk as JSON on explicit request or shutdown.**

Data model:
```typescript
interface SessionEntry {
  chatId: number;
  sessionId: string;        // "tg-${chatId}-${timestamp}"
  provider: string;
  model: string;
  agentName: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  autoApprovedTools: Set<string>;
  pendingPermission?: PendingPermission;
}

interface ArchivedSession {
  chatId: number;
  provider: string;
  model: string;
  agentName: string;
  createdAt: number;
  archivedAt: number;
  messages: Array<{ role: string; content: string; timestamp: number }>;
}
```

Key behaviors:

1. **Lazy creation.** First message in a chat → `createSession()`. Subsequent messages reuse the cached session.
2. **Per-chat serialization.** A `Map<chatId, Promise<void>>` queue ensures messages for the same chat process sequentially. Different chats run in parallel.
3. **Switching provider/model.** Ends the current session and creates a new one with the new settings. History is _not_ carried forward — the user starts fresh (the SDK's cross-provider history support is unreliable).
4. **Switching agent.** Always starts a fresh session. Different agent = different system prompt and tool set.
5. **Archive on `/new`.** Writes session events to `sessions/${chatId}-${timestamp}.json`, then drops the in-memory session.
6. **Resume.** Lists archived sessions by timestamp, replays history as a synthetic "Continuing from a previous session:" prompt into a new SDK session.
7. **Shutdown archive.** `archiveAll()` iterates all active sessions, extracts events via `session.getEvents()`, and saves them.
8. **Soft cap.** When `messageCount >= session.max_messages` (default 200), the bot suggests `/new` but doesn't enforce it.

## Rationale

1. **One session per chat is the simplest model.** No multiplexing, no context switching, no session selection UI. Each chat is its own conversation.
2. **Promise queue prevents races.** Telegram can deliver two messages from the same chat in quick succession (e.g., user sends a message, then immediately sends a command). Without serialization, the SDK would be called re-entrantly. The per-chat promise chain (`queues.set(chatId, task.then(...))`) naturally serializes all messages for that chat — no locks, no semaphores, just async/await.
3. **In-memory sessions with disk archive.** Sessions are ephemeral (in memory). Archives are the safety net. This avoids the complexity of syncing in-memory state to disk on every message while still providing recovery via `/resume`.
4. **`getEvents()` over fake `getMessages()`.** The initial implementation called `(session as any).getMessages?.()` which silently returned `undefined` because `CopilotSession` has no `getMessages` method. The refactored code uses the real `session.getEvents()` API, filtering for `user.message` and `assistant.message` events. Archives now contain real message history.
5. **Synthetic resume prompt is pragmatic.** Rather than trying to reconstruct the SDK's internal state, we feed the archived messages as a single "Continuing from..." user prompt. The agent picks up context naturally from the replay.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| One global session for all chats | Cross-chat contamination. Users expect per-chat conversations. |
| Persistent sessions across restarts | SDK sessions are inherently ephemeral (they wrap a CLI process). Reconstructing internal state is fragile. Archival + replay is more robust. |
| Mutex/lock-based concurrency | Overkill for Node.js single-threaded runtime. A promise chain achieves the same result without dependencies. |
| Full chat-history database | Over-engineering for a personal assistant. JSON files in `sessions/` are sufficient for a single user. |
| Auto-resume on startup | Adds unexpected context. Opt-in via `/resume` is more predictable and respects user intent. |

## Consequences

### Positive
- Simple mental model: one chat = one session
- No concurrency bugs from re-entrant SDK calls
- Archives survive crashes (written on `/new` and shutdown)
- Session switching (provider, model, agent) is explicit and clean
- Soft cap prevents unbounded message growth without hard enforcement

### Negative
- Sessions are lost on crash (not between `/new` calls) — mitigation: archive on every config/agent change
- Resuming a long session replays all archived messages, which counts toward the new session's message cap
- The archive format (JSON) may grow large for very long sessions (mitigated by soft cap)

### Mitigations
- Archive on shutdown (`SIGINT`/`SIGTERM` handlers in `index.ts`)
- Archive on `/new`, provider switch, model switch, and agent switch
- Soft cap reminder at `max_messages` reduces archive size
- `getEvents()` extracts only `user.message` and `assistant.message` — not tool calls or internal events
