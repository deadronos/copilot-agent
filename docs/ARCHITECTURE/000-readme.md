# Architecture Decision Records

This directory contains ADRs (Architecture Decision Records) for `copilot-agent`. Each record documents a technical decision: the context, the choice made, the consequences, and references to the implementing code.

## Index

| # | Title | Status | Key modules |
|---|---|---|---|
| [001](001-copilot-sdk-and-telegram-channel.md) | Copilot SDK as the agentic backend; Telegram as the initial channel | Accepted | `src/llm.ts`, `src/channels/telegram/` |
| [002](002-xdg-config-and-byok-providers.md) | XDG config layout and BYOK provider model | Accepted | `src/config.ts`, `src/logger.ts` |
| [003](003-permission-gate.md) | Permission gate with three modes, deny-on-timeout, per-channel UI | Accepted | `src/permissions.ts`, `src/channels/telegram/format.ts` |
| [004](004-session-store-and-archival.md) | Per-user session serialization, archival, and resume | Accepted | `src/sessions.ts`, `src/gateway.ts` |
| [005](005-custom-agents-markdown-frontmatter.md) | Custom agents via markdown + frontmatter | Accepted | `src/agents.ts`, `src/cli.ts` |
| [006](006-structured-logging-secret-redaction.md) | Structured logging with secret redaction | Accepted | `src/logger.ts` |
| [007](007-type-safe-boundaries.md) | Type-safe boundaries: Zod at edges, TypeScript inside | Accepted | `src/config.ts`, `src/agents.ts`, `src/permissions.ts` |
| [008](008-multi-channel-plug-in-architecture.md) | Multi-channel plug-in architecture with subprocess isolation | Accepted | `src/channels/`, `src/gateway.ts` |
| [009](009-provider-as-code.md) | Provider-as-code: plug-in modules with preset deployment config | Accepted | `src/providers/`, `src/llm.ts` |
| [010](010-testing.md) | Testing: Vitest, TDD, tests next to source | Accepted | `vitest.config.ts`, `src/*.test.ts` |

## Relationship to specs

The [`docs/specs/`](../specs/) folder contains target-state design specs (00-08) that describe the architecture. The ADRs in this folder document the _decisions_ that led to that architecture, grounded in the current codebase. The specs are forward-looking; the ADRs are historical record. Both are consulted when making changes.
