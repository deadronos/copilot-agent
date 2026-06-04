import { homedir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '../../logger.js';
import type { PresetConfig, LoginMethod } from '../types.js';
import { GITHUB_COPILOT_MODELS } from './catalog.js';

const log = createLogger('providers:github-copilot');

/**
 * Run the GitHub Copilot onboarding flow.
 *
 * For device-flow auth, guides the user through the GitHub device flow.
 * The resulting PresetConfig is saved to `<configDir>/presets/<name>.yaml`
 * by the CLI layer; this function only returns the config object.
 */
export async function onboardGitHubCopilot(
  presetName: string,
  method: LoginMethod,
): Promise<PresetConfig> {
  log.info(
    'onboarding GitHub Copilot preset %s with method %s',
    presetName,
    method,
  );

  const tokenFile = defaultTokenFilePath();

  return {
    name: presetName,
    provider: 'github-copilot',
    displayName: 'GitHub Copilot',
    auth:
      method === 'device_flow'
        ? {
            kind: 'device_flow',
            tokenFile,
            clientId: 'copilot-agent',
            scopes: ['user', 'read:org', 'copilot'],
          }
        : {
            kind: 'api_key',
            envVar: 'COPILOT_AGENT_GITHUB_TOKEN',
            tokenFile,
          },
    apiType: 'copilot',
    models: GITHUB_COPILOT_MODELS,
    defaultModel: 'claude-sonnet-4-6',
  };
}

function defaultTokenFilePath(): string {
  return join(homedir(), '.config', 'copilot-agent', 'github-token');
}
