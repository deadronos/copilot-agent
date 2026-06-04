#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveConfigDir } from './config.js';
import { createDefaultAssistantAgent } from './agents.js';

// ── Helpers ──────────────────────────────────────────────────────────

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeIfMissing(
  filePath: string,
  content: string,
  label: string,
): Promise<'created' | 'skipped'> {
  if (await exists(filePath)) {
    process.stdout.write(`  ${label}: already exists, skipping\n`);
    return 'skipped';
  }
  await fs.writeFile(filePath, content, { mode: 0o600 });
  process.stdout.write(`  ${label}: created\n`);
  return 'created';
}

// ── Templates ────────────────────────────────────────────────────────

const CONFIG_YAML = `# copilot-agent configuration
# See README.md for full documentation.

active:
  preset: github-copilot          # change after running 'provider add'
  model: claude-sonnet-4-6

agents:
  dir: agents
  default: assistant

telegram:
  allowed_user_ids: []            # ADD YOUR TELEGRAM USER ID HERE
  token_env: COPILOT_AGENT_TELEGRAM_TOKEN

session:
  history_dir: sessions
  max_messages: 50
  max_idle_seconds: 1800

permissions:
  mode: readonly-default          # approve-all | readonly-default | deny-all
  timeout_seconds: 60

channels:
  enabled:
    - telegram
`;

const DOT_ENV = `# copilot-agent environment variables
# Uncomment and set the values you need.

# Telegram bot token (required)
COPILOT_AGENT_TELEGRAM_TOKEN=

# GitHub personal access token (for github-copilot provider)
# GITHUB_TOKEN=

# OpenAI API key (for openai provider)
# OPENAI_API_KEY=

# Anthropic API key (for anthropic provider)
# ANTHROPIC_API_KEY=

# Custom config directory (optional, defaults to ~/.config/copilot-agent)
# COPILOT_AGENT_CONFIG_DIR=
`;

function defaultAgentMarkdown(): string {
  const agent = createDefaultAssistantAgent();
  return `---
name: ${agent.name}
description: ${agent.description}
---

${agent.systemPrompt}
`;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configDir = resolveConfigDir();

  process.stdout.write(`Setting up copilot-agent in ${configDir}...\n\n`);

  // Create directories
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(configDir, 'agents'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(configDir, 'presets'), { recursive: true, mode: 0o700 });

  // Write template files
  process.stdout.write('Creating files:\n');
  await writeIfMissing(path.join(configDir, 'config.yaml'), CONFIG_YAML, 'config.yaml');
  await writeIfMissing(path.join(configDir, '.env'), DOT_ENV, '.env');
  await writeIfMissing(
    path.join(configDir, 'agents', 'assistant.md'),
    defaultAgentMarkdown(),
    'agents/assistant.md',
  );

  // Next steps
  process.stdout.write(`\nNext steps:
  1. Edit ${path.join(configDir, 'config.yaml')}
     → Add your Telegram user ID to telegram.allowed_user_ids
  2. Add your Telegram bot token to ${path.join(configDir, '.env')}
     → Set COPILOT_AGENT_TELEGRAM_TOKEN=...
  3. Run: node dist/index.js provider add github-copilot
  4. Start the bot: npm start
\n`);
}

main().catch((err) => {
  console.error('Setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
