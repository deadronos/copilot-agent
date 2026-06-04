# copilot-agent

A personal AI assistant powered by the [GitHub Copilot SDK](https://github.com/github/copilot-sdk). Multi-channel architecture with plug-in adapters (Telegram today, more planned). Provider plug-in system (GitHub Copilot, OpenAI, Anthropic, Ollama, anything OpenAI-compatible) configured via BYOK presets. TypeScript on Node 24, ESM.

## Quick start

```bash
# Clone and install
git clone <repo> && cd copilot-agent
npm install

# Build
npm run build

# Scaffold config directory (~/.config/copilot-agent/)
npm run setup

# Edit config (add your Telegram user ID)
$EDITOR ~/.config/copilot-agent/config.yaml

# Set your tokens in the .env file
$EDITOR ~/.config/copilot-agent/.env

# Create a provider preset (interactive onboarding)
node dist/index.js provider add github-copilot

# Run the bot
npm start
```

## Bot commands

| Command | Effect |
| --- | --- |
| `/new` | Start a fresh session |
| `/resume [n]` | Resume the n-th most recent archived session (default: 1) |
| `/provider <id>` | Switch preset |
| `/model <id>` | Switch model |
| `/agent [name]` | List agents, or switch to the named agent |
| `/status` | Show current session info |
| `/approve` | Approve the most recent pending tool |
| `/deny` | Deny the most recent pending tool |
| `/help` | Show commands |

## CLI

The entrypoint doubles as a CLI. Pass subcommands as arguments:

```bash
node dist/index.js provider list           # list configured presets
node dist/index.js provider add <id>       # add a preset (interactive onboarding)
node dist/index.js provider remove <name>  # delete a preset
node dist/index.js provider show <name>    # print preset details (secrets redacted)
node dist/index.js provider login <name>   # authenticate a preset
node dist/index.js provider logout <name>  # deauthenticate a preset
node dist/index.js provider refresh <name> # discover models for a preset

node dist/index.js agent list              # list all agents
node dist/index.js agent show <name>       # print agent source file
node dist/index.js agent create <name>     # scaffold a new agent and open $EDITOR
node dist/index.js agent edit <name>       # open agent file in $EDITOR
node dist/index.js agent delete <name>     # delete an agent file

node dist/index.js config get [key]        # print config (secrets redacted)
node dist/index.js config set <key> <val>  # update a config entry
```

## Configuration

Config lives in `~/.config/copilot-agent/` (overridable via `COPILOT_AGENT_CONFIG_DIR`).

### config.yaml

```yaml
active:
  preset: github-copilot
  model: claude-sonnet-4-6

agents:
  dir: agents
  default: assistant

telegram:
  allowed_user_ids: [123456789]   # your Telegram user ID
  token_env: COPILOT_AGENT_TELEGRAM_TOKEN

session:
  history_dir: sessions
  max_messages: 50
  max_idle_seconds: 1800

permissions:
  mode: readonly-default          # approve-all | readonly-default | deny-all
  timeout_seconds: 60

channels:
  enabled: [telegram]
```

### presets/`<name>`.yaml

Per-provider state created by `provider add`. Example:

```yaml
provider: github-copilot
model: claude-sonnet-4-6
auth:
  kind: device_flow
  clientId: Iv23li...
  tokenFile: /Users/you/.config/copilot-agent/presets/github-copilot.token
models:
  - id: claude-sonnet-4-6
    displayName: "Claude Sonnet 4.6"
  - id: gpt-5
    displayName: "GPT-5"
  - id: gemini-2.5-pro
    displayName: "Gemini 2.5 Pro"
```

### agents/*.md

Custom agent definitions (markdown with frontmatter).

### sessions/

Archived session history.

### Environment variables

Set API tokens in `<configDir>/.env` or export them directly.

| Variable                          | Purpose                     |
| --------------------------------- | --------------------------- |
| `COPILOT_AGENT_TELEGRAM_TOKEN`    | Telegram bot token          |
| `COPILOT_AGENT_CONFIG_DIR`        | Override config directory   |
| `GITHUB_TOKEN`                    | GitHub API token            |
| `OPENAI_API_KEY`                  | OpenAI API key              |
| `ANTHROPIC_API_KEY`               | Anthropic API key           |

## Custom agents

Create markdown files in `~/.config/copilot-agent/agents/`:

```markdown
---
name: writer
description: Long-form writing assistant.
model: claude-sonnet-4-6
---

You are a long-form writing assistant...
```

Switch with `/agent writer`.

## Deployment

### Docker

```bash
docker compose up -d
```

The compose file mounts `./copilot-agent-data` as the config directory (`COPILOT_AGENT_CONFIG_DIR=/data/copilot-agent`). Set API tokens in `.env`.

## Development

```bash
npm run dev       # watch mode with tsx
npm test          # run tests (vitest)
npm run typecheck # type-check without building
npm run lint      # lint source
npm run build     # compile TypeScript
```
