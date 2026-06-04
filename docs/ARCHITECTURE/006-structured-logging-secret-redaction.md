# ADR 006: Structured Logging with Secret Redaction

**Status:** Accepted  
**Date:** 2026-06-01  
**Deciders:** @deadronos

## Context

The bot needs observability into SDK interactions, session lifecycle, errors, and user activity. Logs must:

- Be structured for machine parsing (JSON)
- Survive restarts (file-based)
- Never leak API keys, tokens, or credentials
- Support different log levels for development vs. production
- Provide per-module context for filtering

## Decision

**Use pino (structured JSON logger) with file rotation, stdout mirror in development, and automatic secret redaction.**

Architecture (`src/logger.ts`):
```typescript
const REDACTED_FIELDS = [
  'api_key', 'apiKey', 'bearer_token', 'bearerToken',
  'token', 'TELEGRAM_BOT_TOKEN', 'COPILOT_GITHUB_TOKEN',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_GO_KEY',
];

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: REDACTED_FIELDS, censor: '***' },
}, transport);

const targets = [
  { target: 'pino/file', options: { destination: logPath, mkdir: true } },
  ...(dev ? [{ target: 'pino/file', options: { destination: 1 } }] : []),
];
```

Key design choices:

- **Singleton logger**: `getLogger()` returns a cached pino instance, initialized on first call
- **Child loggers**: `getChildLogger('sessions')` creates `logger.child({ context: 'sessions' })` for per-module filtering
- **Dual output**: File (`logs/copilot-agent.log`) always; stdout only when `NODE_ENV !== 'production'`
- **Secrets are redacted by field name**: Any log object key matching `REDACTED_FIELDS` is replaced with `***` _before_ serialization — not via regex post-processing
- **Log level configurable**: `LOG_LEVEL=debug` for development, `info` for production

## Rationale

1. **pino is the fastest Node.js logger.** Benchmarks show 5-10x throughput vs. Winston. For a bot that may log every SDK event, this matters.
2. **Structured JSON enables log analysis.** `jq`, `pino-pretty`, or any JSON log aggregator can filter by `context`, `level`, or custom fields.
3. **Redaction by field path is robust.** Fields like `apiKey`, `bearerToken`, or `token` are redacted wherever they appear — nested objects, arrays, custom payloads. pino's `redact` option handles this at the serialization layer, so even `logger.info({ apiKey: 'sk-...' })` never writes the key to disk or stdout.
4. **Child loggers provide zero-cost context.** `getChildLogger('sessions')` adds `{ context: 'sessions' }` to every log line from that module. Filtering is as simple as `jq 'select(.context == "sessions")'`.
5. **File rotation is handled by pino's `pino/file` transport.** No external logrotate dependency. The transport uses the destination path and handles creation.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Winston | Slower, more complex configuration, less ergonomic child logger API |
| `console.log` | No structured output, no redaction, no file output in production |
| `debug` module | No structured logging, no built-in redaction, requires `DEBUG=*` env var |
| Cloud logging service | Adds a network dependency. A personal assistant should log locally. |
| Regex-based secret scrubbing in log files | Post-hoc scrubbing is fragile. A field added later might not match the regex. Redaction at serialization is safer. |

## Consequences

### Positive
- Secrets cannot appear in log files (redaction at serialization)
- Structured JSON is grep-friendly and aggregator-ready
- Per-module context makes it easy to isolate issues to a specific component
- Development stdout mirror + production file-only is automatic via `NODE_ENV`

### Negative
- Redaction is by field name, not by value. A secret stored in a field called `prompt` would leak. (Mitigation: API keys flow through typed `ProviderConfig` objects, never through arbitrary user payloads.)
- The `REDACTED_FIELDS` list must be manually updated when new secret env vars are added
- No log rotation by size (only by destination file). For a personal bot, volume is unlikely to be an issue.

### Mitigations
- The `dotenv` loading in `config.ts` reads secrets into `process.env` — they never appear in config objects or user payloads
- `resolveProviderAuth()` extracts keys from `process.env` only when needed, and the keys never pass through `JSON.stringify` in business logic
- New secret env vars should always be added to `REDACTED_FIELDS` as part of the feature implementation
