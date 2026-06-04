import { createLogger } from '../../logger.js';

const log = createLogger('providers:http');

export interface FetchWithTimeoutOptions extends RequestInit {
  /** Timeout in milliseconds. Default 30_000. */
  timeoutMs?: number;
}

/**
 * Fetch wrapper with configurable timeout.
 *
 * Uses `AbortController` to enforce a timeout on the request.
 * On timeout, the promise rejects with an `AbortError`-like error.
 */
export async function fetchWithTimeout(
  url: string,
  opts: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    log.debug('request timed out after %dms: %s', timeoutMs, url);
    controller.abort();
  }, timeoutMs);

  try {
    const { timeoutMs: _, ...fetchInit } = opts;
    const response = await fetch(url, {
      ...fetchInit,
      signal: controller.signal,
    });
    log.debug('%s %s -> %d', opts.method ?? 'GET', url, response.status);
    return response;
  } finally {
    clearTimeout(timer);
  }
}
