import { createLogger } from '../../logger.js';
import type {
  Provider,
  PresetConfig,
  LoginMethod,
  ModelCatalog,
  HealthStatus,
  ByokConfig,
} from '../types.js';
import { resolveApiKey } from './auth.js';
import { atomicWriteFile, removeFileIfExists } from './fs.js';
import { runDeviceFlow } from './device-flow.js';

const log = createLogger('providers:base');

/**
 * Abstract base class for providers.
 *
 * Subclasses can override any method to customise behaviour.
 * Every method has a sensible default so a minimal provider only needs to
 * implement `id`, `displayName`, `capabilities`, `onboard()`, and
 * `buildByokConfig()`.
 */
export abstract class BaseProvider implements Provider {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly capabilities: Provider['capabilities'];

  abstract onboard(
    presetName: string,
    method: LoginMethod,
  ): Promise<PresetConfig>;
  abstract buildByokConfig(preset: PresetConfig): Promise<ByokConfig>;

  // ── login ──────────────────────────────────────────────────────────

  async login(preset: PresetConfig, method: LoginMethod): Promise<void> {
    switch (method) {
      case 'api_key':
        return this.loginApiKey(preset);
      case 'device_flow':
        return this.loginDeviceFlow(preset);
      case 'oauth':
        return this.loginOAuth(preset);
      default:
        throw new Error(`Unknown login method: ${method}`);
    }
  }

  protected async loginApiKey(preset: PresetConfig): Promise<void> {
    const key = await resolveApiKey(preset.auth);
    if (!key) {
      throw new Error(
        `No API key found for preset "${preset.name}". ` +
          `Set the ${preset.auth.kind === 'api_key' && preset.auth.envVar ? preset.auth.envVar : 'appropriate'} environment variable or create a token file.`,
      );
    }
    log.info('api key resolved for preset %s', preset.name);
  }

  protected async loginDeviceFlow(preset: PresetConfig): Promise<void> {
    if (preset.auth.kind !== 'device_flow') {
      throw new Error(
        `Preset "${preset.name}" is not configured for device-flow auth.`,
      );
    }

    const scopes = preset.auth.scopes ?? [];
    const token = await runDeviceFlow(preset.auth.clientId, scopes);

    // Write the token atomically with restrictive permissions.
    await atomicWriteFile(preset.auth.tokenFile, token);
    log.info(
      'device-flow token written to %s for preset %s',
      preset.auth.tokenFile,
      preset.name,
    );
  }

  protected async loginOAuth(_preset: PresetConfig): Promise<void> {
    throw new Error('OAuth login is not implemented in v1');
  }

  // ── logout ─────────────────────────────────────────────────────────

  async logout(preset: PresetConfig): Promise<void> {
    const tokenFile = this.tokenFileFromAuth(preset);
    if (tokenFile) {
      await removeFileIfExists(tokenFile);
      log.info('removed token file %s for preset %s', tokenFile, preset.name);
    }
  }

  // ── refresh ────────────────────────────────────────────────────────

  async refresh(preset: PresetConfig): Promise<void> {
    const method = this.methodFromAuth(preset.auth.kind);
    return this.login(preset, method);
  }

  // ── discoverModels (stub — override for dynamic catalogs) ──────────

  async discoverModels(_preset: PresetConfig): Promise<ModelCatalog> {
    return { models: [], fetchedAt: Date.now(), ttlMs: 0 };
  }

  // ── healthCheck (stub — override to ping the provider) ─────────────

  async healthCheck(_preset: PresetConfig): Promise<HealthStatus> {
    return { up: true };
  }

  // ── helpers ────────────────────────────────────────────────────────

  private tokenFileFromAuth(preset: PresetConfig): string | undefined {
    const auth = preset.auth;
    switch (auth.kind) {
      case 'api_key':
        return auth.tokenFile;
      case 'device_flow':
      case 'oauth':
        return auth.tokenFile;
      default:
        return undefined;
    }
  }

  private methodFromAuth(kind: string): LoginMethod {
    switch (kind) {
      case 'api_key':
        return 'api_key';
      case 'device_flow':
        return 'device_flow';
      case 'oauth':
        return 'oauth';
      default:
        return 'api_key';
    }
  }
}
