import type { ChannelAdapter } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('channel-registry');

const channels = new Map<string, ChannelAdapter>();

export function registerChannel(adapter: ChannelAdapter): void {
  if (channels.has(adapter.id)) {
    throw new Error(`Channel "${adapter.id}" is already registered`);
  }
  channels.set(adapter.id, adapter);
  log.info({ id: adapter.id }, 'Channel registered');
}

export function getChannel(id: string): ChannelAdapter | undefined {
  return channels.get(id);
}

export function listChannels(): ReadonlyArray<ChannelAdapter> {
  return Array.from(channels.values());
}

// ── Compile-time imports ─────────────────────────────────────────────
//
// These imports cause the adapters to be loaded and registered at startup.
// Add new channel adapters here as they are implemented.

import { TelegramAdapter } from './telegram/index.js';
import { NoopChannelAdapter } from './noop.js';

// Register built-in adapters. The gateway may override or extend these at
// runtime via registerChannel().
registerChannel(new TelegramAdapter());
registerChannel(new NoopChannelAdapter());
