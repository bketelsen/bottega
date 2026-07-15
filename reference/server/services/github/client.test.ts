import { describe, expect, it, vi } from 'vitest';

import { GitHubCapabilityError, type GitHubProject } from './capabilities.js';
import { GitHubClient, GitHubClientError, normalizeGitHubRepo } from './client.js';

function project(tier: GitHubProject['autonomy_tier'] = 'automerge'): GitHubProject {
  return {
    id: 1,
    user_id: 1,
    name: 'test',
    repo_folder_path: '/tmp/test',
    subproject_path: null,
    active_worktree_task_id: null,
    serve_symlink_path: null,
    systemd_service_name: null,
    app_url: null,
    created_at: 'now',
    updated_at: 'now',
    github_repo: 'Owner/Repo',
    github_automation_enabled: 1,
    autonomy_tier: tier,
  };
}

const ok = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' });

describe('normalizeGitHubRepo', () => {
  it.each([
    ['Owner/Repo', 'owner/repo'],
    ['https://github.com/Owner/Repo.git', 'owner/repo'],
    ['github.com/Owner/Repo', 'owner/repo'],
    ['git@github.com:Owner/Repo.git', 'owner/repo'],
    ['ssh://git@github.com/Owner/Repo', 'owner/repo'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeGitHubRepo(input)).toBe(expected);
  });

  it('rejects non-GitHub and extra-path values', () => {
    expect(() => normalizeGitHubRepo('https://example.com/a/b')).toThrow(GitHubClientError);
    expect(() => normalizeGitHubRepo('owner/repo/issues')).toThrow(GitHubClientError);
  });
});

