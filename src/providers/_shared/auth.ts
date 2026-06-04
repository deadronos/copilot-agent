import { readFile } from 'node:fs/promises';
import { createLogger } from '../../logger.js';
import type { AuthConfig } from '../types.js';

const log = createLogger('providers:auth');

/**
 * Resolve an API key from an AuthConfig.
 *
 * Priority:
 *  1. `envVar` — reads the named environment variable
 *  2. `tokenFile` — reads the first line of the file, trims whitespace
 *
 * Returns `undefined` if no key could be resolved.
 */
export async function resolveApiKey(
  auth: AuthConfig,
): Promise<string | undefined> {
  if (auth.kind !== 'api_key') return undefined;

  if (auth.envVar) {
    const val = process.env[auth.envVar];
    if (val) {
      log.debug('resolved api key from env var %s', auth.envVar);
      return val;
    }
  }

  if (auth.tokenFile) {
    const token = await extractTokenFile(auth.tokenFile);
    if (token) {
      log.debug('resolved api key from token file %s', auth.tokenFile);
      return token;
    }
  }

  return undefined;
}

/**
 * Read the first line of a token file and return it trimmed.
 * Returns `undefined` if the file is missing or empty.
 */
export async function extractTokenFile(
  filePath: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const token = raw.split('\n')[0]?.trim();
    return token || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log.debug('token file not found: %s', filePath);
      return undefined;
    }
    throw err;
  }
}
