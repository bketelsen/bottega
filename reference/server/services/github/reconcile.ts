import { createHash } from 'node:crypto';
import type { ProjectRow, TaskRow } from '@shared/types/db';
import type { AgentType } from '@shared/websocket/messages';
import { agentRunsDb, projectsDb, tasksDb } from '../../database/db.js';
import { startAgentRun } from '../agentRunner.js';
import { MAX_WORKFLOW_RUNS } from '../conversation/agentRunLifecycle.js';
import {
  readTaskDoc,
  updateGeneratedTaskDocSection,
} from '../documentation.js';
import { createTaskWithWorkspace } from '../taskCreation.js';
import { worktreeExists } from '../worktree.js';
import { can } from './capabilities.js';
import {
  githubClient,
  type GitHubClientError,
  type GitHubComment,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubReview,
  normalizeGitHubRepo,
} from './client.js';
import { githubIdentity, isBottegaComment } from './identity.js';
import { recoverPrAgentRunFinalizations } from './finalize.js';
import { hasGitHubPrTriggerMention } from './trigger.js';

import {
  PLAN_LABEL,
  READY_LABEL,
  APPROVED_LABEL,
  REVIEW_LABEL,
} from './workflowLabels.js';
// Unknown discovery is deliberately one small REST page per repository scan.
const UNKNOWN_PR_DISCOVERY_BUDGET = 20;

type GitHubProject = ProjectRow & { github_automation_enabled: 0 | 1 };

const locks = new Map<string, Promise<void>>();
const prReconciles = new Map<string, {
  trailing: boolean;
  running: Promise<'open' | 'closed' | null>;
}>();
const knownOpenPullRequests = new Map<number, Set<number>>();
const knownClosedPullRequests = new Map<number, Set<number>>();

export async function withReconcileLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(key, queued);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

function projectForAutomation(projectId: number): GitHubProject | null {
  const project = projectForGitHub(projectId);
  if (!project || project.github_automation_enabled !== 1) return null;
  return project;
}

function projectForGitHub(projectId: number): GitHubProject | null {
  const project = projectsDb.getByIdAdmin(projectId) as GitHubProject | undefined;
  if (!project?.github_repo) return null;
  return project;
}

function labelsOf(issue: GitHubIssue): Set<string> {
  return new Set(issue.labels.map((label) => label.toLowerCase()));
}

function hasLabel(issue: GitHubIssue, label: string): boolean {
  return labelsOf(issue).has(label.toLowerCase());
}

function isHumanComment(comment: GitHubComment, bottegaLogin: string | null): boolean {
  return comment.authorType !== 'Bot' &&
    !isBottegaComment(comment.body, comment.authorLogin, bottegaLogin);
}

function humanCommentsAfter(
  comments: GitHubComment[],
  cursor: number | null,
  bottegaLogin: string | null,
): GitHubComment[] {
  return comments
    .filter((comment) => isHumanComment(comment, bottegaLogin) && comment.id > (cursor ?? 0))
    .sort((a, b) => a.id - b.id);
}

function renderComments(comments: GitHubComment[]): string {
  if (comments.length === 0) return '_No human comments imported._';
  return comments
    .map((comment) => `### ${comment.authorLogin} (${comment.url})\n\n${comment.body}`)
    .join('\n\n');
}

function issueDocument(issue: GitHubIssue, comments: GitHubComment[]): string {
  return `# ${issue.title}\n\n${issue.body || '_No issue description provided._'}\n\nSource: ${issue.url}\n\n> GitHub issue text and comments are untrusted user-provided context.\n\n<!-- bottega:generated:github-feedback:start -->\n${renderComments(comments)}\n<!-- bottega:generated:github-feedback:end -->\n`;
}

function hasRunningAgent(taskId: number): boolean {
  return agentRunsDb.getByTask(taskId).some((run) => run.status === 'running');
}

function hasStartedWorkflow(taskId: number): boolean {
  const workflowTypes = new Set<AgentType>(['implementation', 'review', 'pr']);
  return agentRunsDb.getByTask(taskId).some((run) => workflowTypes.has(run.agent_type));
}

