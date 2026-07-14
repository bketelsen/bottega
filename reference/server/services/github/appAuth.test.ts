import { generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectRow } from '../../../shared/types/db.js';
import {
  createGitHubAppAuthService,
  GitHubAppError,
} from './appAuth.js';

const NOW = Date.parse('2026-07-13T12:00:00Z');

function project(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: 7,
    user_id: 2,
    name: 'Bottega',
    repo_folder_path: '/tmp/bottega',
    subproject_path: null,
    active_worktree_task_id: null,
    serve_symlink_path: null,
    systemd_service_name: null,
    app_url: null,
    github_repo: 'owner/repo',
    github_repository_id: 100,
    github_installation_id: 10,
    github_automation_enabled: 1,
    autonomy_tier: 'pr',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Expected a string request body');
  return init.body;
}

describe('GitHub App auth broker', () => {
  let directory: string;
  let keyPath: string;
  let publicKey: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-app-auth-'));
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    keyPath = path.join(directory, 'app.pem');
    fs.writeFileSync(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.chmodSync(keyPath, 0o600);
    publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      GITHUB_AUTH_MODE: 'app',
      GITHUB_APP_CLIENT_ID: 'Iv1.client-id',
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
      ...overrides,
    };
  }

  it('signs RS256 JWTs with a string client ID and the required timestamps', () => {
    const service = createGitHubAppAuthService({ env: env(), now: () => NOW });
    const jwt = service.createAppJwt();
    const [headerPart, payloadPart, signaturePart] = jwt.split('.') as [string, string, string];
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString()) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString()) as Record<string, unknown>;

    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload).toEqual({
      iss: 'Iv1.client-id',
      iat: Math.floor(NOW / 1000) - 30,
      exp: Math.floor(NOW / 1000) + 600,
    });
    expect(verify(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      publicKey,
      Buffer.from(signaturePart, 'base64url'),
    )).toBe(true);
  });

  it('uses a numeric App ID fallback without converting client IDs', () => {
    const service = createGitHubAppAuthService({
      env: env({ GITHUB_APP_CLIENT_ID: '', GITHUB_APP_ID: '12345' }),
      now: () => NOW,
    });
    const payload = JSON.parse(
      Buffer.from(service.createAppJwt().split('.')[1]!, 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(payload.iss).toBe(12345);
  });

  it('keeps host mode inert and rejects partial or unsafe production configuration', async () => {
    const host = createGitHubAppAuthService({ env: {} });
    await expect(host.getHealth()).resolves.toMatchObject({ mode: 'host', status: 'disabled' });
    expect(() => host.createAppJwt()).toThrowError(expect.objectContaining({
      code: 'GITHUB_APP_NOT_CONFIGURED',
    }));
    expect(() => createGitHubAppAuthService({
      env: { GITHUB_AUTH_MODE: 'app', GITHUB_APP_CLIENT_ID: 'Iv1.partial' },
    })).toThrowError(expect.objectContaining({ code: 'GITHUB_APP_NOT_CONFIGURED' }));

    fs.chmodSync(keyPath, 0o644);
    expect(() => createGitHubAppAuthService({
      env: env({ NODE_ENV: 'production' }),
    })).toThrowError(expect.objectContaining({ code: 'GITHUB_APP_KEY_INVALID' }));
  });

  it('requires the optional webhook URL and secret as a pair', () => {
    expect(() => createGitHubAppAuthService({
      env: env({ BOTTEGA_EXTERNAL_URL: 'https://bottega.example' }),
    })).toThrowError(expect.objectContaining({ code: 'GITHUB_APP_NOT_CONFIGURED' }));
  });

  it('rejects malformed private key contents with a stable error', () => {
    fs.writeFileSync(keyPath, 'not a private key');
    expect(() => createGitHubAppAuthService({ env: env() })).toThrowError(expect.objectContaining({
      code: 'GITHUB_APP_KEY_INVALID',
    }));
  });

  it('discovers the installation, downscopes by repository name, and verifies canonical identity', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/repos/owner/repo/installation')) {
        return jsonResponse({ id: 22, suspended_at: null });
      }
      if (url.endsWith('/app/installations/22/access_tokens')) {
        return jsonResponse({ token: 'installation-secret', expires_at: '2026-07-13T13:00:00Z' });
      }
      if (url.endsWith('/repos/owner/repo')) {
        return jsonResponse({ id: 321, full_name: 'Canonical/Renamed' });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const service = createGitHubAppAuthService({ env: env(), fetch: fetchMock, now: () => NOW });

    await expect(service.resolveRepositoryInstallation('https://github.com/Owner/Repo.git')).resolves.toEqual({
      repositoryId: 321,
      installationId: 22,
      canonicalFullName: 'canonical/renamed',
    });
    const tokenRequest = calls.find(({ url }) => url.includes('/access_tokens'))!;
    expect(tokenRequest.init?.method).toBe('POST');
    expect(JSON.parse(requestBody(tokenRequest.init))).toMatchObject({ repositories: ['repo'] });
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: expect.stringMatching(/^Bearer /) });
    expect(calls[2]!.init?.headers).toMatchObject({ Authorization: 'Bearer installation-secret' });
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it('reports suspended and missing installations with stable errors', async () => {
    const suspended = createGitHubAppAuthService({
      env: env(),
      fetch: vi.fn(async () => jsonResponse({ id: 22, suspended_at: '2026-01-01' })),
    });
    await expect(suspended.resolveRepositoryInstallation('owner/repo')).rejects.toMatchObject({
      code: 'GITHUB_INSTALLATION_SUSPENDED',
    });

    const missing = createGitHubAppAuthService({
      env: env(),
      fetch: vi.fn(async () => jsonResponse({}, 404)),
    });
    await expect(missing.resolveRepositoryInstallation('owner/repo')).rejects.toMatchObject({
      code: 'GITHUB_INSTALLATION_NOT_FOUND',
      status: 404,
    });
    await expect(missing.resolveRepositoryInstallation('not a repository')).rejects.toMatchObject({
      code: 'GITHUB_REPOSITORY_NOT_SELECTED',
    });
  });

  it('deduplicates concurrent token refreshes per installation and repository', async () => {
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve; });
    let tokenRequests = 0;
    let botAuthorization: string | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes('/access_tokens')) {
        tokenRequests += 1;
        await tokenGate;
        return jsonResponse({ token: 'shared', expires_at: '2026-07-13T13:00:00Z' });
      }
      if (url.endsWith('/app')) return jsonResponse({ id: 1, slug: 'bottega' });
      if (url.includes('/users/')) {
        botAuthorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
        return jsonResponse({ id: 99 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const service = createGitHubAppAuthService({
      env: env(),
      fetch: fetchMock,
      now: () => NOW,
      getProject: () => project(),
    });

    const first = service.getRepositoryAuth(7, 'push');
    const second = service.getRepositoryAuth(7, 'push');
    await vi.waitFor(() => expect(tokenRequests).toBe(1));
    releaseToken();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      token: 'shared',
      installationId: 10,
      repositoryId: 100,
      botLogin: 'bottega[bot]',
      botUserId: 99,
      botEmail: '99+bottega[bot]@users.noreply.github.com',
    });
    expect(botAuthorization).toBe('Bearer shared');
  });

  it('returns bot login metadata without spending an unauthenticated user lookup', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/app')) return jsonResponse({ id: 1, slug: 'bottega' });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const service = createGitHubAppAuthService({ env: env(), fetch: fetchMock, now: () => NOW });

    await expect(service.getAppMetadata()).resolves.toMatchObject({
      botLogin: 'bottega[bot]',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('isolates caches by installation and repository', async () => {
    const minted: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes('/access_tokens')) {
        const repository = (JSON.parse(requestBody(init)) as { repositories: string[] }).repositories[0]!;
        const installation = url.match(/installations\/(\d+)/)?.[1];
        const token = `${installation}:${repository}`;
        minted.push(token);
        return jsonResponse({ token, expires_at: '2026-07-13T13:00:00Z' });
      }
      if (url.endsWith('/app')) return jsonResponse({ id: 1, slug: 'bottega' });
      if (url.includes('/users/')) return jsonResponse({ id: 99 });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const projects = new Map([
      [1, project({ id: 1 })],
      [2, project({ id: 2, github_repo: 'other/two', github_repository_id: 200, github_installation_id: 20 })],
    ]);
    const service = createGitHubAppAuthService({
      env: env(), fetch: fetchMock, now: () => NOW, getProject: (id) => projects.get(id),
    });

    const [first, second] = await Promise.all([
      service.getRepositoryAuth(1, 'comment'),
      service.getRepositoryAuth(2, 'comment'),
    ]);
    expect(first.token).toBe('10:repo');
    expect(second.token).toBe('20:two');
    expect(minted).toEqual(expect.arrayContaining(['10:repo', '20:two']));
  });

  it('refreshes near expiry once and uses last-good only while still valid', async () => {
    let currentTime = NOW;
    let tokenRequest = 0;
    let failRefresh = false;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('/access_tokens')) {
        tokenRequest += 1;
        if (failRefresh) return jsonResponse({}, 500);
        return jsonResponse({
          token: `token-${tokenRequest}`,
          expires_at: new Date(currentTime + 4 * 60 * 1000).toISOString(),
        });
      }
      if (url.endsWith('/app')) return jsonResponse({ id: 1, slug: 'bottega' });
      if (url.includes('/users/')) return jsonResponse({ id: 99 });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const service = createGitHubAppAuthService({
      env: env(), fetch: fetchMock, now: () => currentTime, getProject: () => project(),
    });

    expect((await service.getRepositoryAuth(7, 'comment')).token).toBe('token-1');
    failRefresh = true;
    expect((await service.getRepositoryAuth(7, 'comment')).token).toBe('token-1');
    currentTime += 4 * 60 * 1000 + 1;
    await expect(service.getRepositoryAuth(7, 'comment')).rejects.toMatchObject({
      code: 'GITHUB_APP_TOKEN_FAILED',
    });
  });

  it('invalidates installation caches and never preserves a token after a 401', async () => {
    let tokenRequest = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('/access_tokens')) {
        tokenRequest += 1;
        if (tokenRequest === 2) return jsonResponse({}, 401);
        return jsonResponse({ token: `token-${tokenRequest}`, expires_at: '2026-07-13T13:00:00Z' });
      }
      if (url.endsWith('/app')) return jsonResponse({ id: 1, slug: 'bottega' });
      if (url.includes('/users/')) return jsonResponse({ id: 99 });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let currentTime = NOW;
    const service = createGitHubAppAuthService({
      env: env(), fetch: fetchMock, now: () => currentTime, getProject: () => project(),
    });
    await service.getRepositoryAuth(7, 'comment');
    service.invalidateInstallation(10);
    await expect(service.getRepositoryAuth(7, 'comment')).rejects.toMatchObject({ status: 401 });
    currentTime += 1;
    await expect(service.getRepositoryAuth(7, 'comment')).resolves.toMatchObject({ token: 'token-3' });
  });

  it('re-resolves and persists repository mapping after an installation 404', async () => {
    let tokenRequests = 0;
    const updateProjectIdentity = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/app/installations/10/access_tokens')) return jsonResponse({}, 404);
      if (url.endsWith('/repos/owner/repo/installation')) {
        return jsonResponse({ id: 20, suspended_at: null });
      }
      if (url.endsWith('/app/installations/20/access_tokens')) {
        tokenRequests += 1;
        return jsonResponse({
          token: tokenRequests === 1 ? 'discovery-token' : 'cached-token',
          expires_at: '2026-07-13T13:00:00Z',
        });
      }
      if (url.endsWith('/repos/owner/repo')) {
        return jsonResponse({ id: 200, full_name: 'owner/renamed' });
      }
      if (url.endsWith('/app')) return jsonResponse({ id: 1, slug: 'bottega' });
      if (url.includes('/users/')) return jsonResponse({ id: 99 });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const service = createGitHubAppAuthService({
      env: env(),
      fetch: fetchMock,
      now: () => NOW,
      getProject: () => project(),
      updateProjectIdentity,
    });

    await expect(service.getRepositoryAuth(7, 'comment')).resolves.toMatchObject({
      token: 'cached-token',
      installationId: 20,
      repositoryId: 200,
      repository: 'owner/renamed',
    });
    expect(updateProjectIdentity).toHaveBeenCalledWith(7, {
      installationId: 20,
      repositoryId: 200,
      canonicalFullName: 'owner/renamed',
    });
  });

  it('re-resolves repository mapping when a near-expiry token refresh returns 404', async () => {
    let currentTime = NOW;
    let oldInstallationRequests = 0;
    let newInstallationRequests = 0;
    const updateProjectIdentity = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/app/installations/10/access_tokens')) {
        oldInstallationRequests += 1;
        if (oldInstallationRequests === 1) {
          return jsonResponse({
            token: 'near-expiry',
            expires_at: new Date(currentTime + 4 * 60 * 1000).toISOString(),
          });
        }
        return jsonResponse({}, 404);
      }
      if (url.endsWith('/repos/owner/repo/installation')) {
        return jsonResponse({ id: 20, suspended_at: null });
      }
      if (url.endsWith('/app/installations/20/access_tokens')) {
        newInstallationRequests += 1;
        return jsonResponse({
          token: `replacement-${newInstallationRequests}`,
          expires_at: new Date(currentTime + 60 * 60 * 1000).toISOString(),
        });
      }
      if (url.endsWith('/repos/owner/repo')) {
        return jsonResponse({ id: 200, full_name: 'owner/renamed' });
      }
      if (url.endsWith('/app')) return jsonResponse({ id: 1, slug: 'bottega' });
      if (url.includes('/users/')) return jsonResponse({ id: 99 });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const service = createGitHubAppAuthService({
      env: env(),
      fetch: fetchMock,
      now: () => currentTime,
      getProject: () => project(),
      updateProjectIdentity,
    });

    await expect(service.getRepositoryAuth(7, 'read')).resolves.toMatchObject({ token: 'near-expiry' });
    currentTime += 1;
    await expect(service.getRepositoryAuth(7, 'read')).resolves.toMatchObject({
      token: 'replacement-2',
      installationId: 20,
      repositoryId: 200,
      repository: 'owner/renamed',
    });
    expect(updateProjectIdentity).toHaveBeenCalledOnce();
  });

  it('reloads project capability before every token return', async () => {
    let enabled = true;
    let tokenRequests = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('/access_tokens')) {
        tokenRequests += 1;
        return jsonResponse({ token: 'token', expires_at: '2026-07-13T13:00:00Z' });
      }
      if (url.endsWith('/app')) return jsonResponse({ id: 1, slug: 'bottega' });
      if (url.includes('/users/')) return jsonResponse({ id: 99 });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const service = createGitHubAppAuthService({
      env: env(),
      fetch: fetchMock,
      now: () => NOW,
      getProject: () => project({ github_automation_enabled: enabled ? 1 : 0 }),
    });
    await service.getRepositoryAuth(7, 'push');
    enabled = false;

    await expect(service.getRepositoryAuth(7, 'push')).rejects.toMatchObject({
      code: 'GITHUB_CAPABILITY_DENIED',
    });
    expect(tokenRequests).toBe(1);
  });

  it('returns metadata and polling-only degradation through health', async () => {
    const service = createGitHubAppAuthService({
      env: env(),
      now: () => NOW,
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith('/app')) return jsonResponse({ id: 42, slug: 'bottega' });
        throw new GitHubAppError('GITHUB_APP_TOKEN_FAILED', 'unexpected request');
      }),
    });

    await expect(service.getHealth()).resolves.toMatchObject({
      mode: 'app',
      status: 'degraded',
      configured: true,
      appId: 42,
      appSlug: 'bottega',
      botLogin: 'bottega[bot]',
      botUserId: null,
      webhookConfigured: false,
      lastMetadataSuccessAt: NOW,
    });
  });
});
