// Per-user Copilot client pool.
//
// A `CopilotClient` bundles and manages its own Copilot CLI runtime
// subprocess (over stdio JSON-RPC) — it is expensive to start and meant to
// be reused across turns, exactly like OpenCode's `opencode serve` daemon
// (see `openCodeServerPool.ts`) and unlike Codex's spawn-per-turn SDK.
//
// Bottega keeps one started client per user, warm across turns and
// idle-reaped. Every consumer (`CopilotProvider`, the `/models` route)
// goes through `getOrSpawnCopilotClient(userId)` — never constructs a
// client directly. The per-user GitHub token (from `copilotCredentials`)
// is injected at construction via the `gitHubToken` option, and the
// per-user `COPILOT_HOME` (`baseDirectory`) isolates on-disk state.
//
// Pool invalidation mirrors OpenCode's R5: when the per-user token is
// written or cleared, the running client still holds the old token, so
// `invalidateCopilotClient(userId)` stops it and the next call spawns a
// fresh one.

import { CopilotClient } from '@github/copilot-sdk';

import {
  readCopilotToken,
  resolveCopilotHomeDir,
} from '../../copilotCredentials.js';

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_REAP_INTERVAL_MS = 60_000;

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface CopilotClientHandle {
  userId: number;
  client: CopilotClient;
  startedAt: number;
  lastUsedAt: number;
  /** Mark this handle stale so the next get() awaits shutdown. */
  stale: boolean;
}

interface CopilotClientEntry {
  handle: CopilotClientHandle;
  /** Pending shutdown promise after invalidate() / idle reap. */
  shutdown$?: Promise<void>;
}

/** How the pool creates a client — injectable so unit tests pass a fake. */
export type CreateClientFn = (args: {
  userId: number;
  gitHubToken: string;
  baseDirectory: string;
}) => CopilotClient;

interface PoolDeps {
  createClient: CreateClientFn;
  idleTimeoutMs: number;
  reapIntervalMs: number;
  now: () => number;
}

const defaultCreateClient: CreateClientFn = ({ gitHubToken, baseDirectory }) =>
  new CopilotClient({
    gitHubToken,
    baseDirectory,
    logLevel: 'error',
  });

const defaultDeps: PoolDeps = {
  createClient: defaultCreateClient,
  idleTimeoutMs: parseIntEnv(
    process.env['COPILOT_IDLE_TIMEOUT_MS'],
    DEFAULT_IDLE_TIMEOUT_MS,
  ),
  reapIntervalMs: parseIntEnv(
    process.env['COPILOT_REAP_INTERVAL_MS'],
    DEFAULT_REAP_INTERVAL_MS,
  ),
  now: () => Date.now(),
};

class CopilotClientPool {
  private readonly entries = new Map<number, CopilotClientEntry>();
  private readonly pending = new Map<number, Promise<CopilotClientHandle>>();
  private reapTimer: NodeJS.Timeout | null = null;
  private deps: PoolDeps;

  constructor(deps: PoolDeps) {
    this.deps = deps;
  }

  setDeps(partial: Partial<PoolDeps>): void {
    this.deps = { ...this.deps, ...partial };
  }

  getStatus(userId: number): { running: boolean; lastUsedAt: number | null } {
    const entry = this.entries.get(userId);
    if (!entry) return { running: false, lastUsedAt: null };
    return { running: !entry.handle.stale, lastUsedAt: entry.handle.lastUsedAt };
  }

  async getOrSpawn(userId: number): Promise<CopilotClientHandle> {
    const existing = this.entries.get(userId);
    if (existing && !existing.handle.stale) {
      existing.handle.lastUsedAt = this.deps.now();
      return existing.handle;
    }
    if (existing && existing.handle.stale) {
      await existing.shutdown$;
    }
    const inFlight = this.pending.get(userId);
    if (inFlight) return inFlight;
    const promise = this.spawnEntry(userId).finally(() => {
      this.pending.delete(userId);
    });
    this.pending.set(userId, promise);
    return promise;
  }

  async invalidate(userId: number): Promise<void> {
    const entry = this.entries.get(userId);
    if (!entry) return;
    entry.handle.stale = true;
    if (!entry.shutdown$) {
      entry.shutdown$ = this.terminate(entry);
    }
    await entry.shutdown$;
  }

