// Per-user GitHub Copilot credentials.
//
// Bottega isolates every user's Copilot auth inside
// `~/.config/bottega/users/{userId}/copilot/`. Two things live there:
//   - `auth.json` — Bottega's own record of the user's GitHub token
//     (provisioned by the device/OAuth login flow). Shape:
//     `{ gitHubToken: string, login?: string }`.
//   - the Copilot CLI's own on-disk state, rooted here via `COPILOT_HOME`
//     (the `baseDirectory` option handed to `new CopilotClient(...)`).
//
// The GitHub token is handed to the SDK through the `gitHubToken`
// constructor option — NOT via env — so the per-user `CopilotClient` in
// `copilotClientPool` is the only thing that ever sees it. The global
// `~/.copilot/` dir and any inherited `GITHUB_TOKEN`/`GH_TOKEN`/
// `COPILOT_GITHUB_TOKEN` are never read by runtime code.

import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_COPILOT_CONFIG_ROOT = path.join(
  os.homedir(),
  '.config',
  'bottega',
  'users',
);
const AUTH_FILE_NAME = 'auth.json';
const COPILOT_SUBDIR = 'copilot';

// GitHub token env keys that would override the per-user token if inherited
// from the parent process. Stripped from the SDK-tagging env so the per-user
// auth.json stays authoritative.
const GLOBAL_COPILOT_AUTH_ENV_KEYS = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

export class CopilotCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopilotCredentialsError';
  }
}

function normalizeUserId(userId: number | string | undefined): string {
  const numericUserId = Number(userId);
  if (
    !Number.isInteger(numericUserId) ||
    numericUserId <= 0 ||
    String(numericUserId) !== String(userId)
  ) {
    throw new CopilotCredentialsError(
      'Cannot resolve Copilot credentials without a valid authenticated user ID',
    );
  }
  return String(numericUserId);
}

export function getCopilotConfigRoot(): string {
  return process.env['COPILOT_CONFIG_ROOT'] || DEFAULT_COPILOT_CONFIG_ROOT;
}

export function resolveCopilotUserDir(userId: number | string | undefined): string {
  return path.join(getCopilotConfigRoot(), normalizeUserId(userId));
}

/** Per-user COPILOT_HOME — root of the Copilot CLI's on-disk state. */
export function resolveCopilotHomeDir(userId: number | string | undefined): string {
  return path.join(resolveCopilotUserDir(userId), COPILOT_SUBDIR);
}

export function resolveCopilotAuthJsonPath(userId: number | string | undefined): string {
  return path.join(resolveCopilotHomeDir(userId), AUTH_FILE_NAME);
}

/**
 * Create the per-user COPILOT_HOME (mode 0700) if it doesn't exist. The
 * parent `users/{userId}/` dir is shared with the other providers'
 * credentials; we mkdirp the chain in case a user is Copilot-first.
 */
export function ensureCopilotHomeDir(
  userId: number | string | undefined,
): { copilotHome: string } {
  const userDir = resolveCopilotUserDir(userId);
  try {
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(userDir, 0o700);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CopilotCredentialsError(
        `Copilot credential directory is not writable: ${getCopilotConfigRoot()}. Check permissions or set COPILOT_CONFIG_ROOT in your .env to a writable path.`,
      );
    }
    throw error;
  }
  const copilotHome = resolveCopilotHomeDir(userId);
  try {
    fs.mkdirSync(copilotHome, { recursive: true, mode: 0o700 });
    fs.chmodSync(copilotHome, 0o700);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CopilotCredentialsError(
        `Copilot per-user dir is not writable: ${copilotHome}.`,
      );
    }
    throw error;
  }
  return { copilotHome };
}

function validateAuthFileSecurity(
  userId: number | string | undefined,
  authPath: string,
): void {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(authPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CopilotCredentialsError(
        `Copilot auth.json is not provisioned for user ${userId}. Run /api/copilot-auth/start to log in.`,
      );
    }
    throw err;
  }

  if (!stats.isFile()) {
    throw new CopilotCredentialsError(
      `Copilot auth.json path for user ${userId} is not a file: ${authPath}`,
    );
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && stats.uid !== currentUid) {
    throw new CopilotCredentialsError(
      `Copilot auth.json for user ${userId} must be owned by the current user`,
    );
  }

  if ((stats.mode & 0o077) !== 0) {
    throw new CopilotCredentialsError(
      `Copilot auth.json for user ${userId} must not be accessible by group or other users; run chmod 600 ${authPath}`,
    );
  }
}

