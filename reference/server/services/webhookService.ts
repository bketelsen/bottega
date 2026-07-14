import crypto from 'crypto';
import { projectsDb } from '../database/db.js';
import type { ProjectRow } from '../../shared/types/db.js';
import {
  reconcileApprovedIssue,
  reconcilePullRequest,
  reconcileRefinementIssue,
} from './github/reconcile.js';
import {
  BOTTEGA_COMMENT_MARKER,
  githubIdentity,
  isBottegaComment,
} from './github/identity.js';
import { hasGitHubPrTriggerMention } from './github/trigger.js';
import { invalidateInstallation } from './github/appAuth.js';
import {
  isSupportedGitHubEvent,
  type GitHubWebhookDelivery,
} from '../../shared/schemas/webhooks.js';

export { BOTTEGA_COMMENT_MARKER, isBottegaComment };

const ISSUE_ACTIONS = new Set(['opened', 'edited', 'labeled', 'unlabeled', 'reopened']);
const COMMENT_ACTIONS = new Set(['created', 'edited']);
const PR_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);
const REVIEW_ACTIONS = new Set(['submitted', 'edited', 'dismissed']);
const CHECK_ACTIONS = new Set(['completed', 'rerequested', 'requested_action']);

let acceptingWebhooks = true;
const pendingWebhooks = new Set<Promise<void>>();
const unavailableInstallations = new Set<number>();
const unavailableRepositories = new Set<string>();

export function validateGitHubWebhookSignature(
  payload: Buffer | string,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!signature || !secret) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export { isSupportedGitHubEvent };

function appMode(): boolean {
  return process.env.GITHUB_AUTH_MODE?.trim() === 'app';
}

function repositoryAvailabilityKey(installationId: number, repositoryId: number): string {
  return `${installationId}:${repositoryId}`;
}

function isUnavailable(installationId: number, repositoryId: number): boolean {
  return unavailableInstallations.has(installationId)
    || unavailableRepositories.has(repositoryAvailabilityKey(installationId, repositoryId));
}

function handleInstallationEvent(
  delivery: Extract<GitHubWebhookDelivery, { event: 'installation' }>,
): void {
  const { action, installation: { id: installationId } } = delivery.payload;
  invalidateInstallation(installationId);
  if (action === 'suspended' || action === 'deleted') {
    unavailableInstallations.add(installationId);
  } else {
    unavailableInstallations.delete(installationId);
  }
}

function handleInstallationRepositoriesEvent(
  delivery: Extract<GitHubWebhookDelivery, { event: 'installation_repositories' }>,
): void {
  const { installation: { id: installationId }, repositories_added, repositories_removed } = delivery.payload;
  invalidateInstallation(installationId);
  for (const repository of repositories_added) {
    unavailableRepositories.delete(repositoryAvailabilityKey(installationId, repository.id));
  }
  for (const repository of repositories_removed) {
    unavailableRepositories.add(repositoryAvailabilityKey(installationId, repository.id));
  }
}

function findProjectForRepository(
  repository: { id: number; full_name: string },
  installationId: number,
): ProjectRow | undefined {
  const projects = projectsDb.getAllAdmin();
  const byId = projects.find((project) => project.github_repository_id === repository.id);
  if (byId) {
    if (byId.github_installation_id !== installationId) return undefined;
    if (byId.github_repo !== repository.full_name) {
      projectsDb.updateGitHubIdentity(byId.id, repository.full_name, repository.id, installationId);
      return { ...byId, github_repo: repository.full_name };
    }
    return byId;
  }

  // Name matching is only for rows created before repository identities were persisted.
  const migrationProject = projects.find(
    (project) => project.github_repository_id == null
      && project.github_repo?.toLowerCase() === repository.full_name,
  );
  if (!migrationProject) return undefined;
  projectsDb.updateGitHubIdentity(
    migrationProject.id,
    repository.full_name,
    repository.id,
    installationId,
  );
  return {
    ...migrationProject,
    github_repo: repository.full_name,
    github_repository_id: repository.id,
    github_installation_id: installationId,
  };
}

function handleRepositoryEvent(
  delivery: Extract<GitHubWebhookDelivery, { event: 'repository' }>,
): void {
  const { repository, installation, action } = delivery.payload;
  if (repository.id == null || installation == null) return;
  const repositoryId = repository.id;
  const installationId = installation.id;
  const project = findProjectForRepository({ id: repositoryId, full_name: repository.full_name }, installationId);
  if (!project) return;
  const key = repositoryAvailabilityKey(installationId, repositoryId);
  if (action === 'deleted' || action === 'archived') unavailableRepositories.add(key);
  else if (action === 'unarchived') unavailableRepositories.delete(key);
}

