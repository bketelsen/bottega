import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../database/db.js', () => ({
  tasksDb: {
    getWithProject: vi.fn(),
    markPrAgentComplete: vi.fn(),
  },
  projectsDb: { getByIdAdmin: vi.fn() },
  agentRunsDb: {
    getLatestPrRun: vi.fn(),
    getRecoverableGitHubFinalizations: vi.fn().mockReturnValue([]),
    claimGitHubFinalization: vi.fn(),
    reclaimStaleGitHubFinalization: vi.fn(),
    recordGitHubFinalized: vi.fn(),
    recordGitHubFinalizeFailure: vi.fn(),
  },
}));

vi.mock('../shell.js', () => ({ runCommand: vi.fn() }));
vi.mock('./gitAuth.js', () => ({ resolveTrustedGitHubAuth: vi.fn().mockResolvedValue(null) }));
vi.mock('./capabilities.js', () => ({ assertCapability: vi.fn() }));
vi.mock('../worktree.js', () => ({
  commitAllChanges: vi.fn(),
  getBranchName: vi.fn(),
  getPullRequestStatus: vi.fn(),
  getWorktreePath: vi.fn(() => '/repo-worktrees/task-7'),
  getWorktreeStatus: vi.fn(),
  hasUncommittedChanges: vi.fn(),
  worktreeExists: vi.fn(),
}));
vi.mock('../prService.js', () => ({
  ensureTaskPullRequestUnlocked: vi.fn(),
}));

import { agentRunsDb, projectsDb, tasksDb } from '../../database/db.js';
import { runCommand } from '../shell.js';
import {
  getBranchName,
  getWorktreeStatus,
  hasUncommittedChanges,
  worktreeExists,
} from '../worktree.js';
import { ensureTaskPullRequestUnlocked } from '../prService.js';
import { finalizePrAgentRun, recoverPrAgentRunFinalizations } from './finalize.js';

const sha = '1'.repeat(40);
const remoteSha = '2'.repeat(40);
const readyRun = {
  id: 9,
  task_id: 7,
  agent_type: 'pr',
  status: 'completed',
  github_finalize_status: 'ready',
  github_finalize_head_sha: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tasksDb.getWithProject).mockReturnValue({
    id: 7,
    project_id: 3,
    repo_folder_path: '/repo',
    title: 'Task title',
  } as never);
  vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({ id: 3, github_repo: null } as never);
  vi.mocked(agentRunsDb.getLatestPrRun).mockReturnValue(readyRun as never);
  vi.mocked(agentRunsDb.claimGitHubFinalization).mockReturnValue({
    ...readyRun,
    github_finalize_status: 'finalizing',
  } as never);
  vi.mocked(agentRunsDb.recordGitHubFinalized).mockReturnValue({
    ...readyRun,
    github_finalize_status: 'finalized',
    github_finalize_head_sha: sha,
  } as never);
  vi.mocked(worktreeExists).mockResolvedValue(true);
  vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: false });
  vi.mocked(getBranchName).mockResolvedValue('task/7-title');
  vi.mocked(getWorktreeStatus).mockResolvedValue({ success: true });
  vi.mocked(ensureTaskPullRequestUnlocked).mockResolvedValue({
    success: true,
    url: 'https://github.com/acme/repo/pull/12',
  });
  vi.mocked(runCommand).mockImplementation(async (_command, args) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${sha}\n`, stderr: '' };
    if (args[0] === 'rev-parse') return { stdout: `${remoteSha}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  });
});

