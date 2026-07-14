import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runCommand } from '../shell.js';
import type { GitHubRepositoryAuth } from './appAuth.js';
import { createGitHubRemoteExecutor, validateGitHubOrigin } from './gitAuth.js';

const auth: GitHubRepositoryAuth = {
  token: 'installation-secret',
  expiresAt: Date.now() + 60_000,
  installationId: 2,
  repositoryId: 3,
  repository: 'Owner/Repo',
  botLogin: 'bottega[bot]',
  botUserId: 4,
  botEmail: '4+bottega[bot]@users.noreply.github.com',
};

describe('GitHub remote execution', () => {
  const run = vi.fn();
  const getAuth = vi.fn();
  const removeTemporaryDirectory = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    run.mockResolvedValue({ stdout: '', stderr: '' });
    getAuth.mockResolvedValue(auth);
    removeTemporaryDirectory.mockResolvedValue(undefined);
  });

  it('preserves host-mode command compatibility without inspecting origin', async () => {
    const executor = createGitHubRemoteExecutor({ getMode: () => 'host', run });

    await executor.runGit('/repo', ['fetch', 'origin'], undefined, 'push');
    await executor.runGh('/repo', ['pr', 'view'], undefined, 'createPR');

    expect(run.mock.calls).toEqual([
      ['git', ['fetch', 'origin'], { cwd: '/repo' }],
      ['gh', ['pr', 'view'], { cwd: '/repo' }],
    ]);
  });

  it('uses project-scoped auth and invocation-only Git configuration', async () => {
    run.mockImplementation(async (_command: string, args: readonly string[]) => ({
      stdout: args[0] === 'remote' ? 'git@github.com:owner/repo.git\n' : '',
      stderr: '',
    }));
    const executor = createGitHubRemoteExecutor({
      getMode: () => 'app',
      getAuth,
      run,
      makeTemporaryDirectory: async () => '/tmp/private-gh',
      removeTemporaryDirectory,
    });

    await executor.runGit('/repo', ['push', 'origin', 'task/1'], { projectId: 7 }, 'push');

    expect(getAuth).toHaveBeenCalledWith(7, 'push');
    const originLookup = run.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(originLookup[2]).toEqual({
      cwd: '/repo',
      env: {
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    const invocation = run.mock.calls[1] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(invocation[0]).toBe('git');
    expect(invocation[1]).toEqual([
      '-c', 'credential.helper=',
      '-c', 'credential.helper=!gh auth git-credential',
      '-c', 'credential.https://github.com.username=x-access-token',
      '-c', 'url.https://github.com/.insteadOf=git@github.com:',
      '-c', 'url.https://github.com/.insteadOf=ssh://git@github.com/',
      'push', 'origin', 'task/1',
    ]);
    expect(invocation[1].join(' ')).not.toContain(auth.token);
    expect(invocation[2].env).toMatchObject({
      GH_TOKEN: auth.token,
      GH_CONFIG_DIR: '/tmp/private-gh',
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null',
    });
    expect(removeTemporaryDirectory).toHaveBeenCalledWith('/tmp/private-gh');
    const resetIndex = invocation[1].indexOf('credential.helper=');
    const intendedHelperIndex = invocation[1].indexOf('credential.helper=!gh auth git-credential');
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(intendedHelperIndex).toBeGreaterThan(resetIndex);
  });

  it('rewrites an SSH URL only after validating it against the trusted repository', async () => {
    run.mockImplementation(async (_command: string, args: readonly string[]) => ({
      stdout: args[0] === 'remote' ? 'ssh://git@github.com/Owner/Repo.git\n' : '',
      stderr: '',
    }));
    const executor = createGitHubRemoteExecutor({
      getMode: () => 'app',
      run,
      makeTemporaryDirectory: async () => '/tmp/private-gh',
      removeTemporaryDirectory,
    });

    await executor.runGit('/repo', ['fetch', 'origin'], { auth }, 'read');

    expect(run.mock.calls[1]![1]).toEqual(expect.arrayContaining([
      'url.https://github.com/.insteadOf=ssh://git@github.com/',
      'fetch', 'origin',
    ]));
  });

  it('runs gh with the explicit token and isolated config but no token argv', async () => {
    run.mockImplementation(async (_command: string, args: readonly string[]) => ({
      stdout: args[0] === 'remote' ? 'https://github.com/Owner/Repo.git\n' : '',
      stderr: '',
    }));
    const executor = createGitHubRemoteExecutor({
      getMode: () => 'app',
      run,
      makeTemporaryDirectory: async () => '/tmp/private-gh',
      removeTemporaryDirectory,
    });

    await executor.runGh('/repo', ['pr', 'checks'], { auth }, 'createPR');

    const invocation = run.mock.calls[1] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(invocation[0]).toBe('gh');
    expect(invocation[1]).toEqual(['pr', 'checks']);
    expect(JSON.stringify(invocation[1])).not.toContain(auth.token);
    expect(invocation[2].env.GH_TOKEN).toBe(auth.token);
  });

  it('requires project context or already-resolved auth in app mode', async () => {
    const executor = createGitHubRemoteExecutor({ getMode: () => 'app', run });

    await expect(executor.runGit('/repo', ['fetch'], undefined, 'push'))
      .rejects.toThrow(/projectId or resolved auth/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('GitHub origin validation', () => {
  it.each([
    'https://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
  ])('accepts trusted HTTPS and SSH origin %s', (remote) => {
    expect(validateGitHubOrigin(remote, 'Owner/Repo')).toBe('owner/repo');
  });

  it.each([
    'https://token@github.com/owner/repo.git',
    'https://token:secret@github.com/owner/repo.git',
    'https://gitlab.com/owner/repo.git',
    'ssh://git@example.com/owner/repo.git',
    'file:///tmp/repo',
  ])('rejects credentialed or unsupported origin %s', (remote) => {
    expect(() => validateGitHubOrigin(remote, 'owner/repo')).toThrow();
  });

  it('rejects a different GitHub repository', () => {
    expect(() => validateGitHubOrigin('https://github.com/owner/other', 'owner/repo'))
      .toThrow(/does not match trusted repository/);
  });
});

describe('trusted Git credential configuration', () => {
  it('clears a hostile local helper before installing the intended helper', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-git-auth-'));
    const hostileMarker = path.join(directory, 'hostile-ran');
    try {
      await runCommand('git', ['init'], { cwd: directory });
      await runCommand('git', [
        'config', '--local', 'credential.helper', `!touch ${hostileMarker}; exit 1`,
      ], { cwd: directory });

      const stdout = execFileSync('git', [
        '-c', 'credential.helper=',
        '-c', 'credential.helper=!f() { echo username=x-access-token; echo password=secret; }; f',
        '-c', 'credential.https://github.com.username=x-access-token',
        'credential', 'fill',
      ], {
        cwd: directory,
        env: { ...process.env, GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' },
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
      }).toString();

      expect(fs.existsSync(hostileMarker)).toBe(false);
      expect(stdout).toContain('username=x-access-token');
      expect(stdout).toContain('password=secret');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