/** Route one accepted delivery through the same idempotent reconciliation used by polling. */
export async function dispatchGitHubWebhook(delivery: GitHubWebhookDelivery): Promise<void> {
  if (delivery.event === 'installation') {
    handleInstallationEvent(delivery);
    return;
  }
  if (delivery.event === 'installation_repositories') {
    handleInstallationRepositoriesEvent(delivery);
    return;
  }
  if (delivery.event === 'repository') {
    handleRepositoryEvent(delivery);
    return;
  }

  const { payload } = delivery;
  const repository = payload.repository.full_name;

  let project: ProjectRow | undefined;
  if (appMode()) {
    const { id: repositoryId } = payload.repository;
    const installationId = payload.installation?.id;
    if (repositoryId == null || installationId == null || isUnavailable(installationId, repositoryId)) return;
    project = findProjectForRepository({ id: repositoryId, full_name: repository }, installationId);
  } else {
    project = projectsDb.getByGithubRepo(repository);
  }
  if (!project?.github_automation_enabled || !project.github_repo) return;

  const { action } = payload;

  if (delivery.event === 'issues') {
    if (!ISSUE_ACTIONS.has(action)) return;
    const issueNumber = delivery.payload.issue.number;
    await Promise.all([
      reconcileRefinementIssue(project.id, issueNumber),
      reconcileApprovedIssue(project.id, issueNumber),
    ]);
    return;
  }

  if (delivery.event === 'issue_comment') {
    if (!COMMENT_ACTIONS.has(action)) return;
    const { issue, comment } = delivery.payload;
    const issueNumber = issue.number;
    const body = comment.body ?? '';
    const author = comment.user?.login;
    if (isBottegaComment(body, author, await githubIdentity.resolveLogin())) return;

    if (issue.pull_request) {
      // The reconciler fetches current comments and incorporates the explicit
      // comment ID into its evidence hash, making this delivery a forced run.
      if (hasGitHubPrTriggerMention(body)) await reconcilePullRequest(project.id, issueNumber);
    } else {
      await Promise.all([
        reconcileRefinementIssue(project.id, issueNumber),
        reconcileApprovedIssue(project.id, issueNumber),
      ]);
    }
    return;
  }

  if (delivery.event === 'pull_request') {
    if (PR_ACTIONS.has(action)) await reconcilePullRequest(project.id, delivery.payload.pull_request.number);
    return;
  }

  if (delivery.event === 'pull_request_review' || delivery.event === 'pull_request_review_comment') {
    if (!REVIEW_ACTIONS.has(action) && !COMMENT_ACTIONS.has(action)) return;
    const source = delivery.event === 'pull_request_review'
      ? delivery.payload.review
      : delivery.payload.comment;
    const body = source.body ?? '';
    const author = source.user?.login;
    if (isBottegaComment(body, author, await githubIdentity.resolveLogin())) return;
    await reconcilePullRequest(project.id, delivery.payload.pull_request.number);
    return;
  }

  if (!CHECK_ACTIONS.has(action)) return;
  const check = delivery.event === 'check_run'
    ? delivery.payload.check_run
    : delivery.payload.check_suite;
  const conclusion = check.conclusion;
  if (
    action === 'completed' &&
    typeof conclusion === 'string' &&
    ['success', 'neutral', 'skipped'].includes(conclusion.toLowerCase())
  ) return;
  for (const number of new Set(check.pull_requests.map((pullRequest) => pullRequest.number))) {
    await reconcilePullRequest(project.id, number);
  }
}

export function queueGitHubWebhook(delivery: GitHubWebhookDelivery): boolean {
  if (!acceptingWebhooks) return false;

  const repository = delivery.event === 'installation_repositories'
    ? undefined
    : delivery.payload.repository?.full_name;
  const work = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => dispatchGitHubWebhook(delivery))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Webhook] ${delivery.event} reconciliation failed for ${String(repository)}:`, message);
    })
    .finally(() => pendingWebhooks.delete(work));
  pendingWebhooks.add(work);
  return true;
}

export function stopAcceptingGitHubWebhooks(): void {
  acceptingWebhooks = false;
}

export async function drainGitHubWebhooks(): Promise<void> {
  await Promise.allSettled([...pendingWebhooks]);
}

export function resetWebhookServiceForTests(): void {
  githubIdentity.reset();
  acceptingWebhooks = true;
  pendingWebhooks.clear();
  unavailableInstallations.clear();
  unavailableRepositories.clear();
}
