import type { Provider, ModelCatalog, PresetConfig } from '../types.js';
import { BaseProvider } from '../_shared/base.js';
import { resolveApiKey } from '../_shared/auth.js';
import { fetchWithTimeout } from '../_shared/http.js';
import { buildByokConfig } from './byok.js';
import { onboardOpenCodeGo } from './onboard.js';
import { OPENCODE_GO_MODELS } from './catalog.js';
import { createLogger } from '../../logger.js';

const log = createLogger('providers:opencode-go');

const MODELS_URL = 'https://opencode.ai/zen/go/v1/models';
const DISCOVERY_TTL_MS = 15 * 60 * 1000; // 15 minutes

class OpenCodeGoProvider extends BaseProvider {
  readonly id = 'opencode-go';
  readonly displayName = 'OpenCode Go';
  readonly capabilities = {
    apiKey: true,
    deviceFlow: false,
    oauthFlow: false,
    dynamicModels: true,
    healthCheck: false,
  } as const;

  onboard = onboardOpenCodeGo;
  buildByokConfig = buildByokConfig;

  // ── Dynamic model discovery ──────────────────────────────────────

  async discoverModels(preset: PresetConfig): Promise<ModelCatalog> {
    const apiKey = await resolveApiKey(preset.auth);
    if (!apiKey) {
      log.warn(
        'cannot discover models for preset %s: no API key available',
        preset.name,
      );
      return {
        models: OPENCODE_GO_MODELS,
        fetchedAt: Date.now(),
        ttlMs: DISCOVERY_TTL_MS,
      };
    }

    try {
      const response = await fetchWithTimeout(MODELS_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        timeoutMs: 10_000,
      });

      if (!response.ok) {
        log.warn(
          'models endpoint returned %d for preset %s, using fallback catalog',
          response.status,
          preset.name,
        );
        return {
          models: OPENCODE_GO_MODELS,
          fetchedAt: Date.now(),
          ttlMs: DISCOVERY_TTL_MS,
        };
      }

      const body = (await response.json()) as {
        data?: Array<{ id: string; name?: string }>;
      };

      if (!body.data || !Array.isArray(body.data)) {
        log.warn(
          'unexpected models response shape for preset %s, using fallback catalog',
          preset.name,
        );
        return {
          models: OPENCODE_GO_MODELS,
          fetchedAt: Date.now(),
          ttlMs: DISCOVERY_TTL_MS,
        };
      }

      const models = body.data.map((m) => ({
        id: m.id,
        displayName: m.name ?? m.id,
      }));

      log.info(
        'discovered %d models for preset %s',
        models.length,
        preset.name,
      );

      return {
        models,
        fetchedAt: Date.now(),
        ttlMs: DISCOVERY_TTL_MS,
      };
    } catch (err) {
      log.warn(
        { err },
        'failed to discover models for preset %s, using fallback catalog',
        preset.name,
      );
      return {
        models: OPENCODE_GO_MODELS,
        fetchedAt: Date.now(),
        ttlMs: DISCOVERY_TTL_MS,
      };
    }
  }
}

export const opencodeGoProvider: Provider = new OpenCodeGoProvider();
