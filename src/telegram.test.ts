import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rehydratePendingPermissionsFromDisk } from './telegram.js';

describe('rehydratePendingPermissionsFromDisk', () => {
  it('is a no-op when no file exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'copilot-agent-tg-'));
    const editImpl = vi.fn();
    rehydratePendingPermissionsFromDisk(
      join(tmp, 'pending-permissions.json'),
      300_000,
      editImpl,
    );
    expect(editImpl).not.toHaveBeenCalled();
    expect(existsSync(join(tmp, 'pending-permissions.json'))).toBe(false);
  });

  it('edits the original message with "interrupted" text and clears the file for a fresh orphan', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'copilot-agent-tg-'));
    const path = join(tmp, 'pending-permissions.json');
    writeFileSync(
      path,
      JSON.stringify([
        {
          requestId: 'call_01_abc',
          chatId: 123,
          messageId: 999,
          toolName: 'shell',
          createdAt: Date.now() - 60_000, // 1 min ago, well within 5min timeout
        },
      ]),
    );

    const editImpl = vi.fn().mockResolvedValue(true);
    rehydratePendingPermissionsFromDisk(path, 300_000, editImpl);

    // editMessage is fire-and-forget; flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));

    expect(editImpl).toHaveBeenCalledWith(
      123,
      999,
      expect.stringContaining('interrupted by a bot restart'),
    );
    expect(readFileSync(path, 'utf-8')).toBe('[]');
  });

  it('uses "expired" wording for records past the timeout', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'copilot-agent-tg-'));
    const path = join(tmp, 'pending-permissions.json');
    writeFileSync(
      path,
      JSON.stringify([
        {
          requestId: 'call_01_xyz',
          chatId: 123,
          messageId: 1000,
          toolName: 'read',
          createdAt: Date.now() - 400_000, // 6m40s, past 5min default
        },
      ]),
    );

    const editImpl = vi.fn().mockResolvedValue(true);
    rehydratePendingPermissionsFromDisk(path, 300_000, editImpl);

    await new Promise((resolve) => setImmediate(resolve));

    expect(editImpl).toHaveBeenCalledWith(
      123,
      1000,
      expect.stringContaining('has expired'),
    );
  });

  it('tolerates corrupted JSON without throwing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'copilot-agent-tg-'));
    const path = join(tmp, 'pending-permissions.json');
    writeFileSync(path, 'this is not json {');

    const editImpl = vi.fn();
    expect(() =>
      rehydratePendingPermissionsFromDisk(path, 300_000, editImpl),
    ).not.toThrow();
    expect(editImpl).not.toHaveBeenCalled();
  });

  it('capitalises the tool name in the message', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'copilot-agent-tg-'));
    const path = join(tmp, 'pending-permissions.json');
    writeFileSync(
      path,
      JSON.stringify([
        {
          requestId: 'r1',
          chatId: 1,
          messageId: 1,
          toolName: 'edit_file',
          createdAt: Date.now() - 1_000,
        },
      ]),
    );

    const editImpl = vi.fn().mockResolvedValue(true);
    rehydratePendingPermissionsFromDisk(path, 300_000, editImpl);

    await new Promise((resolve) => setImmediate(resolve));

    expect(editImpl).toHaveBeenCalledWith(1, 1, expect.stringContaining('**Edit_file**'));
  });
});
