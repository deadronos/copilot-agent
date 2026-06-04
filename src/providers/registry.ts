import { createLogger } from '../logger.js';
import type { Provider } from './types.js';

const log = createLogger('providers:registry');

// ── Registry state ───────────────────────────────────────────────────

const providers = new Map<string, Provider>();

// ── Public API ───────────────────────────────────────────────────────

export function registerProvider(provider: Provider): void {
  if (providers.has(provider.id)) {
    throw new Error(`Provider "${provider.id}" is already registered.`);
  }

  validateProvider(provider);
  providers.set(provider.id, provider);

  log.info('registered provider %s (%s)', provider.id, provider.displayName);
}

export function getProvider(id: string): Provider | undefined {
  return providers.get(id);
}

export function listProviders(): ReadonlyArray<Provider> {
  return [...providers.values()];
}

// ── Validation ───────────────────────────────────────────────────────

function validateProvider(provider: Provider): void {
  if (!provider.id) {
    throw new Error('Provider must have a non-empty id.');
  }

  if (!provider.displayName) {
    throw new Error(`Provider "${provider.id}" must have a displayName.`);
  }

  const cap = provider.capabilities;

  // Capabilities must match the presence of login methods.
  // If apiKey is false, login('api_key') must throw or be unsupported
  // (handled by BaseProvider dispatch).
  // If deviceFlow is false, login('device_flow') must be unsupported.
  // If oauthFlow is false, login('oauth') must be unsupported.

  if (typeof cap.apiKey !== 'boolean') {
    throw new Error(
      `Provider "${provider.id}" capabilities.apiKey must be boolean.`,
    );
  }
  if (typeof cap.deviceFlow !== 'boolean') {
    throw new Error(
      `Provider "${provider.id}" capabilities.deviceFlow must be boolean.`,
    );
  }
  if (typeof cap.oauthFlow !== 'boolean') {
    throw new Error(
      `Provider "${provider.id}" capabilities.oauthFlow must be boolean.`,
    );
  }
  if (typeof cap.dynamicModels !== 'boolean') {
    throw new Error(
      `Provider "${provider.id}" capabilities.dynamicModels must be boolean.`,
    );
  }
  if (typeof cap.healthCheck !== 'boolean') {
    throw new Error(
      `Provider "${provider.id}" capabilities.healthCheck must be boolean.`,
    );
  }

  if (!provider.buildByokConfig) {
    throw new Error(
      `Provider "${provider.id}" must implement buildByokConfig().`,
    );
  }
}

// ── Compile-time registration ────────────────────────────────────────

import { githubCopilotProvider } from './github-copilot/index.js';

registerProvider(githubCopilotProvider);
