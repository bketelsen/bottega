import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../database/db.js', () => ({
  appSettingsDb: { getValue: vi.fn().mockReturnValue('bottega') },
  projectsDb: { getByIdAdmin: vi.fn() },
  tasksDb: {
    getById: vi.fn(),
    getByProject: vi.fn().mockReturnValue([]),
    getByGithubIssue: vi.fn(),
    getByGithubPr: vi.fn(),
    update: vi.fn(),
    blockWorkflow: vi.fn(),
  },
  agentRunsDb: { getByTask: vi.fn().mockReturnValue([]) },
}));

vi.mock('../agentRunner.js', () => ({ startAgentRun: vi.fn() }));
vi.mock('../taskCreation.js', () => ({ createTaskWithWorkspace: vi.fn() }));
vi.mock('../worktree.js', () => ({ worktreeExists: vi.fn().mockResolvedValue(true) }));
vi.mock('./capabilities.js', () => ({ can: vi.fn().mockReturnValue(true) }));
vi.mock('./client.js', () => ({
  normalizeGitHubRepo: (value: string) => value.toLowerCase(),
  githubClient: {
    getSelf: vi.fn(),
    getIssue: vi.fn(),
    getIssueComments: vi.fn(),
    upsertIssueComment: vi.fn(),
    replaceIssueLabels: vi.fn(),
    getPullRequest: vi.fn(),
    findPullRequestForTaskBranch: vi.fn(),
    listOpenIssues: vi.fn(),
    listOpenPullRequests: vi.fn(),
  },
}));
vi.mock('../documentation.js', () => ({
  readTaskDoc: vi.fn().mockReturnValue('# Planned task'),
  updateGeneratedTaskDocSection: vi.fn().mockReturnValue(true),
}));

import { agentRunsDb, appSettingsDb, projectsDb, tasksDb } from '../../database/db.js';
import { startAgentRun } from '../agentRunner.js';
import { createTaskWithWorkspace } from '../taskCreation.js';
import { worktreeExists } from '../worktree.js';
import { MAX_WORKFLOW_RUNS } from '../conversation/agentRunLifecycle.js';
import { updateGeneratedTaskDocSection } from '../documentation.js';
import { can } from './capabilities.js';
import { githubClient } from './client.js';
import { githubIdentity } from './identity.js';
import {
  _internal,
  reconcileApprovedIssue,
  reconcilePullRequest,
  reconcileRepository,
  reconcileRefinementIssue,
  syncPlannedTaskToGitHub,
  syncTaskPullRequest,
  withReconcileLock,
} from './reconcile.js';

const project = {
  id: 1,
  user_id: 8,
  github_repo: 'acme/repo',
  github_automation_enabled: 1,
  autonomy_tier: 'pr',
};

const issue = {
  number: 12,
  title: 'Add feature',
  body: 'Details',
  url: 'https://github.com/acme/repo/issues/12',
  state: 'open',
  labels: ['Needs Refinement'],
};

const task = {
  id: 7,
  project_id: 1,
  github_issue_number: 12,
  github_pr_number: null,
  github_plan_comment_id: null,
  github_last_human_comment_id: 10,
  github_pr_evidence_hash: null,
  planification_complete: 1,
  workflow_complete: 0,
  workflow_blocked: 0,
  workflow_run_count: 1,
  pr_agent_complete: 0,
  status: 'pending',
  user_id: 42,
};

const comment = {
  id: 11,
  body: 'Please include retries',
  url: 'https://github.com/acme/repo/issues/12#issuecomment-11',
  authorLogin: 'human',
  authorType: 'User',
};

