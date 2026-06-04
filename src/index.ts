import { CopilotClient } from '@github/copilot-sdk';
import { loadConfig, resolveConfigDir } from './config.js';
import { getLogger, getChildLogger } from './logger.js';
import { loadAgents } from './agents.js';
import { SessionManager } from './sessions.js';
import { TelegramBot } from './telegram.js';

const log = getChildLogger('main');

async function main(): Promise<void> {
  const configDir = resolveConfigDir();
  log.info({ configDir }, 'Starting copilot-agent');

  // Load config
  const config = loadConfig(configDir);
  log.info({ provider: config.active.provider, model: config.active.model }, 'Config loaded');

  // Load agents
  const agents = loadAgents(config, configDir);
  log.info({ count: agents.size, agents: [...agents.keys()] }, 'Agents loaded');

  // Get Telegram token
  const telegramToken = process.env[config.telegram.token_env]!;
  if (!telegramToken) {
    throw new Error(`Missing ${config.telegram.token_env} in environment`);
  }

  // Create Copilot client
  const client = new CopilotClient({
    logLevel: (process.env.LOG_LEVEL ?? 'info') as 'info' | 'debug' | 'warning' | 'error',
  });

  // Create session manager
  const sessionManager = new SessionManager({
    client,
    config,
    configDir,
    agents,
  });

  // Create Telegram bot
  const telegramBot = new TelegramBot({
    token: telegramToken,
    config,
    sessions: sessionManager,
    agents,
  });

  // Wire permission prompts: session manager asks telegram bot to show buttons
  sessionManager.setPermissionPromptCallback((chatId, toolName, description, requestId) =>
    telegramBot.showPermissionPrompt(chatId, toolName, description, requestId),
  );

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutting down');

    telegramBot.stop();
    await sessionManager.archiveAll();

    try {
      await client.stop();
    } catch (err) {
      log.warn({ err }, 'Error stopping Copilot client');
    }

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start
  log.info('Starting Telegram bot...');
  await telegramBot.start();
}

main().catch((err) => {
  getLogger().fatal({ err }, 'Fatal error');
  process.exit(1);
});
