import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand, type RunCommandOptions, type RunCommandResult } from '../shell.js';
import {
  getGitHubAuthMode,
  getRepositoryAuth,
  type GitHubRepositoryAuth,
} from './appAuth.js';
import type { GitHubAction } from './capabilities.js';

export interface GitHubExecutionContext {
  projectId?: number;
  auth?: GitHubRepositoryAuth;
}

interface GitAuthDependencies {
  getMode?: typeof getGitHubAuthMode;
  getAuth?: typeof getRepositoryAuth;
  run?: typeof runCommand;
  makeTemporaryDirectory?: (prefix: string) => Promise<string>;
  removeTemporaryDirectory?: (directory: string) => Promise<void>;
}

export interface GitHubRemoteExecutor {
  resolveAuth(
    repoPath: string,
    context: GitHubExecutionContext | undefined,
    action: GitHubAction,
  ): Promise<GitHubRepositoryAuth | null>;
  runGit(
    repoPath: string,
    args: readonly string[],
    context: GitHubExecutionContext | undefined,
    action: GitHubAction,
  ): Promise<RunCommandResult>;
  runGh(
    repoPath: string,
    args: readonly string[],
    context: GitHubExecutionContext | undefined,
    action: GitHubAction,
  ): Promise<RunCommandResult>;
}

function parseGitHubRemote(remote: string): string {
  const value = remote.trim();
  const scpMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(value);
  if (scpMatch) return `${scpMatch[1]}/${scpMatch[2]}`;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('origin must be an HTTPS or SSH github.com repository URL');
  }
  if (url.hostname.toLowerCase() !== 'github.com' || url.port !== '') {
    throw new Error(`Unsupported Git remote host: ${url.host || 'unknown'}`);
  }
  if (url.password || (url.protocol === 'https:' && url.username)) {
    throw new Error('Git origin must not contain embedded credentials');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
    throw new Error('origin must use HTTPS or SSH');
  }
  if (url.protocol === 'ssh:' && url.username !== 'git') {
    throw new Error('GitHub SSH origin must use the git user');
  }
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!match) throw new Error('origin must identify one GitHub owner/repository');
  return `${match[1]}/${match[2]}`;
}

export function validateGitHubOrigin(remote: string, trustedRepository: string): string {
  const repository = parseGitHubRemote(remote);
  if (repository.toLowerCase() !== trustedRepository.toLowerCase()) {
    throw new Error(
      `Git origin ${JSON.stringify(repository)} does not match trusted repository ${JSON.stringify(trustedRepository)}`,
    );
  }
  return repository;
}

export function createGitHubRemoteExecutor(
  dependencies: GitAuthDependencies = {},
): GitHubRemoteExecutor {
  const getMode = dependencies.getMode ?? getGitHubAuthMode;
  const getAuth = dependencies.getAuth ?? getRepositoryAuth;
  const run = dependencies.run ?? runCommand;
  const makeTemporaryDirectory = dependencies.makeTemporaryDirectory
    ?? ((prefix: string) => fs.promises.mkdtemp(prefix));
  const removeTemporaryDirectory = dependencies.removeTemporaryDirectory
    ?? ((directory: string) => fs.promises.rm(directory, { recursive: true, force: true }));

  const resolveAuth = async (
    repoPath: string,
    context: GitHubExecutionContext | undefined,
    action: GitHubAction,
  ): Promise<GitHubRepositoryAuth | null> => {
    if (getMode() === 'host') return null;
    const auth = context?.auth
      ?? (context?.projectId === undefined ? null : await getAuth(context.projectId, action));
    if (!auth) throw new Error('App-mode remote GitHub execution requires a projectId or resolved auth');
    const { stdout } = await run('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      env: {
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    validateGitHubOrigin(stdout, auth.repository);
    return auth;
  };

  const authenticatedRun = async (
    command: 'git' | 'gh',
    repoPath: string,
    args: readonly string[],
    context: GitHubExecutionContext | undefined,
    action: GitHubAction,
  ): Promise<RunCommandResult> => {
    const auth = await resolveAuth(repoPath, context, action);
    if (!auth) return run(command, args, { cwd: repoPath });

    const configDirectory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'bottega-gh-'));
    const env: NodeJS.ProcessEnv = {
      GH_TOKEN: auth.token,
      GH_HOST: 'github.com',
      GH_CONFIG_DIR: configDirectory,
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    const options: RunCommandOptions = { cwd: repoPath, env };
    try {
      if (command === 'gh') return await run(command, args, options);
      return await run(command, [
        '-c', 'credential.helper=',
        '-c', 'credential.helper=!gh auth git-credential',
        '-c', 'credential.https://github.com.username=x-access-token',
        '-c', 'url.https://github.com/.insteadOf=git@github.com:',
        '-c', 'url.https://github.com/.insteadOf=ssh://git@github.com/',
        ...args,
      ], options);
    } finally {
      await removeTemporaryDirectory(configDirectory);
    }
  };

  return {
    resolveAuth,
    runGit: (repoPath, args, context, action) => authenticatedRun('git', repoPath, args, context, action),
    runGh: (repoPath, args, context, action) => authenticatedRun('gh', repoPath, args, context, action),
  };
}

const executor = createGitHubRemoteExecutor();

export const resolveTrustedGitHubAuth = executor.resolveAuth;
export const runRemoteGit = executor.runGit;
export const runGitHubCli = executor.runGh;
