# 04 — LLM backend

> **Status:** Draft
> **Owns:** The Copilot SDK wrapper, the BYOK provider model, model + provider switching, the per-session subscription to SDK events. v2 may add: retry / fallback / circuit-breaker, additional SDK backends (Claude, OpenAI direct, Ollama).
> **Pins:** ADR 001 (Copilot SDK as the agentic backend), ADR 002 (BYOK configuration), ADR 007 (type-safe SDK boundaries).

## Purpose

The LLM backend is the gateway's only window onto the model. It owns the Copilot SDK subprocess, the `CopilotClient` instance, the per-session `CopilotSession` objects, and the subscription to SDK events (delta, tool start/end, session error, session idle). The gateway calls into the backend; the backend never calls back into the gateway directly — instead, it surfaces events to the per-chat `StreamSink` (see `01-channel-adapter.md`) and resolves promises the gateway is awaiting.

## Interface

```typescript
export interface LlmBackend {
  /** Start the SDK subprocess and `CopilotClient`. Idempotent. */
  start(): Promise<void>;

  /** Stop the SDK subprocess. Flushes any pending sends. Idempotent. */
  stop(): Promise<void>;

  /** Create a new session for the given user + agent + provider + model. */
  createSession(opts: CreateSessionOpts): Promise<LlmSession>;

  /** Get a session by id. Throws if the session doesn't exist. */
  getSession(sessionId: string): LlmSession;

  /** List active sessions. For diagnostics. */
  listSessions(): ReadonlyArray<LlmSession>;
}

export interface LlmSession {
  readonly sessionId: string;
  readonly presetId: string; // active preset id; the underlying provider is resolved via the registry (see 08-providers.md)
  readonly model: string;
  /** Send a prompt and stream events to the given sink. Resolves when the
   *  session goes idle (or `sendAndWaitTimeoutMs` elapses). */
  send(opts: SendOpts): Promise<SendResult>;
  /** Switch the model on the live session. History is preserved. */
  switchModel(model: string): Promise<void>;
  /** Switch the preset on the live session. The LLM backend resolves the
   *  preset to a provider via the registry and asks the SDK to switch.
   *  History is preserved. */
  switchPreset(presetId: string): Promise<void>;
  /** Subscribe to SDK events not tied to a specific `send()` call. */
  onEvent(handler: (event: LlmEvent) => void): () => void;
  /** Destroy the session. */
  destroy(): Promise<void>;
}

export interface CreateSessionOpts {
  readonly userId: string;
  readonly agent: string; // agent name; the registry resolves the system prompt
  readonly presetId: string; // active preset id; the backend resolves it to a provider via the registry (see 08-providers.md)
  readonly model: string;
  /** Optional pre-resolved system prompt; if absent, the backend asks the registry. */
  readonly systemPrompt?: string;
  /** Optional StreamSink. The backend drives it with delta/tool events. */
  readonly sink?: StreamSink;
}

export interface SendOpts {
  readonly prompt: string;
  /** How long to wait for `session.idle` before timing out. */
  readonly timeoutMs: number;
}

export type SendResult =
  | { kind: 'completed'; content: string }
  | { kind: 'no-content' }
  | { kind: 'permission-denied'; toolName: string }
  | { kind: 'error'; message: string };

export type LlmEvent =
  | { kind: 'delta'; messageId: string; delta: string }
  | { kind: 'message'; messageId: string; content: string }
  | { kind: 'tool-start'; toolCallId: string; toolName: string; args?: unknown }
  | { kind: 'tool-end'; toolCallId: string; result?: unknown }
  | { kind: 'permission-request'; request: PermissionRequestPayload }
  | { kind: 'idle' }
  | { kind: 'error'; message: string };
```

## Provider model

The LLM backend does not own provider configuration — it owns the **BYOK construction seam** with the Copilot SDK. The actual provider configuration lives in `<configDir>/presets/<name>.yaml` (created by the CLI) and the provider code lives in `src/providers/<name>/` (compiled into the bot). For the full provider contract, see `08-providers.md`.

At session creation, the backend:
1. Loads the active preset by `presetId`.
2. Looks up the provider in `src/providers/registry.ts` via `registry.getProvider(preset.provider)`.
3. Calls `provider.buildByokConfig(preset)` and passes the result to the Copilot SDK's `createSession`.
4. Resolves the effective model (opts override preset override agent), looks it up in `presetConfig.models`, and builds `modelCapabilities` from the `ModelInfo` metadata (`supportsVision`, `supportsReasoning`, `maxContextTokens`, `maxPromptTokens`). This override is passed to the SDK's `SessionConfig.modelCapabilities` so the SDK knows the model's actual capabilities without relying on auto-discovery.
5. For dynamic model catalogs, the gateway called `provider.discoverModels(preset)` at startup and the backend uses the cached result for `/model` validation. If the cache is empty or the call failed, the backend falls back to the preset's static `models` array.

## Model capabilities pass-through

