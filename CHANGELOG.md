# Changelog

## Unreleased

- Fixed "Allow once" and "Allow for session" permission buttons doing nothing: the Copilot SDK's `PermissionDecision` wire protocol expects `approve-once` / `approve-for-session` / `denied-interactively-by-user`, not `approved`. The internal `PermissionDecision` kind is now `allow-once` / `allow-session` / `deny`, and `toSdkPermissionResult` in [src/permissions.ts](src/permissions.ts) translates at the SDK boundary. The auto-approve branch in [src/sessions.ts](src/sessions.ts) was also returning the bogus `approved` kind and is now routed through the same mapper. Test coverage added in [src/permissions.test.ts](src/permissions.test.ts). Architecture doc 003 updated to describe the boundary mapping.
- Fixed bot crash on stale permission-button clicks: Telegram only honours `answerCallbackQuery` / `editMessageText` for ~30 seconds after a callback. If the user clicked late (e.g. after the Copilot SDK's 60s `sendAndWait` timeout already killed the session), those API calls returned `400: query is too old`, threw inside grammY middleware, and the unhandled rejection killed the whole bot. The callback handler in [src/telegram.ts](src/telegram.ts) now resolves the permission promise first (which is what actually unblocks the SDK), wraps every Telegram API call in `.catch`, and registers a `bot.catch` error boundary so any future unhandled rejection logs and continues instead of crashing the process.
- Fixed orphaned permission prompts after agent errors: when the message handler caught an SDK error (e.g. the Copilot SDK's `Timeout after 60000ms waiting for session.idle`), any in-flight permission prompt for the same chat was left in the `pendingPermissions` map. The user could still click the buttons, the promise would resolve, but the SDK session was already dead so the agent never resumed — the click appeared to do nothing. The message handler in [src/telegram.ts](src/telegram.ts) now calls a new `cancelPendingPermissions(chatId, reason)` helper on the error path, which resolves all orphan promises with `deny`, removes them from the map, and tells the user the prompts were cleared. The callback handler also now logs an `info` line on entry so future "the callback doesn't happen" reports can distinguish "didn't reach the handler" from "handler ran but the side effect was a no-op".
- Fixed permission prompts racing the SDK's 60s `sendAndWait` timeout: when the agent was blocked on a permission request waiting for the user to click a button, no `session.idle` event fired until the permission resolved. If the user took longer than 60s, the SDK timed out, the session was orphaned, and the user's click arrived too late to be acted on. `SessionManager.sendAndWaitTimeoutMs` in [src/sessions.ts](src/sessions.ts) now passes `permissions.timeout_seconds * 1000 + 30s buffer` (with a 90s floor) to `session.sendAndWait` in both `enqueueMessage` and `resumeSession`. New regression tests in [src/sessions.test.ts](src/sessions.test.ts) lock in the math.
- Added `AGENTS.md` with build/test commands, source layout, conventions, architecture index, pitfalls, and feature-addition workflow
- Added IMPORTANT note in `AGENTS.md` requiring granular CHANGELOG entries on every change and docs ↔ code parity checks
- Added `CLAUDE.md` that points to `AGENTS.md` as the canonical entry point for AI coding agents

## 0.1.0 - 2024-06-01

- Added Telegram bot entrypoint powered by grammY with long-polling message and callback handling
- Added integration with the GitHub Copilot SDK as the agentic backend, spawning the CLI in server mode over JSON-RPC
- Added BYOK provider system supporting GitHub Copilot, OpenAI, Anthropic, Ollama, and any OpenAI-compatible endpoint
- Added runtime-switchable provider, model, and agent via `/provider`, `/model`, and `/agent` commands
- Added `config.yaml` + `.env` configuration loaded under `~/.config/copilot-agent/` (overridable via `COPILOT_AGENT_CONFIG_DIR` or `XDG_CONFIG_HOME`)
- Added Zod-validated config schema covering providers, telegram allowlist, agents, session, and permissions
- Added custom agents loaded from markdown files with frontmatter (name, description, model, tools, prompt)
- Added default `assistant` agent scaffolded by `npm run setup`
- Added `npm run setup` command to generate `config.yaml`, `.env`, agents/, skills/, sessions/, and logs/ directories with sensible defaults
- Added per-chat session manager that creates, reuses, ends, and archives Copilot sessions
- Added message queueing per chat to serialize agent interactions and avoid races
- Added session history archival to `sessions/` on `/new`, on shutdown, and on configuration changes
- Added `/resume [n]` command to list and resume the n-th most recent archived session
- Added `/status` command surfacing current provider, model, agent, and message count
- Added `/new` command to start a fresh session and archive the prior one
- Added permission gate with three modes: `approve-all`, `readonly-default`, and `deny-all`
- Added inline Telegram buttons for tool permission prompts (allow once, allow for session, deny)
- Added per-session auto-approval memory for tools the user has previously accepted
- Added read-only auto-approval in `readonly-default` mode for read-kind tools
- Added configurable permission request timeout with deny-on-timeout default
- Added `/approve` and `/deny` commands as text-based alternatives to the inline buttons
- Added Telegram allowlist enforced as middleware so non-authorized users are silently ignored
- Added pino-based structured logger with secret redaction (api keys, bearer tokens, bot token) and per-module child loggers
- Added file-based log rotation to `logs/copilot-agent.log` with stdout mirror in development
- Added long-message splitting to stay under Telegram's 4096-character limit
- Added typing indicator that recurs while the agent is processing a message
- Added friendly error messages for unauthorized (401) and rate-limited (429) provider responses
- Added suggestion to use `/new` once a session exceeds `session.max_messages`
- Added graceful shutdown on SIGINT/SIGTERM that stops the bot, archives active sessions, and stops the Copilot client
- Added Vitest test suite covering config loading and permission resolution
- Added TypeScript strict build (`tsc`) and `tsx` watch-mode development script
- Added ESLint configuration for the `src/` tree
- Added Dockerfile (multi-stage, node:24-slim, non-root user) and `docker-compose.yml` with persistent `copilot-agent-data` volume
- Added `.nvmrc` pinning the Node.js version and `.gitignore` for `node_modules`, `dist`, logs, and config
- Added README with quick start, command reference, configuration guide, custom agent docs, and deployment instructions for Docker, systemd, and launchd
