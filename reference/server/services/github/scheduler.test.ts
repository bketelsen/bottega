import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../database/db.js', () => ({
  projectsDb: { getGithubAutomationEnabled: vi.fn(() => []) },
}));
vi.mock('./reconcile.js', () => ({ reconcileRepository: vi.fn() }));

import { GitHubRecoveryScheduler } from './scheduler.js';

describe('GitHubRecoveryScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('scans only enabled linked projects with startup staggering', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const scheduler = new GitHubRecoveryScheduler({
      intervalMs: 10_000,
      staggerMs: 100,
      listProjects: () => [
        { id: 1, github_repo: 'org/one', github_automation_enabled: 1 },
        { id: 2, github_repo: null, github_automation_enabled: 1 },
        { id: 3, github_repo: 'org/three', github_automation_enabled: 0 },
        { id: 4, github_repo: 'org/four', github_automation_enabled: 1 },
      ],
      reconcile,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledWith(1);
    expect(reconcile).not.toHaveBeenCalledWith(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcile).toHaveBeenCalledWith(4);
    scheduler.stop();
    await scheduler.drain();
  });

  it('suppresses overlapping scans for the same project', async () => {
    let finish: (() => void) | undefined;
    const reconcile = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const scheduler = new GitHubRecoveryScheduler({
      intervalMs: 50,
      staggerMs: 0,
      listProjects: () => [{ id: 1, github_repo: 'org/repo', github_automation_enabled: 1 }],
      reconcile,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(reconcile).toHaveBeenCalledTimes(1);
    finish?.();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(51);
    expect(reconcile).toHaveBeenCalledTimes(2);
    finish?.();
    scheduler.stop();
    await scheduler.drain();
  });

  it('cancels staggered work and drains an active scan on stop', async () => {
    let finish: (() => void) | undefined;
    const reconcile = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const scheduler = new GitHubRecoveryScheduler({
      intervalMs: 10_000,
      staggerMs: 100,
      listProjects: () => [
        { id: 1, github_repo: 'org/one', github_automation_enabled: 1 },
        { id: 2, github_repo: 'org/two', github_automation_enabled: 1 },
      ],
      reconcile,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    scheduler.stop();
    const stopping = scheduler.drain().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish?.();
    await stopping;
    await vi.advanceTimersByTimeAsync(200);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('start and stop are idempotent', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const scheduler = new GitHubRecoveryScheduler({
      intervalMs: 100,
      staggerMs: 0,
      listProjects: () => [{ id: 1, github_repo: 'org/repo', github_automation_enabled: 1 }],
      reconcile,
    });
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
    scheduler.stop();
    scheduler.stop();
    await scheduler.drain();
    await scheduler.drain();
  });
});
