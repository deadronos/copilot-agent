# ADR 010: Testing Strategy

**Status:** Accepted  
**Date:** 2026-06-01  
**Deciders:** @deadronos

## Context

The bot has multiple layers (config parsing, permission resolution, session management, Telegram integration, SDK interaction) that need testing at different levels of isolation. We need a strategy that:

- Catches regressions before they reach the user
- Runs fast (no network calls in CI)
- Tests the parts we own, trusting the parts we don't (SDK, Telegram API)
- Is maintainable as the codebase grows

## Decision

**Three-layer testing strategy: unit tests (Vitest), integration tests with fakes (future), and live smoke tests (manual, pre-release).**

### Layer 1: Unit Tests (implemented)

Current coverage:
- **`config.test.ts`** (7 tests): Config loading, validation, error paths
  - Valid config loads correctly
  - Missing `config.yaml` throws
  - Invalid YAML throws
  - Empty `allowed_user_ids` throws
  - Missing env var for active provider throws
- **`permissions.test.ts`** (6 tests): Permission resolution logic
  - `deny-all` mode denies everything
  - `approve-all` mode denies everything (no auto-approve)
  - `readonly-default` auto-approves read tools
  - Session auto-approve set bypasses gates
  - Permission message formatting with truncation

Test infrastructure:
- **Vitest** with zero-config TypeScript support (runs `.test.ts` files directly)
- Test files live next to source files (`src/config.test.ts`)
- Tests use a real temp directory for config fixtures (cleaned up in `afterEach`)
- No mocking framework — tests pass real config objects to pure functions

### Layer 2: Integration Tests with Fakes (planned, not implemented)

Design from `idea.md`:

> A test harness with two in-memory fakes:
> - **Fake Copilot client** — implements the same `createSession` / `sendAndWait` / permission-handler surface, but lets tests script responses (return this text, then a tool call, then a tool result, then a final answer). Also lets tests assert "the bot sent a permission prompt with this exact body."
> - **Fake Telegram transport** — feeds scripted `message` and `callback_query` events into the bot, captures every outgoing `sendMessage` / `editMessageText` / `answerCallbackQuery` call, and lets tests assert on them.

Test scenarios for Layer 2:
- End-to-end "user says hello → agent replies with text"
- "User says run a tool → bot shows prompt → user clicks allow once → bot runs tool"
- "User clicks allow for session → second tool call auto-approves"
- "Two chats, two sessions, no cross-talk"
- "Provider returns `unauthorized` → bot tells user"
- "Pending permission times out after 5 min → deny propagates"

### Layer 3: Live Smoke Test (manual)

A short `npm run smoke` script (not yet implemented) that:
1. Starts the bot pointed at a throwaway test bot token
2. Sends `/start`, `/provider`, `/status`, `/new`
3. Sends one real message and asserts a reply
4. Triggers a tool-call permission prompt, asserts inline buttons appear
5. Exits non-zero on timeout or error

Run before tagging a release, not in CI.

## Rationale

1. **Unit tests are fast and reliable.** No network, no SDK, no Telegram API. They run in under 200ms and catch logic errors in config parsing and permission resolution — the two modules with the most branching logic.
2. **Test files live next to source files.** `config.test.ts` next to `config.ts`. This co-location makes it easy to find tests and keeps the mental model simple.
3. **No mocking framework (yet).** The unit-tested functions (`loadConfig`, `shouldAutoApprove`, `formatPermissionMessage`) are pure or use filesystem temp dirs. Mocks aren't needed at Layer 1. Layer 2 (fakes) will use manual fakes, not `vitest.mock()`, because fakes provide better test readability and assertion surfaces.
4. **Integration tests with fakes are deferred.** They're complex to build (the fake needs to implement the full SDK + Telegram surface) but provide the highest-value coverage — full message-to-reply flows without real services. They're planned, not implemented, because the SDK API was still settling when the codebase was written.
5. **Smoke tests catch real-world integration issues.** Provider auth, Telegram API changes, SDK version incompatibilities — things unit and integration tests can't catch. Manual pre-release testing gates the release on a known-good smoke run.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Jest instead of Vitest | Vitest is faster (native ESM, no transform step), shares `tsconfig.json`, and supports watch mode out of the box. |
| Full E2E tests in CI | Requires a real Telegram bot token and provider API key in CI secrets. Security risk and cost for a personal project. |
| Snapshot testing | Not useful for non-UI output. The bot's output is natural language text — snapshots would break on every model update. |
| No tests (rely on manual testing) | The config module alone has 5 error paths; manual testing would miss regressions. Unit tests run in CI and catch mistakes instantly. |
| Test files in a separate `tests/` directory | Co-location with source is more discoverable and reduces import path complexity. |

## Consequences

### Positive
- 12 unit tests running in CI catch config and permission logic regressions
- Test infrastructure is minimal (Vitest, no mocks, temp dirs)
- The testing pyramid is respected: many unit tests, fewer integration tests, rare smoke tests
- Layer 2 fake design is documented and ready to implement when the SDK API stabilizes

### Negative
- Only `config.ts` and `permissions.ts` are tested. `sessions.ts`, `telegram.ts`, `index.ts`, and `agents.ts` have no automated test coverage.
- The planned integration tests (Layer 2) require significant upfront work to build the fakes — they may never be built if the project stays small.
- No CI for the Telegram integration path (it's manual smoke testing only)

### Mitigations
- The untested modules (`sessions.ts`, `telegram.ts`) primarily orchestrate tested modules and the SDK. Their logic is relatively thin — mostly wiring function calls.
- `npm run typecheck` catches type errors in all modules, including untested ones
- ESLint catches unused variables, `any` casts, and non-null assertions across the entire `src/` tree
- The Layer 2 fake design is documented — when complexity warrants it, the implementation path is clear
