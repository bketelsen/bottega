import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand, type RunCommandOptions, type RunCommandResult } from '../shell.js';
import { projectsDb } from '../../database/db.js';
import { normalizeGitHubRepository } from '../../../shared/schemas/github.js';
import {
  assertCapability,
  type GitHubAction,
  type GitHubProject,
} from './capabilities.js';
import {
  getGitHubAppMetadata,
  getGitHubAuthMode,
  getRepositoryAuth,
  type GitHubAppMetadata,
  type GitHubAuthMode,
  type GitHubRepositoryAuth,
} from './appAuth.js';

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
  merged: boolean;
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

export interface GitHubClientOptions {
  runner?: CommandRunner;
  maxAttempts?: number;
  baseBackoffMs?: number;
  rateLimitFallbackMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  loadProject?: (projectId: number) => GitHubProject | undefined;
  authMode?: () => GitHubAuthMode;
  resolveRepositoryAuth?: (projectId: number, action: GitHubAction) => Promise<GitHubRepositoryAuth>;
  loadAppIdentity?: () => Promise<GitHubAppMetadata>;
  ghConfigDir?: string;
}

interface GitHubCommandContext {
  key: string;
  options?: RunCommandOptions;
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
  private readonly authMode: () => GitHubAuthMode;
  private readonly resolveRepositoryAuth: (projectId: number, action: GitHubAction) => Promise<GitHubRepositoryAuth>;
  private readonly loadAppIdentity: () => Promise<GitHubAppMetadata>;
  private readonly configuredGhConfigDir: string | undefined;
  private ghConfigDir: string | undefined;
  private readonly inFlightReads = new Map<string, Promise<unknown>>();
  private readonly rateLimitedUntil = new Map<string, number>();

  constructor(options: GitHubClientOptions = {}) {
    this.runner = options.runner ?? runCommand;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 250;
    this.rateLimitFallbackMs = options.rateLimitFallbackMs ?? 60_000;
    this.sleep = options.sleep ?? sleep;
    this.now = options.now ?? Date.now;
    this.loadProject = options.loadProject ?? ((projectId) => projectsDb.getByIdAdmin(projectId));
    this.authMode = options.authMode ?? getGitHubAuthMode;
    this.resolveRepositoryAuth = options.resolveRepositoryAuth ?? getRepositoryAuth;
    this.loadAppIdentity = options.loadAppIdentity ?? getGitHubAppMetadata;
    this.configuredGhConfigDir = options.ghConfigDir;
  }

  async getSelf(): Promise<GitHubUser> {
    if (this.authMode() === 'app') {
      throw new GitHubClientError('GitHub App authentication has no current user', 'command_failed', {
        endpoint: 'user',
        retryable: false,
      });
    }
    return this.read<GitHubUser>(null, 'user');
  }

  async getAppIdentity(): Promise<GitHubUser> {
    const identity = await this.loadAppIdentity();
    return { login: identity.botLogin, id: 0, type: 'Bot' };
  }

  getAuthMode(): GitHubAuthMode {
    return this.authMode();
  }

  async getIssue(project: GitHubProject, number: number): Promise<GitHubIssue> {
    const issue = await this.read<GitHubIssueResponse>(project, `${this.repoPath(this.repoOf(project))}/issues/${number}`);
    return this.mapIssue(issue);
  }

  private async listIssueComments(project: GitHubProject, number: number): Promise<GitHubComment[]> {
    const comments = await this.readPages<GitHubCommentResponse>(project, `${this.repoPath(this.repoOf(project))}/issues/${number}/comments`);
    return comments.map((comment) => this.mapComment(comment));
  }

  async getIssueComments(project: GitHubProject, number: number): Promise<GitHubComment[]> {
    return this.listIssueComments(project, number);
  }

  private async listIssueLabels(project: GitHubProject, number: number): Promise<GitHubLabel[]> {
    return this.readPages<GitHubLabel>(project, `${this.repoPath(this.repoOf(project))}/issues/${number}/labels`);
  }

