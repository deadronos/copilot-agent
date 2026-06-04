# 02 — Session store

> **Status:** Draft
> **Owns:** The user-keyed session map, archive format, resume semantics, TTL policy, crash recovery, the in-memory + on-disk split.
> **Pins:** ADR 004 (per-chat session serialization).

## Purpose

The session store is the gateway's source of truth for "what conversation is this user having right now, and where did we last leave off." It bridges two realities: the in-memory `Map` that the Copilot SDK's live session objects live in, and the on-disk archive that survives process restarts. It also owns the per-user message queue that prevents two messages from racing each other in the same session.

## Interface

```typescript
export interface SessionStore {
  /** Get the active session for a user, or `null` if there is none. */
  getActive(userId: string): Promise<SessionHandle | null>;

  /** Create a new session for the user, archiving the previous one if any. */
  create(userId: string, opts: CreateSessionOpts): Promise<SessionHandle>;

  /** Archive the user's current session without creating a new one (used by `/new`). */
  archive(userId: string, reason: ArchiveReason): Promise<ArchivedSession>;

  /** List the user's archived sessions, newest first. */
  listArchived(userId: string, limit?: number): Promise<ArchivedSession[]>;

  /** Resume the n-th most recent archived session for the user. Returns the
   *  rehydrated handle. Throws if no such session exists. */
  resume(userId: string, n: number): Promise<SessionHandle>;

  /** Serialize the user's incoming messages. The handler runs at most once
   *  at a time, in arrival order. Returns a release function. */
  enqueue(userId: string, fn: () => Promise<void>): Promise<void>;

  /** Mark a session as idle (e.g. on `session.idle` from the SDK). Updates the
   *  last-activity timestamp used for TTL. */
  markIdle(userId: string, sessionId: string): Promise<void>;

  /** Sweep idle sessions that have exceeded the TTL. Returns the count evicted. */
  sweep(ttlMs: number): Promise<number>;
}

export interface CreateSessionOpts {
  readonly agent: string; // agent name
  readonly presetId: string; // active preset id (see 08-providers.md); resolves to a provider via the registry
  readonly model: string;
  readonly systemPromptOverride?: string;
}

export type ArchiveReason =
  | { kind: 'user-new-session' } // /new
  | { kind: 'agent-switch' } // /agent
  | { kind: 'ttl-eviction' } // soft-TTL exceeded
  | { kind: 'shutdown' }; // process shutdown

export interface SessionHandle {
  readonly sessionId: string;
  readonly userId: string;
  readonly agent: string;
  readonly presetId: string; // active preset id; provider is resolved via the registry (see 08-providers.md)
  readonly model: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  /** Live session (the LLM backend's `LlmSession` wrapper); `null` if the
   *  session is archived and not yet resumed. */
  readonly live: LlmSession | null;
}

export interface ArchivedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly agent: string;
  readonly presetId: string;
  readonly model: string;
  readonly createdAt: number;
  readonly archivedAt: number;
  readonly archiveReason: ArchiveReason['kind'];
  /** Path to the archive file on disk. */
  readonly path: string;
}
```

## Storage model

Two tiers:

1. **In-memory `Map<userId, SessionHandle>`.** The live SDK session lives here. Updated on every `session.idle` event for the TTL sweep and on every archive. Lost on process crash; rehydrated from disk on startup.

2. **On-disk archive.** JSON files under `<configDir>/sessions/<userId>/<sessionId>.json`. Written when a session is archived (any reason). Read on `resume(n)` to reconstruct the session handle and re-create the live SDK session. The current on-disk format (per ADR 004) is sufficient; v2 may switch to SQLite (see open question Q1).

## TTL policy (recommended: soft-TTL with cold archive)

- **Active sessions** stay in memory as long as the user is actively messaging.
- **Idle threshold:** after `session.max_idle_seconds` (default 30 min) of no `session.idle` event, the session is considered idle.
- **Soft eviction:** the next periodic `sweep()` call archives the idle session and removes it from the in-memory map. The user can resume via `/resume [n]`.
- **Cold archive:** archive files are never auto-deleted. A future cleanup command (not in v1) can prune old archives by age.
- **Force-active on resume:** `/resume [n]` rehydrates the archived session, creates a new live SDK session, and resets the idle clock.

This is the recommended default; see open question Q1 for alternatives.

## Lifecycle

**At process startup:**
1. The session store reads the in-memory map from a startup snapshot (if persisted; v1 may not persist this) and the on-disk archive index.
2. No live SDK sessions exist yet — the user's first message after startup creates one.
3. The `sweep()` timer is started (default: every 5 min).

