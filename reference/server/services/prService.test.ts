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

vi.mock('../database/db.js', () => ({
  tasksDb: {
    getById: vi.fn(),
    getWithProject: vi.fn(),
    update: vi.fn(),
  },
  projectsDb: { getByIdAdmin: vi.fn() },
}));

vi.mock('./github/finalize.js', () => ({
  prepareTaskPublication: vi.fn(),
  withTaskPublicationLock: vi.fn((_taskId, work) => work()),
}));

import {
  createPullRequest,
  getPullRequestStatus,
  getWorktreeStatus,
  hasUncommittedChanges,
  pushChanges,
} from './worktree.js';
import { syncTaskPullRequest } from './github/reconcile.js';
import { projectsDb, tasksDb } from '../database/db.js';
import { prepareTaskPublication } from './github/finalize.js';
import { createOrUpdatePR, ensureTaskPullRequest, getCIStatusWithDetails, _internal } from './prService.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPullRequestStatus).mockResolvedValue({ success: false, exists: false });
  vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: false });
  vi.mocked(getWorktreeStatus).mockResolvedValue({ success: true, ahead: 1, behind: 0 });
  vi.mocked(pushChanges).mockResolvedValue({ success: true });
  vi.mocked(tasksDb.getWithProject).mockReturnValue({
    id: 7,
    project_id: 3,
    repo_folder_path: '/repo',
    title: 'Title',
  } as never);
  vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({ id: 3, github_repo: 'acme/repo' } as never);
  vi.mocked(prepareTaskPublication).mockResolvedValue({
    repoPath: '/repo',
    projectId: 3,
    effects: { projectId: 3, beforeEffect: vi.fn() },
  });
});

describe('createOrUpdatePR', () => {
  it('delegates publication through task-resolved project context', async () => {
    vi.mocked(getPullRequestStatus).mockResolvedValue({
      success: true,
      exists: true,
      url: 'https://github.com/acme/repo/pull/42',
      state: 'OPEN',
    });

    await expect(createOrUpdatePR('/untrusted/caller/path', 7, 'Title', 'Body')).resolves.toEqual({
      success: true,
      url: 'https://github.com/acme/repo/pull/42',
    });
    expect(prepareTaskPublication).toHaveBeenCalledWith(7);
    expect(syncTaskPullRequest).toHaveBeenCalledWith(7, 42);
    expect(pushChanges).toHaveBeenCalledWith('/repo', 7, 'Title', expect.objectContaining({ projectId: 3 }));
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it('passes force-with-lease through the shared publication path', async () => {
    const sha = 'a'.repeat(40);
    vi.mocked(createPullRequest).mockResolvedValue({ success: true, url: 'https://github.com/acme/repo/pull/19' });

    await createOrUpdatePR('/repo', 7, 'Title', 'Body', { forceWithLeaseExpectedSha: sha });

    expect(pushChanges).toHaveBeenCalledWith(
      '/repo', 7, 'Title', expect.objectContaining({ forceWithLeaseExpectedSha: sha, projectId: 3 }),
    );
  });
});

describe('getCIStatusWithDetails', () => {
  it('resolves the task project and passes read auth context to PR status', async () => {
    vi.mocked(getPullRequestStatus).mockResolvedValue({
      success: true,
      exists: true,
      url: 'https://github.com/acme/repo/pull/42',
      ciStatus: { status: 'passed', checks: [] },
    });

    await expect(getCIStatusWithDetails('/repo', 7)).resolves.toMatchObject({ success: true });

    expect(getPullRequestStatus).toHaveBeenCalledWith('/repo', 7, { projectId: 3 });
  });
});

describe('pullRequestNumber', () => {
  it('parses canonical GitHub PR URLs', () => {
    expect(_internal.pullRequestNumber('https://github.com/a/b/pull/123')).toBe(123);
    expect(_internal.pullRequestNumber('not-a-pr')).toBeNull();
  });
});

describe('ensureTaskPullRequest', () => {
  it('reuses a branch PR after a crash following PR creation and projects In Review', async () => {
    vi.mocked(getPullRequestStatus).mockResolvedValue({
      success: true,
      exists: true,
      state: 'OPEN',
      url: 'https://github.com/acme/repo/pull/42',
    });

    await expect(ensureTaskPullRequest(7)).resolves.toMatchObject({ success: true });
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(syncTaskPullRequest).toHaveBeenCalledWith(7, 42);
    expect(tasksDb.update).toHaveBeenCalledWith(7, {
      github_pr_number: 42,
      status: 'in_review',
    });
  });

  it('retries safely after a crash following push but before PR creation', async () => {
    vi.mocked(createPullRequest)
      .mockResolvedValueOnce({ success: false, error: 'process stopped after push' })
      .mockResolvedValueOnce({ success: true, url: 'https://github.com/acme/repo/pull/43' });

    await expect(ensureTaskPullRequest(7)).resolves.toMatchObject({ success: false });
    await expect(ensureTaskPullRequest(7)).resolves.toMatchObject({ success: true });
    expect(createPullRequest).toHaveBeenCalledTimes(2);
    expect(syncTaskPullRequest).toHaveBeenCalledWith(7, 43);
  });

  it('rechecks capability at both remote effect boundaries', async () => {
    const guard = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => { throw new Error('capability revoked'); });
    vi.mocked(prepareTaskPublication).mockResolvedValue({
      repoPath: '/repo',
      projectId: 3,
      effects: { projectId: 3, beforeEffect: guard },
    });
    vi.mocked(createPullRequest).mockImplementation(async (_repo, _task, _title, _body, effects) => {
      await effects!.beforeEffect?.('push');
      await effects!.beforeEffect?.('createPR');
      return { success: true };
    });

    await expect(ensureTaskPullRequest(7)).rejects.toThrow('capability revoked');
    expect(guard).toHaveBeenNthCalledWith(1, 'push');
    expect(guard).toHaveBeenNthCalledWith(2, 'createPR');
  });
});
