# ADR 005: Custom Agents as Markdown Files with YAML Frontmatter

**Status:** Accepted  
**Date:** 2026-06-01  
**Deciders:** @deadronos

## Context

Users need different agent personalities for different tasks (a coder, a writer, a general assistant). These agents must be:

- Definable without code changes (plain text files)
- Switchable at runtime via Telegram commands
- Compatible with the Copilot SDK's agent system
- Validated at load time (malformed agents shouldn't crash the bot at runtime)

## Decision

**Define custom agents as Markdown files with YAML frontmatter, stored in `agents/*.md`, loaded at startup, and registered with the SDK.**

Agent file format:
```markdown
---
name: writer
description: Long-form writing assistant. Use for blog posts, essays, and reports.
model: claude-sonnet-4-6  # optional per-agent default; falls back to active.model
tools:                     # optional restricted tool set
  - read
  - websearch
  - webfetch
---

# Writer

You are a long-form writing assistant. Match tone to the requested form…
```

Parsing (in `agents.ts`):
```typescript
function parseAgentFile(filePath: string): AgentDefinition | null {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);

  if (!data.name) {
    log.warn({ filePath }, "Agent file missing 'name' in frontmatter, skipping");
    return null;
  }

  return {
    name: data.name,
    description: data.description ?? '',
    model: data.model,           // optional override
    tools: data.tools,           // optional restriction
    prompt: content.trim(),      // the markdown body becomes the system prompt
  };
}
```

The frontmatter is parsed with `gray-matter`. The body (markdown below the `---` fence) becomes the agent's system prompt, passed to the SDK as `systemMessage: { mode: 'replace', content: agent.prompt }`.

Agent switching (`/agent writer`):
1. Ends the current SDK session (archiving it first)
2. Creates a new session with the new agent's system prompt and optional model override
3. If the agent specifies a `model`, it overrides the active model for that session
4. If the agent specifies `tools`, they are passed to the SDK (currently advisory)

Validation at load time:
- Missing `name` → skipped with warning
- Duplicate `name` → later file wins, warning logged
- Malformed frontmatter → bot refuses to start, error points at the offending file
- Default agent not found → warning logged, bot continues without a default system prompt

## Rationale

1. **Markdown + frontmatter is the SDK's native format.** Custom agents defined this way work identically in Telegram, the Copilot CLI, and VS Code. No format conversion needed.
2. **No code change for new agents.** Drop a `.md` file in `agents/`, restart the bot, and `/agent <name>` works. This is the primary extensibility mechanism.
3. **`gray-matter` is a minimal, battle-tested frontmatter parser.** 7M+ weekly downloads, no dependencies, handles YAML frontmatter exactly as expected.
4. **Validation at startup catches errors early.** A malformed agent file shouldn't surface as a runtime error 3 hours into a conversation. The bot checks all agents at boot.
5. **Agent's `model` override is per-agent, not per-session.** If the `writer` agent wants Claude, it always gets Claude — regardless of what `/provider` and `/model` say. This keeps agent definitions self-contained.
6. **System prompt mode is `replace`, not `append`.** Each agent gets its own prompt. We don't layer prompts because different agents have fundamentally different instructions.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Hardcoded agents in TypeScript | Requires a code change + rebuild for every new agent. Defeats the purpose of extensibility. |
| Database-stored agents | Adds persistence complexity. Markdown files in a directory are simpler — edit with any text editor, version with git. |
| JSON-only agent definitions | No natural place for the system prompt. Markdown's body-as-prompt convention is more natural for long-form instructions. |
| Agent switching without session reset | Different agents have different system prompts and tool sets. Mixing them in one session would produce inconsistent behavior. Fresh session is the safe choice. |
| Hot-reloading agents | Adds complexity for a feature used at startup. Restart the bot to pick up new agents — it takes seconds. |

## Consequences

### Positive
- Adding a new agent is a single `.md` file
- Agents are self-documenting (the markdown is both prompt and documentation)
- The SDK sees agents in its native format — no impedance mismatch
- Frontmatter supports arbitrary metadata (we can add `temperature`, `max_tokens`, etc. later)
- Validation prevents silent failures from malformed agent files

### Negative
- Agent changes require a bot restart (not hot-reloaded)
- No per-agent permission mode (all agents share the global permission config)
- The `tools` field in frontmatter is advisory; the SDK ultimately decides tool availability

### Mitigations
- `npm run dev` with `tsx watch` provides near-instant restarts during development
- Per-agent tool restrictions can be wired through the permission gate if needed
- The `tools` field is parsed and available in `AgentDefinition` — ready for when the SDK or permission gate uses it
