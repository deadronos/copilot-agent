import { writeFile, rename, unlink } from 'node:fs/promises';
import { createLogger } from '../../logger.js';

const log = createLogger('providers:fs');

export interface AtomicWriteOptions {
  /** File mode, defaults to 0o600. */
  readonly mode?: number;
}

/**
 * Atomically write content to a file.
 *
 * Writes to a `.tmp` sibling first, then renames it over the target.
 * This prevents readers from seeing partial content.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const mode = opts.mode ?? 0o600;
  const tmpPath = `${filePath}.tmp`;

  log.debug('writing atomically to %s', filePath);
  await writeFile(tmpPath, content, { mode, encoding: 'utf-8' });
  await rename(tmpPath, filePath);
  log.debug('atomic write complete for %s', filePath);
}

/**
 * Safely delete a file, ignoring ENOENT.
 */
export async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
    log.debug('removed file %s', filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}
