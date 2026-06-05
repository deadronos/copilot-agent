import type { Preset } from '../types.js';

// ── Login method ────────────────────────────────────────────────────

export type LoginMethod = 'api_key' | 'device_flow' | 'oauth';

// ── Provider capabilities ────────────────────────────────────────────

export interface ProviderCapabilities {
  apiKey: boolean;
  deviceFlow: boolean;
  oauthFlow: boolean; // reserved for v2
  dynamicModels: boolean;
  healthCheck: boolean;
}

// ── Provider interface ───────────────────────────────────────────────

export interface Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  onboard(presetName: string, method: LoginMethod): Promise<PresetConfig>;
  login(preset: PresetConfig, method: LoginMethod): Promise<void>;
  logout(preset: PresetConfig): Promise<void>;
  refresh?(preset: PresetConfig): Promise<void>;

  discoverModels?(preset: PresetConfig): Promise<ModelCatalog>;
  healthCheck?(preset: PresetConfig): Promise<HealthStatus>;

  buildByokConfig(preset: PresetConfig): Promise<ByokConfig>;
}

// ── Preset config (per-deployment state) ─────────────────────────────

export interface PresetConfig {
  readonly name: string;
  readonly provider: string;
  readonly displayName?: string;
  readonly auth: AuthConfig;
  readonly baseUrl?: string;
  readonly apiType?:
    | 'openai-completions'
    | 'openai-responses'
    | 'anthropic-native'
    | 'copilot';
  readonly models: ReadonlyArray<ModelInfo>;
  readonly defaultModel?: string;
}

// ── Auth config ──────────────────────────────────────────────────────

export type AuthConfig =
  | {
      readonly kind: 'api_key';
      readonly envVar?: string;
      readonly tokenFile?: string;
    }
  | {
      readonly kind: 'device_flow';
      readonly tokenFile: string;
      readonly clientId: string;
      readonly scopes?: ReadonlyArray<string>;
    }
  | {
      readonly kind: 'oauth';
      readonly tokenFile: string;
      readonly clientId: string;
      readonly authUrl: string;
      readonly tokenUrl: string;
      readonly scopes?: ReadonlyArray<string>;
    }
  | { readonly kind: 'none' };

// ── Model types ──────────────────────────────────────────────────────

export interface ModelInfo {
  readonly id: string;
  readonly displayName?: string;
  /** @deprecated Use maxContextTokens instead. */
  readonly contextWindow?: number;
  readonly maxContextTokens?: number;
  readonly maxPromptTokens?: number;
  readonly supportsTools?: boolean;
  readonly supportsVision?: boolean;
  readonly supportsReasoning?: boolean;
}

export interface ModelCatalog {
  readonly models: ReadonlyArray<ModelInfo>;
  readonly fetchedAt: number;
  readonly ttlMs: number;
}

// ── Health status ────────────────────────────────────────────────────

export interface HealthStatus {
  readonly up: boolean;
  readonly latencyMs?: number;
  readonly error?: string;
}

// ── BYOK config (passed to Copilot SDK) ─────────────────────────────

export interface ByokConfig {
  readonly provider: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly [k: string]: unknown;
}

// ── Utility: convert Preset (from config) to PresetConfig ────────────

export function presetToPresetConfig(
  preset: Preset,
  providerId: string,
  models?: ReadonlyArray<ModelInfo>,
): PresetConfig {
  return {
    name: preset.id,
    provider: providerId,
    displayName: preset.displayName as string | undefined,
    auth: (preset.auth as AuthConfig) ?? { kind: 'none' },
    baseUrl: preset.baseUrl as string | undefined,
    apiType: preset.apiType as PresetConfig['apiType'],
    models: models ?? [],
    defaultModel: preset.model,
  };
}