describe('GitHubClient reads', () => {
  it('isolates App tokens and gh configuration per repository command', async () => {
    const runner = vi.fn().mockResolvedValue(ok({ number: 4, labels: [], html_url: 'https://example/4' }));
    const resolveRepositoryAuth = vi.fn().mockResolvedValue({
      token: 'installation-secret',
      expiresAt: Date.now() + 60_000,
      installationId: 10,
      repositoryId: 100,
      repository: 'owner/repo',
      botLogin: 'bottega[bot]',
      botUserId: 99,
      botEmail: '99+bottega[bot]@users.noreply.github.com',
    });
    const client = new GitHubClient({
      runner,
      authMode: () => 'app',
      resolveRepositoryAuth,
      ghConfigDir: '/tmp/bottega-test-gh',
    });

    await client.getIssue(project(), 4);

    expect(resolveRepositoryAuth).toHaveBeenCalledWith(1, 'read');
    expect(runner).toHaveBeenCalledWith('gh', expect.any(Array), {
      env: {
        GH_TOKEN: 'installation-secret',
        GH_CONFIG_DIR: '/tmp/bottega-test-gh',
      },
    });
  });

  it('keys App rate-limit circuits by installation and repository', async () => {
    const failure = Object.assign(new Error('failed'), { stderr: 'HTTP 403 rate limit exceeded' });
    const runner = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(ok({ number: 2, labels: [], html_url: 'https://example/2' }));
    const resolveRepositoryAuth = vi.fn(async (projectId: number) => ({
      token: `token-${projectId}`,
      expiresAt: Date.now() + 60_000,
      installationId: projectId * 10,
      repositoryId: projectId * 100,
      repository: projectId === 1 ? 'owner/repo' : 'other/repo',
      botLogin: 'bottega[bot]',
      botUserId: 99,
      botEmail: '99+bottega[bot]@users.noreply.github.com',
    }));
    const client = new GitHubClient({
      runner,
      authMode: () => 'app',
      resolveRepositoryAuth,
      ghConfigDir: '/tmp/bottega-test-gh',
    });

    await expect(client.getIssue(project(), 1)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(client.getIssue({ ...project(), id: 2, github_repo: 'other/repo' }, 2)).resolves.toMatchObject({ number: 2 });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('preserves host commands and rejects /user in App mode', async () => {
    const hostRunner = vi.fn().mockResolvedValue(ok({ login: 'host-user', id: 1, type: 'User' }));
    await expect(new GitHubClient({ runner: hostRunner, authMode: () => 'host' }).getSelf())
      .resolves.toMatchObject({ login: 'host-user' });
    expect(hostRunner).toHaveBeenCalledWith('gh', expect.any(Array));

    const appRunner = vi.fn();
    await expect(new GitHubClient({ runner: appRunner, authMode: () => 'app' }).getSelf())
      .rejects.toMatchObject({ details: { endpoint: 'user' } });
    expect(appRunner).not.toHaveBeenCalled();
  });

  it('uses argv-safe gh api arguments and encodes label queries', async () => {
    const runner = vi.fn().mockResolvedValue(ok([{ number: 2, labels: [], html_url: 'https://example/2' }]));
    const client = new GitHubClient({ runner });

    await client.listOpenIssues(project(), ['needs work; $(bad)']);

    expect(runner).toHaveBeenCalledWith('gh', [
      'api', '--method', 'GET',
      'repos/owner/repo/issues?labels=needs+work%3B+%24%28bad%29&state=open&per_page=100',
      '--header', 'Accept: application/vnd.github+json',
    ]);
  });

  it('bounds issue and open PR listing at the endpoint without pagination', async () => {
    const runner = vi.fn().mockResolvedValue(ok([]));
    const client = new GitHubClient({ runner });

    await client.listOpenIssues(project(), ['Ready'], 7);
    await client.listOpenPullRequests(project(), 5);

    expect(runner).toHaveBeenNthCalledWith(1, 'gh', [
      'api', '--method', 'GET',
      'repos/owner/repo/issues?labels=Ready&state=open&per_page=7',
      '--header', 'Accept: application/vnd.github+json',
    ]);
    expect(runner).toHaveBeenNthCalledWith(2, 'gh', [
      'api', '--method', 'GET',
      'repos/owner/repo/pulls?state=open&per_page=5',
      '--header', 'Accept: application/vnd.github+json',
    ]);
  });

  it('deduplicates identical in-flight reads and clears the entry afterward', async () => {
    let resolve!: (result: ReturnType<typeof ok>) => void;
    const runner = vi.fn().mockReturnValue(new Promise((done) => { resolve = done; }));
    const client = new GitHubClient({ runner });
    const first = client.getIssue(project(), 4);
    const second = client.getIssue(project(), 4);
    expect(runner).toHaveBeenCalledTimes(1);
    resolve(ok({ number: 4, labels: [], html_url: 'https://example/4' }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ number: 4 }),
      expect.objectContaining({ number: 4 }),
    ]);
    await client.getIssue(project(), 4);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('retries transient failures with bounded exponential backoff', async () => {
    const failure = Object.assign(new Error('failed'), { stderr: 'HTTP 503 unavailable' });
    const runner = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockResolvedValue(ok({ login: 'bot' }));
    const wait = vi.fn().mockResolvedValue(undefined);
    const client = new GitHubClient({ runner, sleep: wait, baseBackoffMs: 10 });

    await expect(client.getSelf()).resolves.toMatchObject({ login: 'bot' });
    expect(wait.mock.calls).toEqual([[10], [20]]);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('opens the circuit on rate limits without retrying', async () => {
    const failure = Object.assign(new Error('failed'), {
      stderr: 'HTTP 403 rate limit exceeded\nx-ratelimit-reset: 200',
    });
    const runner = vi.fn().mockRejectedValue(failure);
    const client = new GitHubClient({ runner, now: () => 100_000 });

    await expect(client.getSelf()).rejects.toMatchObject({
      kind: 'rate_limited',
      details: { rateLimitResetAt: 200_000, retryable: false },
    });
    await expect(client.getIssue(project(), 1)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('returns a structured error for malformed JSON without retrying', async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: '<html>', stderr: '' });
    const client = new GitHubClient({ runner });
    await expect(client.getSelf()).rejects.toMatchObject({
      kind: 'invalid_json',
      details: { endpoint: 'user', retryable: false },
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('uses GraphQL review thread state to exclude resolved REST comments', async () => {
    const runner = vi.fn().mockImplementation(async (_command, args: string[]) => {
      if (args[1] === 'graphql') {
        return ok([{
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{ isResolved: true, comments: { nodes: [{ databaseId: 91 }] } }],
                },
              },
            },
          },
        }]);
      }
      if (String(args[3]).endsWith('/reviews')) return ok([[]]);
      return ok([[
        {
          id: 91,
          body: 'resolved',
          html_url: 'https://example/comment/91',
          user: { login: 'reviewer', type: 'User' },
          path: 'file.ts',
          line: 1,
          original_line: 1,
          commit_id: 'abc',
        },
      ]]);
    });
    const client = new GitHubClient({ runner });

    await expect(client.getReviewEvidence(project(), 4)).resolves.toMatchObject({
      comments: [{ id: 91, isResolved: true }],
    });
    expect(runner).toHaveBeenCalledWith('gh', expect.arrayContaining([
      'graphql', '--paginate', '--slurp', '--field', 'pullNumber=4',
    ]));
  });

  it('applies the shared retry executor to GraphQL reads', async () => {
    const failure = Object.assign(new Error('failed'), { stderr: 'HTTP 503 unavailable' });
    let graphqlAttempts = 0;
    const runner = vi.fn().mockImplementation(async (_command, args: string[]) => {
      const endpoint = String(args[3]);
      if (args[1] === 'graphql') {
        graphqlAttempts += 1;
        if (graphqlAttempts === 1) throw failure;
        return ok([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }]);
      }
      if (endpoint.endsWith('/pulls/4')) return ok({
        id: 4,
        number: 4,
        state: 'open',
        body: null,
        html_url: 'https://example/4',
        mergeable: true,
        head: { ref: 'feature', sha: 'abc', label: 'owner:feature', repo: { full_name: 'owner/repo' } },
        base: { ref: 'main', sha: 'def', label: 'owner:main' },
      });
      if (endpoint.includes('/check-runs')) return ok({ check_runs: [] });
      if (endpoint.includes('/status')) return ok({ sha: 'abc', statuses: [] });
      return ok([[]]);
    });
    const wait = vi.fn().mockResolvedValue(undefined);

    await new GitHubClient({ runner, sleep: wait, baseBackoffMs: 10 }).getPullRequest(project(), 4);

    expect(graphqlAttempts).toBe(2);
    expect(wait).toHaveBeenCalledWith(10);
  });

  it('retains overall reviews on a fetched pull request', async () => {
    const review = {
      id: 7,
      state: 'CHANGES_REQUESTED',
      body: 'Please add retries',
      submitted_at: '2026-07-13T00:00:00Z',
      commit_id: 'abc',
      user: { login: 'reviewer', id: 2, type: 'User' },
    };
    const runner = vi.fn().mockImplementation(async (_command, args: string[]) => {
      const endpoint = String(args[3]);
      if (args[1] === 'graphql') return ok([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }]);
      if (endpoint.endsWith('/pulls/4')) return ok({
        id: 4,
        number: 4,
        state: 'open',
        body: null,
        html_url: 'https://example/4',
        mergeable: true,
        head: { ref: 'feature', sha: 'abc', label: 'owner:feature', repo: { full_name: 'owner/repo' } },
        base: { ref: 'main', sha: 'def', label: 'owner:main' },
      });
      if (endpoint.endsWith('/reviews')) return ok([[review]]);
      if (endpoint.includes('/check-runs')) return ok({ check_runs: [] });
      if (endpoint.includes('/status')) return ok({ sha: 'abc', statuses: [] });
      return ok([[]]);
    });

    await expect(new GitHubClient({ runner }).getPullRequest(project(), 4)).resolves.toMatchObject({
      reviews: [review],
    });
  });

  it('short-circuits closed pull requests after the base request', async () => {
    const runner = vi.fn().mockResolvedValue(ok({
      id: 4,
      number: 4,
      state: 'closed',
      merged: true,
      body: null,
      html_url: 'https://example/4',
      mergeable: true,
      head: { ref: 'feature', sha: 'abc', label: 'owner:feature', repo: { full_name: 'owner/repo' } },
      base: { ref: 'main', sha: 'def', label: 'owner:main' },
    }));

    await expect(new GitHubClient({ runner }).getPullRequest(project(), 4)).resolves.toMatchObject({
      state: 'closed',
      merged: true,
      checks: [],
      reviews: [],
      comments: [],
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe('GitHubClient mutations', () => {
  it('asserts capability before invoking gh', async () => {
    const runner = vi.fn().mockResolvedValue(ok({ merged: true }));
    const client = new GitHubClient({ runner, loadProject: () => project('pr') });
    await expect(client.mergePullRequest(project('pr'), 3)).rejects.toBeInstanceOf(GitHubCapabilityError);
    expect(runner).not.toHaveBeenCalled();
  });

  it('passes mutation data as literal argv fields', async () => {
    const runner = vi.fn().mockResolvedValue(ok({
      id: 9,
      html_url: 'https://example/comment/9',
      user: { login: 'bot', type: 'Bot' },
    }));
    const client = new GitHubClient({ runner, loadProject: () => project('advisory') });
    await client.createComment(project('advisory'), 2, 'hello; $(touch /tmp/nope)\nnext');
    expect(runner).toHaveBeenCalledWith('gh', [
      'api', '--method', 'POST', 'repos/owner/repo/issues/2/comments',
      '--header', 'Accept: application/vnd.github+json',
      '--raw-field', 'body=hello; $(touch /tmp/nope)\nnext',
    ]);
  });

  it('supports issue, label, reaction, PR, and merge operations', async () => {
    const runner = vi.fn().mockResolvedValue(ok({
      labels: [],
      html_url: 'https://example/item',
      user: { login: 'bot', type: 'Bot' },
      head: { ref: 'task/1', sha: 'abc' },
    }));
    const full = project();
    const client = new GitHubClient({ runner, loadProject: () => full });
    await client.createIssue(full, { title: 'Title', labels: ['Ready'] });
    await client.addLabels(full, 1, ['Refined']);
    await client.removeLabel(full, 1, 'needs work');
    await client.addReaction(full, { type: 'comment', id: 4 }, 'eyes');
    await client.createPullRequest(full, { title: 'PR', head: 'task/1', base: 'main' });
    await client.mergePullRequest(full, 5, { method: 'squash', expectedHeadSha: 'abc' });
    expect(runner).toHaveBeenCalledTimes(6);
  });

  it('reloads capability state and does not retry an ambiguous mutation failure', async () => {
    const failure = Object.assign(new Error('failed'), { stderr: 'HTTP 503 unavailable' });
    const runner = vi.fn().mockRejectedValue(failure);
    const wait = vi.fn();
    const stale = project('automerge');
    const client = new GitHubClient({
      runner,
      sleep: wait,
      loadProject: () => ({ ...stale, github_automation_enabled: 0 }),
    });

    await expect(client.createComment(stale, 2, 'body')).rejects.toBeInstanceOf(GitHubCapabilityError);
    expect(runner).not.toHaveBeenCalled();

    const allowed = new GitHubClient({ runner, sleep: wait, loadProject: () => stale });
    await expect(allowed.createComment(stale, 2, 'body')).rejects.toMatchObject({ kind: 'transient' });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('recovers a missing stored comment by updating the marker match', async () => {
    const client = new GitHubClient();
    const missing = new GitHubClientError('not found', 'command_failed', {
      status: 404,
      retryable: false,
    });
    vi.spyOn(client, 'updateComment')
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({ id: 12 } as never);
    vi.spyOn(client, 'getIssueComments').mockResolvedValue([
      { id: 12, body: '<!-- plan --> old' }
    ] as never);
    const create = vi.spyOn(client, 'createComment');

    await expect(client.upsertIssueComment(project(), 2, '<!-- plan --> new', {
      commentId: 9,
      marker: '<!-- plan -->',
    })).resolves.toEqual({ id: 12 });
    expect(client.updateComment).toHaveBeenNthCalledWith(2, project(), 12, '<!-- plan --> new');
    expect(create).not.toHaveBeenCalled();
  });

  it('recovers a missing stored comment by creating a replacement when no marker matches', async () => {
    const client = new GitHubClient();
    vi.spyOn(client, 'updateComment').mockRejectedValue(new GitHubClientError('not found', 'command_failed', {
      status: 404,
      retryable: false,
    }));
    vi.spyOn(client, 'getIssueComments').mockResolvedValue([]);
    vi.spyOn(client, 'createComment').mockResolvedValue({ id: 13 } as never);

    await expect(client.upsertIssueComment(project(), 2, 'new', {
      commentId: 9,
      marker: '<!-- plan -->',
    })).resolves.toEqual({ id: 13 });
    expect(client.createComment).toHaveBeenCalledWith(project(), 2, 'new');
  });

  it.each([
    [401, 'command_failed'],
    [429, 'rate_limited'],
    [503, 'transient'],
  ] as const)('does not reconcile by marker after a %i stored comment failure', async (status, kind) => {
    const client = new GitHubClient();
    const failure = new GitHubClientError('update failed', kind, {
      status,
      retryable: false,
    });
    vi.spyOn(client, 'updateComment').mockRejectedValue(failure);
    const list = vi.spyOn(client, 'getIssueComments');
    const create = vi.spyOn(client, 'createComment');

    await expect(client.upsertIssueComment(project(), 2, 'new', {
      commentId: 9,
      marker: '<!-- plan -->',
    })).rejects.toBe(failure);
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('GitHubClient.ensureLabels', () => {
  const auth = {
    token: 'installation-secret',
    expiresAt: Date.now() + 60_000,
    installationId: 10,
    repositoryId: 100,
    repository: 'owner/repo',
    botLogin: 'bottega[bot]',
    botUserId: 99,
    botEmail: '99+bottega[bot]@users.noreply.github.com',
  };
  const clientOptions = () => ({
    authMode: () => 'app' as const,
    resolveRepositoryAuth: vi.fn().mockResolvedValue(auth),
    loadProject: () => project('pr'),
    ghConfigDir: '/tmp/bottega-test-gh',
  });

  it('creates only the missing labels and matches existing ones case-insensitively', async () => {
    // readPages returns pages (T[][]) that the client flattens.
    const runner = vi.fn()
      .mockResolvedValueOnce(ok([[{ id: 1, name: 'ready', color: '0e8a16', description: null }]]))
      .mockResolvedValueOnce(ok({ id: 2, name: 'Needs Refinement' }))
      .mockResolvedValueOnce(ok({ id: 3, name: 'Refined' }))
      .mockResolvedValueOnce(ok({ id: 4, name: 'In Review' }));
    const client = new GitHubClient({ runner, ...clientOptions() });

    const result = await client.ensureLabels(project('pr'));

    expect(result.created).toEqual(['Needs Refinement', 'Refined', 'In Review']);
    expect(result.existing).toEqual(['Ready']);
    // 1 list + 3 creates
    expect(runner).toHaveBeenCalledTimes(4);
    // The list hits the repo-level labels endpoint.
    expect(runner.mock.calls[0]![1]).toContain('repos/owner/repo/labels');
  });

  it('creates nothing when every label already exists', async () => {
    const runner = vi.fn().mockResolvedValueOnce(ok([[
      { id: 1, name: 'Needs Refinement' },
      { id: 2, name: 'Ready' },
      { id: 3, name: 'Refined' },
      { id: 4, name: 'In Review' },
    ]]));
    const client = new GitHubClient({ runner, ...clientOptions() });

    const result = await client.ensureLabels(project('pr'));

    expect(result.created).toEqual([]);
    expect(result.existing).toEqual(['Needs Refinement', 'Ready', 'Refined', 'In Review']);
    expect(runner).toHaveBeenCalledTimes(1); // only the list, no creates
  });

  it('treats a 422 already-exists during create as benign', async () => {
    const conflict = Object.assign(new Error('failed'), { stderr: 'HTTP 422 already_exists' });
    const runner = vi.fn()
      .mockResolvedValueOnce(ok([[]])) // no existing labels
      .mockRejectedValueOnce(conflict) // Needs Refinement -> 422
      .mockResolvedValueOnce(ok({ id: 2, name: 'Ready' }))
      .mockResolvedValueOnce(ok({ id: 3, name: 'Refined' }))
      .mockResolvedValueOnce(ok({ id: 4, name: 'In Review' }));
    const client = new GitHubClient({ runner, ...clientOptions() });

    const result = await client.ensureLabels(project('pr'));

    expect(result.created).toEqual(['Ready', 'Refined', 'In Review']);
    expect(result.existing).toEqual(['Needs Refinement']);
  });
});