export interface CopilotAuthPayload {
  gitHubToken: string;
  /** GitHub login/handle, when resolvable from the login flow. */
  login?: string;
  [key: string]: unknown;
}

export interface ReadCopilotAuthResult {
  payload: CopilotAuthPayload;
  authPath: string;
}

export function readCopilotAuth(
  userId: number | string | undefined,
): ReadCopilotAuthResult {
  const authPath = resolveCopilotAuthJsonPath(userId);
  validateAuthFileSecurity(userId, authPath);
  const raw = fs.readFileSync(authPath, 'utf8');
  let payload: CopilotAuthPayload;
  try {
    payload = JSON.parse(raw) as CopilotAuthPayload;
  } catch (err) {
    throw new CopilotCredentialsError(
      `Copilot auth.json for user ${userId} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof payload.gitHubToken !== 'string' || payload.gitHubToken.length === 0) {
    throw new CopilotCredentialsError(
      `Copilot auth.json for user ${userId} carries no gitHubToken`,
    );
  }
  return { payload, authPath };
}

export function writeCopilotAuth(
  userId: number | string | undefined,
  payload: { gitHubToken: string; login?: string },
): { authPath: string } {
  if (typeof payload?.gitHubToken !== 'string' || payload.gitHubToken.length === 0) {
    throw new CopilotCredentialsError(
      `Refusing to persist Copilot auth.json without a gitHubToken for user ${userId}`,
    );
  }
  ensureCopilotHomeDir(userId);
  const authPath = resolveCopilotAuthJsonPath(userId);
  const record: CopilotAuthPayload = {
    gitHubToken: payload.gitHubToken,
    ...(payload.login ? { login: payload.login } : {}),
  };
  fs.writeFileSync(authPath, JSON.stringify(record), { mode: 0o600 });
  fs.chmodSync(authPath, 0o600);
  return { authPath };
}

export function clearCopilotAuth(userId: number | string | undefined): boolean {
  const authPath = resolveCopilotAuthJsonPath(userId);
  try {
    fs.unlinkSync(authPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** The per-user GitHub token, or throw if unprovisioned. */
export function readCopilotToken(userId: number | string | undefined): {
  token: string;
  login: string | null;
  authPath: string;
} {
  const { payload, authPath } = readCopilotAuth(userId);
  return {
    token: payload.gitHubToken,
    login: typeof payload.login === 'string' ? payload.login : null,
    authPath,
  };
}

function fingerprint(value: string): string {
  // Last 6 chars — same shape as the other providers' tokenFingerprint.
  return value.slice(-6);
}

export interface CopilotAuthStatus {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  authPath: string;
  tokenFingerprint?: string;
  login?: string;
  reason?: string;
}

export async function getCopilotAuthStatus(
  userId: number | string | undefined,
): Promise<CopilotAuthStatus> {
  const authPath = resolveCopilotAuthJsonPath(userId);
  try {
    const { payload } = readCopilotAuth(userId);
    return {
      authenticated: true,
      status: 'authenticated',
      authPath,
      tokenFingerprint: fingerprint(payload.gitHubToken),
      ...(typeof payload.login === 'string' ? { login: payload.login } : {}),
    };
  } catch (error) {
    if (error instanceof CopilotCredentialsError) {
      return {
        authenticated: false,
        status: 'missing',
        authPath,
        reason: error.message,
      };
    }
    throw error;
  }
}

function removeInheritedCopilotAuthEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  for (const key of GLOBAL_COPILOT_AUTH_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export interface CopilotSdkEnv extends Record<string, string | undefined> {
  /** Tag the user id so `CopilotProvider` can resolve the pooled client. */
  BOTTEGA_USER_ID: string;
  HOME: string | undefined;
  PATH: string | undefined;
}

/**
 * Build the env tagged onto a Copilot turn's `ProviderRunOptions.env`. The
 * GitHub token is NOT placed here — it is injected at client construction in
 * `copilotClientPool`. This env only carries `BOTTEGA_USER_ID` (so the
 * provider can resolve the pooled client) and strips any inherited global
 * GitHub token so it can never shadow the per-user one.
 */
export function buildCopilotSdkEnv(
  userId: number | string | undefined,
): CopilotSdkEnv {
  const env: Record<string, string | undefined> = {
    HOME: process.env['HOME'],
    PATH: process.env['PATH'],
  };
  removeInheritedCopilotAuthEnv(env);
  env['BOTTEGA_USER_ID'] = normalizeUserId(userId);
  return env as CopilotSdkEnv;
}