beforeEach(() => {
  vi.clearAllMocks();
  githubIdentity.reset();
  vi.mocked(projectsDb.getByIdAdmin).mockReturnValue(project as never);
  vi.mocked(tasksDb.getByProject).mockReturnValue([]);
  vi.mocked(tasksDb.getByGithubIssue).mockReturnValue(task as never);
  vi.mocked(tasksDb.getByGithubPr).mockReturnValue(undefined);
  vi.mocked(tasksDb.getById).mockReturnValue(task as never);
  vi.mocked(tasksDb.update).mockImplementation(((_id: number, updates: object) => ({
    ...task,
    ...updates,
  })) as never);
  vi.mocked(agentRunsDb.getByTask).mockReturnValue([]);
  vi.mocked(githubClient.getIssue).mockResolvedValue(issue as never);
  vi.mocked(githubClient.getSelf).mockResolvedValue({
    login: 'bottega-owner',
    id: 1,
    type: 'User',
  });
  vi.mocked(githubClient.getIssueComments).mockResolvedValue([comment] as never);
  vi.mocked(githubClient.listOpenIssues).mockResolvedValue([]);
  vi.mocked(githubClient.listOpenPullRequests).mockResolvedValue([]);
  vi.mocked(githubClient.upsertIssueComment).mockResolvedValue({ id: 99 });
  vi.mocked(updateGeneratedTaskDocSection).mockReturnValue(true);
  vi.mocked(can).mockReturnValue(true);
  vi.mocked(worktreeExists).mockResolvedValue(true);
  vi.mocked(appSettingsDb.getValue).mockReturnValue('bottega');
  _internal.resetPollingState();
});

describe('withReconcileLock', () => {
  it('serializes work sharing a key without serializing other keys', async () => {
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = withReconcileLock('task:7', async () => {
      events.push('first:start');
      await blocked;
      events.push('first:end');
    });
    const second = withReconcileLock('task:7', async () => { events.push('second'); });
    const independent = withReconcileLock('task:8', async () => { events.push('independent'); });

    await independent;
    expect(events).toEqual(['first:start', 'independent']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'independent', 'first:end', 'second']);
  });
});

