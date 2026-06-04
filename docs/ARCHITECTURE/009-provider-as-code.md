# ADR 009 — Provider-as-code: plug-in modules with preset deployment config

- **Status:** Accepted
- **Date:** 2026-06-04
- **Deciders:** copilot-agent project

## Context

The bot must support multiple BYOK LLM providers (GitHub Copilot, OpenAI, Anthropic, Ollama, anything OpenAI-compatible). Each provider has different auth flows, model catalogs, and BYOK config shapes. The bot's core must not hardcode provider-specific logic.

## Decision

### Providers are TypeScript modules, not config entries

A provider is a code module in `src/providers/<name>/` that implements the `Provider` interface defined in `src/providers/types.ts`. Adding a new provider = writing a new TypeScript module + registering it — no gateway changes.

### The `Provider` interface

```typescript
export interface Provider {
  readonly id: string;                    // e.g. "github-copilot"
  readonly displayName: string;           // e.g. "GitHub Copilot"
  readonly capabilities: ProviderCapabilities;

  onboard(presetName: string, method: LoginMethod): Promise<PresetConfig>;
  login(preset: PresetConfig, method: LoginMethod): Promise<void>;
  logout(preset: PresetConfig): Promise<void>;
  refresh?(preset: PresetConfig): Promise<void>;
  discoverModels?(preset: PresetConfig): Promise<ModelCatalog>;
  healthCheck?(preset: PresetConfig): Promise<HealthStatus>;
  buildByokConfig(preset: PresetConfig): ByokConfig | Promise<ByokConfig>;
}
```

Each method is self-contained: the LLM backend calls `provider.buildByokConfig(preset)` and passes the result to the Copilot SDK. The provider encapsulates all auth, model discovery, and BYOK logic.

### Compile-time registry

`src/providers/registry.ts` maintains a `Map<string, Provider>` populated at import time via hardcoded `registerProvider()` calls. The registry validates unique IDs and that capability flags match implemented methods (e.g., if `dynamicModels: true`, `discoverModels` must be a function).

### Per-deployment state in presets, not in code

Provider code lives in the source tree (`src/providers/<name>/`). Per-deployment state (auth tokens, chosen model, base URL) lives in `<configDir>/presets/<name>.yaml`, created by `copilot-agent provider add`.

This separation means:
- Provider code is versioned and committed to the repo.
- User-specific auth tokens are never committed.
- The same provider module works across deployments with different credentials.

### GitHub Copilot provider (reference implementation)

`src/providers/github-copilot/` is the v1 reference implementation:

- **`catalog.ts`** — static model catalog (Claude Sonnet 4.6, GPT-5, Gemini 2.5 Pro).
- **`onboard.ts`** — interactive onboarding that generates a `PresetConfig` with device-flow or API-key auth.
- **`byok.ts`** — token resolution chain: `COPILOT_AGENT_GITHUB_TOKEN` → `GITHUB_TOKEN` → auth token file.
- **`index.ts`** — `GitHubCopilotProvider` class extending `BaseProvider`.

### `BaseProvider` for inheritance

`src/providers/_shared/base.ts` provides default implementations for `login` (dispatches to `loginApiKey`/`loginDeviceFlow`/`loginOAuth`), `logout` (deletes token file), and `refresh` (re-runs login). Providers can extend `BaseProvider` for these defaults or implement `Provider` directly. Both are first-class.

### Shared utilities

`src/providers/_shared/` contains standalone functions that any provider can use:

| Utility | Purpose |
|---|---|
| `auth.ts` | `resolveApiKey()` — reads from env var or token file |
| `device-flow.ts` | `runDeviceFlow()` — OAuth device flow stub |
| `fs.ts` | `atomicWriteFile()` — `.tmp`-rename pattern for safe writes |
| `http.ts` | `fetchWithTimeout()` — fetch with `AbortController` timeout |

### CLI support

`copilot-agent provider` subcommands (`add`, `remove`, `show`, `login`, `logout`, `refresh`) drive the provider's onboarding and auth lifecycle methods. See `src/cli.ts` for the implementation. The CLI shares the same registry and preset-loading code as the bot.

## Consequences

- **Positive:** Adding a new provider (e.g., Anthropic direct, Ollama) means writing a `src/providers/<name>/` module — no gateway or LLM backend changes.
- **Positive:** The code/config separation means the same repo can be deployed by different users with different credentials.
- **Positive:** `BaseProvider` reduces boilerplate for simple providers (API key only, no dynamic models).
- **Negative:** Compile-time registration means adding a provider requires a rebuild. Runtime plugin discovery is deferred to v2.
- **Negative:** OAuth callback flow is reserved in the type system (`AuthConfig.oauth`, `ProviderCapabilities.oauthFlow`) but not implemented in v1. The `BaseProvider.loginOAuth()` throws a clear error.

## References

- `src/providers/types.ts` — `Provider`, `PresetConfig`, `AuthConfig`, `ByokConfig`
- `src/providers/registry.ts` — `registerProvider`, `getProvider`, `listProviders`
- `src/providers/_shared/base.ts` — `BaseProvider`
- `src/providers/github-copilot/` — reference implementation
- `src/llm.ts` — BYOK construction seam (`buildByokConfig`)
- `src/cli.ts` — provider subcommands
- `docs/specs/08-providers.md`
