import type { ModelInfo } from '../types.js';

export const GITHUB_COPILOT_MODELS: ModelInfo[] = [
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    maxContextTokens: 200_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: 'gpt-5',
    displayName: 'GPT-5',
    contextWindow: 128_000,
    maxContextTokens: 128_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    contextWindow: 1_000_000,
    maxContextTokens: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
  },
];
