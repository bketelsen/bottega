import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getSetting: vi.fn(),
  getSelf: vi.fn(),
  refinement: vi.fn(),
  approved: vi.fn(),
  pullRequest: vi.fn(),
}));

vi.mock('../database/db.js', () => ({
  projectsDb: { getByGithubRepo: mocks.getProject },
  appSettingsDb: { getValue: mocks.getSetting },
}));
vi.mock('./github/client.js', () => ({
  githubClient: { getSelf: mocks.getSelf },
}));
vi.mock('./github/reconcile.js', () => ({
  reconcileRefinementIssue: mocks.refinement,
  reconcileApprovedIssue: mocks.approved,
  reconcilePullRequest: mocks.pullRequest,
}));

import {
  drainGitHubWebhooks,
  dispatchGitHubWebhook,
  isBottegaComment,
  queueGitHubWebhook,
  resetWebhookServiceForTests,
  stopAcceptingGitHubWebhooks,
  validateGitHubWebhookSignature,
} from './webhookService.js';

describe('webhook service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWebhookServiceForTests();
    mocks.getProject.mockReturnValue({
      id: 7,
      github_repo: 'org/repo',
      github_automation_enabled: 1,
    });
    mocks.getSelf.mockResolvedValue({ login: 'bottega-host', id: 1, type: 'User' });
    mocks.getSetting.mockReturnValue('bottega');
    mocks.refinement.mockResolvedValue(undefined);
    mocks.approved.mockResolvedValue(undefined);
    mocks.pullRequest.mockResolvedValue(undefined);
  });

  it('validates HMAC-SHA256 without normalizing payload bytes', () => {
    const payload = Buffer.from('{ "value": 1 }\n');
    const signature = `sha256=${crypto
      .createHmac('sha256', 'secret')
      .update(payload)
      .digest('hex')}`;
    expect(validateGitHubWebhookSignature(payload, signature, 'secret')).toBe(true);
    expect(validateGitHubWebhookSignature(payload, signature, 'other')).toBe(false);
  });

  it('recognizes stable self markers', () => {
    expect(isBottegaComment('plan\n<!-- bottega:task:4:plan -->', 'human', null)).toBe(true);
    expect(isBottegaComment('text', 'BOTTEGA-HOST', 'bottega-host')).toBe(true);
  });

  it('routes issue events through both idempotent issue reconcilers', async () => {
    await dispatchGitHubWebhook('issues', {
      action: 'labeled',
      issue: { number: 12 },
      repository: { full_name: 'Org/Repo' },
    });
    expect(mocks.getProject).toHaveBeenCalledWith('org/repo');
    expect(mocks.refinement).toHaveBeenCalledWith(7, 12);
    expect(mocks.approved).toHaveBeenCalledWith(7, 12);
  });

  it('passes an explicit @bottega comment to PR reconciliation', async () => {
    await dispatchGitHubWebhook('issue_comment', {
      action: 'created',
      issue: { number: 31, pull_request: {} },
      comment: { id: 99, body: '@bottega retry CI', user: { login: 'human' } },
      repository: { full_name: 'org/repo' },
    });
    expect(mocks.pullRequest).toHaveBeenCalledWith(7, 31);
  });

  it('uses the configured trigger and ignores ordinary PR comments', async () => {
    mocks.getSetting.mockReturnValue('repair-bot');
    const payload = {
      action: 'created',
      issue: { number: 31, pull_request: {} },
      comment: { id: 99, body: 'retry this', user: { login: 'human' } },
      repository: { full_name: 'org/repo' },
    };

    await dispatchGitHubWebhook('issue_comment', payload);
    expect(mocks.pullRequest).not.toHaveBeenCalled();

    await dispatchGitHubWebhook('issue_comment', {
      ...payload,
      comment: { ...payload.comment, body: '@repair-bot, retry this' },
    });
    expect(mocks.pullRequest).toHaveBeenCalledWith(7, 31);
  });

  it.each([
    ['broad marker', 'generated <!-- bottega:generated:evidence -->', 'human'],
    ['resolved host login', 'ordinary comment', 'bottega-host'],
  ])('suppresses self comments identified by %s', async (_name, body, login) => {
    await dispatchGitHubWebhook('pull_request_review_comment', {
      action: 'created',
      pull_request: { number: 31 },
      comment: { body, user: { login } },
      repository: { full_name: 'org/repo' },
    });
    expect(mocks.pullRequest).not.toHaveBeenCalled();
  });

  it('retries owner resolution after a transient failure', async () => {
    mocks.getSelf.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({
      login: 'bottega-host',
      id: 1,
      type: 'User',
    });
    const payload = {
      action: 'created',
      pull_request: { number: 31 },
      comment: { body: 'ordinary comment', user: { login: 'bottega-host' } },
      repository: { full_name: 'org/repo' },
    };

    await dispatchGitHubWebhook('pull_request_review_comment', payload);
    expect(mocks.pullRequest).toHaveBeenCalledTimes(1);
    await dispatchGitHubWebhook('pull_request_review_comment', payload);
    expect(mocks.pullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.getSelf).toHaveBeenCalledTimes(2);
  });

  it('retains bot-authored check events and reconciles every attached PR', async () => {
    await dispatchGitHubWebhook('check_run', {
      action: 'completed',
      sender: { login: 'ci[bot]' },
      check_run: { pull_requests: [{ number: 2 }, { number: 3 }] },
      repository: { full_name: 'org/repo' },
    });
    expect(mocks.pullRequest).toHaveBeenNthCalledWith(1, 7, 2);
    expect(mocks.pullRequest).toHaveBeenNthCalledWith(2, 7, 3);
  });

  it('filters successful completed checks and deduplicates PR numbers in one payload', async () => {
    await dispatchGitHubWebhook('check_run', {
      action: 'completed',
      check_run: { conclusion: 'success', pull_requests: [{ number: 2 }] },
      repository: { full_name: 'org/repo' },
    });
    expect(mocks.pullRequest).not.toHaveBeenCalled();

    await dispatchGitHubWebhook('check_suite', {
      action: 'completed',
      check_suite: {
        conclusion: 'failure',
        pull_requests: [{ number: 2 }, { number: 2 }, { number: 3 }],
      },
      repository: { full_name: 'org/repo' },
    });
    expect(mocks.pullRequest).toHaveBeenCalledTimes(2);
    expect(mocks.pullRequest).toHaveBeenNthCalledWith(1, 7, 2);
    expect(mocks.pullRequest).toHaveBeenNthCalledWith(2, 7, 3);
  });

  it('routes PR and review events and skips disabled projects', async () => {
    await dispatchGitHubWebhook('pull_request', {
      action: 'synchronize',
      pull_request: { number: 8 },
      repository: { full_name: 'org/repo' },
    });
    await dispatchGitHubWebhook('pull_request_review', {
      action: 'submitted',
      pull_request: { number: 9 },
      review: { body: 'changes', user: { login: 'reviewer' } },
      repository: { full_name: 'org/repo' },
    });
    expect(mocks.pullRequest).toHaveBeenCalledWith(7, 8);
    expect(mocks.pullRequest).toHaveBeenCalledWith(7, 9);

    mocks.getProject.mockReturnValue({ id: 7, github_repo: 'org/repo', github_automation_enabled: 0 });
    await dispatchGitHubWebhook('pull_request', {
      action: 'reopened',
      pull_request: { number: 10 },
      repository: { full_name: 'org/repo' },
    });
    expect(mocks.pullRequest).not.toHaveBeenCalledWith(7, 10);
  });

  it('tracks accepted deferred work for shutdown and stops new dispatch', async () => {
    let finish: (() => void) | undefined;
    mocks.pullRequest.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));

    const payload = {
      action: 'opened',
      pull_request: { number: 8 },
      repository: { full_name: 'org/repo' },
    };
    expect(queueGitHubWebhook('pull_request', payload)).toBe(true);
    stopAcceptingGitHubWebhooks();
    expect(queueGitHubWebhook('pull_request', payload)).toBe(false);

    await new Promise((resolve) => setImmediate(resolve));
    let drained = false;
    const draining = drainGitHubWebhooks().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish?.();
    await draining;
    expect(mocks.pullRequest).toHaveBeenCalledTimes(1);
  });
});