The SDK's `SessionConfigBase` accepts a `modelCapabilities?: ModelCapabilitiesOverride` field — a deep-partial override of the SDK's `ModelCapabilities` shape. When building the `SessionConfig`, the LLM backend maps our `ModelInfo` metadata (from the provider's static catalog or dynamically discovered list) into this override:

| Our `ModelInfo` field | SDK `ModelCapabilities` path |
|---|---|
| `supportsVision` | `supports.vision` |
| `supportsReasoning` | `supports.reasoningEffort` |
| `maxContextTokens` (falls back to `contextWindow`) | `limits.max_context_window_tokens` |
| `maxPromptTokens` | `limits.max_prompt_tokens` |

If no model metadata is available (the model isn't in the catalog), no override is set and the SDK falls back to auto-discovery. This is safe but may result in incorrect defaults for BYOK providers where the SDK can't inspect the model.

**Switching providers** is a live-session operation: the user runs `/provider <id>`, which resolves to a new preset (with a different `presetId`); the next session is created with the new provider's BYOK config. The Copilot SDK supports this natively; the backend just calls the right SDK method with the new `byok`.

**Provider enablement** is config-driven via `<configDir>/presets/` and the `active.preset` field in `config.yaml`. The gateway does not care which providers exist; it only sees the active preset's id.

## SDK lifecycle

**At `LlmBackend.start()`:**
1. Spawn the Copilot CLI as a subprocess (the SDK handles this).
2. Wait for the `ready` event from the SDK.
3. The backend is now ready to create sessions.

**At `LlmBackend.stop()`:**
1. Send `stop` to the SDK.
2. Wait up to N seconds for graceful shutdown.
3. `SIGTERM` if needed.

**At `createSession(...)`:**
1. The backend asks the agent registry for the system prompt (if not pre-resolved).
2. Calls `client.createSession({ systemPrompt, provider, model, streaming: true })`.
3. Subscribes to the session's events and dispatches to the `StreamSink` (if provided) and to `LlmEvent` subscribers.
4. Returns the `LlmSession` handle.

**At `send(opts)`:**
1. The backend calls `session.send(opts.prompt)`.
2. As events arrive, the backend dispatches `delta`/`tool-start`/`tool-end` to the sink; the sink drives the adapter's UI.
3. The backend resolves the returned promise on `session.idle` (with a `SendResult`) or on `opts.timeoutMs` elapsed.

**At `destroy()`:**
1. The backend calls `session.destroy()` on the SDK.
2. Removes the session from the in-memory list.

## Concurrency & ordering

- **Per-session serialization.** A single `LlmSession` can only have one `send()` in flight at a time. The session store's `enqueue` enforces this at the gateway layer.
- **Cross-session parallelism.** Different sessions run in parallel. The backend maintains a `Map<sessionId, LlmSession>`.
- **Event ordering.** Events from a single session arrive in the order the SDK emits them. The backend never reorders.

## Failure modes

| Failure | Boundary promise |
|---|---|
| SDK subprocess crashes | The backend detects process-exit, marks the backend as down, surfaces a "LLM backend down" error to the gateway, attempts restart with backoff. |
| Provider returns 401 (unauthorized) | The backend surfaces a friendly "your API key is invalid or expired" error to the user. |
| Provider returns 429 (rate limited) | The backend retries with exponential backoff up to 3 times, then surfaces a "rate limited, try again in N seconds" error. |
| `sendAndWait` exceeds `timeoutMs` | The backend resolves the promise with `{ kind: 'error', message: 'Timeout after Xms waiting for session.idle' }`. The gateway maps this to a friendly user-facing message. |
| User switches provider mid-send | The current `send()` is cancelled, the new provider takes over on the next `send()`. No archive; history carries over. |
| Tool permission denied by user | The SDK returns a `denied` event; the backend surfaces `{ kind: 'permission-denied', toolName }` to the gateway. The agent loop is told to continue without the tool's result. |

## Cross-references

- **Pinned by:** ADR 001, ADR 002, ADR 007.
- **Depends on:** the agent registry (`03-agent-registry.md`) for system prompts; the channel-adapter spec (`01-channel-adapter.md`) for the `StreamSink` type.
- **Depended on by:** the session store (`02-session-store.md`) for `CopilotSession`-shaped handles; the message lifecycle spec (`06-message-lifecycle.md`) for the full event flow.

## Open questions

- **Multi-provider fallback.** Should the backend fall back to a secondary provider if the primary times out or 5xx's? v1 recommendation: **no.** The user picks a provider; if it fails, the user picks another. A v2 feature could add a `providers.fallback: [name1, name2]` config block. *YAGNI for v1.*
- **Direct OpenAI / Anthropic SDKs.** The Copilot SDK already wraps these. A future spec could expose "use the OpenAI SDK directly, bypassing the Copilot CLI subprocess" as a backend option. *YAGNI for v1; the Copilot SDK is the canonical backend per the vision statement.*