  async shutdownAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      entry.handle.stale = true;
      if (!entry.shutdown$) entry.shutdown$ = this.terminate(entry);
      tasks.push(entry.shutdown$);
    }
    await Promise.allSettled(tasks);
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  /** Test helper — drop every entry without awaiting termination. */
  _hardReset(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    for (const entry of this.entries.values()) {
      void entry.handle.client.stop().catch(() => {});
    }
    this.entries.clear();
    this.pending.clear();
  }

  private startReaperIfNeeded(): void {
    if (this.reapTimer) return;
    if (!Number.isFinite(this.deps.reapIntervalMs)) return;
    const timer = setInterval(() => {
      this.reapIdle().catch((err) => {
        console.error('[CopilotClientPool] reaper error', err);
      });
    }, this.deps.reapIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.reapTimer = timer;
  }

  private async reapIdle(): Promise<void> {
    const now = this.deps.now();
    for (const entry of this.entries.values()) {
      if (entry.handle.stale) continue;
      if (now - entry.handle.lastUsedAt > this.deps.idleTimeoutMs) {
        entry.handle.stale = true;
        if (!entry.shutdown$) entry.shutdown$ = this.terminate(entry);
      }
    }
  }

  private async spawnEntry(userId: number): Promise<CopilotClientHandle> {
    const { token } = readCopilotToken(userId);
    const baseDirectory = resolveCopilotHomeDir(userId);
    const client = this.deps.createClient({
      userId,
      gitHubToken: token,
      baseDirectory,
    });
    await client.start();
    const now = this.deps.now();
    const handle: CopilotClientHandle = {
      userId,
      client,
      startedAt: now,
      lastUsedAt: now,
      stale: false,
    };
    const entry: CopilotClientEntry = { handle };
    this.entries.set(userId, entry);
    this.startReaperIfNeeded();
    console.log(
      '[CopilotClientPool] Launch audit:',
      JSON.stringify({ source: 'copilotClientPool', userId }),
    );
    return handle;
  }

  private async terminate(entry: CopilotClientEntry): Promise<void> {
    try {
      await entry.handle.client.stop();
    } catch (err) {
      console.warn('[CopilotClientPool] client.stop() failed', err);
      try {
        await entry.handle.client.forceStop();
      } catch {
        // ignore
      }
    } finally {
      const current = this.entries.get(entry.handle.userId);
      if (current === entry) this.entries.delete(entry.handle.userId);
    }
  }
}

let pool = new CopilotClientPool(defaultDeps);

export function getOrSpawnCopilotClient(
  userId: number,
): Promise<CopilotClientHandle> {
  return pool.getOrSpawn(userId);
}

export function getCopilotClientStatus(
  userId: number,
): { running: boolean; lastUsedAt: number | null } {
  return pool.getStatus(userId);
}

export async function invalidateCopilotClient(userId: number): Promise<void> {
  await pool.invalidate(userId);
}

export async function shutdownAllCopilotClients(): Promise<void> {
  await pool.shutdownAll();
}

/** Test-only: swap dependency injections (createClient, time, etc.). */
export function _setCopilotClientPoolDeps(deps: Partial<PoolDeps>): void {
  if (process.env['VITEST'] !== 'true' && process.env['NODE_ENV'] !== 'test') {
    throw new Error('_setCopilotClientPoolDeps is test-only');
  }
  pool.setDeps(deps);
}

/** Test-only: reset pool state for isolation between tests. */
export function _resetCopilotClientPool(overrides: Partial<PoolDeps> = {}): void {
  if (process.env['VITEST'] !== 'true' && process.env['NODE_ENV'] !== 'test') {
    throw new Error('_resetCopilotClientPool is test-only');
  }
  pool._hardReset();
  pool = new CopilotClientPool({ ...defaultDeps, ...overrides });
}

// Best-effort process-exit cleanup — don't leave Copilot runtimes behind.
if (typeof process !== 'undefined' && process.env['VITEST'] !== 'true') {
  const onShutdown = (signal: string): void => {
    void pool.shutdownAll().finally(() => {
      if (signal === 'SIGTERM' || signal === 'SIGINT') {
        process.exit(0);
      }
    });
  };
  process.once('SIGTERM', () => onShutdown('SIGTERM'));
  process.once('SIGINT', () => onShutdown('SIGINT'));
  process.once('beforeExit', () => {
    void pool.shutdownAll();
  });
}