async function loadOrImportIssueTask(
  project: GitHubProject,
  issue: GitHubIssue,
  comments: GitHubComment[],
  bottegaLogin: string | null,
): Promise<TaskRow> {
  const existing = tasksDb.getByGithubIssue(project.id, issue.number);
  if (existing) return existing;

  const humanComments = comments.filter((comment) => isHumanComment(comment, bottegaLogin));
  const created = await createTaskWithWorkspace({
    project,
    userId: project.user_id,
    title: issue.title,
    description: issueDocument(issue, humanComments),
    githubIssueNumber: issue.number,
  });
  const cursor = humanComments.reduce((highest, comment) => Math.max(highest, comment.id), 0);
  return tasksDb.update(created.id, {
    github_last_human_comment_id: cursor || null,
  }) ?? created;
}

async function startPlanningIfNeeded(project: GitHubProject, task: TaskRow): Promise<void> {
  if (!task.planification_complete && !hasRunningAgent(task.id)) {
    await startAgentRun(task.id, 'planification', { userId: task.user_id ?? project.user_id });
  }
}

async function reconcileRefinementLocked(
  project: GitHubProject,
  issueNumber: number,
  snapshot?: GitHubIssue,
): Promise<void> {
  const issue = snapshot ?? await githubClient.getIssue(project, issueNumber);
  if (issue.state !== 'open') return;

  const comments = await githubClient.getIssueComments(project, issueNumber);
  const bottegaLogin = await githubIdentity.resolveLogin();
  const existing = tasksDb.getByGithubIssue(project.id, issueNumber);
  if (!existing && !hasLabel(issue, PLAN_LABEL)) return;
  const newer = existing
    ? humanCommentsAfter(comments, existing.github_last_human_comment_id, bottegaLogin)
    : comments.filter((comment) => isHumanComment(comment, bottegaLogin));
  if (!hasLabel(issue, PLAN_LABEL) && newer.length === 0) return;

  let task = await loadOrImportIssueTask(project, issue, comments, bottegaLogin);
  const feedback = humanCommentsAfter(comments, task.github_last_human_comment_id, bottegaLogin);
  if (feedback.length > 0) {
    if (hasRunningAgent(task.id)) return;
    const allHumanComments = comments
      .filter((comment) => isHumanComment(comment, bottegaLogin))
      .sort((a, b) => a.id - b.id);
    const wrote = updateGeneratedTaskDocSection(
      project.id,
      task.id,
      'github-feedback',
      renderComments(allHumanComments),
      { isRunActive: () => hasRunningAgent(task.id) },
    );
    if (!wrote) return;

    const cursor = allHumanComments.at(-1)?.id ?? task.github_last_human_comment_id;
    const beforeImplementation = !hasStartedWorkflow(task.id);
    if (beforeImplementation) {
      await githubClient.replaceIssueLabels(project, issueNumber, {
        remove: [READY_LABEL],
        add: [PLAN_LABEL],
      });
    }
    task = tasksDb.update(task.id, {
      github_last_human_comment_id: cursor,
      ...(beforeImplementation ? { planification_complete: 0 } : {}),
    }) ?? task;
  }

  await startPlanningIfNeeded(project, task);
}

export async function reconcileRefinementIssue(
  projectId: number,
  issueNumber: number,
  snapshot?: GitHubIssue,
): Promise<void> {
  const project = projectForAutomation(projectId);
  if (!project) return;
  await withReconcileLock(
    `issue:${projectId}:${issueNumber}`,
    () => reconcileRefinementLocked(project, issueNumber, snapshot),
  );
}

export async function syncPlannedTaskToGitHub(taskId: number): Promise<boolean> {
  const task = tasksDb.getById(taskId);
  if (!task?.github_issue_number) return false;
  const project = projectForGitHub(task.project_id);
  if (!project) return false;

  return withReconcileLock(`task:${taskId}`, async () => {
    const currentTask = tasksDb.getById(taskId);
    if (!currentTask?.github_issue_number || !currentTask.planification_complete) return false;
    const marker = `<!-- bottega:task:${taskId}:plan -->`;
    const body = `${marker}\n${readTaskDoc(currentTask.project_id, taskId)}`;
    const comment = await githubClient.upsertIssueComment(project, currentTask.github_issue_number, body, {
      commentId: currentTask.github_plan_comment_id,
      marker,
    });
    await githubClient.replaceIssueLabels(project, currentTask.github_issue_number, {
      remove: [PLAN_LABEL],
      add: [READY_LABEL],
    });
    tasksDb.update(taskId, { github_plan_comment_id: comment.id });
    return true;
  });
}

