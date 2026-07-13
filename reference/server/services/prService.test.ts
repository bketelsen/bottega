import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./worktree.js', () => ({
  hasUncommittedChanges: vi.fn(),
  commitAllChanges: vi.fn(),
  createPullRequest: vi.fn(),
  getPullRequestStatus: vi.fn(),
  getWorktreeStatus: vi.fn(),
  pushChanges: vi.fn(),
}));

vi.mock('./github/reconcile.js', () => ({
  syncTaskPullRequest: vi.fn(),
}));

import {
  commitAllChanges,
  createPullRequest,
  getPullRequestStatus,
  getWorktreeStatus,
  hasUncommittedChanges,
  pushChanges,
} from './worktree.js';
import { syncTaskPullRequest } from './github/reconcile.js';
import { createOrUpdatePR, _internal } from './prService.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPullRequestStatus).mockResolvedValue({ success: false, exists: false });
  vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: false });
  vi.mocked(getWorktreeStatus).mockResolvedValue({ success: true, ahead: 1, behind: 0 });
  vi.mocked(pushChanges).mockResolvedValue({ success: true });
});

describe('createOrUpdatePR', () => {
  it('reuses and links a PR found for the task branch', async () => {
    vi.mocked(getPullRequestStatus).mockResolvedValue({
      success: true,
      exists: true,
      url: 'https://github.com/acme/repo/pull/42',
      state: 'OPEN',
    });

    await expect(createOrUpdatePR('/repo', 7, 'Title', 'Body')).resolves.toEqual({
      success: true,
      url: 'https://github.com/acme/repo/pull/42',
    });
    expect(syncTaskPullRequest).toHaveBeenCalledWith(7, 42);
    expect(pushChanges).toHaveBeenCalledWith('/repo', 7, 'Title', {});
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it.each(['CLOSED', 'MERGED'])('does not reuse a %s branch PR', async (state) => {
    vi.mocked(getPullRequestStatus).mockResolvedValue({
      success: true,
      exists: true,
      url: 'https://github.com/acme/repo/pull/42',
      state,
    });
    vi.mocked(createPullRequest).mockResolvedValue({
      success: true,
      url: 'https://github.com/acme/repo/pull/43',
    });

    await expect(createOrUpdatePR('/repo', 7, 'Title', 'Body')).resolves.toEqual({
      success: true,
      url: 'https://github.com/acme/repo/pull/43',
    });

    expect(pushChanges).not.toHaveBeenCalled();
    expect(createPullRequest).toHaveBeenCalledWith('/repo', 7, 'Title', 'Body', {});
  });

  it('commits changes before pushing an existing open PR', async () => {
    vi.mocked(getPullRequestStatus).mockResolvedValue({
      success: true,
      exists: true,
      url: 'https://github.com/acme/repo/pull/42',
      state: 'OPEN',
    });
    vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: true });
    vi.mocked(commitAllChanges).mockResolvedValue({ success: true });

    await createOrUpdatePR('/repo', 7, 'Title', 'Body');

    expect(commitAllChanges).toHaveBeenCalledWith('/repo', 7, 'Title');
    expect(pushChanges).toHaveBeenCalledWith('/repo', 7, 'Title', {});
  });

  it('links a newly created PR', async () => {
    vi.mocked(createPullRequest).mockResolvedValue({
      success: true,
      url: 'https://github.com/acme/repo/pull/19',
    });

    await createOrUpdatePR('/repo', 7, 'Title', 'Body');

    expect(syncTaskPullRequest).toHaveBeenCalledWith(7, 19);
  });

  it('still commits local changes before creating the PR', async () => {
    vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: true });
    vi.mocked(commitAllChanges).mockResolvedValue({ success: true });
    vi.mocked(createPullRequest).mockResolvedValue({ success: true, url: 'https://github.com/a/b/pull/3' });

    await createOrUpdatePR('/repo', 7, 'Title', 'Body');

    expect(commitAllChanges).toHaveBeenCalledWith('/repo', 7, 'Title');
    expect(createPullRequest).toHaveBeenCalled();
  });
});

describe('pullRequestNumber', () => {
  it('parses canonical GitHub PR URLs', () => {
    expect(_internal.pullRequestNumber('https://github.com/a/b/pull/123')).toBe(123);
    expect(_internal.pullRequestNumber('not-a-pr')).toBeNull();
  });
});