  private async listIssuesByLabel(
    project: GitHubProject,
    label: string,
    state: 'open' | 'closed' | 'all' = 'open',
    limit?: number,
  ): Promise<GitHubIssue[]> {
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) return [];
    const perPage = limit === undefined ? 100 : Math.min(100, Math.floor(limit));
    const query = new URLSearchParams({ labels: label, state, per_page: String(perPage) });
    const endpoint = `${this.repoPath(this.repoOf(project))}/issues?${query.toString()}`;
    const issues = limit === undefined
      ? await this.readPages<GitHubIssueResponse>(project, endpoint)
      : await this.read<GitHubIssueResponse[]>(project, endpoint);
    return issues.filter((issue) => !issue.pull_request).map((issue) => this.mapIssue(issue));
  }

  async listOpenIssues(project: GitHubProject, labels: string[], limit = 100): Promise<GitHubIssue[]> {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const boundedLimit = Math.min(100, Math.floor(limit));
    const groups = labels.length > 0
      ? await Promise.all(labels.map((label) => this.listIssuesByLabel(project, label, 'open', boundedLimit)))
      : [await this.listIssuesByLabel(project, '', 'open', boundedLimit)];
    return [...new Map(groups.flat().map((issue) => [issue.number, issue])).values()].slice(0, boundedLimit);
  }

  async listOpenPullRequests(project: GitHubProject, limit = 20): Promise<GitHubPullRequest[]> {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const boundedLimit = Math.min(100, Math.floor(limit));
    const query = new URLSearchParams({ state: 'open', per_page: String(boundedLimit) });
    const pulls = await this.read<GitHubPullRequestResponse[]>(project,
      `${this.repoPath(this.repoOf(project))}/pulls?${query.toString()}`,
    );
    return pulls.map((pull) => this.mapPullRequest(pull));
  }

  async getPullRequest(project: GitHubProject, number: number): Promise<GitHubPullRequest> {
    const repo = this.repoOf(project);
    const path = `${this.repoPath(repo)}/pulls/${number}`;
    const pull = await this.read<GitHubPullRequestResponse>(project, path);
    if (pull.state !== 'open') return this.mapPullRequest(pull);
    const [checks, evidence, comments] = await Promise.all([
      this.getChecks(project, pull.head.sha),
      this.getReviewEvidence(project, number),
      this.listIssueComments(project, number),
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
    const pulls = await this.read<GitHubPullRequestResponse[]>(project, `${this.repoPath(repo)}/pulls?state=open&per_page=100`);
    const prefix = `task/${taskId}-`;
    const pull = pulls.find((candidate) => candidate.head.ref === `task/${taskId}` || candidate.head.ref.startsWith(prefix));
    return pull ? this.mapPullRequest(pull) : null;
  }

  private async getChecks(project: GitHubProject, ref: string): Promise<GitHubChecks> {
    const path = this.repoPath(this.repoOf(project));
    const encodedRef = encodeURIComponent(ref);
    const [runs, status] = await Promise.all([
      this.read<{ check_runs: GitHubCheckRun[] }>(project, `${path}/commits/${encodedRef}/check-runs?per_page=100`),
      this.read<{ sha: string; statuses: GitHubCommitStatus[] }>(project, `${path}/commits/${encodedRef}/status?per_page=100`),
    ]);
    return { sha: status.sha, checkRuns: runs.check_runs, statuses: status.statuses };
  }

  async getReviewEvidence(project: GitHubProject, pullNumber: number): Promise<GitHubReviewEvidence> {
    const repo = this.repoOf(project);
    const path = `${this.repoPath(repo)}/pulls/${pullNumber}`;
    const [owner, name] = normalizeGitHubRepo(repo).split('/') as [string, string];
    const [reviews, comments, threadPages] = await Promise.all([
      this.readPages<GitHubReview>(project, `${path}/reviews`),
      this.readPages<GitHubReviewCommentResponse>(project, `${path}/comments`),
      this.readGraphqlPages<GitHubReviewThreadsResponse>(project, REVIEW_THREADS_QUERY, {
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
    const current = await this.listIssueLabels(project, issueNumber);
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

  private repoOf(project: GitHubProject): string {
    if (!project.github_repo) {
      throw new GitHubClientError('Project has no GitHub repository', 'invalid_repository', { retryable: false });
    }
    return project.github_repo;
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
      merged: pull.merged === true,
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

  private async read<T>(project: GitHubProject | null, endpoint: string): Promise<T> {
    if (this.authMode() === 'host') {
      const context = { key: 'host' };
      return this.deduplicate(`host GET ${endpoint}`, () => (
        this.request<T>(project, endpoint, 'GET', undefined, false, context)
      ));
    }
    const context = await this.commandContext(project, 'read');
    return this.deduplicate(`${context.key} GET ${endpoint}`, () => (
      this.request<T>(project, endpoint, 'GET', undefined, false, context)
    ));
  }

  private async readPages<T>(project: GitHubProject, endpoint: string): Promise<T[]> {
    const context = await this.commandContext(project, 'read');
    return this.deduplicate(`${context.key} GET pages ${endpoint}`, async () => {
      const pages = await this.request<T[][]>(project, endpoint, 'GET', undefined, true, context);
      return pages.flat();
    });
  }

  private async readGraphqlPages<T>(
    project: GitHubProject,
    query: string,
    variables: Record<string, string | number>,
  ): Promise<T[]> {
    const context = await this.commandContext(project, 'read');
    const key = `${context.key} GraphQL ${query} ${JSON.stringify(variables)}`;
    return this.deduplicate(key, async () => {
      const endpoint = 'graphql';
      const args = ['api', 'graphql', '--paginate', '--slurp', '--raw-field', `query=${query}`];
      for (const [name, value] of Object.entries(variables)) {
        args.push(typeof value === 'number' ? '--field' : '--raw-field', `${name}=${value}`);
      }

      return this.execute<T[]>(endpoint, args, this.maxAttempts, context);
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
    const context = await this.commandContext(freshProject!, action);
    return this.request<T>(freshProject!, this.repoEndpoint(freshProject!, suffix), method, body, false, context);
  }

  private async request<T>(
    project: GitHubProject | null,
    endpoint: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body?: Record<string, unknown>,
    paginate = false,
    existingContext?: GitHubCommandContext,
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

    const context = existingContext ?? await this.commandContext(project, 'read');
    return this.execute<T>(endpoint, args, method === 'GET' ? this.maxAttempts : 1, context);
  }

  private async execute<T>(
    endpoint: string,
    args: string[],
    attempts: number,
    context: GitHubCommandContext,
  ): Promise<T> {
    this.assertCircuitOpen(endpoint, context.key);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = context.options
          ? await this.runner('gh', args, context.options)
          : await this.runner('gh', args);
        return this.parseJson<T>(result.stdout, endpoint);
      } catch (cause) {
        if (cause instanceof GitHubClientError) throw cause;
        const error = this.classifyFailure(cause, endpoint, attempt);
        if (error.kind === 'rate_limited') {
          this.rateLimitedUntil.set(
            context.key,
            error.details.rateLimitResetAt ?? (this.now() + this.rateLimitFallbackMs),
          );
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

  private assertCircuitOpen(endpoint: string, contextKey: string): void {
    const rateLimitedUntil = this.rateLimitedUntil.get(contextKey) ?? 0;
    if (rateLimitedUntil > this.now()) {
      throw new GitHubClientError('GitHub requests are paused by the rate-limit circuit breaker', 'rate_limited', {
        endpoint,
        retryable: false,
        rateLimitResetAt: rateLimitedUntil,
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

  private async commandContext(
    project: GitHubProject | null,
    action: GitHubAction,
  ): Promise<GitHubCommandContext> {
    if (this.authMode() === 'host') return { key: 'host' };
    if (!project) {
      throw new GitHubClientError('GitHub App requests require project repository context', 'invalid_repository', {
        retryable: false,
      });
    }
    const auth = await this.resolveRepositoryAuth(project.id, action);
    return {
      key: `app:${auth.installationId}:${auth.repositoryId}`,
      options: {
        env: {
          GH_TOKEN: auth.token,
          GH_CONFIG_DIR: this.isolatedGhConfigDir(),
        },
      },
    };
  }

  private isolatedGhConfigDir(): string {
    if (this.configuredGhConfigDir) return this.configuredGhConfigDir;
    this.ghConfigDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-gh-'));
    return this.ghConfigDir;
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
