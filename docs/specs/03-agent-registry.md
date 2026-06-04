# 03 — Agent registry

> **Status:** Draft
> **Owns:** The agent definition format (markdown + frontmatter), validation at load, the switch semantics for `/agent`, `/model`, `/provider`. v2 may add: skills system, hot-reload.
> **Pins:** ADR 005 (custom agents via markdown + frontmatter).

## Purpose

The agent registry is the gateway's source of truth for "what personalities does this user have, and which one is active for which user." It loads agent definitions from `<configDir>/agents/*.md` at startup, validates the frontmatter, and provides lookups for the gateway's switch and resume flows.

## Interface

```typescript
export interface AgentDefinition {
  /** Name from frontmatter. Required. Unique within the agents dir. */
  readonly name: string;
  /** Description from frontmatter. Optional. */
  readonly description?: string;
  /** Model id from frontmatter. Optional; falls back to the gateway default. */
  readonly model?: string;
  /** Tools allowlist from frontmatter. Optional; empty means "use the SDK default tool set." */
  readonly tools?: ReadonlyArray<string>;
  /** The body of the markdown file (everything after the frontmatter).
   *  Becomes the agent's system prompt. */
  readonly systemPrompt: string;
  /** Absolute path to the source file. */
  readonly sourcePath: string;
  /** mtime of the source file at load. Used for hot-reload (v2). */
  readonly loadedAt: number;
}

export interface AgentRegistry {
  /** Load all agents from the configured directory. Called at startup.
   *  Throws on the first malformed agent; the bot refuses to start. */
  load(): Promise<void>;

  /** List all loaded agents, sorted by name. */
  list(): ReadonlyArray<AgentDefinition>;

  /** Get an agent by name, or `null` if not found. */
  get(name: string): AgentDefinition | null;

  /** The default agent (the one named in `agents.default` in `config.yaml`).
   *  Throws if the default is missing or invalid. */
  default(): AgentDefinition;
}
```

## Agent format

Unchanged from ADR 005. A markdown file in `<configDir>/agents/`:

```markdown
---
name: writer
description: Long-form writing assistant.
model: claude-sonnet-4-6
tools: []
---

You are a long-form writing assistant. ...
```

**Frontmatter rules** (Zod-validated at load):

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `name` | string | yes | — | Must be unique across all agent files. Duplicates: the second one wins; the first is logged and ignored. |
| `description` | string | no | — | Shown in `/agent` listing. |
| `model` | string | no | gateway default | Must be a model id the active provider recognizes. |
| `tools` | string[] | no | `[]` (SDK default) | Empty array = use the SDK's default tool set. Non-empty = allowlist of tool names. |

**Body** = system prompt. Always present; an empty body is allowed (the agent has no additional instructions beyond the SDK's defaults).

**Validation failures** fail the bot's startup with a clear error pointing at the offending file and field. *Per ADR 005.*

## Switch semantics

| Slash command | Effect on the session | Why |
|---|---|---|
| `/agent <name>` | Archive the current session; the next message creates a new session with the named agent. | The system prompt and tool set change. History doesn't carry over. *Pins: ADR 005.* |
| `/model <id>` | Switch the model on the *live* session; no archive, no new session. | Only the model changes; the agent identity and tool set are unchanged. |
| `/provider <id>` | Switch the provider on the *live* session; no archive, no new session. | Same as `/model`: only the underlying model host changes. |

In all three cases, the gateway also issues a synthetic first prompt that records the switch in the session history so the user (and the agent) can see what changed. *Per ADR 004.*

## Lifecycle

**At process startup:**
1. The registry reads `<configDir>/agents/*.md`.
2. For each file: parse frontmatter with gray-matter, validate with Zod, build an `AgentDefinition`.
3. Duplicate `name`: log a warning, keep the second one (matches ADR 005).
4. Malformed: throw, the bot refuses to start.
5. The registry sorts by name and freezes the list. The gateway uses the list for the rest of the process lifetime.

**At `/agent` with no arg:** the gateway lists all agents with description, with the active one marked.
**At `/agent <name>`:** the gateway calls `registry.get(name)`. If `null`, the user gets a "no such agent" error with the list of available names. Otherwise, the switch semantics above kick in.

**At process restart:** the registry reloads from disk. If the user edited an agent file, the new content is picked up — but active sessions keep using the *old* system prompt (it's already in the live session). Only new sessions see the new content.

## Concurrency & ordering

- The registry is **read-only after `load()`** in v1. No locking needed; all reads are synchronous and the underlying array never mutates.
- v2 hot-reload would add a lock and atomic-swap semantics; out of scope for v1.

## Failure modes

| Failure | Boundary promise |
|---|---|
| `agents/` dir missing | The registry uses only the default `assistant` agent that `npm run setup` scaffolds; logs a warning. |
| One agent file is malformed | Startup fails with a clear error pointing at the file and field. The bot refuses to start (per ADR 005). |
| `name` is missing in frontmatter | Startup fails; the file is treated as a validation error. |
| `name` is a duplicate | Logged; the second definition wins; the first is silently dropped. |
| `tools` lists a tool the SDK doesn't recognize | Passed through to the SDK; the SDK is the source of truth on tool names. Errors surface at session creation, not at agent load. |
| User edits an agent file mid-session | Active session keeps the old system prompt. New sessions (post-restart or after `/agent`) see the new content. *Hot-reload is v2; see open question Q4.* |

## Cross-references

- **Pinned by:** ADR 005.
- **Depends on:** `config.ts` (for the `agents.dir` path).
- **Depended on by:** the gateway's message handler (resolves the active agent on session creation); the WebUI's control surface (`07-webui-control-surface.md`) for the agent CRUD UI.

## CLI integration

The `copilot-agent` binary exposes agent-management subcommands. The CLI shares the agent registry's validation and file-format logic — it does not duplicate the parser.

| Subcommand | Effect |
|---|---|
| `copilot-agent agent list` | List all loaded agents, sorted by name, with the active one marked. |
| `copilot-agent agent show <name>` | Print the agent's source file (frontmatter + body). |
| `copilot-agent agent create <name>` | Scaffold a new agent `.md` from a template; opens `$EDITOR` for editing. |
| `copilot-agent agent edit <name>` | Open the agent file in `$EDITOR`. |
| `copilot-agent agent delete <name>` | Delete the agent file (refuses if the agent is the active one or the default). |

The `agent create` / `agent edit` / `agent delete` operations update the on-disk file; the bot picks up the change on next session creation (in-process registry reload is deferred to v2 — see open question 4 below).

## Open questions

1. **Skills system.** The current `npm run setup` scaffolds a `skills/` folder but no spec mentions it. v1 recommendation: **defer to v2.** The agent file format and registry don't need to know about skills in v1. A future v2 spec can introduce a `skills: [name1, name2]` field in the frontmatter and a parallel `skills/` dir.
2. **Hot-reload of agent definitions.** v1 recommendation: **YAGNI.** Restart on change is fine for a personal tool. A v2 extension could add a `chokidar` watcher that re-parses changed files and atomically swaps the registry entry, while active sessions keep their old system prompt. *Trade-off:* hot-reload complicates the registry's concurrency story (the `load()` becomes `reload()`) for a feature the user may not actually need.
