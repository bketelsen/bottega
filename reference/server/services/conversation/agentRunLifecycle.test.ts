import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../database/db.js', () => ({
  tasksDb: {
    getById: vi.fn(),
    getWithProject: vi.fn(),
    markRefinementComplete: vi.fn(),
    blockWorkflow: vi.fn()
  },
  projectsDb: {
    getByIdAdmin: vi.fn()
  },
  agentRunsDb: {
    getByTask: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    create: vi.fn()
  },
  userDb: {
    getUserById: vi.fn()
  }
}));

vi.mock('../worktree.js', () => ({
  worktreeExists: vi.fn().mockResolvedValue(false)
}));

vi.mock('../notifications.js', () => ({
  notifyClaudeComplete: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../agentRunner.js', () => ({
  startAgentRun: vi.fn().mockResolvedValue(undefined),
  getRunningAgentForTask: vi.fn().mockReturnValue(null)
}));

vi.mock('../github/reconcile.js', () => ({
  syncPlannedTaskToGitHub: vi.fn().mockResolvedValue(true),
  syncTaskPullRequest: vi.fn().mockResolvedValue(42)
}));

vi.mock('../github/finalize.js', () => ({
  finalizePrAgentRun: vi.fn().mockResolvedValue({ success: true, finalized: true })
}));

vi.mock('../prService.js', () => ({
  ensureTaskPullRequest: vi.fn().mockResolvedValue({ success: true, url: 'https://github.com/acme/repo/pull/42' })
}));

