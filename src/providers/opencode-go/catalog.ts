import type { ModelInfo } from '../types.js';

/**
 * Fallback static catalog in case dynamic discovery is unavailable.
 * The primary model list is fetched live from the API via discoverModels().
 */
export const OPENCODE_GO_MODELS: ModelInfo[] = [
  {
    id: 'glm-5.1',
    displayName: 'GLM-5.1',
    contextWindow: 200_000,
    maxContextTokens: 200_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: 'kimi-k2.6',
    displayName: 'Kimi K2.6',
    contextWindow: 200_000,
    maxContextTokens: 200_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
  },
  {
    id: 'minimax-m2.7',
    displayName: 'MiniMax M2.7',
    contextWindow: 200_000,
    maxContextTokens: 200_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
  },
  {
    id: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    contextWindow: 200_000,
    maxContextTokens: 200_000,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
  },
  {
    id: 'qwen-3.6-plus',
    displayName: 'Qwen 3.6 Plus',
    contextWindow: 200_000,
    maxContextTokens: 200_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
  },
];
