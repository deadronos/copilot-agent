import pino from 'pino';

// ── Root logger with secret redaction ──────────────────────────────

const isDev = process.env.NODE_ENV !== 'production';

export const logger: pino.Logger = pino({
  name: 'copilot-agent',
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  redact: {
    paths: [
      // Flat keys that carry secrets
      'apiKey',
      'token',
      'secret',
      'password',
      'key',
      'authorization',
      'botToken',
      // Wildcard matches for nested objects
      '*.apiKey',
      '*.token',
      '*.secret',
      '*.password',
      '*.key',
      '*.authorization',
      '*.botToken',
      '*.headers.authorization',
      '*.headers.Authorization',
      // Config objects that embed secrets
      'config.apiKey',
      'config.token',
      'config.secret',
    ],
    censor: '***REDACTED***',
  },
});

// ── Child logger factory ───────────────────────────────────────────

export function createLogger(name: string): pino.Logger {
  return logger.child({ module: name });
}
