# 08 — Providers

> **Status:** Draft
> **Owns:** The `Provider` interface, the `BaseProvider` base class, the `PresetConfig` shape, the `src/providers/` directory layout, the CLI's `provider` subcommands, and the LLM backend's BYOK construction seam.
> **Pins:** ADR 001 (Copilot SDK as the LLM runtime), ADR 002 (XDG config; presets extend the config dir layout), ADR 007 (type-safe SDK boundaries).

## Purpose

A provider is a **code module** in `src/providers/<name>/` that wraps a BYOK configuration for a specific LLM backend (github-copilot, openai-codex, opencode-go, …) and exposes a common interface the gateway and the CLI both consume. The Copilot SDK is the single LLM runtime that actually calls the model; providers do not replace it — they configure it. Providers own the parts that vary by backend: the auth flow (API key, device flow, future OAuth), the model catalog (static or dynamic), the BYOK config shape the SDK accepts, and the onboarding UX the CLI drives.

Adding a new provider = writing a new TypeScript module and registering it at compile time. Provider code lives in the source tree, not in the config dir; the per-deployment state (auth token, chosen model) lives in `<configDir>/presets/<name>.yaml` and is created by `copilot-agent provider add`.

## Interface

```typescript
// src/providers/types.ts

export type LoginMethod = 'api_key' | 'device_flow' | 'oauth';

export interface ProviderCapabilities {
  /** Provider can authenticate via a static API key (env-var or token file). */
  apiKey: boolean;
  /** Provider can authenticate via OAuth device flow. */
  deviceFlow: boolean;
  /** Provider can authenticate via full OAuth (callback-based). Not
   *  implemented in v1; the flag is reserved for v2. */
  oauthFlow: boolean;
  /** Provider can list its model catalog dynamically (list-models API). */
  dynamicModels: boolean;
  /** Provider exposes a periodic health check. */
  healthCheck: boolean;
}

export interface Provider {
  /** Stable id used in preset files, CLI commands, and slash-command args. */
  readonly id: string;
  /** Human-readable name for listings. */
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  // ── Onboarding (CLI drives the menu, then calls onboard) ──────────────
  /** Run onboarding for the chosen method. The provider may run the auth
   *  flow inline (so the preset is immediately usable) or defer login to
   *  a separate `login` call — its choice. Returns the preset config the
   *  CLI writes to `<configDir>/presets/<name>.yaml`. */
  onboard(presetName: string, method: LoginMethod): Promise<PresetConfig>;

  // ── Auth lifecycle (CLI) ───────────────────────────────────────────────
  /** Run (or re-run) the auth flow for an existing preset. The framework
   *  dispatches to the right implementation based on the preset's
   *  `auth.kind`. */
  login(preset: PresetConfig, method: LoginMethod): Promise<void>;
  /** Clear any persisted auth state for the preset. */
  logout(preset: PresetConfig): Promise<void>;
  /** Optional: refresh the credential if it's about to expire. */
  refresh?(preset: PresetConfig): Promise<void>;

  // ── Runtime lifecycle (bot startup, periodic) ──────────────────────────
  /** Required iff `capabilities.dynamicModels` is true. Fetch the live
   *  model catalog. The gateway caches the result per its `ttlMs`. */
  discoverModels?(preset: PresetConfig): Promise<ModelCatalog>;
  /** Optional iff `capabilities.healthCheck` is true. */
  healthCheck?(preset: PresetConfig): Promise<HealthStatus>;

  // ── BYOK construction (LLM backend seam) ───────────────────────────────
  /** Build the BYOK config object the Copilot SDK consumes. Called at
   *  session creation; the result is passed verbatim to
   *  `client.createSession(...)`. */
  buildByokConfig(preset: PresetConfig): ByokConfig;
}

export interface PresetConfig {
  /** Unique name; matches the filename `<configDir>/presets/<name>.yaml`. */
  readonly name: string;
  /** Matches `Provider.id`. Resolved via the provider registry at runtime. */
  readonly provider: string;
  readonly displayName?: string;
  readonly auth: AuthConfig;
  /** Base URL override (for OpenAI-compatible endpoints, custom servers). */
  readonly baseUrl?: string;
  /** Hint to the LLM backend about which API type to use. The Copilot SDK
   *  currently treats this as a provider-implementation detail; we carry
   *  it in the preset so future SDK versions can use it. */
  readonly apiType?: 'openai-completions' | 'openai-responses' | 'anthropic-native' | 'copilot';
  /** Static fallback catalog. Used when `capabilities.dynamicModels` is
   *  false, or as the seed when discovery fails. */
  readonly models: ReadonlyArray<ModelInfo>;
  readonly defaultModel?: string;
}

export type AuthConfig =
  /** A static API key. The framework reads it from `envVar` first, falling
   *  back to `tokenFile` if env is unset. */
  | { kind: 'api_key'; envVar?: string; tokenFile?: string }
  /** OAuth device flow. The framework writes the resulting token to
   *  `tokenFile` during login. */
  | { kind: 'device_flow'; tokenFile: string; clientId: string; scopes?: ReadonlyArray<string> }
  /** Full OAuth (callback-based). Reserved for v2; see open questions. */
  | { kind: 'oauth'; tokenFile: string; clientId: string; authUrl: string; tokenUrl: string; scopes?: ReadonlyArray<string> }
  /** No auth required (e.g. local-only providers). */
  | { kind: 'none' };

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

export interface HealthStatus {
  readonly up: boolean;
  readonly latencyMs?: number;
  readonly error?: string;
}

/** The shape the Copilot SDK's `createSession` accepts. Kept loose here;
 *  the SDK's actual type lives in `@github/copilot-sdk`. */
export interface ByokConfig {
  readonly provider: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly [k: string]: unknown;
}
```

