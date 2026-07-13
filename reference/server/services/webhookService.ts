import crypto from 'crypto';
import { projectsDb } from '../database/db.js';
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

export { BOTTEGA_COMMENT_MARKER, isBottegaComment };

const SUPPORTED_EVENTS = new Set([
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_run',
  'check_suite',
]);

const ISSUE_ACTIONS = new Set(['opened', 'edited', 'labeled', 'unlabeled', 'reopened']);
const COMMENT_ACTIONS = new Set(['created', 'edited']);
const PR_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);
const REVIEW_ACTIONS = new Set(['submitted', 'edited', 'dismissed']);
const CHECK_ACTIONS = new Set(['completed', 'rerequested', 'requested_action']);

let acceptingWebhooks = true;
const pendingWebhooks = new Set<Promise<void>>();

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

export function isSupportedGitHubEvent(event: string): boolean {
  return SUPPORTED_EVENTS.has(event);
}

function numberAt(value: unknown, key: string): number | null {
  const number = (value as Record<string, unknown> | undefined)?.[key];
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : null;
}

function pullRequestNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((pullRequest) => numberAt(pullRequest, 'number'))
    .filter((number): number is number => number !== null))];
}

/** Route one accepted delivery through the same idempotent reconciliation used by polling. */
export async function dispatchGitHubWebhook(
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const repository = (payload.repository as { full_name?: unknown } | undefined)?.full_name;
  if (typeof repository !== 'string') return;

  const project = projectsDb.getByGithubRepo(repository.toLowerCase());
  if (!project?.github_automation_enabled || !project.github_repo) return;

  const action = typeof payload.action === 'string' ? payload.action : '';
  const issueNumber = numberAt(payload.issue, 'number');
  const prNumber = numberAt(payload.pull_request, 'number');

  if (event === 'issues') {
    if (!ISSUE_ACTIONS.has(action) || !issueNumber) return;
    await Promise.all([
      reconcileRefinementIssue(project.id, issueNumber),
      reconcileApprovedIssue(project.id, issueNumber),
    ]);
    return;
  }

  if (event === 'issue_comment') {
    if (!COMMENT_ACTIONS.has(action) || !issueNumber) return;
    const comment = payload.comment as
      | { id?: unknown; body?: unknown; user?: { login?: unknown } }
      | undefined;
    const body = typeof comment?.body === 'string' ? comment.body : '';
    const author = typeof comment?.user?.login === 'string' ? comment.user.login : undefined;
    if (isBottegaComment(body, author, await githubIdentity.resolveLogin())) return;

    if ((payload.issue as { pull_request?: unknown } | undefined)?.pull_request) {
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

  if (event === 'pull_request') {
    if (PR_ACTIONS.has(action) && prNumber) await reconcilePullRequest(project.id, prNumber);
    return;
  }

  if (event === 'pull_request_review' || event === 'pull_request_review_comment') {
    if (!REVIEW_ACTIONS.has(action) && !COMMENT_ACTIONS.has(action)) return;
    const source = event === 'pull_request_review' ? payload.review : payload.comment;
    const comment = source as { body?: unknown; user?: { login?: unknown } } | undefined;
    const body = typeof comment?.body === 'string' ? comment.body : '';
    const author = typeof comment?.user?.login === 'string' ? comment.user.login : undefined;
    if (isBottegaComment(body, author, await githubIdentity.resolveLogin())) return;
    if (prNumber) await reconcilePullRequest(project.id, prNumber);
    return;
  }

  const check = event === 'check_run' ? payload.check_run : payload.check_suite;
  if (!CHECK_ACTIONS.has(action)) return;
  const conclusion = (check as { conclusion?: unknown } | undefined)?.conclusion;
  if (
    action === 'completed' &&
    typeof conclusion === 'string' &&
    ['success', 'neutral', 'skipped'].includes(conclusion.toLowerCase())
  ) return;
  for (const number of pullRequestNumbers(
    (check as { pull_requests?: unknown } | undefined)?.pull_requests,
  )) {
    await reconcilePullRequest(project.id, number);
  }
}

export function queueGitHubWebhook(
  event: string,
  payload: Record<string, unknown>,
): boolean {
  if (!acceptingWebhooks) return false;

  const repository = (payload.repository as { full_name?: unknown } | undefined)?.full_name;
  const work = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => dispatchGitHubWebhook(event, payload))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Webhook] ${event} reconciliation failed for ${String(repository)}:`, message);
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
}
