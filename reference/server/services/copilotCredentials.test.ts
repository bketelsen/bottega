import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildCopilotSdkEnv,
  buildCopilotRuntimeEnv,
  clearCopilotAuth,
  getCopilotAuthStatus,
  readCopilotToken,
  resolveCopilotAuthJsonPath,
  writeCopilotAuth,
  CopilotCredentialsError,
} from './copilotCredentials.js';

let tmpRoot: string;
const ISOLATED_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'SSH_AUTH_SOCK',
  'GH_CONFIG_DIR',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cred-'));
  process.env['COPILOT_CONFIG_ROOT'] = tmpRoot;
  for (const key of ISOLATED_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  delete process.env['COPILOT_CONFIG_ROOT'];
  for (const key of ISOLATED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('copilotCredentials', () => {
  it('write → read round-trips the GitHub token and login', () => {
    writeCopilotAuth(7, { gitHubToken: 'ghs_abcdef123456', login: 'octocat' });
    const { token, login } = readCopilotToken(7);
    expect(token).toBe('ghs_abcdef123456');
    expect(login).toBe('octocat');
  });

  it('persists auth.json with mode 0600', () => {
    writeCopilotAuth(3, { gitHubToken: 'tok' });
    const stat = fs.statSync(resolveCopilotAuthJsonPath(3));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('getCopilotAuthStatus reports authenticated with a fingerprint', async () => {
    writeCopilotAuth(1, { gitHubToken: 'token-XYZ789', login: 'me' });
    const status = await getCopilotAuthStatus(1);
    expect(status.authenticated).toBe(true);
    expect(status.tokenFingerprint).toBe('XYZ789');
    expect(status.login).toBe('me');
  });

  it('getCopilotAuthStatus reports missing before provisioning', async () => {
    const status = await getCopilotAuthStatus(99);
    expect(status.authenticated).toBe(false);
    expect(status.status).toBe('missing');
  });

  it('clearCopilotAuth removes the file and returns true, then false', () => {
    writeCopilotAuth(5, { gitHubToken: 'tok' });
    expect(clearCopilotAuth(5)).toBe(true);
    expect(clearCopilotAuth(5)).toBe(false);
  });

  it('readCopilotToken throws when unprovisioned', () => {
    expect(() => readCopilotToken(42)).toThrow(CopilotCredentialsError);
  });

  it('writeCopilotAuth rejects an empty token', () => {
    expect(() => writeCopilotAuth(1, { gitHubToken: '' })).toThrow(CopilotCredentialsError);
  });

  it('buildCopilotSdkEnv tags BOTTEGA_USER_ID and isolates inherited GitHub credentials', () => {
    for (const key of ISOLATED_ENV_KEYS) process.env[key] = `host-${key}`;
    const env = buildCopilotSdkEnv(11);
    expect(env.BOTTEGA_USER_ID).toBe('11');
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GH_ENTERPRISE_TOKEN']).toBeUndefined();
    expect(env['GITHUB_ENTERPRISE_TOKEN']).toBeUndefined();
    expect(env['SSH_AUTH_SOCK']).toBeUndefined();
    expect(env['GH_CONFIG_DIR']).toBe(path.join(tmpRoot, '11', 'copilot', 'gh'));
    expect(fs.readdirSync(env['GH_CONFIG_DIR']!)).toEqual([]);
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(env['GIT_CONFIG_SYSTEM']).toBe('/dev/null');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['GIT_SSH_COMMAND']).toBe('ssh -F /dev/null -o IdentityFile=none -o IdentitiesOnly=yes -o BatchMode=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o StrictHostKeyChecking=yes');
  });

  it('buildCopilotRuntimeEnv does not set or replace model authentication', () => {
    const env = buildCopilotRuntimeEnv(11);
    expect(env['COPILOT_SDK_AUTH_TOKEN']).toBeUndefined();
    expect(env['COPILOT_GITHUB_TOKEN']).toBeUndefined();
    expect(env['BOTTEGA_USER_ID']).toBeUndefined();
  });
});