## `BaseProvider` (the "extend or implement" choice)

```typescript
// src/providers/_shared/base.ts

export abstract class BaseProvider implements Partial<Provider> {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly capabilities: ProviderCapabilities;
  abstract onboard(presetName: string, method: LoginMethod): Promise<PresetConfig>;
  abstract buildByokConfig(preset: PresetConfig): ByokConfig;

  /** Default login dispatcher. Override individual handlers below. */
  async login(preset: PresetConfig, method: LoginMethod): Promise<void> {
    if (method === 'api_key') return this.loginApiKey(preset);
    if (method === 'device_flow') return this.loginDeviceFlow(preset);
    if (method === 'oauth') return this.loginOAuth(preset);
  }

  /** Default API-key login: resolve the env var or read the token file.
   *  Override only if your provider needs more (e.g. a remote key service). */
  protected async loginApiKey(preset: PresetConfig): Promise<void> {
    if (preset.auth.kind !== 'api_key') throw new Error('auth.kind must be api_key');
    const value = resolveApiKey(preset.auth);  // reads env or file
    if (!value) throw new Error('API key not found in env or token file');
  }

  /** Default device-flow login: run the dance, write the token file. */
  protected async loginDeviceFlow(preset: PresetConfig): Promise<void> {
    if (preset.auth.kind !== 'device_flow') throw new Error('auth.kind must be device_flow');
    const token = await runDeviceFlow(preset.auth.clientId, preset.auth.scopes ?? []);
    await atomicWriteFile(preset.auth.tokenFile, token, { mode: 0o600 });
  }

  /** Default OAuth login. Stubbed in v1; raises a clear error. */
  protected async loginOAuth(preset: PresetConfig): Promise<void> {
    throw new Error('OAuth login is not implemented in v1; use device_flow instead.');
  }

  /** Default logout: delete the token file if it exists. */
  async logout(preset: PresetConfig): Promise<void> {
    const tokenFile = extractTokenFile(preset.auth);
    if (tokenFile) await fs.unlink(tokenFile).catch(() => {}); // missing is fine
  }

  /** Default refresh: re-run login with the preset's method. */
  async refresh(preset: PresetConfig): Promise<void> {
    const method = preset.auth.kind === 'none' ? 'api_key' : (preset.auth.kind as LoginMethod);
    return this.login(preset, method);
  }
}
```

