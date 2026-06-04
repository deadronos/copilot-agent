# ADR 004 — Per-user session serialization, archival, and resume

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** copilot-agent project

## Context

Each user needs a dedicated conversation session with the LLM. Sessions must survive process restarts, support resuming old conversations, and not grow unbounded in memory. The bot must also prevent two messages from the same user from racing each other in the same session.

## Decision

### One user = one active session

The session store (`src/sessions.ts`) maintains an in-memory `Map<userId, SessionHandle>`. Only one session is active per user at a time. When a new session is created, the previous one is archived.

### In-memory + on-disk split

Two tiers:

1. **In-memory `Map<userId, SessionHandle>`** — the live SDK session (`live: LlmSession`) lives here. Used for fast lookups on every message. Lost on process crash.

2. **On-disk JSON archive** — JSON files under `<configDir>/sessions/<userId>/<sessionId>.json`. Written when a session is archived (any reason: `/new`, agent switch, TTL eviction, shutdown). Read on `/resume [n]`. Written using atomic rename (`write to .tmp`, then `rename`) so partial writes never leave a corrupt archive.

### Soft-TTL with cold archive

- **Active sessions** stay in memory as long as the user is messaging.
- **Idle threshold:** after `session.max_idle_seconds` (default 30 minutes) of no `markIdle()` call, the session is considered idle.
- **Soft eviction:** the gateway's periodic `sweep()` call (every 5 minutes, `src/gateway.ts`) archives idle sessions and removes them from the in-memory map.
- **Cold archive:** archive files are never auto-deleted. The user can resume archived sessions with `/resume [n]`.
- **Force-active on resume:** `/resume [n]` rehydrates the archived session, creates a new live SDK session, and resets the idle clock.

### Per-user serialization queue

`sessionStore.enqueue(userId, fn)` ensures that messages from the same user are processed one at a time in arrival order. The implementation chains promises so the second message waits for the first to finish, avoiding race conditions in the SDK session.

### Slash command semantics

| Command | Effect on session | Why |
|---|---|---|
| `/new` | Archive current, create new on next message | Clean slate |
| `/agent <name>` | Archive current, create new with named agent | System prompt and tool set change; history doesn't carry over |
| `/model <id>` | Switch model on live session | Only the model changes |
| `/provider <id>` | Switch preset on live session | Only the underlying provider config changes |
| `/resume [n]` | Rehydrate nth archived session | Return to a previous conversation |

## Consequences

- **Positive:** Process crashes only lose the in-memory map; on-disk archives are intact. The user's first message after restart creates a fresh session (or they can `/resume`).
- **Positive:** The atomic write pattern prevents corrupt archives.
- **Positive:** Soft-TTL prevents unbounded memory growth without deleting history the user might want.
- **Negative:** Archives are JSON files on disk — not queryable. v2 may switch to SQLite if the need arises.
- **Negative:** The per-user queue means a long-running agent response blocks the user's next message. v2 could add interrupt/cancel support.

## References

- `src/sessions.ts` — `SessionStoreImpl`
- `src/gateway.ts` — slash command handlers, `sweepSessions`
- `src/index.ts` — `createSessionStoreWithLiveBacking`
- `docs/specs/02-session-store.md`
