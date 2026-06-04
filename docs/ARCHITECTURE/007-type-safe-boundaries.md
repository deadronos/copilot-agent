# ADR 007 — Type-safe boundaries: Zod at edges, TypeScript inside

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** copilot-agent project

## Context

The bot handles data from many external sources — YAML config files, markdown frontmatter, JSON archives, SDK JSON-RPC responses, IPC messages from channel subprocesses. Untrusted data must be validated before it enters the bot's internal logic.

## Decision

### Zod at every external boundary

Every piece of data crossing a process or format boundary is validated with Zod before being used internally. Inside the boundary, plain TypeScript types are trusted.

| Boundary | Validation | Location |
|---|---|---|
| `config.yaml` | `ConfigSchema` (strict) | `src/config.ts` |
| `<preset>.yaml` | `PresetSchema` (passthrough) | `src/config.ts` |
| Agent `.md` frontmatter | `AgentFrontmatterSchema` | `src/agents.ts` |
| SDK `PermissionDecision` | `toSdkPermissionResult()` type mapping | `src/permissions.ts` |
| IPC messages | JSON-RPC shape (structural, not Zod — runtime type narrowing) | `src/channels/_shared/ipc.ts` |

**The principle:** if a config file is malformed, the bot refuses to start with a clear error pointing at the file and field. It never silently ignores invalid config.

### Strict schemas reject unknown keys

`ConfigSchema` is `.strict()` — unknown keys cause a validation error. This prevents typos (e.g., `permisions` instead of `permissions`) from being silently ignored.

`PresetSchema` is `.passthrough()` — unknown keys are passed through because presets may contain provider-specific fields the schema doesn't enumerate.

### TypeScript inside the boundary

Once data passes Zod validation, it's assigned a TypeScript type (e.g., `AppConfig`, `AgentDefinition`) and used with full type safety. The `src/types.ts` module defines the canonical types that every subsystem imports.

### The SDK owns the agent loop — we never bypass it

The bot never reaches into the SDK's internals or reimplements tool-calling. It only consumes typed SDK events (`assistant.message_delta`, `tool.execution_start`, `permission.requested`, etc.) and translates between its own types and the SDK's wire protocol at a single translation point (`toSdkPermissionResult` in `src/permissions.ts`).

## Consequences

- **Positive:** Malformed config or agent files fail fast with actionable errors — the bot never starts in a broken state.
- **Positive:** The strict/not-strict distinction for config vs. presets is intentional: config is fully controlled by the bot, presets may contain provider-specific extensions.
- **Positive:** The single permission-decision translation point prevents protocol drift between the bot and the SDK.
- **Negative:** Adding a new config field requires updating both the Zod schema and the `AppConfig` type. This is by design — the two must stay in sync.
- **Negative:** IPC messages from channel subprocesses are not Zod-validated (they use runtime type narrowing). This is acceptable because the subprocess runs the bot's own code and the attack surface is minimal, but a future v2 may add Zod schemas for IPC messages.

## References

- `src/types.ts` — all shared TypeScript interfaces
- `src/config.ts` — `ConfigSchema`, `PresetSchema`, `loadConfig`, `loadPreset`
- `src/agents.ts` — `AgentFrontmatterSchema`
- `src/permissions.ts` — `toSdkPermissionResult`
- `docs/specs/00-high-level.md` — cross-cutting principle "Type-safe at the boundary, validated at the edge"
