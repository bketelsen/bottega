import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';

import type { ProjectRow } from '../../../shared/types/db.js';
import { normalizeGitHubRepository } from '../../../shared/schemas/github.js';
import { assertCapability, type GitHubAction } from './capabilities.js';

const GITHUB_API_URL = 'https://api.github.com';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const APP_JWT_LIFETIME_SECONDS = 10 * 60;
const APP_JWT_BACKDATE_SECONDS = 30;

export type GitHubAuthMode = 'host' | 'app';
export type GitHubAppErrorCode =
  | 'GITHUB_APP_NOT_CONFIGURED'
  | 'GITHUB_APP_KEY_INVALID'
  | 'GITHUB_INSTALLATION_NOT_FOUND'
  | 'GITHUB_INSTALLATION_SUSPENDED'
  | 'GITHUB_REPOSITORY_NOT_SELECTED'
  | 'GITHUB_APP_PERMISSION_MISSING'
  | 'GITHUB_APP_TOKEN_FAILED';

export interface GitHubRepositoryAuth {
  token: string;
  expiresAt: number;
  installationId: number;
  repositoryId: number;
  repository: string;
  botLogin: string;
  botUserId: number;
  botEmail: string;
}

export interface GitHubRepositoryInstallation {
  repositoryId: number;
  installationId: number;
  canonicalFullName: string;
}

export interface GitHubAppHealth {
  mode: GitHubAuthMode;
  status: 'disabled' | 'healthy' | 'degraded' | 'error';
  configured: boolean;
  appId: number | null;
  appSlug: string | null;
  botLogin: string | null;
  botUserId: number | null;
  webhookConfigured: boolean;
  webhookUrl: string | null;
  lastMetadataSuccessAt: number | null;
  lastTokenMintSuccessAt: number | null;
  errorCode: GitHubAppErrorCode | null;
  error: string | null;
}

export class GitHubAppError extends Error {
  constructor(
    readonly code: GitHubAppErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'GitHubAppError';
  }
}

interface AppConfig {
  mode: GitHubAuthMode;
  issuer: string | number | null;
  configuredAppId: number | null;
  privateKey: KeyObject | null;
  webhookUrl: string | null;
}

export interface GitHubAppIdentity {
  appId: number;
  slug: string;
  botLogin: string;
  botUserId: number;
  botEmail: string;
}

export interface GitHubAppMetadata {
  appId: number;
  slug: string;
  botLogin: string;
}

interface TokenEntry {
  token: string;
  expiresAt: number;
}

interface GitHubAppAuthDependencies {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  readFile?: typeof fs.readFileSync;
  stat?: typeof fs.statSync;
  warn?: (message: string) => void;
  getProject?: (projectId: number) => Promise<ProjectRow | undefined> | ProjectRow | undefined;
  updateProjectIdentity?: (
    projectId: number,
    identity: GitHubRepositoryInstallation,
  ) => Promise<void> | void;
}

export interface GitHubAppAuthService {
  readonly mode: GitHubAuthMode;
  createAppJwt(): string;
  resolveRepositoryInstallation(repository: string): Promise<GitHubRepositoryInstallation>;
  getRepositoryAuth(projectId: number, action: GitHubAction): Promise<GitHubRepositoryAuth>;
  getAppMetadata(): Promise<GitHubAppMetadata>;
  getHealth(): Promise<GitHubAppHealth>;
  invalidateInstallation(installationId: number): void;
}

function configurationError(message: string): GitHubAppError {
  return new GitHubAppError('GITHUB_APP_NOT_CONFIGURED', message);
}