**The rule:** providers can either extend `BaseProvider` (inherit defaults, override only what differs) or implement `Provider` directly (no inheritance, write every method). The framework dispatches the same way regardless. The choice is per-provider based on how much of the default behavior applies.

The `_shared/` folder also contains the standalone utility functions `BaseProvider` uses (`resolveApiKey`, `runDeviceFlow`, `atomicWriteFile`, `extractTokenFile`, etc.). Providers that don't extend `BaseProvider` can still import these directly.

## Lifecycle

**At registration (compile-time):**
1. `src/providers/registry.ts` has a hardcoded list of `import` statements and a `registerProvider(provider)` call for each provider module. *Pins: the cross-cutting "compile-time plugin loading" principle from `00-high-level.md`.*
2. The registry validates the provider at registration: `id` is unique, `capabilities` is present, methods match the capability flags (e.g., if `dynamicModels: true` then `discoverModels` is a function).
3. The registry exposes `getProvider(id)` for the LLM backend and the CLI to look up providers by id.

**At `copilot-agent provider add <name>`:**
1. The CLI loads the named provider from the registry.
2. The CLI reads `provider.capabilities` and presents an interactive menu of supported login methods.
3. The user picks a method. The CLI calls `provider.onboard(presetName, method)`.
4. The provider's `onboard` runs whatever setup it needs (e.g. prompts for env var name, runs the device flow inline, writes the token file) and returns a `PresetConfig`.
5. The CLI writes the config to `<configDir>/presets/<name>.yaml` with `0600` permissions.
6. The CLI prints a summary and exits.

**At `copilot-agent provider login <name>`:**
1. The CLI loads the preset from `<configDir>/presets/<name>.yaml`.
2. The CLI calls `provider.login(preset, preset.auth.kind)`.
3. The provider's `login` runs the flow (e.g. re-runs the device flow, refreshes an expiring token, validates a manually-pasted API key).
4. The CLI prints a summary and exits.

**At gateway startup (bot):**
1. The gateway loads all preset files from `<configDir>/presets/`.
2. For each preset whose provider advertises `dynamicModels: true`, the gateway calls `provider.discoverModels(preset)` and caches the result per the catalog's `ttlMs`.
3. The gateway validates the `active.preset` name in `config.yaml` resolves to an existing preset.
4. If `discoverModels` fails for a preset, the gateway logs a warning and uses the preset's static `models` array as the fallback catalog. The bot still starts.

**At session creation (bot):**
1. The LLM backend looks up the active provider: `registry.getProvider(preset.provider)`.
2. The backend calls `provider.buildByokConfig(preset)`. The result is the BYOK config the SDK consumes.
3. The backend calls `client.createSession({ ...byok, streaming: true })`.
4. When the user runs `/model <id>`, the backend validates `<id>` against the active catalog (dynamic result if available, else the static fallback).

**At `copilot-agent provider refresh <name>`:**
1. The CLI calls `provider.discoverModels(preset)` and prints the result.
2. *Does not* write back to the preset file — the dynamic catalog is the gateway's cache, not the preset's static fallback. (If a new model should be added permanently, the user edits the preset file or re-runs `provider add`.)

**At `copilot-agent provider logout <name>`:**
1. The CLI calls `provider.logout(preset)`. The default implementation deletes the token file.
2. The preset itself is not deleted; `provider remove` does that.

## Directory structure