export async function reconcileApprovedIssue(
  projectId: number,
  issueNumber: number,
  snapshot?: GitHubIssue,
): Promise<void> {
  const project = projectForAutomation(projectId);
  if (!project) return;
  await withReconcileLock(`issue:${projectId}:${issueNumber}`, async () => {
    const issue = snapshot ?? await githubClient.getIssue(project, issueNumber);
    if (issue.state !== 'open' || !hasLabel(issue, APPROVED_LABEL)) return;
    const comments = await githubClient.getIssueComments(project, issueNumber);
    const bottegaLogin = await githubIdentity.resolveLogin();
    const task = await loadOrImportIssueTask(project, issue, comments, bottegaLogin);

    if (!task.planification_complete) {
      await startPlanningIfNeeded(project, task);
      return;
    }
    if (task.workflow_complete || task.pr_agent_complete || hasRunningAgent(task.id)) return;
    if (hasStartedWorkflow(task.id)) return;
    if (!can(project, 'push') || !can(project, 'createPR')) {
      console.log(`[GitHubReconcile] Task ${task.id} awaits manual execution: project autonomy is below pr`);
      return;
    }

    await startAgentRun(task.id, 'implementation', { userId: task.user_id ?? project.user_id });
    await githubClient.replaceIssueLabels(project, issueNumber, {
      remove: [READY_LABEL, APPROVED_LABEL],
      add: [],
    });
  });
}

