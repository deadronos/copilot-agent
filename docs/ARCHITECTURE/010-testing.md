# ADR 010 — Testing: Vitest, TDD, tests next to source

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** copilot-agent project

## Context

The bot processes user messages, manages sessions, evaluates permissions, and calls the Copilot SDK — all logic that must be correct. We need a testing strategy that catches regressions, is fast to run, and doesn't require external services.

## Decision

### Vitest as the test runner

`vitest` is the test runner, configured in `vitest.config.ts`. It's fast (native ESM, parallel execution), compatible with the project's ESM setup, and has a watch mode for TDD (`npm run test:watch`).

### Tests live next to source

Test files are co-located with the modules they test: `src/cli.test.ts` tests `src/cli.ts`, and similarly for every module. This keeps tests discoverable and makes it obvious when a module lacks test coverage.

### Test what the bot controls — mock external boundaries

Tests focus on the bot's own logic. External boundaries are mocked:

| Boundary | Test approach |
|---|---|
| Copilot SDK | Mocked at the interface level; tests verify that the bot calls the right SDK methods with the right arguments |
| Telegram (grammY) | Mocked; tests verify message formatting, button generation, and callback handling |
| File system | Mocked for config/agent loading; tests verify Zod validation and error paths |
| IPC | Not tested in v1 (structural contract); structural testing planned for v2 |

### 34 tests and growing

The current test suite (`src/cli.test.ts`, 34 tests) covers the CLI subcommand dispatch. Additional test files should be added for every new module:

- `src/config.test.ts` — config loading, Zod validation, secret resolution
- `src/agents.test.ts` — agent file parsing, frontmatter validation, duplicate handling
- `src/permissions.test.ts` — mode evaluation, session memory, timeout behavior, SDK boundary mapping
- `src/sessions.test.ts` — create, archive, resume, TTL sweep, enqueue serialization
- `src/gateway.test.ts` — slash commands, message processing, permission handling

### TDD workflow

The project follows TDD for new features: write a failing test, implement, verify green. The `npm run test:watch` script supports this workflow.

### No exceptions for "glue code"

The cross-cutting principle from `docs/specs/00-high-level.md` is explicit: every module gets tests, even "glue code" like the entrypoint (`src/index.ts`) and adapters. The entrypoint's adapter functions (`createSessionStoreAdapter`, `createLlmBackendAdapter`) are structured as pure functions specifically to be testable.

## Consequences

- **Positive:** Fast test execution (132ms for 34 tests) encourages frequent test runs.
- **Positive:** Co-located tests make it easy to find and update tests when the module changes.
- **Negative:** Not all modules have tests yet — `config.test.ts`, `agents.test.ts`, `permissions.test.ts`, `sessions.test.ts`, and `gateway.test.ts` are planned but not yet written.
- **Negative:** Testing the Copilot SDK integration requires mocking the entire SDK interface, which can drift from the real SDK behavior. Integration tests against a real SDK instance (planned for v2) would catch these drifts.

## References

- `vitest.config.ts` — test configuration
- `src/cli.test.ts` — 34 CLI tests (reference pattern)
- `docs/specs/00-high-level.md` — cross-cutting principle "Tests live next to source"
