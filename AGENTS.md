# copilot-agent

Telegram bot powered by the GitHub Copilot SDK. BYOK provider system (GitHub, OpenAI, Anthropic, Ollama, anything OpenAI-compatible). TypeScript on Node 24, ESM.

## Build & test

| Task | Command |
| --- | --- |
| Install | `npm install` |
| First-time config | `npm run setup` (writes `~/.config/copilot-agent/`) |
| Build | `npm run build` |
| Run (dev, watch) | `npm run dev` |
| Run (prod) | `npm start` |
| Tests | `npm test` (watch: `npm run test:watch`) |
| Type-check | `npm run typecheck` |
| Lint | `npm run lint` (auto-fix: `npm run lint:fix`) |
| Format | `npm run format` (check: `npm run format:check`) |

Always run `npm run typecheck && npm run lint && npm test` before committing.

## Source layout

| File | Responsibility |
| --- | --- |
| [src/index.ts](src/index.ts) | Entrypoint. Wires config → agents → sessions → Telegram, handles SIGINT/SIGTERM. |
| [src/config.ts](src/config.ts) | XDG config-dir resolution, YAML + `.env` load, env-var validation. |
| [src/agents.ts](src/agents.ts) | Scans `agents/*.md`, parses gray-matter frontmatter, validates at load. |
| [src/sessions.ts](src/sessions.ts) | Per-chat SDK session map + per-chat async queue; archive/resume to `sessions/`. |
| [src/telegram.ts](src/telegram.ts) | grammY bot, command router, permission-prompt buttons, 4096-char splitter. |
| [src/permissions.ts](src/permissions.ts) | `shouldAutoApprove` for the three modes; permission-request timeout. |
| [src/logger.ts](src/logger.ts) | Pino singleton, `getChildLogger(name)`, secret-field redaction list. |
| [src/types.ts](src/types.ts) | Zod schemas (config, providers) + derived TS types. |
| [src/setup.ts](src/setup.ts) | Scaffolds config dir, `config.yaml`, `.env`, default `assistant` agent. |

## Conventions

- **ESM / NodeNext.** Import sibling files as `./foo.js` (with the `.js` extension), not `./foo`.
- **Strict TS, no `any` in production code** (relaxed only in `src/**/*.test.ts`).
- **Type-only imports** must be inline: `import { type X, foo } from '...'`. Enforced by `@typescript-eslint/consistent-type-imports`.
- **Logger, not `console`.** `const log = getChildLogger('module-name');` and use structured fields (`log.info({ chatId, err }, '...')`).
- **Redact secrets at the pino level.** If you add a new env-var name holding a secret, append it to `REDACTED_FIELDS` in [src/logger.ts](src/logger.ts).
- **Validate external data with Zod.** Config, frontmatter, archived sessions — anything read from disk or the SDK.
- **Tests live next to source** as `src/foo.test.ts`. Use `tmpdir()` + `beforeEach`/`afterEach` for filesystem fixtures. Vitest globals are enabled — no need to import `describe`/`it`/`expect`.
- **Prettier:** 2-space, single quotes, trailing commas, 100-col, LF. `npm run format` before committing.

## Architecture (read in this order)

Don't re-derive design decisions — these docs are canonical:

- [001 — Telegram + Copilot SDK architecture](docs/ARCHITECTURE/001-telegram-copilot-sdk-architecture.md)
- [002 — XDG config with YAML + dotenv](docs/ARCHITECTURE/002-xdg-config-with-yaml-and-dotenv.md)
- [003 — Permission gate with Telegram buttons](docs/ARCHITECTURE/003-permission-gate-with-telegram-buttons.md)
- [004 — Per-chat session serialization](docs/ARCHITECTURE/004-per-chat-session-serialization.md)
- [005 — Custom agents (markdown + frontmatter)](docs/ARCHITECTURE/005-custom-agents-markdown-frontmatter.md)
- [006 — Structured logging + secret redaction](docs/ARCHITECTURE/006-structured-logging-secret-redaction.md)
- [007 — Type-safe SDK boundaries](docs/ARCHITECTURE/007-type-safe-sdk-boundaries.md)
- [008 — ESLint + Prettier code quality](docs/ARCHITECTURE/008-eslint-prettier-code-quality.md)
- [009 — Deployment (Docker + local)](docs/ARCHITECTURE/009-deployment-docker-and-local.md)
- [010 — Testing strategy](docs/ARCHITECTURE/010-testing-strategy.md)

## Pitfalls

- **The Copilot SDK is a subprocess** (server mode over stdio JSON-RPC). Don't import the CLI or assume in-process state — only use the SDK's typed surface.
- **All env-var access is centralized in `config.ts`.** New secrets → add a `*_env` field to the relevant schema, not direct `process.env` reads.
- **`/provider` and `/model` carry history forward** as a synthetic first prompt; **`/agent` always starts fresh** because the system prompt and tool set change. See [004](docs/ARCHITECTURE/004-per-chat-session-serialization.md).
- **Permission requests deny on timeout** (5 min default). The handler should resolve with `denied-interactively-by-user` and let the agent surface a "user did not respond" message — never auto-approve silently.
- **Telegram message cap is 4096 chars.** Route any long text through `splitMessage` in [src/telegram.ts](src/telegram.ts); Markdown parse failures should fall back to plain text.
- **`agents.dir` and `session.history_dir` in `config.yaml` are relative to the config dir**, not CWD. Always `resolve(configDir, ...)` before touching the filesystem.
- **Agent frontmatter:** `name` required (duplicates → second wins), `description`/`model`/`tools` optional, body becomes the system prompt. Malformed frontmatter fails the bot's startup.
- **Tests mutate `process.env` via dotenv.** Restore the original env in `afterEach` or you'll leak state across test files (see [src/config.test.ts](src/config.test.ts)).
- **Permission decision shape is `{ kind: 'approved' | 'denied-interactively-by-user' }`.** `denied-no-approval-rule-and-could-not-request-from-user` and `denied-by-rules` come from the SDK and are not user-facing.

> [!IMPORTANT]
> **CHANGELOG.md is updated on every change.** Add a single bullet per logical change (one entry per line) under `## Unreleased`, or under the current version header if a release is in progress. Be granular — one bullet per change, not one per commit or per PR.
>
> **Docs ↔ code parity is mandatory.** Whenever you touch `src/`, also read the matching `docs/ARCHITECTURE/00X-*.md` and check both directions:
>
> - **Codebase → docs:** if you change a behavior, command, schema field, or module boundary, the corresponding doc must be updated in the same change.
> - **Docs → codebase:** if a doc specifies a behavior the code doesn't actually implement (or implements differently), the codebase is the source of truth — fix the code, then either delete the stale doc text or rewrite it to match reality. Never leave docs lying about what the code does.
>
> When in doubt about which side to align, ask: "What would surprise a new contributor more — out-of-date docs or a doc that no longer matches the code?" The answer is always to fix both sides to agree.

## Adding a feature

1. **Pick the layer:** Telegram command handler, session manager, permission gate, agent loader, or config schema — each has one owner file.
2. **Implement + add a test** in `src/*.test.ts`. Follow the existing vitest patterns.
3. **Update `docs/ARCHITECTURE/00X-*.md`** if user-facing behavior, the config schema, or module boundaries change.
4. **Add a granular CHANGELOG.md entry** — one bullet per logical change under `## Unreleased` (or the current version header).
5. **Run `npm run typecheck && npm run lint && npm test`.**
