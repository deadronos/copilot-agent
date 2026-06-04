# copilot-agent — concept

A personal assistant that runs as a Telegram bot and uses the [GitHub Copilot SDK](https://github.com/github/copilot-sdk) as its agentic backend. Configurable providers via BYOK (GitHub token, OpenAI, Anthropic, opencode-go, Ollama, anything OpenAI-compatible). You chat with it from Telegram on your phone like you'd chat with a smart friend who can also use tools.

> **Status:** concept / pre-implementation. This document captures the design we agreed on. The implementation plan will follow once you've signed off on it.

---

## 1. High-level architecture

```
┌──────────────────┐      ┌──────────────────────┐      ┌────────────────────┐
│  Telegram user   │ <──> │  copilot-agent bot   │ <──> │  Copilot CLI       │
│  (1:1 chat)      │      │  (Node.js process)   │ JSON │  (server mode,     │
└──────────────────┘      │                      │ RPC  │   spawned by SDK)  │
                          │  ┌────────────────┐  │      └────────────────────┘
                          │  │ Telegram layer │  │              │
                          │  ├────────────────┤  │              v
                          │  │ Command router │  │      ┌────────────────────┐
                          │  ├────────────────┤  │      │  LLM provider      │
                          │  │ Session store  │◀─┼───── │  (BYOK: GitHub,    │
                          │  ├────────────────┤  │      │   OpenAI, Anthropic│
                          │  │ Permission gate│  │      │   opencode-go, etc)│
                          │  ├────────────────┤  │      └────────────────────┘
                          │  │ Provider cfg   │  │
                          │  ├────────────────┤  │      ┌────────────────────┐
                          │  │ Agent loader   │──┼──>   │ ~/.config/         │
                          │  └────────────────┘  │      │  copilot-agent/    │
                          └──────────────────────┘      │   agents/*.md      │
                                                        │   skills/**/*.md   │
                                                        └────────────────────┘
```

**Three processes, four files on disk:**

1. **Telegram layer** — long-polling (grammY). Receives messages + callback queries, emits normalized events.
2. **Bot core** — command router, per-chat session map, permission gate, provider/model registry, custom agent loader.
3. **Copilot CLI** — SDK spawns it in server mode, JSON-RPC over stdio. We don't touch it directly.

**Files on disk** (under `~/.config/copilot-agent/` by default, overridable):

- `config.yaml` — providers, models, allowlist, active agent
- `.env` — `TELEGRAM_BOT_TOKEN`, API keys per provider
- `agents/*.md` — custom agents (markdown with frontmatter)
- `skills/**/*.md` — reusable agent skills

**One-way data flow:** Telegram → bot → SDK → CLI → provider. The permission gate is the only place the bot can hold a request open and ask the user.

---

## 2. Configuration model

Two files: `config.yaml` (non-secret) and `.env` (secrets). YAML chosen because comments + multi-line strings play nicely with provider presets and custom-agent metadata.

**`config.yaml`**

```yaml
# Active provider + model (runtime-switchable via /provider and /model)
active:
  provider: openai # matches a key in `providers:`
  model: gpt-4o

# Named providers — any combination of these. `type` is the SDK's ProviderConfig.type.
providers:
  github:
    type: openai
    base_url: https://api.githubcopilot.com
    bearer_token_env: COPILOT_GITHUB_TOKEN
  openai:
    type: openai
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
  anthropic:
    type: anthropic
    base_url: https://api.anthropic.com
    api_key_env: ANTHROPIC_API_KEY
  opencode-go:
    type: openai
    base_url: https://api.opencode-go.example/v1
    api_key_env: OPENCODE_GO_KEY
    wire_api: responses # for newer models that need it
  ollama:
    type: openai
    base_url: http://localhost:11434/v1
    # no api_key_env — local

# Telegram access control
telegram:
  allowed_user_ids: [123456789] # your Telegram ID; bot ignores everyone else
  # token_env: TELEGRAM_BOT_TOKEN  # default; override if you ever have multiple bots

# Custom agents — paths are relative to config dir
agents:
  dir: ./agents
  default: assistant # name (no .md) of the agent used for /start, /new

# Per-chat behavior
session:
  history_dir: ./sessions # on-disk JSONL of recent messages (for /resume, /new)
  max_messages: 200 # soft cap before /new is suggested

# Permission gate
permissions:
  mode: approve-all # approve-all | readonly-default | deny-all
```

**`.env`**

```
TELEGRAM_BOT_TOKEN=...
COPILOT_GITHUB_TOKEN=ghp_...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OPENCODE_GO_KEY=...
```

**Key choices:**

- `*_env` indirection: config stays committable (when you version your private config repo), secrets stay in `.env`.
- `active` is just a pointer — `/provider github` rewrites it in memory; `config.yaml` only changes when you also want to persist.
- `permissions.mode` is the only knob you usually touch; per-tool rules are a later feature if you ever need them.

---

## 3. Telegram surface

The bot speaks two dialects: **commands** (intentional actions) and **messages** (the actual conversation). Plus **inline callbacks** for permission prompts.

**Commands**

| Command              | Effect                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------- |
| `/start`             | Greets, shows current provider/model/agent, lists available providers and agents.       |
| `/new`               | Ends the current session and starts fresh. Archives prior to `sessions/<chatId>.jsonl`. |
| `/resume [n]`        | Resumes the n-th most recent archived session for this chat (default 1).                |
| `/provider [name]`   | With no arg: lists. With name: switches provider for this chat.                         |
| `/model [name]`      | With no arg: lists models for active provider. With name: switches.                     |
| `/agent [name]`      | With no arg: lists. With name: starts a new session with that agent.                    |
| `/status`            | Current provider, model, agent, message count, session uptime.                          |
| `/approve` / `/deny` | Replies to the most recent permission prompt in chat.                                   |
| `/help`              | One-line per command.                                                                   |

**Plain messages** (anything not starting with `/`) are forwarded to the active session. The full SDK response streams back. The bot handles three response shapes from the SDK:

- **text** → reply with the text (Markdown). Telegram has a 4096-char limit, so long replies are split.
- **tool call** → no reply to user yet; the permission gate takes over (see Section 5).
- **tool result** → no user reply; the agent continues internally. We may show a "thinking…" indicator that we update on the final text.

**Inline callbacks** (used by the permission gate)
The bot sends a message like:

> ⚠️ Agent wants to run `rm -rf /tmp/build`
> ✅ Allow once 🔁 Allow for this session 🚫 Deny

Buttons attach `callback_data` like `perm:allow-once:<requestId>`, `perm:allow-session:<requestId>`, `perm:deny:<requestId>`. The bot matches them to the pending request and unblocks the SDK.

**Updates to user-visible messages** (typing indicator, then final reply) use `message.editMessageText` so the chat doesn't fill with "thinking…" follow-ups. The typing indicator is sent on every incoming user message and stopped on the first SDK event for that request.

**Markdown formatting:** SDK output is assumed-Markdown, but Telegram only supports a subset. We pipe it through a Markdown→Telegram converter (e.g., `telegramify-markdown`) so headings, tables, code blocks, etc. all render. Long code blocks get a "show full" inline button if truncated.

---

## 4. Session management

The bot keeps **one SDK session per Telegram chat ID**, in memory. Sessions are short-lived across restarts unless explicitly archived.

**Lifecycle**

1. **Lazy creation.** First message in a chat → `client.createSession({ provider, model, systemPrompt, tools, customAgents })`. The session is cached in a `Map<chatId, SessionEntry>`.
2. **Reuse.** Subsequent messages in the same chat reuse the cached session — full conversation history is preserved (the SDK manages it).
3. **Switching provider or model.** `/provider github` or `/model claude-sonnet-4-6` ends the current session, creates a new one with the new provider/model, and _carries forward the message history_ as the first user turn in a synthetic prompt: "Continuing from <chat>'s previous session: …". This keeps continuity without depending on the SDK's cross-provider history support.
4. **Switching agent.** `/agent writer` always ends the session and starts fresh — different agent = different system prompt and tool set, so prior history doesn't apply.
5. **Archive + reset.** `/new` writes the last N messages to `sessions/<chatId>-<timestamp>.jsonl`, then drops the session. On restart, `/resume` can replay that JSONL into a new session.
6. **Eviction.** On bot shutdown, all in-memory sessions are archived. On startup, nothing is auto-loaded — `/resume` is opt-in, so you always start fresh unless you ask.

**Data model**

```ts
type SessionEntry = {
  chatId: number;
  sessionId: string; // SDK session ID
  provider: string; // ref into config.providers
  model: string;
  agentName: string; // default "assistant"
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  pendingPermission?: PendingPermission;
};
```

**Soft cap.** When `messageCount >= session.max_messages` (default 200), the bot _suggests_ `/new` after the next reply but doesn't enforce it.

**Concurrency.** Telegram can deliver two messages from the same chat in quick succession. We serialize per chat with an `async` queue (one promise chain per `chatId`) so the SDK session isn't called re-entrantly. Different chats run in parallel.

**Crash safety.** If the bot process dies mid-conversation, the in-memory session is lost. The `sessions/` directory is the user's safety net: any code path that ends a session archives it. This isn't a full chat-history replay feature, just a recovery path.

---

## 5. Permission flow

The SDK's permission handler fires before every tool call. We use it to gate **everything** by default, then layer allow/deny/once semantics on top via Telegram inline buttons.

**The flow, end-to-end**

1. The agent decides to call a tool (e.g., `Bash`, `Edit`, `Read`).
2. The SDK calls our `PermissionHandler` with `{ toolName, args, requestId, sessionId }`.
3. Our handler returns a `Promise<{ decision: "allow" | "deny", reason?: string }>` — it does **not** resolve until the user replies in Telegram.
4. The bot:
   - Sends a Telegram message with a description of the tool call and three inline buttons: **Allow once** / **Allow for session** / **Deny**.
   - Stores the pending request keyed by `requestId` and tagged with the originating `chatId` (the user might be in a group with the bot in the future).
   - Resumes a `sendChatAction("typing")` indicator so the user knows the agent is still working.
5. The user taps a button → Telegram sends a `callback_query`. We resolve the promise with the chosen decision and edit the prompt message to show the choice ("✅ allowed" / "🚫 denied").
6. The SDK either continues the tool call or surfaces a "permission denied" error to the agent, which it then handles in its next turn.

**Where the state lives**

- Pending requests live in a `Map<requestId, { chatId, resolve, messageId }>`.
- `session.entry.pendingPermission` is the _current_ one (the most recent), used so `/approve` and `/deny` text commands can target it without a callback.
- "Allow for session" decisions accumulate in a `Set<toolName>` on the `SessionEntry` — that set is passed into subsequent permission checks so the same tool auto-approves for the rest of that session.

**Modes** (from `config.yaml → permissions.mode`)

| Mode                    | Behavior                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `approve-all` (default) | Every tool call goes through inline-approve. Nothing is auto-approved.                                |
| `readonly-default`      | Read-only tools (`Read`, `Glob`, `Grep`, `list`) auto-approve; everything else goes through the gate. |
| `deny-all`              | Hard refusal on every tool call. Useful when you only want chat.                                      |

`approve-all` is the default. The other two are escape hatches you can flip later.

**Edge cases**

- **User denies** → the bot resolves the promise with `{ decision: "deny", reason: "user denied" }`. The agent gets a permission error and can either ask the user something else via text or move on.
- **User doesn't reply** → request times out after 5 minutes (configurable). Default behavior is to deny and tell the agent "user did not respond in 5 minutes."
- **Bot restarts mid-prompt** → the pending promise rejects, the agent gets a permission error, and the user can retry by sending a new message.
- **Two simultaneous tool calls** → only one prompt is shown at a time. The second is queued (we show a "1 more tool call pending" line below the first prompt). When the first is resolved, the second is shown.
- **Telegram message edit fails** (e.g., the user deleted the prompt message) → we fall back to sending a fresh message with the result.

---

## 6. Custom agents + skills

Custom agents and skills are the SDK's "behavior pack" — markdown files that define how the agent thinks and what it can do. The bot just needs to point the SDK at them.

**Where they live**

```
~/.config/copilot-agent/
├── config.yaml
├── .env
├── agents/
│   ├── assistant.md        # default; loaded at startup
│   ├── writer.md
│   └── coder.md
└── skills/
    ├── summarize/
    │   └── SKILL.md
    └── journal/
        └── SKILL.md
```

`agents/<name>.md` is the file the SDK consumes. `skills/<skill-name>/SKILL.md` is a single file per skill, with optional `references/` and `examples/` siblings.

**Agent file format** (markdown + frontmatter; the SDK's custom-agent format)

```markdown
---
name: writer
description: Long-form writing assistant. Use for blog posts, essays, and reports.
model: claude-sonnet-4-6 # optional per-agent default; falls back to active.model
tools: # optional restricted tool set
  - read
  - websearch
  - webfetch
---

# Writer

You are a long-form writing assistant. Match tone to the requested form…
```

**What the bot does with them**

- At startup, the bot **scans `agents/*.md`**, parses frontmatter + body, and registers them with the SDK via `createSession({ customAgents: [...] })`.
- The active agent's name + body are passed as `systemPrompt` (or via the SDK's `customAgent` parameter if its API supports direct agent-name reference — we'll wire whichever the SDK exposes cleanly; this is the part to confirm when we get to the implementation plan).
- When you `/agent writer`, the bot ends the current session and starts a new one with `writer.md` as the active agent.
- Skills are _not_ loaded per-session; they're declared once at the client level via the SDK's skills config so any agent can invoke them. The user doesn't switch skills — the agent decides when a skill applies based on the skill's `description` field.

**Validation at load time**

- Missing `name` → bot warns at startup, skips the file.
- `model` references a provider that's not configured → bot warns, falls back to `active.model`.
- Duplicate `name` → second one wins, first is logged as a warning.
- Malformed frontmatter → bot refuses to start and points at the offending file.

**Why custom agents + skills (and not hardcoded prompts)**

- New behaviors = new `.md` file. No code change, no rebuild.
- Same agent definition works whether invoked from Telegram, the CLI, or VS Code.
- Skills compose: `writer` can use `summarize` and `journal` skills without knowing about them at definition time.

---

## 7. Error handling

Five places things can go wrong, and what we do about each. The principle: **fail loudly in your Telegram chat, never silently**, and prefer graceful degradation over crashes.

**1. SDK / CLI process dies**

- The bot watches the SDK client's `error` and `exit` events.
- On unexpected exit, the bot sends the affected chats: "⚠️ The Copilot backend stopped. I'll try to recover on your next message."
- Next incoming message triggers a `client.restart()` + fresh session for that chat.
- A structured log goes to `logs/copilot-agent.log` (rotated daily) with the stack.

**2. Provider errors (rate limit, auth, model not found, network)**

- The SDK surfaces these as `session.error` events with a typed `reason` field.
- We map to user-friendly Telegram messages:
  - `unauthorized` → "🔑 Provider rejected the API key. Check `config.yaml` + `.env`, then `/provider <name>` to retry."
  - `rate_limited` → "⏳ Rate-limited by the provider. I'll auto-retry in <N>s." (we retry up to 3× with exponential backoff before giving up)
  - `model_not_found` → "❌ Model '<name>' isn't available on this provider. `/model` to pick another."
  - `network` / `timeout` → "🌐 Network blip. Retrying…" (one auto-retry, then surface to user)
- All errors are logged with the full provider response (sanitized of API keys).

**3. Telegram-side errors**

- Bot token invalid → log + exit non-zero so a process manager (pm2, systemd, Docker restart) can flag it.
- Telegram rate limit (HTTP 429 with `retry_after`) → global token-bucket queue. We pause _outgoing_ messages until the window clears, never drop.
- Sending a message fails (user blocked the bot, chat deleted) → log + drop that chat from the session map; don't crash the process.
- `callback_query` arrives for an unknown `requestId` (user clicked an old prompt) → answer with "⏰ This prompt has expired."

**4. Permission gate failures**

- User doesn't reply within 5 min → deny, tell the agent "user did not respond," log it.
- Bot crashes between prompt and reply → pending promise rejects, agent gets "permission check failed," user can retry by sending a new message.
- Inline button click races with a timeout → first-wins (the map entry is deleted when the promise resolves; second click gets a "stale prompt" answer).

**5. Configuration / startup errors**

- `config.yaml` missing required fields → fail at startup with a single readable error pointing at the field.
- `.env` missing a referenced `*_env` variable → same — fail at startup, list the missing keys.
- `agents/*.md` malformed → refuse to start, list the offending files.
- Telegram `allowed_user_ids` empty → refuse to start ("refusing to run with empty allowlist — that's a bot open to the world").

**Logging**

- Structured JSON to `logs/copilot-agent.log` (rotated via `pino` + `pino-roll`).
- Log levels: `debug` (SDK events, full payloads), `info` (lifecycle: session created, provider switched), `warn` (recoverable errors), `error` (things the user should know about).
- No secrets in logs. A small `redact` list strips `*_key`, `*_token`, `bearer_token`, `TELEGRAM_BOT_TOKEN`, etc.

**What we explicitly do NOT do**

- Catch-all `try/catch` that swallows errors.
- Silent fallbacks (e.g., switching providers on auth error without telling the user).
- Crash-looping on a recoverable error — we log, surface, and keep serving other chats.

---

## 8. Testing

Three layers, each catching a different class of bug. Tests run via `vitest` (TypeScript-native, fast, no extra build step).

**Layer 1 — Unit tests (fast, no I/O)**

What they cover:

- `config.yaml` + `.env` parsing, including the `*_env` indirection, with fixtures for "missing key," "unknown provider," "duplicate agent name," etc.
- Provider/model switching logic in isolation — given a session, switch to provider X, assert the new session is created with the right `ProviderConfig`.
- Session history carry-forward: given an old session transcript, the synthetic "Continuing from…" prompt is shaped correctly.
- Command router: each command (`/provider`, `/model`, `/agent`, `/new`, `/resume`, `/status`, `/approve`, `/deny`) parses its input and produces the right action.
- Permission gate decision logic: clicking Allow-once, Allow-for-session, Deny, timeout, and stale-callback all resolve the right promise outcome.
- Markdown → Telegram conversion (long-message splitting, unsupported tag stripping).
- Log redaction: feed in a payload with `api_key`, `bearer_token`, etc., assert they're `***` in the output.

What they don't cover: real SDK calls, real Telegram API calls.

**Layer 2 — Integration tests with a fake SDK + fake Telegram**

A test harness with two in-memory fakes:

- **Fake Copilot client** — implements the same `createSession` / `sendAndWait` / permission-handler surface, but lets tests script responses (return this text, then a tool call, then a tool result, then a final answer). Also lets tests assert "the bot sent a permission prompt with this exact body."
- **Fake Telegram transport** — feeds scripted `message` and `callback_query` events into the bot, captures every outgoing `sendMessage` / `editMessageText` / `answerCallbackQuery` call, and lets tests assert on them.

What this layer covers:

- End-to-end "user says hello → agent replies with text" with no tool calls.
- "User says run a tool → bot shows prompt → user clicks allow once → bot runs tool → agent replies."
- "User clicks allow for session → second tool call of same name auto-approves."
- "Two chats, two sessions, two providers, no cross-talk."
- "Provider returns `unauthorized` → bot tells the user, suggests `/provider`."
- "Pending permission times out after 5 min → deny propagates to agent."
- "Provider switched mid-conversation → history is carried forward as the first user turn."

**Layer 3 — Live smoke test (manual, not in CI)**

A short `npm run smoke` script that:

1. Starts the bot pointed at a real `TELEGRAM_BOT_TOKEN` for a throwaway test bot.
2. Sends `/start`, `/provider`, `/status`, `/new` from a test Telegram account.
3. Sends one real message and asserts a real reply comes back.
4. Sends a message that should trigger a tool-call permission prompt and asserts the inline buttons appear.
5. Exits non-zero if any step takes longer than 30s or returns an error.

The smoke test is run by you before tagging a release, not on every commit. We document it in `README.md` and gate the release section of the changelog on "smoke test passed."

**Coverage target:** 80% lines on `src/**` (the bot core), excluding the fakes themselves. CI fails the build below that.

**What we explicitly do not test**

- The SDK's own behavior — we trust it.
- Telegram's servers — we trust the fake at Layer 2, and smoke at Layer 3 catches the gaps.
- The Copilot CLI's JSON-RPC protocol — that's the SDK's job.
- Agent prompts themselves (the markdown in `agents/*.md`) — those are validated at load time but not "tested" for behavior. If you want behavioral tests of the agent's answers, that's a separate harness (e.g., a fixture-driven eval suite) and a later feature.

---

## 9. Deployment

Two supported ways to run the bot, sharing the same code and config layout. No deployment-specific branches in the code — the differences are entirely in how the config dir is found and how the process is supervised.

**Path resolution (XDG-style, with overrides)**

Resolution order, first wins:

1. `COPILOT_AGENT_CONFIG_DIR` env var (explicit override; Docker uses this).
2. `$XDG_CONFIG_HOME/copilot-agent` if `XDG_CONFIG_HOME` is set.
3. `~/.config/copilot-agent` (default on Mac/Linux).
4. Windows fallback: `%APPDATA%\copilot-agent` (we don't test on Windows, but the resolver supports it).

The config dir is the single source of truth for `config.yaml`, `.env`, `agents/`, `skills/`, `sessions/`, `logs/`. The bot creates any missing subdirs on first run.

**Mode A — Local development / single-machine**

```bash
git clone <repo> ~/code/copilot-agent
cd ~/code/copilot-agent
nvm use                # reads .nvmrc → Node 24
npm install
npm run setup            # creates ~/.config/copilot-agent/ with template config.yaml + .env
$EDITOR ~/.config/copilot-agent/config.yaml
$EDITOR ~/.config/copilot-agent/.env
npm start                # foreground
```

`.nvmrc` contains `24` and `package.json` has `"engines": { "node": ">=24.0.0" }`. `npm install` warns if local Node is older; CI uses the same `engines` constraint.

For long-running use, `npm run setup:service` registers a `launchd` plist (Mac) or `systemd --user` unit (Linux) that restarts the bot on crash and starts it at login. The plist/unit just runs `npm start` from the cloned repo dir.

**Mode B — Docker**

`Dockerfile` is a multi-stage Node 24 image, ~150MB. `docker-compose.yml` mounts the config dir as a read-write volume and reads secrets from a `.env` file next to `docker-compose.yml` (Docker's native mechanism — we don't reimplement it):

```yaml
services:
  bot:
    build: .
    restart: unless-stopped
    volumes:
      - ./copilot-agent-data:/data/copilot-agent
    environment:
      - COPILOT_AGENT_CONFIG_DIR=/data/copilot-agent
    env_file:
      - .env # beside docker-compose.yml; injected at container start
```

The entrypoint is `node dist/index.js`. Logs go to stdout (Docker's default log driver captures them). The mounted config dir persists `agents/`, `skills/`, `sessions/`, `logs/` across container recreations. Runs as a non-root user.

**Why this shape**

- **One config dir, two runtimes.** No "Docker config" vs "local config" divergence.
- **Secrets in `.env` either way.** Locally, the bot reads it. In Docker, compose injects it. Either way, `config.yaml` references `*_env` names, never literal keys.
- **Process supervision is a host concern, not the bot's.** The bot doesn't manage its own restarts; launchd/systemd/Docker do. We just have to exit cleanly on SIGTERM and persist sessions before exit (covered in Section 4).

**Versioning and updates**

- Local: `git pull && npm install && npm start` (the service unit picks up the new process on next start).
- Docker: `docker compose pull && docker compose up -d`. The config volume is preserved, so `config.yaml`, `.env`, `agents/`, and `sessions/` survive the image swap.
- We commit a `CHANGELOG.md` and tag releases. Breaking changes to `config.yaml` ship with a one-time migration in `npm run setup` (or, in Docker, an entrypoint hook).

**What we explicitly do not provide (yet)**

- A cloud-hosted version. The whole point of a personal assistant is that it runs where you do.
- TLS-terminated webhook mode. Polling works fine for one user; if we ever needed webhooks, it'd be a follow-up.
- Auto-update. You pull; we don't push.

---

## Open questions / future work

These are intentional deferrals, not gaps:

- **Long-term memory** beyond per-session: facts about you that survive across sessions (preferences, recurring projects). Would need a small vector or key-value store, an extraction step on session end, and an injection step on session start. _Not in v1._
- **Voice notes** (Telegram supports voice messages): needs STT (Whisper, etc.) on the way in and TTS on the way out. _Not in v1._
- **Image inputs** (Telegram photo messages): the SDK can handle vision-capable models; we'd just plumb the bytes through. Easy to add later.
- **Multiple Telegram users**: the allowlist supports it already, but per-user config (different default provider, different agents) is _not_ in v1.
- **Group chats**: works technically, but no per-message @-mention gating yet. _Not in v1._
- **Per-tool permission rules** (e.g., "auto-allow `Read`, always prompt for `Bash`"): the architecture supports it, only the config knob is missing. _Not in v1._
- **Behavioral eval suite** for the custom agents: separate harness, separate concern. _Not in v1._

---

## Next step

Once you sign off on this concept, the next step is an **implementation plan** — a sequenced, testable set of tasks that builds the bot in working slices (config + boot first, then Telegram, then sessions, then permission gate, then providers, then agents). That's a separate document, generated by the writing-plans skill.
