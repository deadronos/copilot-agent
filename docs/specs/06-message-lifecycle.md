# 06 — Message lifecycle

> **Status:** Draft
> **Owns:** The state machine that ties the gateway, session store, channel adapter, LLM backend, and permission gate together. Defines the states, transitions, channel-capability dispatch, and IPC round-trips for the path of a single user message.
> **Pins:** ADR 001, ADR 003, ADR 004.

## Purpose

A single user message travels through five layers (channel → gateway → session → LLM → permission gate) and produces zero or more outbound messages back. This spec is the map. It tells a new contributor: "when this happens over here, this should happen over there" — without them having to read all five boundary specs in parallel.

## States

```
                              ┌──────────┐
                              │  idle    │◀──────────────────────┐
                              └────┬─────┘                       │
                                   │                             │
                          (inbound arrives)                      │
                                   │                             │
                                   ▼                             │
                            ┌────────────┐                       │
                            │  queued    │                       │
                            └────┬───────┘                       │
                                 │                               │
                  (per-user queue releases)                     │
                                 │                               │
                                 ▼                               │
                          ┌────────────┐                         │
                          │  typing    │ (channel shows "...")  │
                          └────┬───────┘                         │
                               │                                 │
                  (session.send() called)                       │
                               │                                 │
                               ▼                                 │
                  ┌────────────────────────┐                    │
                  │      streaming         │                    │
                  │  (adapter.startStream) │                    │
                  │  (sink.append deltas)  │                    │
                  └────┬──────────────┬────┘                    │
                       │              │                         │
          (tool start) │              │ (final message)         │
                       │              │                         │
                       ▼              ▼                         │
              ┌─────────────┐  ┌────────────┐                  │
              │ permission  │  │  finalizing │                  │
              │   prompt    │  │  (sink.finish)                  │
              └──────┬──────┘  └──────┬──────┘                  │
                     │               │                         │
        (user response or timeout)   │                         │
                     │               │                         │
                     ▼               │                         │
              ┌─────────────┐        │                         │
              │  tool ran   │────────┘                         │
              │  (sink.app) │                                  │
              └──────┬──────┘                                  │
                     │                                          │
              (more tool calls? or done?)                      │
                     │                                          │
                     └──────────────────────────────────────────┘
                          (session.idle → mark idle → archived on /new or TTL)
```

### State reference

| State | Owned by | Side effects | Exit conditions |
|---|---|---|---|
| `idle` | session store | none | inbound message arrives |
| `queued` | session store (per-user queue) | none | per-user queue releases (only one message per user in flight) |
| `typing` | channel adapter | channel shows "typing…" indicator (recurring) | `session.send()` called |
| `streaming` | LLM backend + channel adapter | adapter's `StreamSink` is alive; sink throttles edits | either a tool starts (`permission prompt` state) or the final message arrives (`finalizing` state) |
| `permission-prompt` | permission gate + channel adapter | IPC round-trip; channel renders prompt UI; promise awaits user response | user response (allow / deny) or timeout (auto-deny) |
| `tool-ran` | LLM backend | sink appends a "🔧 ran `toolName`" line; tool result returned to agent | next tool starts or session goes idle |
| `finalizing` | channel adapter | sink finalizes; if content exceeds channel length cap, full content is sent via `adapter.send(...)` | sink flushed; `markIdle` called; back to `idle` |
| `archived` | session store | on-disk JSON written | next inbound message creates a new session |

## Channel-capability dispatch

The gateway uses the adapter's `capabilities` to decide which path to take at each transition:

| Transition | Capability check | Behavior |
|---|---|---|
| Inbound → typing | always | every channel shows a typing indicator |
| Streaming → finalizing | `capabilities.streaming` | if false, the gateway never enters `streaming`; it uses atomic `adapter.send(...)` only |
| Streaming (long content) → finalizing | `capabilities.unlimitedLength` | if false, the adapter truncates the live stream at the cap; the gateway sends the full content as new messages after `finalizing` |
| Tool → permission prompt | `capabilities.inlineButtons` | if false, the adapter uses a text-based prompt (readline for TUI); the gateway doesn't try to render buttons |
| Permission timeout | always | all channels get a "this prompt has expired" message |

The gateway never tries to render channel-specific UI itself. It just calls the adapter's methods and lets the adapter pick the right shape.

## IPC round-trips in the lifecycle

When the adapter is a subprocess, the following transitions cross the process boundary and incur IPC latency:

| Transition | Direction | Latency budget |
|---|---|---|
| Inbound message | subprocess → gateway | one IPC round-trip (the handler is invoked synchronously) |
| `startStream` | gateway → subprocess | one round-trip (returns the sink) |
| `sink.append(delta)` | gateway → subprocess | fire-and-forget; the subprocess throttles its own edits |
| `sink.finish` | gateway → subprocess | one round-trip |
| `promptPermission` | gateway → subprocess | one round-trip to start, one to deliver the user's response — total bounded by `timeoutSeconds` |
| `adapter.send(final)` | gateway → subprocess | one round-trip |

The total wall-clock latency for a "happy path" message (no permission prompt) is the IPC round-trip count × per-call latency. The gateway enforces a per-IPC-call timeout (default 5 s) to bound it. The per-call timeout is separate from `sendAndWaitTimeoutMs` (which bounds the SDK's wait for `session.idle`).

## Error paths

| Error | Where it surfaces | User sees |
|---|---|---|
| Channel adapter dies mid-message | gateway detects subprocess exit, marks channel down | The other channels (if any) get a "channel X went offline" message; the affected channel gets nothing until it restarts. |
| `session.idle` doesn't arrive within `sendAndWaitTimeoutMs` | LLM backend resolves the `send` promise with a timeout error | "⏳ The model didn't respond in time (X seconds). Try `/model` or `/new`." |
| Permission prompt times out | permission gate resolves with `deny` | "⏰ The tool `<name>` was auto-denied after X seconds of no response." |
| Permission prompt's adapter subprocess dies | gateway detects death, resolves prompt with `deny` | The other channels get a "channel X went offline" message; the affected channel gets nothing. |
| LLM backend dies mid-send | LLM backend resolves with an error | "🔌 The LLM backend went down. I've tried to restart it; try again in a moment." |
| User sends a message before the previous one is done | session store's per-user queue | The second message waits in `queued` until the first finishes. |
| Bot restarts mid-message | process death | The user sees nothing. On next message after restart, the gateway creates a fresh session and the conversation continues from there. |

## Cross-references

- **Pinned by:** ADR 001, ADR 003, ADR 004.
- **Depends on:** all five other boundary specs (this is the integration spec).
- **Depended on by:** none — this is a top-level spec for understanding, not a building block.

## Open questions

- **Multiple inbound messages during `streaming`.** The current behavior aborts the in-flight stream and starts a new one. v1 keeps this. A v2 feature could queue the second message instead of aborting. *YAGNI for v1.*
- **`/new`, `/agent`, `/model`, `/provider` as mid-stream interrupts.** Same as above: today these abort the stream. v1 keeps this. *YAGNI for v1.*
- **Cancellation propagation.** When the gateway aborts a stream, it should tell the SDK to cancel the in-flight `send()`. The Copilot SDK's API for this is TBD; the spec assumes it's possible. *Verify in implementation; if not, document the limitation.*
