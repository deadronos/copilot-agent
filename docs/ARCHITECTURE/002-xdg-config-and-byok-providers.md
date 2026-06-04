# ADR 002 — XDG config layout and BYOK provider model

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** copilot-agent project

## Context

The bot needs a configuration system that works across platforms, doesn't leak secrets, and supports multiple BYOK (Bring Your Own Key) LLM providers. Configuration must be editable by both humans (text editor) and the CLI.

## Decision

### XDG-style config directory resolution

`src/config.ts` resolves the config directory with this priority:

1. `COPILOT_AGENT_CONFIG_DIR` env var (explicit override)
2. `XDG_CONFIG_HOME/copilot-agent` (XDG convention)
3. `~/.config/copilot-agent` (fallback)

**Implementation:** `resolveConfigDir()` in `src/config.ts`.

### Single `config.yaml` with Zod validation

All configuration lives in `<configDir>/config.yaml`, validated by a strict Zod schema (`ConfigSchema` in `src/config.ts`). Unknown keys are rejected. The schema covers:

| Section | Key fields |
|---|---|
| `active` | `preset`, `model` |
| `agents` | `dir`, `default` |
| `telegram` | `allowed_user_ids`, `token_env` |
| `session` | `history_dir`, `max_messages`, `max_idle_seconds` |
| `permissions` | `mode`, `timeout_seconds` |
| `channels` | `enabled` |

**Defaults are baked into the Zod schema**, not into a separate defaults file — the schema is the source of truth for default values.

### Secrets only in env vars

All API keys, tokens, and credentials are read from environment variables at runtime. No secrets appear in `config.yaml`, in archive JSON files, or in log output. `src/config.ts` defines a `SECRET_ENV_VARS` list and a `resolveSecrets()` function that also discovers any `*_API_KEY` env vars.

The pino logger in `src/logger.ts` redacts secrets via its built-in redaction paths.

### Per-deployment state in presets, not in config

Provider-specific configuration (auth method, token file path, base URL, model catalog) lives in `<configDir>/presets/<name>.yaml` — **not** in `config.yaml`. The `active.preset` field in `config.yaml` is a reference to a preset, not a provider config block. This keeps `config.yaml` small and provider-agnostic.

**Implementation:** `loadPreset()` and `listPresets()` in `src/config.ts`.

## Consequences

- **Positive:** The config system is portable across macOS, Linux, and WSL without hardcoded paths.
- **Positive:** Secrets cannot leak through config files or archives because they're never written to disk by the bot.
- **Positive:** The preset indirection means the same `config.yaml` works regardless of which provider the user has configured — switching providers requires only changing the `active.preset` field.
- **Negative:** New users must set env vars before starting the bot. The `npm run setup` command scaffolds a `.env` file to guide them.
- **Negative:** The strict schema means adding a new config field requires a schema change + migration logic if backward compatibility is needed.

## References

- `src/config.ts` — `resolveConfigDir`, `loadConfig`, `loadPreset`, `listPresets`, `resolveSecrets`
- `src/logger.ts` — pino secret redaction
- `docs/specs/08-providers.md`
- `docs/specs/00-high-level.md` — cross-cutting principle "Secrets only in env vars"
