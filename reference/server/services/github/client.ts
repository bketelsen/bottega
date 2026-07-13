import { runCommand, type RunCommandOptions, type RunCommandResult } from '../shell.js';
import { projectsDb } from '../../database/db.js';
import { normalizeGitHubRepository } from '../../../shared/schemas/github.js';
import {
  assertCapability,
  type GitHubAction,
  type GitHubProject,
} from './capabilities.js';

export interface GitHubUser {
  login: string;
  id: number;
  type: string;
}

export interface GitHubLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  url: string;
  labels: string[];
  user: GitHubUser;
  pull_request?: { url: string };
}

export interface GitHubComment {
  id: number;
  body: string;
  html_url: string;
  url: string;
  created_at: string;
  updated_at: string;
  user: GitHubUser;
  authorLogin: string;
  authorType: string;
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  html_url: string;
  url: string;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  headSha: string;
  linkedIssueNumber: number | null;
  checks: GitHubCheckRun[];
  statuses: GitHubCommitStatus[];
  reviews: GitHubReview[];
  reviewComments: Array<GitHubComment & { isResolved: boolean }>;
  comments: GitHubComment[];
  head: { ref: string; sha: string; label: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string; label: string };
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface GitHubCommitStatus {
  id: number;
  context: string;
  state: string;
  description: string | null;
  target_url: string | null;
}

interface GitHubChecks {
  sha: string;
  checkRuns: GitHubCheckRun[];
  statuses: GitHubCommitStatus[];
}

export interface GitHubReview {
  id: number;
  state: string;
  body: string | null;
  submitted_at: string | null;
  commit_id: string;
  user: GitHubUser;
}

export interface GitHubReviewComment extends GitHubComment {
  path: string;
  line: number | null;
  original_line: number | null;
  commit_id: string;
  isResolved: boolean;
}

export interface GitHubReviewEvidence {
  reviews: GitHubReview[];
  comments: GitHubReviewComment[];
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
}

export interface CreatePullRequestInput {
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

export interface MergePullRequestInput {
  method?: 'merge' | 'squash' | 'rebase';
  title?: string;
  message?: string;
  expectedHeadSha?: string;
}

export interface GitHubMergeResult {
  sha: string;
  merged: boolean;
  message: string;
}

export type ReactionContent = '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes';

export interface GitHubReaction {
  id: number;
  content: ReactionContent;
  user: GitHubUser;
}

export type GitHubErrorKind =
  | 'invalid_repository'
  | 'invalid_json'
  | 'rate_limited'
  | 'transient'
  | 'command_failed';

export class GitHubClientError extends Error {
  constructor(
    message: string,
    readonly kind: GitHubErrorKind,
    readonly details: {
      endpoint?: string;
      status?: number;
      retryable: boolean;
      attempt?: number;
      rateLimitResetAt?: number;
      stderr?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.name = 'GitHubClientError';
  }
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: RunCommandOptions,
) => Promise<RunCommandResult>;

interface GitHubClientOptions {
  runner?: CommandRunner;
  maxAttempts?: number;
  baseBackoffMs?: number;
  rateLimitFallbackMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  loadProject?: (projectId: number) => GitHubProject | undefined;
}

interface CommandFailure extends Error {
  stderr?: string;
  stdout?: string;
  code?: string | number;
}

interface GitHubIssueResponse extends Omit<GitHubIssue, 'url' | 'labels'> {
  labels: Array<GitHubLabel | string>;
}

type GitHubCommentResponse = Omit<GitHubComment, 'url' | 'authorLogin' | 'authorType'>;

interface GitHubReviewCommentResponse extends GitHubCommentResponse {
  path: string;
  line: number | null;
  original_line: number | null;
  commit_id: string;
}

interface GitHubReviewThreadsResponse {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: Array<{
            isResolved: boolean;
            comments: { nodes: Array<{ databaseId: number | null }> };
          }>;
        };
      } | null;
    } | null;
  };
}

