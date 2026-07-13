import { describe, expect, it, vi } from 'vitest';
import { GitHubIdentity, isBottegaComment } from './identity.js';

describe('GitHubIdentity', () => {
  it('deduplicates lookups, caches success, and retries after a transient failure', async () => {
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    const getSelf = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ login: 'bottega-owner', id: 1, type: 'User' });
    const identity = new GitHubIdentity({ getSelf });
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
});

describe('isBottegaComment', () => {
  it('recognizes broad markers and the authenticated owner case-insensitively', () => {
    expect(isBottegaComment('generated <!-- BOTTEGA:generated:evidence -->', 'human', null)).toBe(true);
    expect(isBottegaComment('unmarked', 'BOTTEGA-OWNER', 'bottega-owner')).toBe(true);
    expect(isBottegaComment('unmarked', 'actual-human', 'bottega-owner')).toBe(false);
  });
});