```
src/
├── providers/
│   ├── types.ts                       ← the Provider interface, PresetConfig, etc.
│   ├── registry.ts                    ← compile-time import + register
│   ├── _shared/                       ← common code; not a spec boundary
│   │   ├── base.ts                    ← BaseProvider abstract class
│   │   ├── device-flow.ts             ← runDeviceFlow()
│   │   ├── oauth.ts                   ← OAuth helpers (stubbed in v1)
│   │   ├── auth.ts                    ← resolveApiKey(), extractTokenFile()
│   │   ├── fs.ts                      ← atomicWriteFile()
│   │   └── http.ts                    ← fetch wrapper with timeouts
│   ├── github-copilot/
│   │   ├── index.ts                   ← exports `provider: Provider`
│   │   ├── onboard.ts                 ← onboarding flows
│   │   ├── catalog.ts                 ← static fallback catalog
│   │   └── byok.ts                    ← buildByokConfig implementation
│   ├── openai-codex/
│   │   └── index.ts
│   └── opencode-go/
│       └── index.ts
│
└── channels/                          ← symmetric structure (see 01-channel-adapter.md)
    ├── types.ts
    ├── registry.ts
    ├── _shared/
    ├── telegram/
    ├── tui/                           ← future
    └── discord/                       ← future
```

The `_shared/` folder is **not a spec boundary**. It's an implementation-detail location for code that multiple providers reuse. The boundary is the `Provider` interface; `_shared/` is convenience code the framework doesn't depend on as a contract.

## CLI integration

```
copilot-agent provider list                    # list configured presets + capability summary
copilot-agent provider add <name>              # interactive: provider.onboard() driven menu
copilot-agent provider add <name> --from-flags # scripted: provider.onboardFromFlags() (planned v2)
copilot-agent provider remove <name>           # delete the preset file
copilot-agent provider show <name>             # print preset details (secrets redacted)
copilot-agent provider login <name>            # run provider.login(preset, preset.auth.kind)
copilot-agent provider logout <name>           # run provider.logout(preset) — usually deletes the token file
copilot-agent provider refresh <name>          # run provider.discoverModels(preset) and print
```

The CLI is part of the same `copilot-agent` binary as the bot. When invoked with no subcommand, the binary starts the bot. When invoked with a subcommand, it dispatches to the CLI handler. (The exact argv dispatch is an implementation detail; the contract is "the same binary serves both roles.")

Secrets are always redacted in CLI output. The `provider show` command prints `envVar` and `tokenFile` paths but never the values. Token files have `0600` permissions and are written atomically (`write to .tmp`, then `rename`).

## LLM backend integration

The LLM backend's job shrinks slightly: it no longer reads `providers:` from `config.yaml` directly. It looks up the active preset, finds the provider in the registry, and calls `provider.buildByokConfig(preset)`.

```
User → gateway → session.create({ userId, agent, presetId, model, sink })
                     │
                     ├── configStore.getPreset(presetId)         ← reads <configDir>/presets/<id>.yaml
                     ├── registry.getProvider(preset.provider)   ← from src/providers/registry.ts
                     ├── provider.buildByokConfig(preset)
                     │       → { provider, apiKey, baseUrl, ... }
                     ├── client.createSession({ ...byok, streaming: true })
                     └── return LlmSession
```

`/model <id>` validates against the dynamic catalog (or static fallback) of the *active* preset. `/provider <id>` resolves `<id>` to a preset name; if the preset is for a *different* provider than the active one, the next session is created with the new provider's BYOK config and the SDK is told to switch providers mid-session (per the SDK's native capability).

## Failure modes