describe('finalizePrAgentRun', () => {
  it('claims, publishes, and records the finalized HEAD exactly once', async () => {
    await expect(finalizePrAgentRun(7, 9)).resolves.toMatchObject({
      success: true,
      finalized: true,
      headSha: sha,
    });
    expect(agentRunsDb.claimGitHubFinalization).toHaveBeenCalledWith(9);
    expect(agentRunsDb.recordGitHubFinalized).toHaveBeenCalledWith(9, sha);
    expect(tasksDb.markPrAgentComplete).toHaveBeenCalledWith(7);
  });

  it('makes duplicate completion a no-op after finalization', async () => {
    vi.mocked(agentRunsDb.getLatestPrRun).mockReturnValue({
      ...readyRun,
      github_finalize_status: 'finalized',
      github_finalize_head_sha: sha,
    } as never);

    await expect(finalizePrAgentRun(7, 9)).resolves.toMatchObject({ success: true, headSha: sha });
    expect(agentRunsDb.claimGitHubFinalization).not.toHaveBeenCalled();
    expect(ensureTaskPullRequestUnlocked).not.toHaveBeenCalled();
  });

  it('never leases a non-ready, unsuccessful, or missing-worktree run', async () => {
    vi.mocked(agentRunsDb.getLatestPrRun).mockReturnValue({
      ...readyRun,
      status: 'failed',
    } as never);
    await expect(finalizePrAgentRun(7, 9)).resolves.toMatchObject({ success: false, skipped: true });

    vi.mocked(agentRunsDb.getLatestPrRun).mockReturnValue(readyRun as never);
    vi.mocked(worktreeExists).mockResolvedValue(false);
    await expect(finalizePrAgentRun(7, 9)).resolves.toMatchObject({ success: false, skipped: true });
    expect(agentRunsDb.claimGitHubFinalization).not.toHaveBeenCalled();
  });

  it('reclaims a stale finalizing lease', async () => {
    vi.mocked(agentRunsDb.getLatestPrRun).mockReturnValue({
      ...readyRun,
      github_finalize_status: 'finalizing',
    } as never);
    vi.mocked(agentRunsDb.reclaimStaleGitHubFinalization).mockReturnValue({
      ...readyRun,
      github_finalize_status: 'finalizing',
    } as never);

    await finalizePrAgentRun(7, 9, { leaseTimeoutMs: 0 });
    expect(agentRunsDb.reclaimStaleGitHubFinalization).toHaveBeenCalledWith(9, 0);
  });

  it('uses the exact remote SHA for force-with-lease after a rebase', async () => {
    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${sha}\n`, stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: `${remoteSha}\n`, stderr: '' };
      if (args[0] === 'merge-base') throw new Error('not an ancestor');
      return { stdout: '', stderr: '' };
    });

    await finalizePrAgentRun(7, 9);
    expect(ensureTaskPullRequestUnlocked).toHaveBeenCalledWith(7, expect.objectContaining({
      forceWithLeaseExpectedSha: remoteSha,
    }));
  });

  it('records a failed attempt so a crash-recovery retry can claim it', async () => {
    vi.mocked(ensureTaskPullRequestUnlocked).mockRejectedValueOnce(new Error('crash after push'));
    await expect(finalizePrAgentRun(7, 9)).resolves.toMatchObject({ success: false });
    expect(agentRunsDb.recordGitHubFinalizeFailure).toHaveBeenCalledWith(9, expect.any(Error));
  });
});

describe('recoverPrAgentRunFinalizations', () => {
  it('reclaims a crashed stale lease and does not publish twice across overlapping scans', async () => {
    let state: {
      id: number;
      task_id: number;
      agent_type: string;
      status: string;
      github_finalize_status: string;
      github_finalize_head_sha: string | null;
    } = { ...readyRun, github_finalize_status: 'finalizing' };
    vi.mocked(agentRunsDb.getRecoverableGitHubFinalizations).mockReturnValue([state] as never);
    vi.mocked(agentRunsDb.getLatestPrRun).mockImplementation(() => state as never);
    vi.mocked(agentRunsDb.reclaimStaleGitHubFinalization).mockImplementation(() => state as never);
    vi.mocked(agentRunsDb.recordGitHubFinalized).mockImplementation((_id, headSha) => {
      state = { ...state, github_finalize_status: 'finalized', github_finalize_head_sha: headSha };
      return state as never;
    });

    await Promise.all([
      recoverPrAgentRunFinalizations(3, { leaseTimeoutMs: 60_000 }),
      recoverPrAgentRunFinalizations(3, { leaseTimeoutMs: 60_000 }),
    ]);

    expect(agentRunsDb.reclaimStaleGitHubFinalization).toHaveBeenCalledTimes(1);
    expect(getWorktreeStatus).toHaveBeenCalledTimes(1);
    expect(ensureTaskPullRequestUnlocked).toHaveBeenCalledTimes(1);
    expect(tasksDb.markPrAgentComplete).toHaveBeenCalledTimes(1);
  });

  it('retries ready and failed runs and continues after one item fails', async () => {
    const failedRun = { ...readyRun, id: 10, task_id: 8, github_finalize_status: 'failed' };
    vi.mocked(agentRunsDb.getRecoverableGitHubFinalizations).mockReturnValue([
      readyRun,
      failedRun,
    ] as never);
    vi.mocked(agentRunsDb.getLatestPrRun).mockImplementation((taskId) => (
      taskId === 7 ? readyRun : failedRun
    ) as never);
    vi.mocked(agentRunsDb.claimGitHubFinalization).mockImplementation((id) => ({
      ...(id === 9 ? readyRun : failedRun),
      github_finalize_status: 'finalizing',
    }) as never);
    vi.mocked(tasksDb.getWithProject).mockImplementation((taskId) => ({
      id: taskId,
      project_id: 3,
      repo_folder_path: '/repo',
      title: `Task ${taskId}`,
    }) as never);
    vi.mocked(ensureTaskPullRequestUnlocked)
      .mockRejectedValueOnce(new Error('first retry failed'))
      .mockResolvedValueOnce({ success: true, url: 'https://github.com/acme/repo/pull/12' });

    await recoverPrAgentRunFinalizations(3);

    expect(agentRunsDb.claimGitHubFinalization).toHaveBeenCalledWith(9);
    expect(agentRunsDb.claimGitHubFinalization).toHaveBeenCalledWith(10);
    expect(ensureTaskPullRequestUnlocked).toHaveBeenCalledTimes(2);
    expect(agentRunsDb.recordGitHubFinalized).toHaveBeenCalledWith(10, sha);
  });
});
