import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';

import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';

import type { AppConfig, Preset } from './types.js';

// ── Config directory resolution ────────────────────────────────────

/**
 * Priority:
 *  1. `COPILOT_AGENT_CONFIG_DIR` env var
 *  2. `XDG_CONFIG_HOME/copilot-agent`
 *  3. `~/.config/copilot-agent`
 */
export function resolveConfigDir(): string {
  if (process.env.COPILOT_AGENT_CONFIG_DIR) {
    return path.resolve(process.env.COPILOT_AGENT_CONFIG_DIR);
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'copilot-agent');
  }
  return path.join(homedir(), '.config', 'copilot-agent');
}

// ── Config dir .env loading ───────────────────────────────────────
// CWD .env is loaded first by the import above. Then we load the
// config dir .env with override: true so it takes priority for
// secrets like API tokens.

{
  const dir = resolveConfigDir();
  dotenvConfig({ path: path.join(dir, '.env'), override: true });
}

// ── Zod schema (strict — rejects unknown keys) ─────────────────────

const ConfigSchema = z
  .object({
    active: z
      .object({
        preset: z.string(),
        model: z.string(),
      })
      .strict(),

    agents: z
      .object({
        dir: z.string().default('agents'),
        default: z.string().default('assistant'),
      })
      .strict()
      .default({ dir: 'agents', default: 'assistant' }),

    telegram: z
      .object({
        allowed_user_ids: z.array(z.number()),
        token_env: z.string().default('TELEGRAM_BOT_TOKEN'),
      })
      .strict(),

    session: z
      .object({
        history_dir: z.string().default('sessions'),
        max_messages: z.number().int().positive().default(50),
        max_idle_seconds: z.number().int().positive().default(1800),
      })
      .strict()
      .default({
        history_dir: 'sessions',
        max_messages: 50,
        max_idle_seconds: 1800,
      }),

    permissions: z
      .object({
        mode: z
          .enum(['approve-all', 'readonly-default', 'deny-all'])
          .default('readonly-default'),
        timeout_seconds: z.number().int().positive().default(60),
      })
      .strict()
      .default({ mode: 'readonly-default' as const, timeout_seconds: 60 }),

    channels: z
      .object({
        enabled: z.array(z.string()).default(['telegram']),
      })
      .strict()
      .default({ enabled: ['telegram'] }),
  })
  .strict();

// ── Config loading ─────────────────────────────────────────────────

export async function loadConfig(configDir?: string): Promise<AppConfig> {
  const dir = configDir ?? resolveConfigDir();
  const configPath = path.join(dir, 'config.yaml');

  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Config file not found at ${configPath}. Run 'npm run setup' to create it.`,
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse YAML in ${configPath}: ${String(err)}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid config at ${configPath}:\n${z.formatError(result.error)}`,
    );
  }

  return result.data as AppConfig;
}

// ── Preset loading ─────────────────────────────────────────────────

const PresetSchema = z
  .object({
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    provider: z.string().optional(),
  })
  .passthrough();

export async function loadPreset(
  configDir: string,
  presetId: string,
): Promise<Preset> {
  const presetPath = path.join(configDir, 'presets', `${presetId}.yaml`);
  let raw: string;
  try {
    raw = await fs.readFile(presetPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Preset not found: ${presetPath}`);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse YAML in ${presetPath}: ${String(err)}`);
  }

  const result = PresetSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid preset at ${presetPath}:\n${z.formatError(result.error)}`,
    );
  }

  const data = result.data as Record<string, unknown>;
  return { id: presetId, ...data } as Preset;
}

// ── Preset listing ─────────────────────────────────────────────────

export async function listPresets(configDir: string): Promise<string[]> {
  const presetsDir = path.join(configDir, 'presets');
  let entries: Dirent[];
  try {
    entries = await fs.readdir(presetsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  return entries
    .filter((d) => d.isFile() && /\.(yaml|yml)$/.test(d.name))
    .map((d) => d.name.replace(/\.(yaml|yml)$/, ''));
}

// ── Secrets resolution ─────────────────────────────────────────────

const SECRET_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
];

export function resolveSecrets(): Readonly<Record<string, string>> {
  const secrets: Record<string, string> = {};

  for (const key of SECRET_ENV_VARS) {
    const val = process.env[key];
    if (val) {
      secrets[key] = val;
    }
  }

  // Also pick up any *_API_KEY env vars (e.g. custom provider tokens).
  for (const [key, value] of Object.entries(process.env)) {
    if (key.endsWith('_API_KEY') && value && !(key in secrets)) {
      secrets[key] = value;
    }
  }

  return secrets;
}