function parsePositiveInteger(value: string | undefined, name: string): number | null {
  if (value === undefined || value.trim() === '') return null;
  if (!/^\d+$/.test(value.trim())) throw configurationError(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw configurationError(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function loadConfig(dependencies: GitHubAppAuthDependencies): AppConfig {
  const env = dependencies.env ?? process.env;
  const modeValue = env.GITHUB_AUTH_MODE?.trim() || 'host';
  if (modeValue !== 'host' && modeValue !== 'app') {
    throw configurationError('GITHUB_AUTH_MODE must be "host" or "app"');
  }
  if (modeValue === 'host') {
    return { mode: 'host', issuer: null, configuredAppId: null, privateKey: null, webhookUrl: null };
  }

  const clientId = env.GITHUB_APP_CLIENT_ID?.trim() || null;
  const appId = parsePositiveInteger(env.GITHUB_APP_ID, 'GITHUB_APP_ID');
  const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim() || null;
  if ((!clientId && appId === null) || !keyPath) {
    throw configurationError(
      'App mode requires GITHUB_APP_CLIENT_ID (or numeric GITHUB_APP_ID) and GITHUB_APP_PRIVATE_KEY_PATH',
    );
  }

  const externalUrl = env.BOTTEGA_EXTERNAL_URL?.trim() || null;
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET?.trim() || null;
  if (Boolean(externalUrl) !== Boolean(webhookSecret)) {
    throw configurationError('BOTTEGA_EXTERNAL_URL and GITHUB_WEBHOOK_SECRET must be supplied together');
  }

  try {
    const stat = (dependencies.stat ?? fs.statSync)(keyPath);
    if (!stat.isFile()) throw new Error('path is not a file');
    const mode = stat.mode & 0o777;
    const currentUid = process.getuid?.();
    const unsafe = mode !== 0o600 || (currentUid !== undefined && stat.uid !== currentUid);
    if (unsafe) {
      const message = 'GitHub App private key must be owned by the service account with mode 0600';
      if (env.NODE_ENV === 'production') throw new Error(message);
      (dependencies.warn ?? console.warn)(message);
    }
    const pem = (dependencies.readFile ?? fs.readFileSync)(keyPath, 'utf8');
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('private key is not RSA');
    return {
      mode: 'app',
      issuer: clientId ?? appId,
      configuredAppId: appId,
      privateKey,
      webhookUrl: externalUrl
        ? `${externalUrl.replace(/\/+$/, '')}/api/webhooks/github`
        : null,
    };
  } catch (error) {
    throw new GitHubAppError(
      'GITHUB_APP_KEY_INVALID',
      `GitHub App private key is invalid or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubAppError('GITHUB_APP_TOKEN_FAILED', 'GitHub returned an invalid response');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new GitHubAppError('GITHUB_APP_TOKEN_FAILED', `GitHub response is missing ${field}`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubAppError('GITHUB_APP_TOKEN_FAILED', `GitHub response is missing ${field}`);
  }
  return value;
}

function responseError(status: number, operation: string): GitHubAppError {
  if (status === 401) {
    return new GitHubAppError('GITHUB_APP_TOKEN_FAILED', `${operation} was rejected by GitHub`, status);
  }
  if (status === 403) {
    return new GitHubAppError('GITHUB_APP_PERMISSION_MISSING', `${operation} is not permitted`, status);
  }
  if (status === 404) {
    return new GitHubAppError('GITHUB_INSTALLATION_NOT_FOUND', `${operation} was not found`, status);
  }
  return new GitHubAppError('GITHUB_APP_TOKEN_FAILED', `${operation} failed with HTTP ${status}`, status);
}

function normalizeRepositoryInput(repository: string): string {
  try {
    return normalizeGitHubRepository(repository);
  } catch {
    throw new GitHubAppError(
      'GITHUB_REPOSITORY_NOT_SELECTED',
      'A valid GitHub owner/repository is required',
    );
  }
}

export function createGitHubAppAuthService(
  dependencies: GitHubAppAuthDependencies = {},
): GitHubAppAuthService {
  const config = loadConfig(dependencies);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const cache = new Map<string, TokenEntry>();
  const inFlight = new Map<string, Promise<TokenEntry>>();
  let metadata: GitHubAppMetadata | null = null;
  let metadataRequest: Promise<GitHubAppMetadata> | null = null;
  let botIdentity: GitHubAppIdentity | null = null;
  let botIdentityRequest: Promise<GitHubAppIdentity> | null = null;
  let lastMetadataSuccessAt: number | null = null;
  let lastTokenMintSuccessAt: number | null = null;

  const requireAppConfig = (): { issuer: string | number; privateKey: KeyObject } => {
    if (config.mode !== 'app' || config.issuer === null || config.privateKey === null) {
      throw configurationError('GitHub App authentication is not configured');
    }
    return { issuer: config.issuer, privateKey: config.privateKey };
  };

  const createAppJwt = (): string => {
    const app = requireAppConfig();
    const timestamp = Math.floor(now() / 1000);
    const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = encodeBase64Url(JSON.stringify({
      iss: app.issuer,
      iat: timestamp - APP_JWT_BACKDATE_SECONDS,
      exp: timestamp + APP_JWT_LIFETIME_SECONDS,
    }));
    const unsigned = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(app.privateKey, 'base64url')}`;
  };

  const request = async (
    path: string,
    authorization: string | null,
    operation: string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetchImplementation(`${GITHUB_API_URL}${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          ...(authorization ? { Authorization: authorization } : {}),
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch (error) {
      throw new GitHubAppError(
        'GITHUB_APP_TOKEN_FAILED',
        `${operation} could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) throw responseError(response.status, operation);
    return object(await response.json());
  };

  const getMetadata = async (): Promise<GitHubAppMetadata> => {
    if (metadata) return metadata;
    if (metadataRequest) return metadataRequest;
    metadataRequest = (async () => {
      const app = await request('/app', `Bearer ${createAppJwt()}`, 'GitHub App metadata request');
      const slug = requiredString(app.slug, 'slug');
      const appId = requiredNumber(app.id, 'id');
      const botLogin = `${slug}[bot]`;
      metadata = { appId, slug, botLogin };
      lastMetadataSuccessAt = now();
      return metadata;
    })().finally(() => {
      metadataRequest = null;
    });
    return metadataRequest;
  };

  const getBotIdentity = async (installationToken: string): Promise<GitHubAppIdentity> => {
    if (botIdentity) return botIdentity;
    if (botIdentityRequest) return botIdentityRequest;
    botIdentityRequest = (async () => {
      const appMetadata = await getMetadata();
      const bot = await request(
        `/users/${encodeURIComponent(appMetadata.botLogin)}`,
        `Bearer ${installationToken}`,
        'GitHub App bot identity request',
      );
      const botUserId = requiredNumber(bot.id, 'bot user id');
      botIdentity = {
        ...appMetadata,
        botUserId,
        botEmail: `${botUserId}+${appMetadata.botLogin}@users.noreply.github.com`,
      };
      return botIdentity;
    })().finally(() => {
      botIdentityRequest = null;
    });
    return botIdentityRequest;
  };

  const mintToken = async (installationId: number, repositoryName: string): Promise<TokenEntry> => {
    const body = JSON.stringify({
      repositories: [repositoryName],
      permissions: {
        contents: 'write',
        issues: 'write',
        pull_requests: 'write',
        checks: 'read',
        statuses: 'read',
      },
    });
    const result = await request(
      `/app/installations/${installationId}/access_tokens`,
      `Bearer ${createAppJwt()}`,
      'GitHub installation token request',
      { method: 'POST', body },
    );
    const expiresAt = Date.parse(requiredString(result.expires_at, 'expires_at'));
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
      throw new GitHubAppError('GITHUB_APP_TOKEN_FAILED', 'GitHub returned an invalid token expiration');
    }
    lastTokenMintSuccessAt = now();
    return { token: requiredString(result.token, 'token'), expiresAt };
  };

  const resolveRepositoryInstallation = async (
    repository: string,
  ): Promise<GitHubRepositoryInstallation> => {
    requireAppConfig();
    const normalized = normalizeRepositoryInput(repository);
    const [owner, name] = normalized.split('/');
    if (!owner || !name) {
      throw new GitHubAppError('GITHUB_REPOSITORY_NOT_SELECTED', 'A GitHub owner/repository is required');
    }
    const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const installation = await request(
      `${repositoryPath}/installation`,
      `Bearer ${createAppJwt()}`,
      `GitHub installation for ${normalized}`,
    );
    if (installation.suspended_at !== null && installation.suspended_at !== undefined) {
      throw new GitHubAppError(
        'GITHUB_INSTALLATION_SUSPENDED',
        `GitHub App installation for ${normalized} is suspended`,
      );
    }
    const installationId = requiredNumber(installation.id, 'installation id');
    const token = await mintToken(installationId, name);
    const canonical = await request(
      repositoryPath,
      `Bearer ${token.token}`,
      `GitHub repository ${normalized}`,
    );
    const canonicalFullName = normalizeGitHubRepository(requiredString(canonical.full_name, 'full_name'));
    return {
      repositoryId: requiredNumber(canonical.id, 'repository id'),
      installationId,
      canonicalFullName,
    };
  };

  const defaultGetProject = async (projectId: number): Promise<ProjectRow | undefined> => {
    const { projectsDb } = await import('../../database/db.js');
    return projectsDb.getByIdAdmin(projectId);
  };
  const defaultUpdateProjectIdentity = async (
    projectId: number,
    discovered: GitHubRepositoryInstallation,
  ): Promise<void> => {
    const { projectsDb } = await import('../../database/db.js');
    projectsDb.updateGitHubIdentity(
      projectId,
      discovered.canonicalFullName,
      discovered.repositoryId,
      discovered.installationId,
    );
  };

  const invalidateInstallation = (installationId: number): void => {
    const prefix = `${installationId}:`;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
    for (const key of inFlight.keys()) {
      if (key.startsWith(prefix)) inFlight.delete(key);
    }
  };

  const cachedToken = async (
    installationId: number,
    repositoryId: number,
    repositoryName: string,
  ): Promise<TokenEntry> => {
    const key = `${installationId}:${repositoryId}:automation`;
    const previous = cache.get(key);
    if (previous && previous.expiresAt - now() >= TOKEN_REFRESH_BUFFER_MS) return previous;
    const existingRequest = inFlight.get(key);
    if (existingRequest) return existingRequest;

    const refresh = mintToken(installationId, repositoryName)
      .then((token) => {
        cache.set(key, token);
        return token;
      })
      .catch((error: unknown) => {
        if (error instanceof GitHubAppError && (error.status === 401 || error.status === 404)) {
          invalidateInstallation(installationId);
          throw error;
        }
        if (previous && previous.expiresAt > now()) return previous;
        throw error;
      })
      .finally(() => {
        if (inFlight.get(key) === refresh) inFlight.delete(key);
      });
    inFlight.set(key, refresh);
    return refresh;
  };

  const getRepositoryAuth = async (
    projectId: number,
    action: GitHubAction,
  ): Promise<GitHubRepositoryAuth> => {
    requireAppConfig();
    const getProject = dependencies.getProject ?? defaultGetProject;
    const project = await getProject(projectId);
    if (!project) {
      throw new GitHubAppError('GITHUB_REPOSITORY_NOT_SELECTED', `Project ${projectId} was not found`);
    }
    assertCapability(project, action);
    if (!project.github_repo || project.github_repository_id == null || project.github_installation_id == null) {
      throw new GitHubAppError(
        'GITHUB_REPOSITORY_NOT_SELECTED',
        `Project ${projectId} does not have a verified GitHub App repository`,
      );
    }

    let repository = project.github_repo;
    let repositoryId = project.github_repository_id;
    let installationId = project.github_installation_id;
    const repositoryName = repository.split('/')[1]!;
    let token: TokenEntry;
    try {
      token = await cachedToken(installationId, repositoryId, repositoryName);
    } catch (error) {
      if (!(error instanceof GitHubAppError) || error.status !== 404) throw error;
      const discovered = await resolveRepositoryInstallation(repository);
      try {
        await (dependencies.updateProjectIdentity ?? defaultUpdateProjectIdentity)(projectId, discovered);
      } catch (_updateError) {
        throw new GitHubAppError(
          'GITHUB_REPOSITORY_NOT_SELECTED',
          `Could not persist the verified repository identity for project ${projectId}`,
          null,
        );
      }
      repository = discovered.canonicalFullName;
      repositoryId = discovered.repositoryId;
      installationId = discovered.installationId;
      token = await cachedToken(installationId, repositoryId, repository.split('/')[1]!);
    }
    const appIdentity = await getBotIdentity(token.token);
    return {
      ...token,
      installationId,
      repositoryId,
      repository,
      botLogin: appIdentity.botLogin,
      botUserId: appIdentity.botUserId,
      botEmail: appIdentity.botEmail,
    };
  };

  const getHealth = async (): Promise<GitHubAppHealth> => {
    if (config.mode === 'host') {
      return {
        mode: 'host',
        status: 'disabled',
        configured: false,
        appId: null,
        appSlug: null,
        botLogin: null,
        botUserId: null,
        webhookConfigured: false,
        webhookUrl: null,
        lastMetadataSuccessAt,
        lastTokenMintSuccessAt,
        errorCode: null,
        error: null,
      };
    }
    try {
      const appMetadata = await getMetadata();
      return {
        mode: 'app',
        status: config.webhookUrl ? 'healthy' : 'degraded',
        configured: true,
        appId: appMetadata.appId,
        appSlug: appMetadata.slug,
        botLogin: appMetadata.botLogin,
        botUserId: null,
        webhookConfigured: config.webhookUrl !== null,
        webhookUrl: config.webhookUrl,
        lastMetadataSuccessAt,
        lastTokenMintSuccessAt,
        errorCode: null,
        error: config.webhookUrl ? null : 'GitHub webhook is not configured; polling-only mode is active',
      };
    } catch (error) {
      const appError = error instanceof GitHubAppError
        ? error
        : new GitHubAppError('GITHUB_APP_TOKEN_FAILED', 'GitHub App health check failed');
      return {
        mode: 'app',
        status: 'error',
        configured: true,
        appId: config.configuredAppId,
        appSlug: null,
        botLogin: null,
        botUserId: null,
        webhookConfigured: config.webhookUrl !== null,
        webhookUrl: config.webhookUrl,
        lastMetadataSuccessAt,
        lastTokenMintSuccessAt,
        errorCode: appError.code,
        error: appError.message,
      };
    }
  };

  return {
    mode: config.mode,
    createAppJwt,
    resolveRepositoryInstallation,
    getRepositoryAuth,
    getAppMetadata: getMetadata,
    getHealth,
    invalidateInstallation,
  };
}

let singleton: GitHubAppAuthService | null = null;

function service(): GitHubAppAuthService {
  singleton ??= createGitHubAppAuthService();
  return singleton;
}

export function createAppJwt(): string {
  return service().createAppJwt();
}

export function getGitHubAuthMode(): GitHubAuthMode {
  return service().mode;
}

export function getGitHubAppMetadata(): Promise<GitHubAppMetadata> {
  return service().getAppMetadata();
}

export function resolveRepositoryInstallation(
  repository: string,
): Promise<GitHubRepositoryInstallation> {
  return service().resolveRepositoryInstallation(repository);
}

export function getRepositoryAuth(
  projectId: number,
  action: GitHubAction,
): Promise<GitHubRepositoryAuth> {
  return service().getRepositoryAuth(projectId, action);
}

export function getGitHubAppHealth(): Promise<GitHubAppHealth> {
  return service().getHealth();
}

export function invalidateInstallation(installationId: number): void {
  service().invalidateInstallation(installationId);
}
