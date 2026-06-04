import { createLogger } from '../../logger.js';
import type { PresetConfig, LoginMethod } from '../types.js';
import { OPENCODE_GO_MODELS } from './catalog.js';

const log = createLogger('providers:opencode-go');

/**
 * Run the OpenCode Go onboarding flow.
 *
 * OpenCode Go uses API key auth. The user provides their key via the
 * `OPENCODE_GO_API_KEY` environment variable. This function returns
 * a PresetConfig with the auth shape; the CLI layer saves it to disk.
 */
export async function onboardOpenCodeGo(
  presetName: string,
  method: LoginMethod,
): Promise<PresetConfig> {
  log.info(
    'onboarding OpenCode Go preset %s with method %s',
    presetName,
    method,
  );

  if (method !== 'api_key') {
    throw new Error(
      `OpenCode Go only supports api_key auth, got ${method}`,
    );
  }

  return {
    name: presetName,
    provider: 'opencode-go',
    displayName: 'OpenCode Go',
    auth: {
      kind: 'api_key',
      envVar: 'OPENCODE_GO_API_KEY',
    },
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiType: 'openai-completions',
    models: OPENCODE_GO_MODELS,
    defaultModel: 'glm-5.1',
  };
}