import {
  buildAgentRunCompletionHandler,
  MAX_WORKFLOW_RUNS
} from './agentRunLifecycle.js';
import { tasksDb, agentRunsDb, projectsDb, userDb } from '../../database/db.js';
import { worktreeExists } from '../worktree.js';
import { notifyClaudeComplete } from '../notifications.js';
import { startAgentRun, getRunningAgentForTask } from '../agentRunner.js';
import { syncPlannedTaskToGitHub, syncTaskPullRequest } from '../github/reconcile.js';
import { finalizePrAgentRun } from '../github/finalize.js';
import { ensureTaskPullRequest } from '../prService.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(agentRunsDb.getByTask).mockReturnValue([]);
  vi.mocked(worktreeExists).mockResolvedValue(false);
  vi.mocked(getRunningAgentForTask).mockReturnValue(null);
  vi.mocked(startAgentRun).mockResolvedValue(undefined as never);
  vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({
    id: 1,
    github_repo: 'acme/repo',
    github_automation_enabled: 1,
    autonomy_tier: 'pr'
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

function ctx(overrides = {}) {
  return {
    conversationId: 100,
    taskId: 7,
    claudeSessionId: 'sess',
    userId: 1,
    broadcastFn: vi.fn(),
    broadcastToTaskSubscribersFn: vi.fn(),
    isNewSession: false,
    ...overrides
  };
}

describe('buildAgentRunCompletionHandler', () => {
  it('is a no-op when ctx has no taskId', async () => {
    const handler = buildAgentRunCompletionHandler(ctx({ taskId: undefined }));
    await handler('success');

    expect(agentRunsDb.getByTask).not.toHaveBeenCalled();
    expect(notifyClaudeComplete).not.toHaveBeenCalled();
  });

  it('marks the linked agent run completed and broadcasts agent-run-updated', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'pr', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, title: 'T', project_id: 1, workflow_complete: false } as never);

    await buildAgentRunCompletionHandler(c)('success');

    expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(9, 'completed');
    expect(c.broadcastToTaskSubscribersFn).toHaveBeenCalledWith(7, {
      type: 'agent-run-updated',
      agentRun: { id: 9, status: 'completed', agent_type: 'pr', conversation_id: 100 }
    });
  });

  it("leaves a 'failed' row untouched and skips chaining (user-Stop path)", async () => {
    // abortSession marks the row 'failed' synchronously before unwinding the
    // streaming loop. When the completion handler runs afterwards it must
    // not flip the status back to 'completed' and must not chain.
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'implementation', status: 'failed' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0 } as never);

    await buildAgentRunCompletionHandler(c)('success');

    expect(agentRunsDb.updateStatus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it.each(['error', 'aborted'] as const)('marks a running agent failed and does not chain on %s', async (outcome) => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'implementation', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0 } as never);

    await buildAgentRunCompletionHandler(c)(outcome);
    await vi.advanceTimersByTimeAsync(2000);

    expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(9, 'failed');
    expect(c.broadcastToTaskSubscribersFn).toHaveBeenCalledWith(7, {
      type: 'agent-run-updated',
      agentRun: { id: 9, status: 'failed', agent_type: 'implementation', conversation_id: 100 }
    });
    expect(startAgentRun).not.toHaveBeenCalled();
    expect(syncPlannedTaskToGitHub).not.toHaveBeenCalled();
    expect(syncTaskPullRequest).not.toHaveBeenCalled();
  });

  it('does not chain after a PR agent (terminal)', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'pr', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_complete: true, refinement_complete: true, pr_agent_complete: false } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(worktreeExists).mockResolvedValue(true);

    await buildAgentRunCompletionHandler(c)('success');
    vi.advanceTimersByTime(2000);

    // PR is not in the chain-eligible list, so the chaining branch never runs.
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('skips planification → implementation chain for technical actor', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'planification', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0, planification_complete: 1 } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: 1 } as never);

    await buildAgentRunCompletionHandler(c)('success');
    vi.advanceTimersByTime(2000);

    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('chains planification → implementation for non-technical actor after 1s', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'planification', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0, planification_complete: 1 } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: 0 } as never);

    await buildAgentRunCompletionHandler(c)('success');
    expect(startAgentRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(startAgentRun).toHaveBeenCalledWith(7, 'implementation', expect.objectContaining({ userId: 1 }));
  });

  it('syncs GitHub-backed planning and never applies the non-technical auto-chain', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'planification', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({
      id: 7,
      project_id: 1,
      github_issue_number: 31,
      planification_complete: 1,
      workflow_run_count: 0
    } as never);
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: 0 } as never);

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(2000);

    expect(syncPlannedTaskToGitHub).toHaveBeenCalledWith(7);
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it.each([0, undefined])('leaves planning running (awaiting clarification) without its completion signal when completion is %s', async (planificationComplete) => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'planification', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({
      id: 7,
      project_id: 1,
      github_issue_number: 31,
      planification_complete: planificationComplete,
      workflow_run_count: 0
    } as never);
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: 0 } as never);

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(2000);

    // Non-terminal waiting state: not failed, not completed, not synced, not chained.
    expect(agentRunsDb.updateStatus).not.toHaveBeenCalled();
    expect(syncPlannedTaskToGitHub).not.toHaveBeenCalled();
    expect(startAgentRun).not.toHaveBeenCalled();
    expect(c.broadcastToTaskSubscribersFn).not.toHaveBeenCalled();
  });

  it('recovers a failed planning run to completed once the plan completes in the same conversation (GitHub-backed)', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'planification', status: 'failed' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({
      id: 7,
      project_id: 1,
      github_issue_number: 31,
      planification_complete: 1,
      workflow_run_count: 0
    } as never);
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: 0 } as never);

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(2000);

    expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(9, 'completed');
    expect(c.broadcastToTaskSubscribersFn).toHaveBeenCalledWith(7, {
      type: 'agent-run-updated',
      agentRun: { id: 9, status: 'completed', agent_type: 'planification', conversation_id: 100 },
    });
    // GitHub-backed planning is terminal — sync up, do not auto-chain.
    expect(syncPlannedTaskToGitHub).toHaveBeenCalledWith(7);
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('recovers a failed local planning run and chains into implementation for a non-technical actor', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'planification', status: 'failed' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0, planification_complete: 1 } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: 0 } as never);

    await buildAgentRunCompletionHandler(c)('success');
    expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(9, 'completed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(startAgentRun).toHaveBeenCalledWith(7, 'implementation', expect.objectContaining({ userId: 1 }));
  });

  it.each(['aborted', 'error'] as const)('does not recover a failed planning run on %s', async (outcome) => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'planification', status: 'failed' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, planification_complete: 1, workflow_run_count: 0 } as never);

    await buildAgentRunCompletionHandler(c)(outcome);
    await vi.advanceTimersByTimeAsync(2000);

    expect(agentRunsDb.updateStatus).not.toHaveBeenCalled();
    expect(syncPlannedTaskToGitHub).not.toHaveBeenCalled();
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('does not recover a failed planning run while the plan is still incomplete', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'planification', status: 'failed' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, planification_complete: 0, workflow_run_count: 0 } as never);

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(2000);

    expect(agentRunsDb.updateStatus).not.toHaveBeenCalled();
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('finalizes a ready PR run when its successful lifecycle completes', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'pr', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, project_id: 1 } as never);

    await buildAgentRunCompletionHandler(c)('success');

    expect(finalizePrAgentRun).toHaveBeenCalledWith(7, 9);
  });

  it('chains planification → implementation when the non-tech actor differs from the technical task owner', async () => {
    // Task owner is user 1 (technical); planification was run by user 2 (non-technical).
    const c = ctx({ userId: 2 });
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'planification', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0, planification_complete: 1 } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(userDb.getUserById).mockImplementation(((id: number) =>
      id === 2 ? { id: 2, is_technical: 0 } : { id: 1, is_technical: 1 }) as never);

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(1000);

    expect(userDb.getUserById).toHaveBeenCalledWith(2);
    expect(startAgentRun).toHaveBeenCalledWith(7, 'implementation', expect.objectContaining({ userId: 2 }));
  });

  it('does not chain planification → implementation when the tech actor differs from the non-tech task owner', async () => {
    // Task owner is user 1 (non-technical); planification was run by user 2 (technical).
    const c = ctx({ userId: 2 });
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'planification', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0, planification_complete: 1 } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(userDb.getUserById).mockImplementation(((id: number) =>
      id === 2 ? { id: 2, is_technical: 1 } : { id: 1, is_technical: 0 }) as never);

    await buildAgentRunCompletionHandler(c)('success');
    vi.advanceTimersByTime(2000);

    expect(userDb.getUserById).toHaveBeenCalledWith(2);
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('falls back to the task owner is_technical when ctx has no userId', async () => {
    const c = ctx({ userId: undefined });
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'planification', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0, planification_complete: 1 } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 5 } as never);
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 5, is_technical: 0 } as never);

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(1000);

    expect(userDb.getUserById).toHaveBeenCalledWith(5);
    expect(startAgentRun).toHaveBeenCalledWith(7, 'implementation', expect.any(Object));
  });

  it('chains implementation → review when not workflow_complete', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'implementation', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 1 } as never);

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(1000);

    expect(startAgentRun).toHaveBeenCalledWith(7, 'review', expect.any(Object));
  });

  it('continues the baseline loop for advisory GitHub-backed tasks', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'implementation', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({
      id: 7,
      project_id: 1,
      github_issue_number: 31,
      workflow_run_count: 1
    } as never);
    vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({
      id: 1,
      github_repo: 'acme/repo',
      github_automation_enabled: 1,
      autonomy_tier: 'advisory'
    } as never);

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(1000);

    expect(startAgentRun).toHaveBeenCalledWith(7, 'review', expect.any(Object));
  });

  it('chains review → implementation when not workflow_complete', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'review', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 2 } as never);

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(1000);

    expect(startAgentRun).toHaveBeenCalledWith(7, 'implementation', expect.any(Object));
  });

  it('starts refinement when workflow_complete and refinement not yet complete', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'review', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_complete: true, refinement_complete: false } as never);

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(1000);

    expect(startAgentRun).toHaveBeenCalledWith(7, 'refinement', expect.any(Object));
  });

  it('starts refinement for advisory GitHub-backed tasks', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'review', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({
      id: 7,
      project_id: 1,
      github_issue_number: 31,
      workflow_complete: true,
      refinement_complete: false
    } as never);
    vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({
      id: 1,
      github_repo: 'acme/repo',
      github_automation_enabled: 1,
      autonomy_tier: 'advisory'
    } as never);

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(1000);

    expect(startAgentRun).toHaveBeenCalledWith(7, 'refinement', expect.any(Object));
  });

  it('marks refinement complete and publishes the initial PR without starting a PR agent', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'refinement', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_complete: true, refinement_complete: false, pr_agent_complete: false } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(worktreeExists).mockResolvedValue(true);

    await buildAgentRunCompletionHandler(c)('success');
    expect(tasksDb.markRefinementComplete).toHaveBeenCalledWith(7);

    expect(ensureTaskPullRequest).toHaveBeenCalledWith(7);
    await vi.advanceTimersByTimeAsync(1000);
    expect(startAgentRun).not.toHaveBeenCalledWith(7, 'pr', expect.any(Object));
  });

  it('rechecks PR autonomy after scheduling and before starting the PR agent', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'refinement', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({
      id: 7,
      project_id: 1,
      github_issue_number: 31,
      workflow_complete: true,
      refinement_complete: false,
      pr_agent_complete: false
    } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(worktreeExists).mockResolvedValue(true);

    await buildAgentRunCompletionHandler(c)('success');
    vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({
      id: 1,
      github_repo: 'acme/repo',
      github_automation_enabled: 1,
      autonomy_tier: 'issues'
    } as never);
    await vi.advanceTimersByTimeAsync(1000);

    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('blocks the workflow when run count hits MAX_WORKFLOW_RUNS', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'implementation', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: MAX_WORKFLOW_RUNS } as never);

    await buildAgentRunCompletionHandler(c)('success');

    expect(tasksDb.blockWorkflow).toHaveBeenCalledWith(7);
    expect(c.broadcastToTaskSubscribersFn).toHaveBeenCalledWith(7, {
      type: 'task-blocked',
      reason: 'max_iterations'
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('skips chaining when another agent is already running for the task', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'implementation', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 1 } as never);
    vi.mocked(getRunningAgentForTask).mockReturnValue({ id: 99 } as never);

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(1000);

    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('does NOT create a sibling failed row when the chain dispatch throws', async () => {
    // Old behaviour: insert a placeholder 'failed' row for the agent type
    // we couldn't start. New behaviour: log loud and stop. The parent run
    // is already 'completed'; the loop simply pauses here until the user
    // retries.
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'implementation', status: 'running' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 1 } as never);
    vi.mocked(startAgentRun).mockRejectedValue(new Error('dispatch failed'));

    await buildAgentRunCompletionHandler(c)('success');
    await vi.advanceTimersByTimeAsync(1000);

    expect(agentRunsDb.create).not.toHaveBeenCalled();
    // The only updateStatus call should be the parent run's 'completed', not
    // an extra 'failed' for the new run.
    expect(agentRunsDb.updateStatus).toHaveBeenCalledTimes(1);
    expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(9, 'completed');
  });

  it('fires push notification on success when userId is set', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, title: 'task title', project_id: 5, workflow_complete: false } as never);

    await buildAgentRunCompletionHandler(c)('success');

    expect(notifyClaudeComplete).toHaveBeenCalledWith(
      1, 'task title', 7, 100, 5,
      expect.objectContaining({ agentType: null, workflowComplete: false })
    );
  });

  it('fires push notification on user abort too (loop reached a clean end)', async () => {
    // Notifications are no longer gated on success: under the new model
    // the streaming loop reaching its end is itself the signal, regardless
    // of whether the user aborted.
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'review', status: 'failed' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, title: 'task title', project_id: 5, workflow_complete: false } as never);

    await buildAgentRunCompletionHandler(c)('success');

    expect(notifyClaudeComplete).toHaveBeenCalledWith(
      1, 'task title', 7, 100, 5,
      expect.objectContaining({ agentType: 'review', workflowComplete: false })
    );
  });

  it('skips status update when the linked run is not in "running" state', async () => {
    const c = ctx();
    vi.mocked(agentRunsDb.getByTask).mockReturnValue([
      { id: 9, conversation_id: 100, agent_type: 'implementation', status: 'completed' }
    ] as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7 } as never);

    await buildAgentRunCompletionHandler(c)('success');

    expect(agentRunsDb.updateStatus).not.toHaveBeenCalled();
  });
});
