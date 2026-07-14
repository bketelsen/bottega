import { agentRunsDb, projectsDb, tasksDb } from '../../database/db.js';
import { runCommand } from '../shell.js';
import {
  commitAllChanges,
  getBranchName,
  getWorktreePath,
  getWorktreeStatus,
  hasUncommittedChanges,
  worktreeExists,
  type GitHubEffectOptions,
} from '../worktree.js';
import { assertCapability } from './capabilities.js';
import { resolveTrustedGitHubAuth } from './gitAuth.js';

const FINALIZATION_LEASE_MS = 5 * 60 * 1000;
const FINALIZATION_RECOVERY_LIMIT = 50;
const taskLocks = new Map<number, Promise<void>>();

export interface TaskPublicationContext {
  repoPath: string;
  projectId: number;
  effects: GitHubEffectOptions;
}

export interface FinalizePrResult {
  success: boolean;
  finalized?: boolean;
  skipped?: boolean;
  url?: string;
  headSha?: string;
  error?: string;
}

export async function withTaskPublicationLock<T>(taskId: number, work: () => Promise<T>): Promise<T> {
  const previous = taskLocks.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  taskLocks.set(taskId, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (taskLocks.get(taskId) === queued) taskLocks.delete(taskId);
  }
}

function assertFreshEffect(projectId: number, action: 'push' | 'createPR'): void {
  const project = projectsDb.getByIdAdmin(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  // Host-mode/local repositories retain the legacy behavior.
  if (project.github_repo) assertCapability(project, action);
}

export async function prepareTaskPublication(taskId: number): Promise<TaskPublicationContext> {
  const task = tasksDb.getWithProject(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const project = projectsDb.getByIdAdmin(task.project_id);
  if (!project) throw new Error(`Project ${task.project_id} not found`);
  if (!await worktreeExists(task.repo_folder_path, taskId)) {
    throw new Error(`Worktree for task ${taskId} not found`);
  }

  const executionContext = project.github_repo ? { projectId: project.id } : {};
  const auth = project.github_repo
    ? await resolveTrustedGitHubAuth(task.repo_folder_path, executionContext, 'push')
    : null;
  if (auth) {
    const worktreePath = getWorktreePath(task.repo_folder_path, taskId);
    await runCommand('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: task.repo_folder_path });
    await runCommand('git', ['config', '--worktree', 'user.name', auth.botLogin], { cwd: worktreePath });
    await runCommand('git', ['config', '--worktree', 'user.email', auth.botEmail], { cwd: worktreePath });
  }

  return {
    repoPath: task.repo_folder_path,
    projectId: task.project_id,
    effects: {
      ...executionContext,
      ...(auth ? { auth } : {}),
      beforeEffect: (action) => assertFreshEffect(task.project_id, action),
    },
  };
}

async function revParse(worktreePath: string, ref: string): Promise<string | null> {
  try {
    return (await runCommand('git', ['rev-parse', ref], { cwd: worktreePath })).stdout.trim() || null;
  } catch {
    return null;
  }
}

async function needsForceWithLease(
  worktreePath: string,
  remoteSha: string | null,
): Promise<boolean> {
  if (!remoteSha) return false;
  try {
    await runCommand('git', ['merge-base', '--is-ancestor', remoteSha, 'HEAD'], { cwd: worktreePath });
    return false;
  } catch {
    return true;
  }
}

/** Finalize only the latest successfully completed, explicitly-ready PR run. */
export async function finalizePrAgentRun(
  taskId: number,
  runId: number,
  options: { leaseTimeoutMs?: number } = {},
): Promise<FinalizePrResult> {
  return withTaskPublicationLock(taskId, async () => {
    const latest = agentRunsDb.getLatestPrRun(taskId);
    if (!latest || latest.id !== runId || latest.status !== 'completed') {
      return { success: false, skipped: true, error: 'PR run is not the latest successful run' };
    }
    if (latest.github_finalize_status === 'finalized') {
      return {
        success: true,
        finalized: true,
        ...(latest.github_finalize_head_sha ? { headSha: latest.github_finalize_head_sha } : {}),
      };
    }
    if (latest.github_finalize_status !== 'ready' && latest.github_finalize_status !== 'failed'
        && latest.github_finalize_status !== 'finalizing') {
      return { success: false, skipped: true, error: 'PR run is not ready for finalization' };
    }

    const task = tasksDb.getWithProject(taskId);
    if (!task || !await worktreeExists(task.repo_folder_path, taskId)) {
      return { success: false, skipped: true, error: 'Task worktree is unavailable' };
    }

    const lease = latest.github_finalize_status === 'finalizing'
      ? agentRunsDb.reclaimStaleGitHubFinalization(
          runId,
          options.leaseTimeoutMs ?? FINALIZATION_LEASE_MS,
        )
      : agentRunsDb.claimGitHubFinalization(runId);
    if (!lease) return { success: false, skipped: true, error: 'PR finalization is already in progress' };

    try {
      const context = await prepareTaskPublication(taskId);
      const changes = await hasUncommittedChanges(context.repoPath, taskId);
      if (!changes.success) throw new Error(changes.error || 'Failed to inspect worktree changes');
      if (changes.hasChanges) {
        const committed = await commitAllChanges(context.repoPath, taskId, task.title || `Task #${taskId}`);
        if (!committed.success) throw new Error(committed.error || 'Failed to commit task changes');
      }

      const worktreePath = getWorktreePath(context.repoPath, taskId);
      const branch = await getBranchName(worktreePath);
      if (!branch) throw new Error('Could not determine worktree branch');
      await getWorktreeStatus(context.repoPath, taskId, context.effects);
      const localHead = await revParse(worktreePath, 'HEAD');
      const remoteHead = await revParse(worktreePath, `refs/remotes/origin/${branch}`);
      if (!localHead) throw new Error('Could not determine local HEAD');

      const { ensureTaskPullRequestUnlocked } = await import('../prService.js');
      const publication = await ensureTaskPullRequestUnlocked(taskId, {
        title: task.title || `Task #${taskId}`,
        forceWithLeaseExpectedSha: await needsForceWithLease(worktreePath, remoteHead)
          ? remoteHead ?? undefined
          : undefined,
        preparedContext: context,
      });
      if (!publication.success) throw new Error(publication.error || 'Failed to publish pull request');

      const finalHead = await revParse(worktreePath, 'HEAD');
      if (!finalHead) throw new Error('Could not determine finalized HEAD');
      if (!agentRunsDb.recordGitHubFinalized(runId, finalHead)) {
        throw new Error('Lost GitHub finalization lease');
      }
      tasksDb.markPrAgentComplete(taskId);
      return {
        success: true,
        finalized: true,
        headSha: finalHead,
        ...(publication.url ? { url: publication.url } : {}),
      };
    } catch (error) {
      agentRunsDb.recordGitHubFinalizeFailure(runId, error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export async function recoverPrAgentRunFinalizations(
  projectId: number,
  options: { leaseTimeoutMs?: number; now?: Date; limit?: number } = {},
): Promise<void> {
  const leaseTimeoutMs = options.leaseTimeoutMs ?? FINALIZATION_LEASE_MS;
  const now = options.now ?? new Date();
  const candidates = agentRunsDb.getRecoverableGitHubFinalizations(
    projectId,
    new Date(now.getTime() - leaseTimeoutMs),
    options.limit ?? FINALIZATION_RECOVERY_LIMIT,
  );

  for (const run of candidates) {
    try {
      const result = await finalizePrAgentRun(run.task_id, run.id, { leaseTimeoutMs });
      if (!result.success && !result.skipped) {
        console.error(`[GitHub Finalize] Recovery failed for run ${run.id}:`, result.error);
      }
    } catch (error) {
      console.error(`[GitHub Finalize] Recovery failed for run ${run.id}:`, error);
    }
  }
}

export const _internal = {
  needsForceWithLease,
  revParse,
  FINALIZATION_LEASE_MS,
  FINALIZATION_RECOVERY_LIMIT,
};