| Failure | Boundary promise |
|---|---|
| `provider add` — onboarding fails mid-flow | The CLI surfaces the error, deletes any partial preset file, and exits non-zero. No half-configured preset is left on disk. |
| `provider login` — auth flow fails (user abandons device flow, wrong code, etc.) | The CLI surfaces the error, leaves the preset unchanged, exits non-zero. Token file is not written. |
| `provider login` — token expires after the bot has been running | The next SDK call fails with a 401; the backend surfaces a "token expired, run `copilot-agent provider login <name>`" error. The bot does not auto-retry. (Future: a token-expiry watcher could trigger `refresh()`. *YAGNI for v1.*) |
| `discoverModels` — list-models API call fails at startup | The gateway logs a warning and uses the preset's static `models` array. The bot still starts. |
| `discoverModels` — succeeds, then a follow-up refresh fails | The gateway keeps the previous successful catalog and retries on the next TTL. |
| `buildByokConfig` — token file is missing | The backend throws a typed error. The gateway surfaces a "provider `<name>` is not authenticated; run `copilot-agent provider login <name>`" error. |
| `buildByokConfig` — the SDK rejects the config | The SDK throws; the gateway maps to "provider rejected BYOK config; check the preset's baseUrl and apiType." |
| `provider add` writes a preset with a duplicate name | The CLI errors with "preset `<name>` already exists" and refuses to overwrite. (User runs `provider remove` first, or picks a different name.) |
| `provider remove` on the active preset | The CLI refuses with "preset `<name>` is the active preset; switch first with `/provider <other>` or edit `config.yaml`." |
| `provider add` for a provider not in the registry | The CLI errors with "no such provider `<name>`; available: github-copilot, openai-codex, opencode-go." |

## Cross-references

- **Pinned by:** ADR 001 (Copilot SDK is the LLM runtime; providers configure it, they don't replace it), ADR 002 (XDG config; presets extend the config dir layout), ADR 007 (type-safe SDK boundaries).
- **Depends on:** the Copilot SDK's `createSession` API (pinned by ADR 001); the shared utility code in `src/providers/_shared/` (implementation detail, not a boundary).
- **Depended on by:**
  - [04-llm-backend.md](04-llm-backend.md) — calls `provider.buildByokConfig(preset)` at session creation; resolves `preset.provider` via the registry.
  - [06-message-lifecycle.md](06-message-lifecycle.md) — `/provider` and `/model` slash commands use the provider registry and the active preset's catalog.
  - [07-webui-control-surface.md](07-webui-control-surface.md) — the WebUI's `ControlAPI` exposes preset listing/CRUD (read-only at first; full CRUD in v2).
  - The `copilot-agent` CLI binary — `provider` subcommands.

## Open questions

- **CLI subcommand scope.** v1 ships `provider` only. `agent`, `config`, and `channels` subcommands are documented in their respective specs (03, 07, 01) but the CLI implementation is part of the same binary — recommended to land in the same release as the `provider` subcommands rather than staggered.
- **Dynamic catalog caching.** The `ModelCatalog.ttlMs` is provider-chosen. Recommended default: **1 hour**. The gateway caches per preset; on cache miss + provider error, falls back to the static catalog. Push back if you want a different default.
- **Token file permissions.** All token files are written with `0600` and atomically renamed. The dir containing them (`<configDir>/auth/`) is `0700`. Push back if you'd rather have the dir inherit a different mode.
- **OAuth flow (v2).** Reserved in the `AuthConfig` union and the `ProviderCapabilities.oauthFlow` flag. The default `BaseProvider.loginOAuth` raises an error. v2 adds the local HTTP listener and the implementation. *Not in v1.*
- **Provider SDKs / dynamic plugin loading.** v1 providers are compile-time. v2 could add a `plugins/` directory scanned at startup, with each plugin as a separate Node module. *Not in v1.*
- **Per-user provider selection.** Today every user shares the active preset. A future spec could let a Telegram user pin a specific preset via `/provider <id>` (per-user override). *Not in v1; today's `/provider` switches the global active.*
- **BYOK config field whitelist.** The `ByokConfig` type uses `[k: string]: unknown` for forward-compatibility. A v2 spec could narrow this once the Copilot SDK's BYOK API stabilizes.
