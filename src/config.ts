import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { config as loadDotenv } from 'dotenv';
import { ConfigSchema, type AppConfig } from './types.js';

/**
 * Resolve the config directory using XDG-style rules.
 * Order: COPILOT_AGENT_CONFIG_DIR > XDG_CONFIG_HOME/copilot-agent > ~/.config/copilot-agent
 */
export function resolveConfigDir(): string {
  const explicit = process.env.COPILOT_AGENT_CONFIG_DIR;
  if (explicit) return resolve(explicit);

  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'copilot-agent');

  return join(homedir(), '.config', 'copilot-agent');
}

/**
 * Load and validate config from the config directory.
 * Reads config.yaml and .env, validates with Zod.
 */
export function loadConfig(configDir?: string): AppConfig {
  const dir = configDir ?? resolveConfigDir();

  // Load .env first so env vars are available for config resolution
  const envPath = join(dir, '.env');
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }

  const configPath = join(dir, 'config.yaml');
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}. Run 'npm run setup' to create it.`);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config.yaml:\n${issues}`);
  }

  const config = result.data;

  // Validate that referenced env vars exist
  validateEnvVars(config);

  // Ensure subdirectories exist
  ensureDirs(dir, config);

  return config;
}

/**
 * Validate that all *_env references in providers have corresponding env vars.
 */
function validateEnvVars(config: AppConfig): void {
  const missing: string[] = [];

  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.api_key_env && !process.env[provider.api_key_env]) {
      // Only flag if it's not the active provider or if it's explicitly required
      // Ollama-style providers may not need keys
      if (name === config.active.provider) {
        missing.push(provider.api_key_env);
      }
    }
    if (provider.bearer_token_env && !process.env[provider.bearer_token_env]) {
      if (name === config.active.provider) {
        missing.push(provider.bearer_token_env);
      }
    }
  }

  const tokenEnv = config.telegram.token_env;
  if (!process.env[tokenEnv]) {
    missing.push(tokenEnv);
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((v) => `  - ${v}`).join('\n')}\n` +
        `Set them in ${resolveConfigDir()}/.env or export them.`,
    );
  }
}

/**
 * Ensure required subdirectories exist.
 */
function ensureDirs(dir: string, config: AppConfig): void {
  const dirs = [
    join(dir, config.agents.dir),
    join(dir, config.session.history_dir),
    join(dir, 'skills'),
    join(dir, 'logs'),
  ];

  for (const d of dirs) {
    const resolved = resolve(dir, d);
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true });
    }
  }
}

/**
 * Resolve a provider's API key or bearer token from env vars.
 */
export function resolveProviderAuth(provider: AppConfig['providers'][string]): {
  apiKey?: string;
  bearerToken?: string;
} {
  return {
    apiKey: provider.api_key_env ? process.env[provider.api_key_env] : undefined,
    bearerToken: provider.bearer_token_env ? process.env[provider.bearer_token_env] : undefined,
  };
}
