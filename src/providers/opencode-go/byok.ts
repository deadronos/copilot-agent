import { createLogger } from '../../logger.js';
import type { PresetConfig, ByokConfig } from '../types.js';
import { resolveApiKey } from '../_shared/auth.js';

const log = createLogger('providers:opencode-go');

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';

/**
 * Build the BYOK configuration for the Copilot SDK.
 *
 * Token resolution order:
 *  1. `OPENCODE_GO_API_KEY` environment variable
 *  2. Token file specified in the preset's auth config
 *
 * Throws if no token can be found.
 */
export async function buildByokConfig(
  preset: PresetConfig,
): Promise<ByokConfig> {
  const apiKey = await resolveApiKey(preset.auth);
  if (!apiKey) {
    throw new Error(
      'No API key found for OpenCode Go. ' +
        'Set the OPENCODE_GO_API_KEY environment variable or run the onboarding flow.',
    );
  }

  log.debug('resolved opencode-go api key');

  return {
    provider: 'opencode-go',
    apiKey,
    baseUrl: preset.baseUrl ?? DEFAULT_BASE_URL,
  };
}
