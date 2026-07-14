import { describe, expect, it, vi } from 'vitest';
import { GitHubIdentity, isBottegaComment } from './identity.js';

describe('GitHubIdentity', () => {
  it('deduplicates lookups, caches success, and retries after a transient failure', async () => {
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    const getSelf = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ login: 'bottega-owner', id: 1, type: 'User' });
    const identity = new GitHubIdentity({
      getAuthMode: () => 'host',
      getAppIdentity: vi.fn(),
      getSelf,
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const failedA = identity.resolveLogin();
    const failedB = identity.resolveLogin();
    expect(getSelf).toHaveBeenCalledTimes(1);
    rejectFirst(new Error('temporary network failure'));
    await expect(Promise.all([failedA, failedB])).resolves.toEqual([null, null]);

    await expect(identity.resolveLogin()).resolves.toBe('bottega-owner');
    await expect(identity.resolveLogin()).resolves.toBe('bottega-owner');
    expect(getSelf).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it('uses the App bot identity without querying the authenticated user', async () => {
    const getSelf = vi.fn();
    const getAppIdentity = vi.fn().mockResolvedValue({ login: 'bottega[bot]', id: 99, type: 'Bot' });
    const identity = new GitHubIdentity({
      getAuthMode: () => 'app',
      getAppIdentity,
      getSelf,
    });

    await expect(identity.resolveLogin()).resolves.toBe('bottega[bot]');
    expect(getAppIdentity).toHaveBeenCalledOnce();
    expect(getSelf).not.toHaveBeenCalled();
  });
});

describe('isBottegaComment', () => {
  it('recognizes broad markers and the authenticated owner case-insensitively', () => {
    expect(isBottegaComment('generated <!-- BOTTEGA:generated:evidence -->', 'human', null)).toBe(true);
    expect(isBottegaComment('unmarked', 'BOTTEGA-OWNER', 'bottega-owner')).toBe(true);
    expect(isBottegaComment('unmarked', 'actual-human', 'bottega-owner')).toBe(false);
  });
});
