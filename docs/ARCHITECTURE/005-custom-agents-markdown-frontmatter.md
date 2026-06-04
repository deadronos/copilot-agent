# ADR 005 — Custom agents via markdown + frontmatter

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** copilot-agent project

## Context

Users need to create custom AI personalities with different system prompts, model preferences, and tool allowlists. The format must be human-editable, machine-validatable, and work with the Copilot SDK's session creation API.

## Decision

### Markdown files with YAML frontmatter

Agent definitions live as `.md` files in `<configDir>/agents/`. Each file has YAML frontmatter for structured metadata and markdown body for the system prompt:

```markdown
---
name: writer
description: Long-form writing assistant.
model: claude-sonnet-4-6
tools: []
---

You are a long-form writing assistant. ...
```

**Implementation:** `src/agents.ts` parses files with `gray-matter` and validates frontmatter with Zod (`AgentFrontmatterSchema`).

### Frontmatter schema

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `name` | string | yes | — | Must be unique across all agent files. Duplicates: second wins, first logged as warning. |
| `description` | string | no | — | Shown in `/agent` listing. |
| `model` | string | no | gateway default | Overrides `config.active.model` for this agent. |
| `tools` | string[] | no | undefined (SDK default) | Empty array = use SDK default. Non-empty = allowlist. |

### Strict validation at load

- Missing frontmatter `name` → startup fails with clear error pointing to the file.
- Invalid frontmatter (Zod parse failure) → startup fails with formatted error.
- Duplicate `name` → logged as warning, second definition wins, first is silently dropped. The bot still starts.
- `agents/` directory missing → bot starts with only the built-in `assistant` agent (logged as warning).
- Malformed YAML → startup fails.

### Default assistant agent

A built-in `assistant` agent is created by `createDefaultAssistantAgent()` in `src/agents.ts` and is used as the fallback when the agents directory is missing. It has a generic helpful system prompt and no model/tools override.

### CLI support

The `copilot-agent agent` subcommands (`list`, `show`, `create`, `edit`, `delete`) share the agent registry's validation and file-format logic. See `src/cli.ts` for the implementation.

### No hot-reload

Agent definitions are loaded once at startup (`agentRegistry.load()`). Editing an agent file requires a process restart to take effect. Hot-reload is deferred to v2.

### Skills system deferred

The `skills/` folder exists in the setup scaffold but is unused in v1. A future v2 spec may add a `skills: [name1, name2]` frontmatter field and a parallel skills loader.

## Consequences

- **Positive:** Markdown + frontmatter is familiar to developers and easy to edit in any text editor.
- **Positive:** Strict validation catches errors at startup rather than silently at runtime.
- **Positive:** Model and tool overrides per agent give users fine-grained control.
- **Negative:** No hot-reload means editing an agent requires a restart. Acceptable for a personal tool; v2 may add a file watcher.
- **Negative:** Tool allowlists are passed through to the SDK without validation — if a tool name doesn't exist, the error surfaces at session creation, not at agent load.

## References

- `src/agents.ts` — `createAgentRegistry`, `createDefaultAssistantAgent`
- `src/cli.ts` — `handleAgent` subcommand handler
- `src/gateway.ts` — `/agent` slash command handler
- `docs/specs/03-agent-registry.md`
