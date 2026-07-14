/**
 * PR Service - Consolidates PR logic for manual button and PR agent
 *
 * This service provides a unified interface for PR operations used by:
 * - Manual "Create PR" button in the UI
 * - Automated PR agent
 */

import {
  hasUncommittedChanges,
  commitAllChanges,
  createPullRequest as worktreeCreatePR,
  getPullRequestStatus,
  getWorktreeStatus,
  pushChanges,
  type GitHubEffectOptions,
} from './worktree.js';
import { projectsDb, tasksDb, type TaskRow } from '../database/db.js';
import { syncTaskPullRequest } from './github/reconcile.js';
import {
  prepareTaskPublication,
  withTaskPublicationLock,
  type TaskPublicationContext,
} from './github/finalize.js';

export interface PRResult {
  success: boolean;
  url?: string | undefined;
  error?: string | undefined;
}

export interface CIStatusResult {
  success: boolean;
  url?: string | undefined;
  ciStatus?: unknown;
  mergeable?: string | undefined;
  error?: string | undefined;
}

export interface EnsureTaskPullRequestOptions {
  title?: string;
  body?: string;
  forceWithLeaseExpectedSha?: string | undefined;
  preparedContext?: TaskPublicationContext;
}

export async function ensureTaskPullRequest(
  taskId: number,
  options: EnsureTaskPullRequestOptions = {},
): Promise<PRResult> {
  return withTaskPublicationLock(taskId, () => ensureTaskPullRequestUnlocked(taskId, options));
}

/** Internal lock-sharing entry point used by the finalization lease owner. */
export async function ensureTaskPullRequestUnlocked(
  taskId: number,
  options: EnsureTaskPullRequestOptions = {},
): Promise<PRResult> {
  const task = tasksDb.getWithProject(taskId);
  if (!task) return { success: false, error: `Task ${taskId} not found` };
  const project = projectsDb.getByIdAdmin(task.project_id);
  if (!project) return { success: false, error: `Project ${task.project_id} not found` };
  const context = options.preparedContext ?? await prepareTaskPublication(taskId);
  const effects: GitHubEffectOptions = {
    ...context.effects,
    ...(options.forceWithLeaseExpectedSha
      ? { forceWithLeaseExpectedSha: options.forceWithLeaseExpectedSha }
      : {}),
  };
  const title = options.title ?? task.title ?? `Task #${taskId}`;
  const body = options.body ?? '';

  // Re-query after committing and again after pushing. This makes retries after
  // a successful remote effect converge on the branch's existing open PR.
  const changes = await hasUncommittedChanges(context.repoPath, taskId);
  if (!changes.success) return { success: false, error: changes.error || 'Failed to inspect changes' };
  if (changes.hasChanges) {
    const committed = await commitAllChanges(context.repoPath, taskId, title);
    if (!committed.success) return { success: false, error: `Failed to commit: ${committed.error}` };
  }

  let existing = await getPullRequestStatus(context.repoPath, taskId, effects);
  if (existing.success && existing.exists && existing.state === 'OPEN' && existing.url) {
    const pushed = await pushChanges(context.repoPath, taskId, title, effects);
    if (!pushed.success) return { success: false, error: `Failed to push: ${pushed.error}` };
  } else {
    const status = await getWorktreeStatus(context.repoPath, taskId, effects);
    if (!status.success) return { success: false, error: status.error || 'Failed to inspect worktree' };
    if (status.ahead === 0) return { success: false, error: 'No changes to create a PR' };

    // createPullRequest performs the push and guards both effects. If the
    // process previously crashed after creating the PR, this fresh lookup
    // avoids a duplicate create attempt.
    existing = await getPullRequestStatus(context.repoPath, taskId, effects);
    if (!(existing.success && existing.exists && existing.state === 'OPEN' && existing.url)) {
      if (options.forceWithLeaseExpectedSha) {
        const pushed = await pushChanges(context.repoPath, taskId, title, effects);
        if (!pushed.success) return { success: false, error: `Failed to push: ${pushed.error}` };
      }
      const created = await worktreeCreatePR(context.repoPath, taskId, title, body, effects);
      if (!created.success) return created;
      existing = await getPullRequestStatus(context.repoPath, taskId, effects);
      if (!(existing.success && existing.exists && existing.state === 'OPEN' && existing.url)) {
        existing = {
          success: true,
          exists: true,
          state: 'OPEN',
          ...(created.url ? { url: created.url } : {}),
        };
      }
    }
  }

  const url = existing.url;
  const number = pullRequestNumber(url);
  if (number) await syncTaskPullRequest(taskId, number);
  tasksDb.update(taskId, { ...(number ? { github_pr_number: number } : {}), status: 'in_review' });
  return { success: true, ...(url ? { url } : {}) };
}

/**
 * Create or update a PR for a task
 * Used by both manual button and PR agent
 */
export async function createOrUpdatePR(
  _repoPath: string,
  taskId: number,
  title: string,
  body: string,
  options: GitHubEffectOptions = {},
): Promise<PRResult> {
  return ensureTaskPullRequest(taskId, {
    title,
    body,
    ...(options.forceWithLeaseExpectedSha
      ? { forceWithLeaseExpectedSha: options.forceWithLeaseExpectedSha }
      : {}),
  });
}

function pullRequestNumber(url: string | undefined): number | null {
  if (!url) return null;
  const match = /\/pull\/(\d+)(?:\/|$)/.exec(url);
  return match ? Number(match[1]) : null;
}

/**
 * Get CI status and failure details for a task's PR
 */
export async function getCIStatusWithDetails(
  repoPath: string,
  taskId: number,
): Promise<CIStatusResult> {
  const task = tasksDb.getWithProject(taskId);
  if (!task) return { success: false, error: `Task ${taskId} not found` };
  const project = projectsDb.getByIdAdmin(task.project_id);
  if (!project) return { success: false, error: `Project ${task.project_id} not found` };
  const prStatus = await getPullRequestStatus(repoPath, taskId, { projectId: project.id });
  if (!prStatus.success || !prStatus.exists) {
    return { success: false, error: 'No PR found' };
  }
  return {
    success: true,
    url: prStatus.url,
    ciStatus: prStatus.ciStatus,
    mergeable: prStatus.mergeable,
  };
}

/**
 * Check if PR agent should run for a task
 */
export function shouldRunPrAgent(task: Pick<TaskRow, 'workflow_complete' | 'pr_agent_complete'>): boolean {
  return task.workflow_complete === 1 && task.pr_agent_complete === 0;
}

export const _internal = { pullRequestNumber };
