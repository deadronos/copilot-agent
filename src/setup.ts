import { mkdirSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveConfigDir } from "./config.js";

const CONFIG_TEMPLATE = `# copilot-agent configuration
# See idea.md for full documentation

# Active provider + model (runtime-switchable via /provider and /model)
active:
  provider: openai
  model: gpt-4o

# Named providers
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
  ollama:
    type: openai
    base_url: http://localhost:11434/v1
    # no api_key_env needed for local Ollama

# Telegram access control
telegram:
  allowed_user_ids: []     # ADD YOUR TELEGRAM USER ID HERE
  # token_env: TELEGRAM_BOT_TOKEN  # default

# Custom agents
agents:
  dir: ./agents
  default: assistant

# Session settings
session:
  history_dir: ./sessions
  max_messages: 200

# Permission gate
permissions:
  mode: approve-all        # approve-all | readonly-default | deny-all
  timeout_seconds: 300     # 5 minutes
`;

const ENV_TEMPLATE = `# copilot-agent secrets
# Fill in the values for the providers you want to use.

TELEGRAM_BOT_TOKEN=
COPILOT_GITHUB_TOKEN=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OPENCODE_GO_KEY=
`;

const ASSISTANT_AGENT = `---
name: assistant
description: General-purpose assistant. Answers questions, helps with tasks, and uses tools when needed.
---

# Assistant

You are a helpful personal assistant accessible via Telegram. You can answer questions,
help with tasks, write code, analyze data, and use tools when appropriate.

Be concise but thorough. Format responses for Telegram (use Markdown sparingly —
Telegram supports bold, italic, code blocks, and links).
`;

function main(): void {
  const configDir = resolveConfigDir();
  console.log(`Setting up copilot-agent in ${configDir}`);

  // Create directories
  const dirs = ["agents", "skills", "sessions", "logs"];
  for (const dir of dirs) {
    const full = join(configDir, dir);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      console.log(`  Created ${dir}/`);
    } else {
      console.log(`  ${dir}/ already exists`);
    }
  }

  // Write config template
  const configPath = join(configDir, "config.yaml");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, CONFIG_TEMPLATE);
    console.log("  Created config.yaml — EDIT THIS FILE to add your Telegram user ID");
  } else {
    console.log("  config.yaml already exists");
  }

  // Write .env template
  const envPath = join(configDir, ".env");
  if (!existsSync(envPath)) {
    writeFileSync(envPath, ENV_TEMPLATE);
    console.log("  Created .env — EDIT THIS FILE to add your API keys");
  } else {
    console.log("  .env already exists");
  }

  // Write default agent
  const agentPath = join(configDir, "agents", "assistant.md");
  if (!existsSync(agentPath)) {
    writeFileSync(agentPath, ASSISTANT_AGENT);
    console.log("  Created agents/assistant.md");
  } else {
    console.log("  agents/assistant.md already exists");
  }

  console.log("");
  console.log("Setup complete! Next steps:");
  console.log(`  1. Edit ${configPath}`);
  console.log(`     - Add your Telegram user ID to telegram.allowed_user_ids`);
  console.log(`  2. Edit ${envPath}`);
  console.log(`     - Add TELEGRAM_BOT_TOKEN and API keys for your chosen provider`);
  console.log(`  3. Run: npm start`);
}

main();
