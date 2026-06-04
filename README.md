# copilot-agent

A personal assistant that runs as a Telegram bot, powered by the [GitHub Copilot SDK](https://github.com/github/copilot-sdk) as its agentic backend. Configurable providers via BYOK (GitHub token, OpenAI, Anthropic, Ollama, anything OpenAI-compatible).

## Quick start

```bash
# Clone and install
git clone <repo> && cd copilot-agent
npm install

# Set up config directory
npm run setup

# Edit config
$EDITOR ~/.config/copilot-agent/config.yaml   # add your Telegram user ID
$EDITOR ~/.config/copilot-agent/.env           # add TELEGRAM_BOT_TOKEN + API keys

# Run
npm start
```

## Commands

| Command | Effect |
|---|---|
| `/start` | Greet, show current provider/model/agent |
| `/new` | Start a fresh session |
| `/resume [n]` | Resume the n-th most recent archived session |
| `/provider [name]` | List or switch provider |
| `/model [name]` | List or switch model |
| `/agent [name]` | List or switch agent |
| `/status` | Show current session info |
| `/approve` / `/deny` | Reply to the most recent permission prompt |
| `/help` | Show commands |

## Configuration

Config lives in `~/.config/copilot-agent/` (overridable via `COPILOT_AGENT_CONFIG_DIR`).

- `config.yaml` — providers, models, allowlist, active agent
- `.env` — API keys and tokens
- `agents/*.md` — custom agent definitions (markdown with frontmatter)
- `skills/**/*.md` — reusable agent skills
- `sessions/` — archived session history

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

### Systemd (Linux)

```bash
npm run setup:service
```

### Launchd (macOS)

```bash
npm run setup:service
```

## Development

```bash
npm run dev      # watch mode with tsx
npm test         # run tests
npm run typecheck # type-check without building
```