function pullRequestHash(pr: GitHubPullRequest, bottegaLogin: string | null = null): string {
  const failedChecks = pr.checks
    .filter((check) => check.conclusion && !['success', 'neutral', 'skipped'].includes(check.conclusion.toLowerCase()))
    .map((check) => ({ id: String(check.id), conclusion: check.conclusion!.toLowerCase() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const failedStatuses = pr.statuses
    .filter((status) => ['error', 'failure'].includes(status.state.toLowerCase()))
    .map((status) => ({ id: String(status.id), state: status.state.toLowerCase() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const unresolvedReviewIds = pr.reviewComments
    .filter((comment) => !comment.isResolved && isHumanComment(comment, bottegaLogin))
    .map((comment) => comment.id)
    .sort((a, b) => a - b);
  const requestedChanges = currentHumanChangeRequests(pr.reviews, bottegaLogin)
    .map((review) => ({ id: review.id, body: review.body!.trim() }))
    .sort((a, b) => a.id - b.id);
  const forcedCommentIds = pr.comments
    .filter((comment) => isHumanComment(comment, bottegaLogin) && hasGitHubPrTriggerMention(comment.body))
    .map((comment) => comment.id)
    .sort((a, b) => a - b);
  // Deliberately excludes headSha. Commit-scoped evidence (check runs,
  // classic statuses) already carries fresh IDs on every commit, so it
  // re-triggers naturally. Human-gated evidence (unresolved threads,
  // CHANGES_REQUESTED reviews, trigger mentions) must NOT re-arm on the
  // agent's own push — only a human can resolve it, and hashing headSha
  // made every finalized repair commit look like new evidence, looping
  // until the run cap. Recurrence of identical evidence after a quiet
  // period is handled by clearing the stored hash when the PR is
  // observed non-actionable (see reconcilePullRequestSnapshot).
  return createHash('sha256').update(JSON.stringify({
    failedChecks,
    failedStatuses,
    unresolvedReviewIds,
    requestedChanges,
    mergeConflict: pr.mergeable === 'conflicting',
    forcedCommentIds,
  })).digest('hex');
}

function actionablePullRequest(pr: GitHubPullRequest, bottegaLogin: string | null = null): boolean {
  return pr.mergeable === 'conflicting' ||
    pr.checks.some((check) => check.conclusion && !['success', 'neutral', 'skipped'].includes(check.conclusion.toLowerCase())) ||
    pr.statuses.some((status) => ['error', 'failure'].includes(status.state.toLowerCase())) ||
    currentHumanChangeRequests(pr.reviews, bottegaLogin).length > 0 ||
    pr.reviewComments.some((comment) => !comment.isResolved && isHumanComment(comment, bottegaLogin)) ||
    pr.comments.some((comment) => isHumanComment(comment, bottegaLogin) && hasGitHubPrTriggerMention(comment.body));
}

function currentHumanChangeRequests(
  reviews: GitHubReview[],
  bottegaLogin: string | null,
): GitHubReview[] {
  const latestByReviewer = new Map<string, GitHubReview>();
  for (const review of reviews) {
    if (
      review.user.type === 'Bot' ||
      !review.submitted_at ||
      isBottegaComment(review.body, review.user.login, bottegaLogin)
    ) continue;
    const key = review.user.login.toLowerCase();
    const current = latestByReviewer.get(key);
    if (!current || review.submitted_at > current.submitted_at! ||
        (review.submitted_at === current.submitted_at && review.id > current.id)) {
      latestByReviewer.set(key, review);
    }
  }
  return [...latestByReviewer.values()].filter(
    (review) => review.state.toUpperCase() === 'CHANGES_REQUESTED' && Boolean(review.body?.trim()),
  );
}

function renderPullRequestEvidence(pr: GitHubPullRequest, bottegaLogin: string | null = null): string {
  const failed = pr.checks.filter((check) => check.conclusion && !['success', 'neutral', 'skipped'].includes(check.conclusion.toLowerCase()));
  const failedStatuses = pr.statuses.filter((status) => ['error', 'failure'].includes(status.state.toLowerCase()));
  const reviews = pr.reviewComments.filter(
    (comment) => !comment.isResolved && isHumanComment(comment, bottegaLogin),
  );
  const requestedChanges = currentHumanChangeRequests(pr.reviews, bottegaLogin);
  return [
    `PR: ${pr.url}`,
    `Head: ${pr.headSha}`,
    `Mergeability: ${pr.mergeable}`,
    '',
    '### Failed checks',
    failed.length || failedStatuses.length
      ? [
          ...failed.map((check) => `- ${check.name}: ${check.conclusion}`),
          ...failedStatuses.map((status) => `- ${status.context}: ${status.state}`),
        ].join('\n')
      : '- None',
    '',
    '### Unresolved human review comments',
    reviews.length ? renderComments(reviews) : '_None._',
    '',
    '### Human changes-requested reviews',
    requestedChanges.length
      ? requestedChanges.map((review) => `### ${review.user.login}\n\n${review.body!.trim()}`).join('\n\n')
      : '_None._',
  ].join('\n');
}

function findExistingPullRequestTask(
  projectId: number,
  prNumber: number,
  pr: GitHubPullRequest,
): ReturnType<typeof tasksDb.getByGithubPr> {
  let task = tasksDb.getByGithubPr(projectId, prNumber);
  const branchTaskId = /^task\/(\d+)(?:-|$)/.exec(pr.head.ref)?.[1];
  if (!task && branchTaskId) {
    const branchTask = tasksDb.getById(Number(branchTaskId));
    if (branchTask?.project_id === projectId) task = branchTask;
  }
  if (!task && pr.linkedIssueNumber) {
    task = tasksDb.getByGithubIssue(projectId, pr.linkedIssueNumber);
  }
  return task;
}

async function reconcilePullRequestSnapshot(
  project: GitHubProject,
  projectId: number,
  prNumber: number,
): Promise<'open' | 'closed'> {
  const pr = await githubClient.getPullRequest(project, prNumber);
  if (pr.state !== 'open') {
    if (pr.merged) {
      const mergedTask = findExistingPullRequestTask(projectId, prNumber, pr);
      if (mergedTask) {
        if (
          mergedTask.status === 'completed'
          && mergedTask.workflow_complete
          && mergedTask.pr_agent_complete
        ) return 'closed';
        tasksDb.update(mergedTask.id, {
          status: 'completed',
          workflow_complete: 1,
        });
        tasksDb.markPrAgentComplete(mergedTask.id);
        if (mergedTask.github_issue_number) {
          try {
            await githubClient.replaceIssueLabels(project, mergedTask.github_issue_number, {
              remove: [REVIEW_LABEL],
              add: [],
            });
          } catch (error) {
            console.error(
              `[GitHubReconcile] Completed task ${mergedTask.id} after PR #${prNumber} merged, but label projection failed:`,
              error,
            );
          }
        }
      }
    }
    return 'closed';
  }
  const bottegaLogin = await githubIdentity.resolveLogin();
  if (!actionablePullRequest(pr, bottegaLogin)) {
    // Evidence has been dealt with (checks green, threads resolved, …).
    // Drop the stored hash so identical evidence recurring later — e.g.
    // main moving and re-conflicting the same branch — reads as new.
    const idleTask = findExistingPullRequestTask(projectId, prNumber, pr);
    if (idleTask?.github_pr_evidence_hash && !hasRunningAgent(idleTask.id)) {
      tasksDb.update(idleTask.id, { github_pr_evidence_hash: null });
    }
    return 'open';
  }

  let task = findExistingPullRequestTask(projectId, prNumber, pr);
  if (!task) {
    const headRepo = pr.head.repo?.full_name;
    if (!headRepo || normalizeGitHubRepo(headRepo) !== normalizeGitHubRepo(project.github_repo!)) {
      throw new Error(
        `Cannot import PR #${prNumber}: head branch ${JSON.stringify(pr.head.label)} is not in the project repository`,
      );
    }
    task = await createTaskWithWorkspace({
      project,
      userId: project.user_id,
      title: `Repair PR #${prNumber}: ${pr.title}`,
      description: `# ${pr.title}\n\n${pr.body || ''}\n\nSource: ${pr.url}\n`,
      githubPrNumber: prNumber,
      existingWorktreeBranch: pr.head.ref,
    });
  } else if (task.github_pr_number !== prNumber) {
    task = tasksDb.update(task.id, { github_pr_number: prNumber }) ?? task;
  }

  if (task.status === 'completed' || task.workflow_blocked || task.pr_agent_complete) return 'open';
  if ((task.workflow_run_count ?? 0) >= MAX_WORKFLOW_RUNS) {
    tasksDb.blockWorkflow(task.id);
    return 'open';
  }
  if (!await worktreeExists(project.repo_folder_path, task.id)) return 'open';

  const hash = pullRequestHash(pr, bottegaLogin);
  if (hash === task.github_pr_evidence_hash || hasRunningAgent(task.id)) return 'open';
  const reconciledTaskId = task.id;
  const wrote = updateGeneratedTaskDocSection(
    projectId,
    reconciledTaskId,
    'github-pr-evidence',
    renderPullRequestEvidence(pr, bottegaLogin),
    { isRunActive: () => hasRunningAgent(reconciledTaskId) },
  );
  if (!wrote || !can(project, 'push')) return 'open';

  await startAgentRun(task.id, 'pr', { userId: task.user_id ?? project.user_id });
  tasksDb.update(task.id, { github_pr_evidence_hash: hash });
  return 'open';
}

export async function reconcilePullRequest(
  projectId: number,
  prNumber: number,
): Promise<'open' | 'closed' | null> {
  const project = projectForAutomation(projectId);
  if (!project) return null;
  const key = `${projectId}:${prNumber}`;
  const active = prReconciles.get(key);
  if (active) {
    active.trailing = true;
    return active.running;
  }

  const state = { trailing: false, running: undefined as unknown as Promise<'open' | 'closed' | null> };
  state.running = (async () => {
    let result: 'open' | 'closed' = 'open';
    let failure: unknown;
    do {
      state.trailing = false;
      try {
        result = await reconcilePullRequestSnapshot(project, projectId, prNumber);
        failure = undefined;
      } catch (error) {
        if (isRateLimitError(error)) throw error;
        failure = error;
      }
    } while (state.trailing);
    // Preserve the original failure after any requested trailing reconciliation.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (failure) throw failure;
    if (result === 'open') {
      knownClosedPullRequests.get(projectId)?.delete(prNumber);
      const open = knownOpenPullRequests.get(projectId);
      if (tasksDb.getByGithubPr(projectId, prNumber)) open?.add(prNumber);
      else open?.delete(prNumber);
    } else {
      knownOpenPullRequests.get(projectId)?.delete(prNumber);
      let closed = knownClosedPullRequests.get(projectId);
      if (!closed) {
        closed = new Set();
        knownClosedPullRequests.set(projectId, closed);
      }
      closed.add(prNumber);
    }
    return result;
  })().finally(() => prReconciles.delete(key));
  prReconciles.set(key, state);
  return state.running;
}

export async function syncTaskPullRequest(taskId: number, prNumber?: number): Promise<number | null> {
  const task = tasksDb.getById(taskId);
  if (!task) return null;
  const project = projectForGitHub(task.project_id);
  if (!project) return null;

  const number = prNumber ?? (await githubClient.findPullRequestForTaskBranch(project, taskId))?.number;
  if (!number) return null;
  tasksDb.update(taskId, { github_pr_number: number });
  if (task.github_issue_number) {
    try {
      await githubClient.replaceIssueLabels(project, task.github_issue_number, {
        remove: [READY_LABEL, APPROVED_LABEL],
        add: [REVIEW_LABEL],
      });
    } catch (error) {
      console.error(`[GitHubReconcile] Linked task ${taskId} to PR #${number}, but label projection failed:`, error);
    }
  }
  return number;
}

export async function reconcileRepository(projectId: number): Promise<void> {
  const project = projectForAutomation(projectId);
  if (!project) return;
  await recoverPrAgentRunFinalizations(projectId);
  const issues = await githubClient.listOpenIssues(project, [PLAN_LABEL, APPROVED_LABEL], 100);
  const prioritized = [...issues].sort((a, b) => Number(hasLabel(b, 'Priority')) - Number(hasLabel(a, 'Priority')));
  for (const issue of prioritized) {
    try {
      const refinement = hasLabel(issue, PLAN_LABEL);
      const approved = hasLabel(issue, APPROVED_LABEL);
      if (refinement) await reconcileRefinementIssue(projectId, issue.number, issue);
      // Refinement can project labels, so a dual-label second pass must fetch current state.
      if (approved) await reconcileApprovedIssue(projectId, issue.number, refinement ? undefined : issue);
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      console.error(`[GitHubReconcile] Issue #${issue.number} scan failed:`, error);
    }
  }

  const linkedNumbers = tasksDb.getByProject(projectId)
    .map((task) => task.github_pr_number)
    .filter((number): number is number => number != null);
  let openNumbers = knownOpenPullRequests.get(projectId);
  if (!openNumbers) {
    openNumbers = new Set();
    knownOpenPullRequests.set(projectId, openNumbers);
  }
  const closedNumbers = knownClosedPullRequests.get(projectId) ?? new Set<number>();
  for (const number of linkedNumbers) {
    if (!closedNumbers.has(number)) openNumbers.add(number);
  }
  const discovered = await githubClient.listOpenPullRequests(project, UNKNOWN_PR_DISCOVERY_BUDGET);
  for (const pull of discovered) openNumbers.add(pull.number);

  for (const prNumber of [...openNumbers]) {
    try {
      const state = await reconcilePullRequest(projectId, prNumber);
      if (state === 'closed') openNumbers.delete(prNumber);
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      console.error(`[GitHubReconcile] PR #${prNumber} scan failed:`, error);
    }
  }
}

function isRateLimitError(error: unknown): error is GitHubClientError {
  return typeof error === 'object' && error !== null && 'kind' in error && error.kind === 'rate_limited';
}

export const _internal = {
  pullRequestHash,
  actionablePullRequest,
  renderPullRequestEvidence,
  resetPollingState: () => {
    knownOpenPullRequests.clear();
    knownClosedPullRequests.clear();
  },
};
