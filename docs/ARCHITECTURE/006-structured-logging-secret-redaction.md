# ADR 006 — Structured logging with secret redaction

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** copilot-agent project

## Context

The bot processes sensitive data (API keys, user messages, tool arguments) across multiple subsystems (channel adapters, session store, LLM backend, permission gate). Every cross-boundary call must be observable for debugging, but secrets must never appear in logs.

## Decision

### Pino as the structured logger

`src/logger.ts` creates a root [pino](https://getpino.io/) logger with the following configuration:

- **Log level:** controlled by `LOG_LEVEL` env var (default `info`).
- **Output:** file-based rotation via `pino-roll` to `logs/copilot-agent.log`, with stdout mirror in development.
- **Module child loggers:** `createLogger(name: string)` returns a child logger with `{ module: name }` bound to every log line.

### Secret redaction

The root logger's `redact` configuration covers:

```typescript
redact: {
  paths: [
    'apiKey', 'api_key', 'bearerToken', 'bearer_token',
    'token', 'secret', 'password',
    'headers.Authorization', 'headers.authorization',
  ],
  censor: '[REDACTED]',
}
```

Every log line passes through the redaction filter before being written. This means even if a developer accidentally logs an API key, it's redacted in the output.

### All cross-boundary calls are logged

Every cross-boundary transition gets a structured log line. Examples from the codebase:

| Boundary | Logged event |
|---|---|
| Channel → Gateway | `{ userId, channel, messageId }` "Processing message" |
| Gateway → Session | `{ userId, sessionId, agent }` "session created" |
| Session → LLM | `{ sessionId }` "LLM backend started" |
| LLM → SDK | `{ sessionId }` "sendAndWait failed" — with error |
| Permission gate | `{ toolCallId, toolName, choice }` "permission resolved" |
| Subprocess lifecycle | `{ signal }` "Shutting down" |

**Implementation:** log lines are scattered across `src/gateway.ts`, `src/sessions.ts`, `src/llm.ts`, `src/permissions.ts`, and `src/channels/`.

### All I/O is async, all state transitions are logged

This is a cross-cutting principle from `docs/specs/00-high-level.md`. Every `create`, `archive`, `switch`, `start`, `stop`, and `send` call is logged at `info` level or higher. Debug-level logs cover internal decision points (auto-allow/auto-deny, permission evaluation).

## Consequences

- **Positive:** Structured JSON logs are machine-parseable for monitoring and alerting.
- **Positive:** Secret redaction is applied at the pipeline level — individual log calls don't need to remember to redact.
- **Positive:** Module-based child loggers make it easy to filter logs by subsystem.
- **Negative:** Excessive logging at `debug` level can produce large log files. The default level is `info` to avoid this.
- **Negative:** The redaction uses path-based matching — a secret stored under an unexpected key name (e.g., `my_custom_token`) won't be redacted unless added to the path list.

## References

- `src/logger.ts` — `createLogger`, root logger configuration
- `src/gateway.ts` — lifecycle and message-processing log lines
- `src/sessions.ts` — session creation and archival log lines
- `src/llm.ts` — LLM backend lifecycle log lines