**At first user message:**
1. The gateway calls `store.getActive(userId)`. If `null`, it calls `create(...)`.
2. `create(...)` spawns a new SDK session, inserts into the map, returns the handle.

**At `/new`:**
1. The gateway calls `store.archive(userId, { kind: 'user-new-session' })`.
2. The next message triggers `create(...)`.

**At `/agent <name>`:**
1. The gateway calls `store.archive(userId, { kind: 'agent-switch' })` (the new agent has a different system prompt; history doesn't carry over).
2. The next message triggers `create(...)` with the new agent.

**At `/model <id>` or `/provider <id>`:**
1. The gateway calls `session.switchModel(...)` or `session.switchProvider(...)` on the *live* session — no archive, no new session. History carries over because only the model changed.

**At `/resume [n]`:**
1. The gateway calls `store.listArchived(userId)`, picks the n-th entry, and calls `store.resume(userId, n)`.
2. `resume(...)` reads the archive file, creates a new live SDK session with the same agent/provider/model, and re-inserts into the in-memory map.

**At `session.idle`:**
1. The gateway calls `store.markIdle(userId, sessionId)`. Updates `lastActivityAt`.

**At process crash:**
1. In-memory map is lost. The next startup has no live sessions.
2. The user's first message after restart creates a fresh session (not resumed). Optionally the gateway can detect "user X has an active conversation that just died" and prompt: "Resume your last conversation? [Y/n]".

**At graceful shutdown:**
1. The gateway iterates the in-memory map and calls `store.archive(userId, { kind: 'shutdown' })` for each.
2. The SDK sessions are destroyed.

## Concurrency & ordering

- **`enqueue(userId, fn)`** is the per-user serialization point. All gateway-side message handling for a user funnels through this. Within a user, messages are processed in arrival order.
- **Cross-user parallelism:** different users run in parallel; the `enqueue` map is per-user.
- **`sweep()`** is global; it walks the in-memory map and evicts idle sessions. It runs on a timer, not on the message path, so it doesn't block users.
- **`create(...)` and `archive(...)` are atomic at the in-memory layer** (single-process in v1). On-disk writes use a `*.tmp` rename pattern so partial writes never leave a corrupt archive.

## Failure modes

| Failure | Boundary promise |
|---|---|
| Process crash | In-memory map is lost; on-disk archive is intact. First message after restart creates a fresh session. |
| Archive file corrupt | `resume(n)` for that index throws a typed error; the gateway surfaces a "could not resume, archive corrupt" message. Other archives are unaffected. |
| Disk full on archive write | `archive(...)` throws; the in-memory map still has the session; the gateway surfaces a "could not archive, session will be lost on next crash" warning to the user. |
| Two concurrent `enqueue` for the same user | The second call queues behind the first; never races. |
| TTL sweep evicts an actively-used session | Should never happen: `markIdle` is called on every `session.idle`, which always precedes the next user message. If it does happen, `getActive` returns `null` and the gateway creates a new session. |
| SDK session dies unexpectedly | The gateway detects `session.error` or process-exit events, calls `archive(..., { kind: 'shutdown' })` if possible, and surfaces an error to the user. |

## Cross-references

- **Pinned by:** ADR 004.
- **Depends on:** the LLM backend spec (`04-llm-backend.md`) for the `LlmSession` type.
- **Depended on by:** `06-message-lifecycle.md` (the lifecycle spec funnels every message through `enqueue`).
- **Implements the user's question:**
  - "Session expiry — TTL-based or forever?" → Recommended: **soft-TTL with cold archive** (see "TTL policy" above and open question Q1).

## Open questions

1. **TTL policy.** The default above (soft-TTL, cold archive, never auto-delete) is recommended. Alternatives:
   - **Forever (current behavior).** No sweep. In-memory map grows unboundedly. Recommended against.
   - **Hard cap with eviction.** Evict idle sessions AND delete archive files older than N days. Risky: the user loses history they might want to resume.
   - The user should confirm or override the recommended default.
2. **Storage backend.** v1 keeps the existing JSON-on-disk format. v2 may switch to SQLite (mentioned in the original Copilot CLI proposal) for better queryability and crash recovery. *Defer to v2 unless there's a specific reason to land it in v1.*
3. **Crash-recovery prompt.** Should the gateway detect "user X was mid-conversation when the process died" and offer to resume? Recommended **yes, with a single yes/no inline button** (or text `/resume y` for the channel). Defer to a follow-up spec if implementation is non-trivial.
