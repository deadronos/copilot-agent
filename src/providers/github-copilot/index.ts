import type { Provider } from '../types.js';
import { BaseProvider } from '../_shared/base.js';
import { buildByokConfig } from './byok.js';
import { onboardGitHubCopilot } from './onboard.js';

class GitHubCopilotProvider extends BaseProvider {
  readonly id = 'github-copilot';
  readonly displayName = 'GitHub Copilot';
  readonly capabilities = {
    apiKey: false,
    deviceFlow: true,
    oauthFlow: false,
    dynamicModels: false,
    healthCheck: false,
  } as const;

  onboard = onboardGitHubCopilot;
  buildByokConfig = buildByokConfig;
}

export const githubCopilotProvider: Provider = new GitHubCopilotProvider();
