import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildCopilotSdkEnv,
  clearCopilotAuth,
  getCopilotAuthStatus,
  readCopilotToken,
  resolveCopilotAuthJsonPath,
  writeCopilotAuth,
  CopilotCredentialsError,
} from './copilotCredentials.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cred-'));
  process.env['COPILOT_CONFIG_ROOT'] = tmpRoot;
});

afterEach(() => {
  delete process.env['COPILOT_CONFIG_ROOT'];
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

  it('buildCopilotSdkEnv tags BOTTEGA_USER_ID and strips inherited GitHub tokens', () => {
    process.env['GITHUB_TOKEN'] = 'leak-me';
    process.env['GH_TOKEN'] = 'leak-me-too';
    const env = buildCopilotSdkEnv(11);
    expect(env.BOTTEGA_USER_ID).toBe('11');
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['GH_TOKEN']).toBeUndefined();
    delete process.env['GITHUB_TOKEN'];
    delete process.env['GH_TOKEN'];
  });
});
