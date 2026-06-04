import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '../../logger.js';
import type { PresetConfig, ByokConfig } from '../types.js';

const log = createLogger('providers:github-copilot');

/**
 * Build the BYOK configuration for the Copilot SDK.
 *
 * Token resolution order:
 *  1. `COPILOT_AGENT_GITHUB_TOKEN` environment variable
 *  2. `GITHUB_TOKEN` environment variable
 *  3. Token file specified in the preset's auth config
 *  4. `~/.config/copilot-agent/github-token` (default path)
 *
 * Throws if no token can be found.
 */
export async function buildByokConfig(
  preset: PresetConfig,
): Promise<ByokConfig> {
  const token = await resolveGitHubToken(preset);
  if (!token) {
    throw new Error(
      'No GitHub token found. Set COPILOT_AGENT_GITHUB_TOKEN or GITHUB_TOKEN, ' +
        'or run the onboarding flow.',
    );
  }

  return {
    provider: 'github-copilot',
    apiKey: token,
    baseUrl: preset.baseUrl,
  };
}

async function resolveGitHubToken(
  preset: PresetConfig,
): Promise<string | undefined> {
  // 1. Primary env var
  const primary = process.env.COPILOT_AGENT_GITHUB_TOKEN;
  if (primary) {
    log.debug('resolved github token from COPILOT_AGENT_GITHUB_TOKEN');
    return primary;
  }

  // 2. Fallback env var
  const fallback = process.env.GITHUB_TOKEN;
  if (fallback) {
    log.debug('resolved github token from GITHUB_TOKEN');
    return fallback;
  }

  // 3. Token file from auth config
  if (preset.auth.kind === 'api_key' && preset.auth.tokenFile) {
    const fromFile = await readTokenFile(preset.auth.tokenFile);
    if (fromFile) return fromFile;
  }

  if (preset.auth.kind === 'device_flow' && preset.auth.tokenFile) {
    const fromFile = await readTokenFile(preset.auth.tokenFile);
    if (fromFile) return fromFile;
  }

  // 4. Default token file path
  const defaultPath = join(
    homedir(),
    '.config',
    'copilot-agent',
    'github-token',
  );
  const fromDefault = await readTokenFile(defaultPath);
  if (fromDefault) return fromDefault;

  return undefined;
}

async function readTokenFile(filePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const token = raw.split('\n')[0]?.trim();
    if (token) {
      log.debug('resolved github token from file %s', filePath);
      return token;
    }
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}