interface GitHubPullRequestResponse extends Omit<
  GitHubPullRequest,
  'url' | 'mergeable' | 'headSha' | 'linkedIssueNumber' | 'checks' | 'statuses' | 'reviews' | 'reviewComments' | 'comments'
> {
  mergeable: boolean | null;
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
export function normalizeGitHubRepo(value: string): string {
  try {
    return normalizeGitHubRepository(value);
  } catch (cause) {
    throw new GitHubClientError(`Invalid GitHub repository: ${value}`, 'invalid_repository', {
      retryable: false,
      cause,
    });
  }
}

export class GitHubClient {
  private readonly runner: CommandRunner;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly rateLimitFallbackMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly loadProject: (projectId: number) => GitHubProject | undefined;
  private readonly inFlightReads = new Map<string, Promise<unknown>>();
  private rateLimitedUntil = 0;

  constructor(options: GitHubClientOptions = {}) {
    this.runner = options.runner ?? runCommand;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 250;
    this.rateLimitFallbackMs = options.rateLimitFallbackMs ?? 60_000;
    this.sleep = options.sleep ?? sleep;
    this.now = options.now ?? Date.now;
    this.loadProject = options.loadProject ?? ((projectId) => projectsDb.getByIdAdmin(projectId));
  }

  async getSelf(): Promise<GitHubUser> {
    return this.read<GitHubUser>('user');
  }

  async getIssue(project: GitHubProject, number: number): Promise<GitHubIssue>;
  async getIssue(repo: string, number: number): Promise<GitHubIssue>;
  async getIssue(repoOrProject: string | GitHubProject, number: number): Promise<GitHubIssue> {
    const issue = await this.read<GitHubIssueResponse>(`${this.repoPath(this.repoOf(repoOrProject))}/issues/${number}`);
    return this.mapIssue(issue);
  }

  private async listIssueComments(repo: string, number: number): Promise<GitHubComment[]> {
    const comments = await this.readPages<GitHubCommentResponse>(`${this.repoPath(repo)}/issues/${number}/comments`);
    return comments.map((comment) => this.mapComment(comment));
  }

  async getIssueComments(project: GitHubProject, number: number): Promise<GitHubComment[]> {
    return this.listIssueComments(this.repoOf(project), number);
  }

  private async listIssueLabels(repo: string, number: number): Promise<GitHubLabel[]> {
    return this.readPages<GitHubLabel>(`${this.repoPath(repo)}/issues/${number}/labels`);
  }

  private async listIssuesByLabel(
    repo: string,
    label: string,
    state: 'open' | 'closed' | 'all' = 'open',
    limit?: number,
  ): Promise<GitHubIssue[]> {
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) return [];
    const perPage = limit === undefined ? 100 : Math.min(100, Math.floor(limit));
    const query = new URLSearchParams({ labels: label, state, per_page: String(perPage) });
    const endpoint = `${this.repoPath(repo)}/issues?${query.toString()}`;
    const issues = limit === undefined
      ? await this.readPages<GitHubIssueResponse>(endpoint)
      : await this.read<GitHubIssueResponse[]>(endpoint);
    return issues.filter((issue) => !issue.pull_request).map((issue) => this.mapIssue(issue));
  }

  async listOpenIssues(project: GitHubProject, labels: string[], limit = 100): Promise<GitHubIssue[]> {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const boundedLimit = Math.min(100, Math.floor(limit));
    const groups = labels.length > 0
      ? await Promise.all(labels.map((label) => this.listIssuesByLabel(this.repoOf(project), label, 'open', boundedLimit)))
      : [await this.listIssuesByLabel(this.repoOf(project), '', 'open', boundedLimit)];
    return [...new Map(groups.flat().map((issue) => [issue.number, issue])).values()].slice(0, boundedLimit);
  }

  async listOpenPullRequests(project: GitHubProject, limit = 20): Promise<GitHubPullRequest[]> {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const boundedLimit = Math.min(100, Math.floor(limit));
    const query = new URLSearchParams({ state: 'open', per_page: String(boundedLimit) });
    const pulls = await this.read<GitHubPullRequestResponse[]>(
      `${this.repoPath(this.repoOf(project))}/pulls?${query.toString()}`,
    );
    return pulls.map((pull) => this.mapPullRequest(pull));
  }

  async getPullRequest(project: GitHubProject, number: number): Promise<GitHubPullRequest>;
  async getPullRequest(repo: string, number: number): Promise<GitHubPullRequest>;
  async getPullRequest(repoOrProject: string | GitHubProject, number: number): Promise<GitHubPullRequest> {
    const repo = this.repoOf(repoOrProject);
    const path = `${this.repoPath(repo)}/pulls/${number}`;
    const pull = await this.read<GitHubPullRequestResponse>(path);
    if (pull.state !== 'open') return this.mapPullRequest(pull);
    const [checks, evidence, comments] = await Promise.all([
      this.getChecks(repo, pull.head.sha),
      this.getReviewEvidence(repo, number),
      this.listIssueComments(repo, number),
    ]);
    const linkedIssue = pull.body?.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i)?.[1];
    return {
      ...pull,
      url: pull.html_url,
      mergeable: pull.mergeable === true ? 'mergeable' : pull.mergeable === false ? 'conflicting' : 'unknown',
      headSha: pull.head.sha,
      linkedIssueNumber: linkedIssue ? Number(linkedIssue) : null,
      checks: checks.checkRuns,
      statuses: checks.statuses,
      reviews: evidence.reviews,
      reviewComments: evidence.comments,
      comments,
    };
  }

  async findPullRequestForTaskBranch(project: GitHubProject, taskId: number): Promise<GitHubPullRequest | null> {
    const repo = this.repoOf(project);
    const pulls = await this.read<GitHubPullRequestResponse[]>(`${this.repoPath(repo)}/pulls?state=open&per_page=100`);
    const prefix = `task/${taskId}-`;
    const pull = pulls.find((candidate) => candidate.head.ref === `task/${taskId}` || candidate.head.ref.startsWith(prefix));
    return pull ? this.mapPullRequest(pull) : null;
  }

  private async getChecks(repo: string, ref: string): Promise<GitHubChecks> {
    const path = this.repoPath(repo);
    const encodedRef = encodeURIComponent(ref);
    const [runs, status] = await Promise.all([
      this.read<{ check_runs: GitHubCheckRun[] }>(`${path}/commits/${encodedRef}/check-runs?per_page=100`),
      this.read<{ sha: string; statuses: GitHubCommitStatus[] }>(`${path}/commits/${encodedRef}/status?per_page=100`),
    ]);
    return { sha: status.sha, checkRuns: runs.check_runs, statuses: status.statuses };
  }

  async getReviewEvidence(repo: string, pullNumber: number): Promise<GitHubReviewEvidence> {
    const path = `${this.repoPath(repo)}/pulls/${pullNumber}`;
    const [owner, name] = normalizeGitHubRepo(repo).split('/') as [string, string];
    const [reviews, comments, threadPages] = await Promise.all([
      this.readPages<GitHubReview>(`${path}/reviews`),
      this.readPages<GitHubReviewCommentResponse>(`${path}/comments`),
      this.readGraphqlPages<GitHubReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
        owner,
        name,
        pullNumber,
      }),
    ]);
    const resolutionByCommentId = new Map<number, boolean>();
    for (const page of threadPages) {
      for (const thread of page.data.repository?.pullRequest?.reviewThreads.nodes ?? []) {
        for (const threadComment of thread.comments.nodes) {
          if (threadComment.databaseId != null) resolutionByCommentId.set(threadComment.databaseId, thread.isResolved);
        }
      }
    }
    return {
      reviews,
      comments: comments.map((comment) => ({
        ...this.mapComment(comment),
        path: comment.path,
        line: comment.line,
        original_line: comment.original_line,
        commit_id: comment.commit_id,
        isResolved: resolutionByCommentId.get(comment.id) ?? false,
      })),
    };
  }

  async createIssue(project: GitHubProject, input: CreateIssueInput): Promise<GitHubIssue> {
    const issue = await this.mutate<GitHubIssueResponse>(project, 'createIssue', 'issues', 'POST', {
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    return this.mapIssue(issue);
  }

  async createComment(project: GitHubProject, issueNumber: number, body: string): Promise<GitHubComment> {
    const comment = await this.mutate<GitHubCommentResponse>(project, 'comment', `issues/${issueNumber}/comments`, 'POST', { body });
    return this.mapComment(comment);
  }

  async updateComment(project: GitHubProject, commentId: number, body: string): Promise<GitHubComment> {
    const comment = await this.mutate<GitHubCommentResponse>(project, 'comment', `issues/comments/${commentId}`, 'PATCH', { body });
    return this.mapComment(comment);
  }

  async upsertIssueComment(
    project: GitHubProject,
    issueNumber: number,
    body: string,
    options: { commentId: number | null; marker: string },
  ): Promise<Pick<GitHubComment, 'id'>> {
    if (options.commentId) {
      try {
        return await this.updateComment(project, options.commentId, body);
      } catch (error) {
        if (!(error instanceof GitHubClientError) || error.details.status !== 404) throw error;
      }
    }
    const existing = (await this.getIssueComments(project, issueNumber))
      .find((comment) => comment.body.includes(options.marker));
    return existing
      ? this.updateComment(project, existing.id, body)
      : this.createComment(project, issueNumber, body);
  }

  async addLabels(project: GitHubProject, issueNumber: number, labels: string[]): Promise<GitHubLabel[]> {
    return this.mutate<GitHubLabel[]>(project, 'label', `issues/${issueNumber}/labels`, 'POST', { labels });
  }

  async removeLabel(project: GitHubProject, issueNumber: number, label: string): Promise<void> {
    await this.mutate<unknown>(project, 'label', `issues/${issueNumber}/labels/${encodeURIComponent(label)}`, 'DELETE');
  }

  async replaceIssueLabels(
    project: GitHubProject,
    issueNumber: number,
    changes: { remove: string[]; add: string[] },
  ): Promise<void> {
    const current = await this.listIssueLabels(this.repoOf(project), issueNumber);
    const byLowerName = new Map(current.map((label) => [label.name.toLowerCase(), label.name]));
    for (const label of changes.remove) {
      const existing = byLowerName.get(label.toLowerCase());
      if (existing) await this.removeLabel(project, issueNumber, existing);
    }
    const additions = changes.add.filter((label) => !byLowerName.has(label.toLowerCase()));
    if (additions.length > 0) await this.addLabels(project, issueNumber, additions);
  }

  async addReaction(
    project: GitHubProject,
    subject: { type: 'issue'; number: number } | { type: 'comment'; id: number },
    content: ReactionContent,
  ): Promise<GitHubReaction> {
    const suffix = subject.type === 'issue'
      ? `issues/${subject.number}/reactions`
      : `issues/comments/${subject.id}/reactions`;
    return this.mutate<GitHubReaction>(project, 'reaction', suffix, 'POST', { content });
  }

  async createPullRequest(project: GitHubProject, input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    const pull = await this.mutate<GitHubPullRequestResponse>(project, 'createPR', 'pulls', 'POST', {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: input.draft,
    });
    return this.mapPullRequest(pull);
  }

  async mergePullRequest(
    project: GitHubProject,
    pullNumber: number,
    input: MergePullRequestInput = {},
  ): Promise<GitHubMergeResult> {
    return this.mutate<GitHubMergeResult>(project, 'merge', `pulls/${pullNumber}/merge`, 'PUT', {
      merge_method: input.method,
      commit_title: input.title,
      commit_message: input.message,
      sha: input.expectedHeadSha,
    });
  }

  private repoPath(repo: string): string {
    return `repos/${normalizeGitHubRepo(repo)}`;
  }

  private repoOf(repoOrProject: string | GitHubProject): string {
    if (typeof repoOrProject === 'string') return repoOrProject;
    if (!repoOrProject.github_repo) {
      throw new GitHubClientError('Project has no GitHub repository', 'invalid_repository', { retryable: false });
    }
    return repoOrProject.github_repo;
  }

  private mapIssue(issue: GitHubIssueResponse): GitHubIssue {
    return {
      ...issue,
      url: issue.html_url,
      labels: issue.labels.map((label) => typeof label === 'string' ? label : label.name),
    };
  }

  private mapComment(comment: GitHubCommentResponse): GitHubComment {
    return {
      ...comment,
      url: comment.html_url,
      authorLogin: comment.user.login,
      authorType: comment.user.type,
    };
  }

  private mapPullRequest(pull: GitHubPullRequestResponse): GitHubPullRequest {
    const linkedIssue = pull.body?.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i)?.[1];
    return {
      ...pull,
      url: pull.html_url,
      mergeable: pull.mergeable === true ? 'mergeable' : pull.mergeable === false ? 'conflicting' : 'unknown',
      headSha: pull.head.sha,
      linkedIssueNumber: linkedIssue ? Number(linkedIssue) : null,
      checks: [],
      statuses: [],
      reviews: [],
      reviewComments: [],
      comments: [],
    };
  }

  private repoEndpoint(project: GitHubProject, suffix: string): string {
    if (!project.github_repo) {
      throw new GitHubClientError('Project has no GitHub repository', 'invalid_repository', { retryable: false });
    }
    return `${this.repoPath(project.github_repo)}/${suffix}`;
  }

  private async read<T>(endpoint: string): Promise<T> {
    return this.deduplicate(`GET ${endpoint}`, () => this.request<T>(endpoint, 'GET'));
  }

  private async readPages<T>(endpoint: string): Promise<T[]> {
    return this.deduplicate(`GET pages ${endpoint}`, async () => {
      const pages = await this.request<T[][]>(endpoint, 'GET', undefined, true);
      return pages.flat();
    });
  }

  private async readGraphqlPages<T>(query: string, variables: Record<string, string | number>): Promise<T[]> {
    const key = `GraphQL ${query} ${JSON.stringify(variables)}`;
    return this.deduplicate(key, async () => {
      const endpoint = 'graphql';
      const args = ['api', 'graphql', '--paginate', '--slurp', '--raw-field', `query=${query}`];
      for (const [name, value] of Object.entries(variables)) {
        args.push(typeof value === 'number' ? '--field' : '--raw-field', `${name}=${value}`);
      }

      return this.execute<T[]>(endpoint, args, this.maxAttempts);
    });
  }

  private deduplicate<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.inFlightReads.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const pending = operation().finally(() => this.inFlightReads.delete(key));
    this.inFlightReads.set(key, pending);
    return pending;
  }

  private async mutate<T>(
    project: GitHubProject,
    action: GitHubAction,
    suffix: string,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body?: Record<string, unknown>,
  ): Promise<T> {
    const freshProject = this.loadProject(project.id);
    assertCapability(freshProject ?? { ...project, github_automation_enabled: 0 }, action);
    return this.request<T>(this.repoEndpoint(freshProject!, suffix), method, body);
  }

  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body?: Record<string, unknown>,
    paginate = false,
  ): Promise<T> {
    const args = ['api', '--method', method, endpoint, '--header', 'Accept: application/vnd.github+json'];
    if (paginate) args.push('--paginate', '--slurp');
    if (body) {
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            const serialized = typeof item === 'object' ? JSON.stringify(item) : String(item);
            args.push('--raw-field', `${key}[]=${serialized}`);
          }
        } else if (typeof value === 'string') {
          args.push('--raw-field', `${key}=${value}`);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          args.push('--field', `${key}=${String(value)}`);
        } else {
          args.push('--raw-field', `${key}=${JSON.stringify(value)}`);
        }
      }
    }

    return this.execute<T>(endpoint, args, method === 'GET' ? this.maxAttempts : 1);
  }

  private async execute<T>(endpoint: string, args: string[], attempts: number): Promise<T> {
    this.assertCircuitOpen(endpoint);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await this.runner('gh', args);
        return this.parseJson<T>(result.stdout, endpoint);
      } catch (cause) {
        if (cause instanceof GitHubClientError) throw cause;
        const error = this.classifyFailure(cause, endpoint, attempt);
        if (error.kind === 'rate_limited') {
          this.rateLimitedUntil = error.details.rateLimitResetAt ?? (this.now() + this.rateLimitFallbackMs);
          throw error;
        }
        if (!error.details.retryable || attempt === attempts) throw error;
        await this.sleep(this.baseBackoffMs * (2 ** (attempt - 1)));
      }
    }
    throw new Error('Unreachable GitHub retry state');
  }

  private parseJson<T>(stdout: string, endpoint: string): T {
    try {
      return JSON.parse(stdout) as T;
    } catch (cause) {
      throw new GitHubClientError(`GitHub returned invalid JSON for ${endpoint}`, 'invalid_json', {
        endpoint,
        retryable: false,
        cause,
      });
    }
  }

  private assertCircuitOpen(endpoint: string): void {
    if (this.rateLimitedUntil > this.now()) {
      throw new GitHubClientError('GitHub requests are paused by the rate-limit circuit breaker', 'rate_limited', {
        endpoint,
        retryable: false,
        rateLimitResetAt: this.rateLimitedUntil,
      });
    }
  }

  private classifyFailure(cause: unknown, endpoint: string, attempt: number): GitHubClientError {
    const failure = cause as CommandFailure;
    const stderr = typeof failure?.stderr === 'string' ? failure.stderr : '';
    const statusMatch = stderr.match(/(?:HTTP|status(?: code)?)\s*[: ]\s*(\d{3})/i)
      ?? stderr.match(/\b(4\d\d|5\d\d)\b/);
    const status = statusMatch?.[1] ? Number(statusMatch[1]) : undefined;
    const rateLimited = status === 429 || (status === 403 && /rate.?limit|abuse detection/i.test(stderr));
    const resetAt = this.parseRateLimitReset(stderr);
    const transient = status === 408 || status === 409 || status === 425 || status === 502
      || status === 503 || status === 504 || status === 500
      || /ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|network error/i.test(`${failure?.message ?? ''} ${stderr}`);
    const details = {
      endpoint,
      ...(status === undefined ? {} : { status }),
      retryable: transient && !rateLimited,
      attempt,
      ...(resetAt === undefined ? {} : { rateLimitResetAt: resetAt }),
      ...(stderr ? { stderr: stderr.slice(0, 2_000) } : {}),
      cause,
    };
    if (rateLimited) {
      return new GitHubClientError(`GitHub rate limit reached for ${endpoint}`, 'rate_limited', {
        ...details,
        retryable: false,
      });
    }
    return new GitHubClientError(
      `GitHub request failed for ${endpoint}`,
      transient ? 'transient' : 'command_failed',
      details,
    );
  }

  private parseRateLimitReset(stderr: string): number | undefined {
    const epoch = stderr.match(/x-ratelimit-reset:\s*(\d+)/i)?.[1];
    if (epoch) return Number(epoch) * 1_000;
    const retryAfter = stderr.match(/retry-after:\s*(\d+)/i)?.[1];
    if (retryAfter) return this.now() + (Number(retryAfter) * 1_000);
    return undefined;
  }
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $pullNumber: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pullNumber) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes {
          isResolved
          comments(first: 100) { nodes { databaseId } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

export const githubClient = new GitHubClient();
