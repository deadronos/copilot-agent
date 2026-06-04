import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ArchivedSession,
  ArchiveReason,
  CreateSessionOpts,
  LlmSession,
  SessionHandle,
} from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('session-store');

// ── Public interface ─────────────────────────────────────────────────

export interface SessionStore {
  getActive(userId: string): SessionHandle | null;
  create(userId: string, opts: CreateSessionOpts): SessionHandle;
  setLive(userId: string, live: LlmSession): void;
  archive(userId: string, reason: ArchiveReason): Promise<ArchivedSession>;
  listArchived(userId: string, limit?: number): Promise<ArchivedSession[]>;
  resume(userId: string, n: number): Promise<SessionHandle>;
  enqueue(userId: string, fn: () => Promise<void>): Promise<void>;
  markIdle(userId: string, sessionId: string): void;
  sweep(ttlMs: number): Promise<number>;
  getAllActive(): SessionHandle[];
}

// ── Implementation ───────────────────────────────────────────────────

export class SessionStoreImpl implements SessionStore {
  /** In-memory map of active sessions, keyed by userId. */
  private readonly active = new Map<string, SessionHandle>();
  /** Per-user serialization queue. Each value is the promise of the currently-running handler. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly configDir: string;
  private readonly historyDir: string;

  constructor(configDir: string, historyDir: string) {
    this.configDir = configDir;
    this.historyDir = historyDir;
  }

  // ── Active session access ────────────────────────────────────────

  getActive(userId: string): SessionHandle | null {
    return this.active.get(userId) ?? null;
  }

  getAllActive(): SessionHandle[] {
    return Array.from(this.active.values());
  }

  create(userId: string, opts: CreateSessionOpts): SessionHandle {
    const handle: SessionHandle = {
      sessionId: randomUUID(),
      userId,
      agent: opts.agent,
      presetId: opts.presetId,
      model: opts.model,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      live: null,
    };
    this.active.set(userId, handle);
    log.info({ userId, sessionId: handle.sessionId, agent: handle.agent }, 'session created');
    return handle;
  }

  setLive(userId: string, live: LlmSession): void {
    const handle = this.active.get(userId);
    if (handle) {
      (handle as { live: LlmSession }).live = live;
    }
  }

  markIdle(userId: string, sessionId: string): void {
    const handle = this.active.get(userId);
    if (handle && handle.sessionId === sessionId) {
      (handle as { lastActivityAt: number }).lastActivityAt = Date.now();
    }
  }

  // ── Archive ──────────────────────────────────────────────────────

  async archive(userId: string, reason: ArchiveReason): Promise<ArchivedSession> {
    const handle = this.active.get(userId);
    if (!handle) {
      throw new Error(`no active session for user ${userId}`);
    }
    this.active.delete(userId);

    const archived: ArchivedSession = {
      sessionId: handle.sessionId,
      userId: handle.userId,
      agent: handle.agent,
      presetId: handle.presetId,
      model: handle.model,
      createdAt: handle.createdAt,
      archivedAt: Date.now(),
      archiveReason: reason.kind,
      path: this.archivePath(userId, handle.sessionId),
    };

    await this.writeArchive(archived);
    log.info(
      { userId, sessionId: handle.sessionId, reason: reason.kind },
      'session archived',
    );
    return archived;
  }

  async listArchived(userId: string, limit?: number): Promise<ArchivedSession[]> {
    const dir = join(this.historyDir, userId);
    try {
      const entries = await readdir(dir);
      const sessions: ArchivedSession[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(dir, entry), 'utf-8');
          sessions.push(JSON.parse(raw) as ArchivedSession);
        } catch {
          log.warn({ path: join(dir, entry) }, 'corrupt archive file, skipping');
        }
      }
      sessions.sort((a, b) => b.archivedAt - a.archivedAt);
      return limit != null ? sessions.slice(0, limit) : sessions;
    } catch {
      // directory doesn't exist yet
      return [];
    }
  }

  async resume(userId: string, n: number): Promise<SessionHandle> {
    const archived = await this.listArchived(userId);
    if (n < 0 || n >= archived.length) {
      throw new Error(
        `invalid resume index ${n} (have ${archived.length} archived sessions)`,
      );
    }
    const entry = archived[n];
    if (!entry) {
      throw new Error(`no session at index ${n}`);
    }

    // Archive current active session if any
    if (this.active.has(userId)) {
      await this.archive(userId, { kind: 'user-new-session' });
    }

    const handle: SessionHandle = {
      sessionId: randomUUID(), // new live session
      userId: entry.userId,
      agent: entry.agent,
      presetId: entry.presetId,
      model: entry.model,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      live: null,
    };
    this.active.set(userId, handle);
    log.info(
      { userId, sessionId: handle.sessionId, resumedFrom: entry.sessionId },
      'session resumed from archive',
    );
    return handle;
  }

  // ── Concurrency ──────────────────────────────────────────────────

  async enqueue(userId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(userId) ?? Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    this.queues.set(userId, next);
    await next;
  }

  // ── TTL sweep ────────────────────────────────────────────────────

  async sweep(ttlMs: number): Promise<number> {
    const now = Date.now();
    let evicted = 0;
    for (const [userId, handle] of this.active) {
      if (now - handle.lastActivityAt > ttlMs) {
        await this.archive(userId, { kind: 'ttl-eviction' });
        evicted++;
      }
    }
    if (evicted > 0) {
      log.info({ evicted, ttlMs }, 'ttl sweep evicted sessions');
    }
    return evicted;
  }

  // ── Internal helpers ─────────────────────────────────────────────

  private archivePath(userId: string, sessionId: string): string {
    return join(this.historyDir, userId, `${sessionId}.json`);
  }

  private async writeArchive(entry: ArchivedSession): Promise<void> {
    const dir = join(this.historyDir, entry.userId);
    await mkdir(dir, { recursive: true });
    const target = join(dir, `${entry.sessionId}.json`);
    const tmp = `${target}.tmp`;
    const content = JSON.stringify(entry, null, 2);
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, target);
  }
}
