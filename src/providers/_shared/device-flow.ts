import { createLogger } from '../../logger.js';

const log = createLogger('providers:device-flow');

/**
 * Run a device-authorization flow.
 *
 * In v1 this is a **stub**: it prints instructions to stdout and returns
 * a placeholder token. A real implementation would:
 *
 *  1. POST to the device-code endpoint to get `device_code`, `user_code`,
 *     `verification_uri`, and `interval`.
 *  2. Print `verification_uri` and `user_code` to the user.
 *  3. Poll the token endpoint every `interval` seconds until the user
 *     completes authorization or the device code expires.
 *  4. Return the access token.
 *
 * The Copilot SDK is expected to handle the full GitHub device flow in a
 * future integration; this stub exists so the provider interface can be
 * exercised end-to-end without real network calls.
 */
export async function runDeviceFlow(
  _clientId: string,
  _scopes?: ReadonlyArray<string>,
): Promise<string> {
  log.info(
    'device flow stub: visit https://github.com/login/device and enter the code shown below',
  );
  log.info('device code: XXXX-XXXX (placeholder — v2 will implement real flow)');

  // Placeholder — returns a fake token so callers can exercise the pipeline.
  return 'ghp_device_flow_placeholder_v1';
}
