import pino from 'pino';
import { join } from 'node:path';
import { resolveConfigDir } from './config.js';

const REDACTED_FIELDS = [
  'api_key',
  'apiKey',
  'bearer_token',
  'bearerToken',
  'token',
  'TELEGRAM_BOT_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENCODE_GO_KEY',
];

let logger: pino.Logger;

/**
 * Initialize and return the singleton logger.
 */
export function getLogger(): pino.Logger {
  if (logger) return logger;

  const configDir = resolveConfigDir();
  const logPath = join(configDir, 'logs', 'copilot-agent.log');

  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino/file',
      level: process.env.LOG_LEVEL ?? 'info',
      options: { destination: logPath, mkdir: true },
    },
  ];

  // Also log to stdout in development
  if (process.env.NODE_ENV !== 'production') {
    targets.push({
      target: 'pino/file',
      level: process.env.LOG_LEVEL ?? 'info',
      options: { destination: 1 }, // stdout
    });
  }

  const transport = pino.transport({ targets });

  logger = pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: REDACTED_FIELDS,
        censor: '***',
      },
    },
    transport,
  );

  return logger;
}

/**
 * Create a child logger with a specific context.
 */
export function getChildLogger(context: string): pino.Logger {
  return getLogger().child({ context });
}