describe('issue reconciliation', () => {
  it('reuses a listed issue snapshot instead of fetching the issue again', async () => {
    await reconcileRefinementIssue(1, 12, issue as never);

    expect(githubClient.getIssue).not.toHaveBeenCalled();
  });

  it('imports new human feedback, advances the cursor, resets planning, and starts planning', async () => {
    await reconcileRefinementIssue(1, 12);

    expect(updateGeneratedTaskDocSection).toHaveBeenCalledWith(
      1,
      7,
      'github-feedback',
      expect.stringContaining('Please include retries'),
      expect.any(Object),
    );
    expect(tasksDb.update).toHaveBeenCalledWith(7, {
      github_last_human_comment_id: 11,
      planification_complete: 0,
    });
    expect(githubClient.replaceIssueLabels).toHaveBeenCalledWith(project, 12, {
      remove: ['Ready'],
      add: ['Needs Refinement'],
    });
    expect(startAgentRun).toHaveBeenCalledWith(7, 'planification', { userId: 42 });
  });

  it('ignores owner-authored, bot-marked, and Bot comments while retaining actual humans', async () => {
    vi.mocked(githubClient.getIssueComments).mockResolvedValue([
      { ...comment, id: 11, body: 'unmarked owner output', authorLogin: 'bottega-owner' },
      { ...comment, id: 12, body: 'generated <!-- bottega:generated:feedback -->' },
      { ...comment, id: 13, body: 'automation', authorLogin: 'other-bot', authorType: 'Bot' },
      { ...comment, id: 14, body: 'actual human feedback', authorLogin: 'alice' },
    ] as never);

    await reconcileRefinementIssue(1, 12);

    const rendered = vi.mocked(updateGeneratedTaskDocSection).mock.calls[0]?.[3];
    expect(rendered).toContain('actual human feedback');
    expect(rendered).not.toContain('unmarked owner output');
    expect(rendered).not.toContain('bottega:generated');
    expect(rendered).not.toContain('automation');
    expect(tasksDb.update).toHaveBeenCalledWith(7, {
      github_last_human_comment_id: 14,
      planification_complete: 0,
    });
  });

  it('starts approved implementation only after all gates pass, then removes approval labels', async () => {
    vi.mocked(githubClient.getIssue).mockResolvedValue({ ...issue, labels: ['Ready', 'Refined'] } as never);

    await reconcileApprovedIssue(1, 12);

    expect(startAgentRun).toHaveBeenCalledWith(7, 'implementation', { userId: 42 });
    expect(githubClient.replaceIssueLabels).toHaveBeenCalledWith(project, 12, {
      remove: ['Ready', 'Refined'],
      add: [],
    });
  });

  it('does not advance feedback state when label projection fails transiently', async () => {
    vi.mocked(githubClient.replaceIssueLabels).mockRejectedValueOnce(new Error('transient'));

    await expect(reconcileRefinementIssue(1, 12)).rejects.toThrow('transient');

    expect(tasksDb.update).not.toHaveBeenCalled();
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('leaves approval labels intact when autonomy is insufficient', async () => {
    vi.mocked(githubClient.getIssue).mockResolvedValue({ ...issue, labels: ['Ready', 'Refined'] } as never);
    vi.mocked(can).mockReturnValue(false);

    await reconcileApprovedIssue(1, 12);

    expect(startAgentRun).not.toHaveBeenCalled();
    expect(githubClient.replaceIssueLabels).not.toHaveBeenCalled();
  });

  it('does not import an unknown issue from an ordinary human comment', async () => {
    vi.mocked(githubClient.getIssue).mockResolvedValue({ ...issue, labels: [] } as never);
    vi.mocked(tasksDb.getByGithubIssue).mockReturnValue(undefined);

    await reconcileRefinementIssue(1, 12);

    expect(createTaskWithWorkspace).not.toHaveBeenCalled();
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('imports and plans an unknown issue with Needs Refinement', async () => {
    vi.mocked(tasksDb.getByGithubIssue).mockReturnValue(undefined);
    vi.mocked(createTaskWithWorkspace).mockResolvedValue({
      ...task,
      user_id: 8,
      planification_complete: 0,
    } as never);
    vi.mocked(tasksDb.update).mockReturnValueOnce({
      ...task,
      user_id: 8,
      planification_complete: 0,
      github_last_human_comment_id: 11,
    } as never);

    await reconcileRefinementIssue(1, 12);

    expect(createTaskWithWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      project,
      userId: 8,
      githubIssueNumber: 12,
    }));
    expect(startAgentRun).toHaveBeenCalledWith(7, 'planification', { userId: 8 });
  });

  it('imports a directly refined issue but plans it before implementation', async () => {
    vi.mocked(githubClient.getIssue).mockResolvedValue({ ...issue, labels: ['Refined'] } as never);
    vi.mocked(tasksDb.getByGithubIssue).mockReturnValue(undefined);
    vi.mocked(createTaskWithWorkspace).mockResolvedValue({
      ...task,
      user_id: 8,
      planification_complete: 0,
    } as never);
    vi.mocked(tasksDb.update).mockReturnValueOnce({
      ...task,
      user_id: 8,
      planification_complete: 0,
      github_last_human_comment_id: 11,
    } as never);

    await reconcileApprovedIssue(1, 12);

    expect(startAgentRun).toHaveBeenCalledOnce();
    expect(startAgentRun).toHaveBeenCalledWith(7, 'planification', { userId: 8 });
  });
});

describe('repository recovery', () => {
  const quietPr = {
    number: 55,
    title: 'Quiet',
    body: '',
    url: 'https://github.com/acme/repo/pull/55',
    state: 'open',
    headSha: 'abc',
    linkedIssueNumber: null,
    mergeable: 'mergeable',
    checks: [],
    statuses: [],
    reviews: [],
    reviewComments: [],
    comments: [],
    head: { ref: 'feature', sha: 'abc' },
  };

  it('discovers unknown open PRs and stops polling a stored closed PR', async () => {
    vi.mocked(tasksDb.getByProject).mockReturnValue([{ ...task, github_pr_number: 44 }] as never);
    vi.mocked(githubClient.listOpenPullRequests).mockResolvedValue([{ number: 55 }] as never);
    vi.mocked(githubClient.getPullRequest).mockImplementation(async (_project, number) => (
      number === 44 ? { ...quietPr, number: 44, state: 'closed' } : quietPr
    ) as never);

    await reconcileRepository(1);
    await reconcileRepository(1);

    expect(githubClient.listOpenPullRequests).toHaveBeenCalledWith(project, 20);
    expect(githubClient.getPullRequest).toHaveBeenCalledTimes(3);
    expect(vi.mocked(githubClient.getPullRequest).mock.calls.map((call) => call[1])).toEqual([44, 55, 55]);
  });

  it('passes list snapshots through and refreshes the second side of a dual-label issue', async () => {
    vi.mocked(githubClient.listOpenIssues).mockResolvedValue([{
      ...issue,
      labels: ['Needs Refinement', 'Refined'],
    }] as never);
    vi.mocked(githubClient.getIssue).mockResolvedValue({ ...issue, labels: ['Refined'] } as never);

    await reconcileRepository(1);

    expect(githubClient.getIssue).toHaveBeenCalledOnce();
    expect(githubClient.getIssue).toHaveBeenCalledWith(project, 12);
  });

  it('isolates ordinary item failures but propagates identifiable rate limits', async () => {
    vi.mocked(githubClient.listOpenPullRequests).mockResolvedValue([{ number: 55 }, { number: 56 }] as never);
    vi.mocked(githubClient.getPullRequest)
      .mockRejectedValueOnce(new Error('bad PR'))
      .mockResolvedValueOnce({ ...quietPr, number: 56 } as never);

    await expect(reconcileRepository(1)).resolves.toBeUndefined();
    expect(githubClient.getPullRequest).toHaveBeenCalledTimes(2);

    _internal.resetPollingState();
    vi.mocked(githubClient.getPullRequest).mockReset().mockRejectedValue({ kind: 'rate_limited' });
    await expect(reconcileRepository(1)).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});

describe('GitHub projections', () => {
  it('uses the stable plan marker and saves the returned comment id', async () => {
    await expect(syncPlannedTaskToGitHub(7)).resolves.toBe(true);

    expect(githubClient.upsertIssueComment).toHaveBeenCalledWith(
      project,
      12,
      expect.stringContaining('<!-- bottega:task:7:plan -->'),
      { commentId: null, marker: '<!-- bottega:task:7:plan -->' },
    );
    expect(tasksDb.update).toHaveBeenCalledWith(7, { github_plan_comment_id: 99 });
  });

  it('refuses to project a task whose plan is not complete', async () => {
    vi.mocked(tasksDb.getById).mockReturnValue({ ...task, planification_complete: 0 } as never);

    await expect(syncPlannedTaskToGitHub(7)).resolves.toBe(false);

    expect(githubClient.upsertIssueComment).not.toHaveBeenCalled();
  });

  it('links a branch PR and transitions the issue to In Review', async () => {
    vi.mocked(githubClient.findPullRequestForTaskBranch).mockResolvedValue({ number: 44 } as never);

    await expect(syncTaskPullRequest(7)).resolves.toBe(44);

    expect(tasksDb.update).toHaveBeenCalledWith(7, { github_pr_number: 44 });
    expect(githubClient.replaceIssueLabels).toHaveBeenCalledWith(project, 12, {
      remove: ['Ready', 'Refined'],
      add: ['In Review'],
    });
  });

  it('keeps a stored PR link when projection labels are disallowed', async () => {
    vi.mocked(githubClient.findPullRequestForTaskBranch).mockResolvedValue({ number: 44 } as never);
    vi.mocked(githubClient.replaceIssueLabels).mockRejectedValue(new Error('denied'));

    await expect(syncTaskPullRequest(7)).resolves.toBe(44);
    expect(tasksDb.update).toHaveBeenCalledWith(7, { github_pr_number: 44 });
  });
});

describe('PR reconciliation', () => {
  const pr = {
    number: 44,
    title: 'Feature',
    body: '',
    url: 'https://github.com/acme/repo/pull/44',
    state: 'open',
    headSha: 'abc',
    linkedIssueNumber: 12,
    mergeable: 'mergeable',
    checks: [{ id: 2, name: 'test', conclusion: 'failure' }],
    statuses: [],
    reviews: [],
    reviewComments: [],
    comments: [],
    head: { ref: 'task/7-feature', sha: 'abc' },
  };

  it('hashes evidence independent of check and comment ordering', () => {
    const withReviews = {
      ...pr,
      checks: [
        { id: 3, name: 'lint', conclusion: 'failure' },
        { id: 2, name: 'test', conclusion: 'failure' },
      ],
      reviewComments: [
        { ...comment, id: 20, isResolved: false },
        { ...comment, id: 19, isResolved: false },
      ],
    };
    expect(_internal.pullRequestHash(withReviews as never)).toBe(_internal.pullRequestHash({
      ...withReviews,
      checks: [...withReviews.checks].reverse(),
      reviewComments: [...withReviews.reviewComments].reverse(),
    } as never));
  });

  it('starts one PR agent and persists evidence only after startup', async () => {
    vi.mocked(githubClient.getPullRequest).mockResolvedValue(pr as never);
    vi.mocked(tasksDb.getByGithubPr).mockReturnValue({ ...task, github_pr_number: 44 } as never);

    await reconcilePullRequest(1, 44);

    expect(startAgentRun).toHaveBeenCalledWith(7, 'pr', { userId: 42 });
    expect(tasksDb.update).toHaveBeenCalledWith(7, {
      github_pr_evidence_hash: _internal.pullRequestHash(pr as never),
    });
    expect(vi.mocked(startAgentRun).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(tasksDb.update).mock.invocationCallOrder.at(-1)!,
    );
  });

  it('coalesces concurrent requests into one active and one trailing snapshot', async () => {
    let release!: (value: typeof pr) => void;
    vi.mocked(githubClient.getPullRequest)
      .mockReturnValueOnce(new Promise((resolve) => { release = resolve; }) as never)
      .mockResolvedValue(pr as never);
    vi.mocked(tasksDb.getByGithubPr).mockReturnValue({
      ...task,
      github_pr_number: 44,
      github_pr_evidence_hash: _internal.pullRequestHash(pr as never),
    } as never);

    const first = reconcilePullRequest(1, 44);
    const second = reconcilePullRequest(1, 44);
    const third = reconcilePullRequest(1, 44);
    expect(githubClient.getPullRequest).toHaveBeenCalledOnce();
    release(pr);
    await Promise.all([first, second, third]);

    expect(githubClient.getPullRequest).toHaveBeenCalledTimes(2);
  });

  it('does not restart for unchanged evidence', async () => {
    vi.mocked(githubClient.getPullRequest).mockResolvedValue(pr as never);
    vi.mocked(tasksDb.getByGithubPr).mockReturnValue({
      ...task,
      github_pr_number: 44,
      github_pr_evidence_hash: _internal.pullRequestHash(pr as never),
    } as never);

    await reconcilePullRequest(1, 44);

    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('blocks and stops PR retries at the shared workflow run cap', async () => {
    vi.mocked(githubClient.getPullRequest).mockResolvedValue(pr as never);
    vi.mocked(tasksDb.getByGithubPr).mockReturnValue({
      ...task,
      github_pr_number: 44,
      workflow_run_count: MAX_WORKFLOW_RUNS,
    } as never);

    await reconcilePullRequest(1, 44);

    expect(tasksDb.blockWorkflow).toHaveBeenCalledWith(7);
    expect(startAgentRun).not.toHaveBeenCalled();
    expect(updateGeneratedTaskDocSection).not.toHaveBeenCalled();
  });

  it.each([
    ['completed', { status: 'completed' }],
    ['blocked', { workflow_blocked: 1 }],
    ['PR-complete', { pr_agent_complete: 1 }],
  ])('does not start a PR agent for a %s task', async (_name, state) => {
    vi.mocked(githubClient.getPullRequest).mockResolvedValue(pr as never);
    vi.mocked(tasksDb.getByGithubPr).mockReturnValue({
      ...task,
      github_pr_number: 44,
      ...state,
    } as never);

    await reconcilePullRequest(1, 44);

    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('does not start a PR agent without its task worktree', async () => {
    vi.mocked(githubClient.getPullRequest).mockResolvedValue(pr as never);
    vi.mocked(tasksDb.getByGithubPr).mockReturnValue({ ...task, github_pr_number: 44 } as never);
    vi.mocked(worktreeExists).mockResolvedValue(false);

    await reconcilePullRequest(1, 44);

    expect(startAgentRun).not.toHaveBeenCalled();
    expect(updateGeneratedTaskDocSection).not.toHaveBeenCalled();
  });

  it('uses the configured mention in both PR actionability and evidence hashing', () => {
    vi.mocked(appSettingsDb.getValue).mockReturnValue('repair.bot');
    const configured = {
      ...pr,
      checks: [],
      comments: [{ ...comment, body: 'please @repair.bot, retry' }],
    };

    expect(_internal.actionablePullRequest(configured as never)).toBe(true);
    expect(_internal.pullRequestHash(configured as never)).not.toBe(_internal.pullRequestHash({
      ...configured,
      comments: [],
    } as never));
  });

  it('excludes owner and marked PR evidence while retaining actual human evidence', () => {
    const evidence = {
      ...pr,
      checks: [],
      reviewComments: [
        { ...comment, id: 20, body: 'unmarked owner review', authorLogin: 'bottega-owner', isResolved: false },
        { ...comment, id: 21, body: '<!-- bottega:review --> generated', isResolved: false },
        { ...comment, id: 22, body: 'real review feedback', authorLogin: 'alice', isResolved: false },
      ],
      comments: [
        { ...comment, id: 23, body: '@bottega retry', authorLogin: 'bottega-owner' },
        { ...comment, id: 24, body: '@bottega retry', authorLogin: 'alice' },
      ],
      reviews: [
        { id: 25, state: 'CHANGES_REQUESTED', body: 'owner request', submitted_at: '2026-01-01', user: { login: 'bottega-owner', type: 'User' } },
        { id: 26, state: 'CHANGES_REQUESTED', body: '<!-- bottega:review --> bot request', submitted_at: '2026-01-01', user: { login: 'bob', type: 'User' } },
        { id: 27, state: 'CHANGES_REQUESTED', body: 'human request', submitted_at: '2026-01-01', user: { login: 'carol', type: 'User' } },
      ],
    };

    const rendered = _internal.renderPullRequestEvidence(evidence as never, 'bottega-owner');
    expect(rendered).toContain('real review feedback');
    expect(rendered).toContain('human request');
    expect(rendered).not.toContain('unmarked owner review');
    expect(rendered).not.toContain('owner request');
    expect(rendered).not.toContain('bot request');
    expect(_internal.actionablePullRequest(evidence as never, 'bottega-owner')).toBe(true);
    const emptyEvidence = { ...evidence, reviewComments: [], comments: [], reviews: [] };
    const bottegaOnly = {
      ...evidence,
      reviewComments: evidence.reviewComments.slice(0, 2),
      comments: evidence.comments.slice(0, 1),
      reviews: evidence.reviews.slice(0, 2),
    };
    expect(_internal.actionablePullRequest(bottegaOnly as never, 'bottega-owner')).toBe(false);
    expect(_internal.pullRequestHash(bottegaOnly as never, 'bottega-owner')).toBe(
      _internal.pullRequestHash(emptyEvidence as never, 'bottega-owner'),
    );
    expect(_internal.pullRequestHash(evidence as never, 'bottega-owner')).not.toBe(
      _internal.pullRequestHash(emptyEvidence as never, 'bottega-owner'),
    );
  });

  it('treats failed classic commit statuses as actionable evidence', () => {
    const statusOnly = {
      ...pr,
      checks: [],
      statuses: [{ id: 5, context: 'legacy-ci', state: 'failure' }],
    };

    expect(_internal.actionablePullRequest(statusOnly as never)).toBe(true);
    expect(_internal.pullRequestHash(statusOnly as never)).not.toBe(_internal.pullRequestHash({
      ...statusOnly,
      statuses: [],
    } as never));
  });

  it('treats the latest human changes-requested review body as actionable evidence', () => {
    const reviewOnly = {
      ...pr,
      checks: [],
      reviews: [
        { id: 1, state: 'CHANGES_REQUESTED', body: 'Old request', submitted_at: '2026-01-01', user: { login: 'alice', type: 'User' } },
        { id: 2, state: 'APPROVED', body: 'Resolved', submitted_at: '2026-01-02', user: { login: 'alice', type: 'User' } },
        { id: 3, state: 'CHANGES_REQUESTED', body: 'Add a timeout', submitted_at: '2026-01-03', user: { login: 'bob', type: 'User' } },
      ],
    };

    expect(_internal.actionablePullRequest(reviewOnly as never)).toBe(true);
    expect(_internal.renderPullRequestEvidence(reviewOnly as never)).toContain('Add a timeout');
    expect(_internal.renderPullRequestEvidence(reviewOnly as never)).not.toContain('Old request');
    expect(_internal.pullRequestHash(reviewOnly as never)).not.toBe(_internal.pullRequestHash({
      ...reviewOnly,
      reviews: [],
    } as never));
  });

  it('recovers the originating task from the task branch before creating a repair task', async () => {
    vi.mocked(githubClient.getPullRequest).mockResolvedValue({ ...pr, linkedIssueNumber: null } as never);
    vi.mocked(tasksDb.getByGithubIssue).mockReturnValue(undefined);
    vi.mocked(tasksDb.getById).mockReturnValue(task as never);

    await reconcilePullRequest(1, 44);

    expect(createTaskWithWorkspace).not.toHaveBeenCalled();
    expect(tasksDb.update).toHaveBeenCalledWith(7, { github_pr_number: 44 });
  });

  it('does not attach a task branch from another project', async () => {
    vi.mocked(githubClient.getPullRequest).mockResolvedValue({
      ...pr,
      linkedIssueNumber: null,
      head: {
        ...pr.head,
        ref: 'feature/original-pr',
        label: 'acme:feature/original-pr',
        repo: { full_name: 'acme/repo' },
      },
    } as never);
    vi.mocked(tasksDb.getByGithubIssue).mockReturnValue(undefined);
    vi.mocked(tasksDb.getById).mockReturnValue({ ...task, project_id: 2 } as never);
    vi.mocked(createTaskWithWorkspace).mockResolvedValue({ ...task, id: 9, github_pr_number: 44 } as never);

    await reconcilePullRequest(1, 44);

    expect(createTaskWithWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      project,
      githubPrNumber: 44,
      existingWorktreeBranch: 'feature/original-pr',
    }));
  });

  it('fails clearly instead of importing a fork PR onto a duplicate branch', async () => {
    vi.mocked(githubClient.getPullRequest).mockResolvedValue({
      ...pr,
      linkedIssueNumber: null,
      head: { ...pr.head, label: 'contributor:feature', repo: { full_name: 'contributor/repo' } },
    } as never);
    vi.mocked(tasksDb.getByGithubIssue).mockReturnValue(undefined);
    vi.mocked(tasksDb.getById).mockReturnValue(undefined);

    await expect(reconcilePullRequest(1, 44)).rejects.toThrow(/not in the project repository/);
    expect(createTaskWithWorkspace).not.toHaveBeenCalled();
  });
});
