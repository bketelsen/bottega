// Per-user GitHub Copilot device/OAuth login flow.
//
// Copilot authenticates with a GitHub token. We provision one through the
// standard GitHub OAuth **device flow** (https://docs.github.com/developers/
// apps/authorizing-oauth-apps#device-flow), which maps cleanly onto the same
// start → poll → complete UX the Codex device-auth flow uses, but over plain
// HTTPS rather than a PTY:
//
//   1. POST /login/device/code → { device_code, user_code, verification_uri,
//      interval, expires_in }. We surface `verification_uri` (authUrl) and
//      `user_code` (deviceCode) to the UI.
//   2. The user opens the URL, enters the code, authorises Bottega.
//   3. We poll POST /login/oauth/access_token until it returns an
//      `access_token`, then persist it via `writeCopilotAuth` (mode 0600).
//
// The OAuth client id defaults to the GitHub CLI's public client id (which
// supports the device flow); override with `COPILOT_OAUTH_CLIENT_ID` to use
// a dedicated app. No client secret is used or needed for the device flow.

import crypto from 'crypto';

import {
  CopilotCredentialsError,
  ensureCopilotHomeDir,
  getCopilotAuthStatus,
  resolveCopilotAuthJsonPath,
  writeCopilotAuth,
} from './copilotCredentials.js';

const DEFAULT_LOGIN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'; // GitHub CLI public client id
const DEFAULT_SCOPE = 'read:user';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_API_URL = 'https://api.github.com/user';
const EXIT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

export class CopilotAuthLoginError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'CopilotAuthLoginError';
    this.statusCode = statusCode;
  }
}

export interface PublicSession {
  loginSessionId: string;
  authUrl: string | null;
  deviceCode: string | null;
  startedAt: string;
  expiresAt: string;
}

interface LoginSession {
  id: string;
  userId: number | string;
  userKey: string;
  startedAt: string;
  expiresAt: string;
  /** GitHub `verification_uri` shown to the user. */
  authUrl: string | null;
  /** GitHub `user_code` the user types into the browser. */
  deviceCode: string | null;
  /** GitHub `device_code` used in the token-poll request (secret-ish). */
  internalDeviceCode: string;
  pollIntervalMs: number;
  cancelled: boolean;
  done: boolean;
  ttlTimer: NodeJS.Timeout;
  pollTimer: NodeJS.Timeout | null;
  completion: Promise<void>;
  resolveCompletion: () => void;
  rejectCompletion: (err: Error) => void;
}

const activeLogins = new Map<string, LoginSession>();

function normalizeUserKey(userId: number | string | undefined): string {
  const numericUserId = Number(userId);
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
    throw new CopilotAuthLoginError(
      'Cannot authenticate Copilot without a valid user ID',
      400,
    );
  }
  return String(numericUserId);
}

function getClientId(): string {
  return process.env['COPILOT_OAUTH_CLIENT_ID'] || DEFAULT_CLIENT_ID;
}

function getScope(): string {
  return process.env['COPILOT_OAUTH_SCOPE'] || DEFAULT_SCOPE;
}

function publicSession(session: LoginSession): PublicSession {
  return {
    loginSessionId: session.id,
    authUrl: session.authUrl,
    deviceCode: session.deviceCode,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
  };
}

function logSession(
  session: Pick<LoginSession, 'userId' | 'id'> | null,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  console.log(
    '[CopilotAuthFlow]',
    JSON.stringify({
      message,
      userId: session?.userId ?? null,
      loginSessionId: session?.id ?? null,
      ...extra,
    }),
  );
}

function teardown(session: LoginSession): void {
  clearTimeout(session.ttlTimer);
  if (session.pollTimer) clearTimeout(session.pollTimer);
  if (activeLogins.get(session.userKey)?.id === session.id) {
    activeLogins.delete(session.userKey);
  }
}

export function getActiveCopilotAuthLogin(
  userId: number | string | undefined,
): PublicSession | null {
  const userKey = normalizeUserKey(userId);
  const session = activeLogins.get(userKey);
  return session ? publicSession(session) : null;
}

export function cancelCopilotAuthLogin(
  userId: number | string | undefined,
  reason = 'cancelled',
): boolean {
  const userKey = normalizeUserKey(userId);
  const session = activeLogins.get(userKey);
  if (!session) return false;
  logSession(session, 'cancel-request', { reason });
  session.cancelled = true;
  teardown(session);
  if (!session.done) {
    session.done = true;
    session.rejectCompletion(new CopilotAuthLoginError(`login ${reason}`, 409));
  }
  return true;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: getClientId(), scope: getScope() }),
  });
  if (!res.ok) {
    throw new CopilotAuthLoginError(
      `GitHub device-code request failed (${res.status})`,
      502,
    );
  }
  const body = (await res.json()) as DeviceCodeResponse;
  if (!body.device_code || !body.user_code || !body.verification_uri) {
    throw new CopilotAuthLoginError('GitHub device-code response was malformed', 502);
  }
  return body;
}

async function pollAccessToken(deviceCode: string): Promise<AccessTokenResponse> {
  const res = await fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: getClientId(),
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  return (await res.json()) as AccessTokenResponse;
}

async function resolveLogin(token: string): Promise<string | null> {
  try {
    const res = await fetch(USER_API_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { login?: string };
    return typeof body.login === 'string' ? body.login : null;
  } catch {
    return null;
  }
}

function scheduleNextPoll(session: LoginSession): void {
  if (session.done || session.cancelled) return;
  session.pollTimer = setTimeout(() => {
    void runPoll(session);
  }, session.pollIntervalMs);
  session.pollTimer.unref?.();
}

async function runPoll(session: LoginSession): Promise<void> {
  if (session.done || session.cancelled) return;
  let result: AccessTokenResponse;
  try {
    result = await pollAccessToken(session.internalDeviceCode);
  } catch (err) {
    // Transient network error — keep polling until the TTL fires.
    logSession(session, 'poll-error', { error: (err as Error).message });
    scheduleNextPoll(session);
    return;
  }

  if (result.access_token) {
    try {
      const login = await resolveLogin(result.access_token);
      writeCopilotAuth(session.userId, {
        gitHubToken: result.access_token,
        ...(login ? { login } : {}),
      });
      session.done = true;
      teardown(session);
      logSession(session, 'login-complete', { login });
      session.resolveCompletion();
    } catch (err) {
      session.done = true;
      teardown(session);
      session.rejectCompletion(
        err instanceof Error ? err : new CopilotAuthLoginError(String(err)),
      );
    }
    return;
  }

  switch (result.error) {
    case 'authorization_pending':
      scheduleNextPoll(session);
      return;
    case 'slow_down':
      // GitHub asks us to back off — bump the interval.
      session.pollIntervalMs += (result.interval ?? 5) * 1000;
      scheduleNextPoll(session);
      return;
    case 'expired_token':
    case 'access_denied':
    case undefined:
    default:
      session.done = true;
      teardown(session);
      session.rejectCompletion(
        new CopilotAuthLoginError(
          `GitHub authorization failed: ${result.error ?? 'unknown'}`,
          400,
        ),
      );
  }
}

export interface StartLoginOptions {
  ttlMs?: number;
}

/**
 * Begin the device flow: request a device code from GitHub, start polling in
 * the background, and return the verification URL + user code for the UI. The
 * background poll runs until the user authorises (→ token persisted), the TTL
 * fires, or the caller cancels.
 */
export async function startCopilotAuthLogin(
  userId: number | string,
  options: StartLoginOptions = {},
): Promise<PublicSession> {
  const userKey = normalizeUserKey(userId);
  const envTtlMs = Number(process.env['COPILOT_AUTH_LOGIN_TTL_MS']);
  const ttlMs =
    options.ttlMs ?? (Number.isFinite(envTtlMs) ? envTtlMs : DEFAULT_LOGIN_TTL_MS);

  cancelCopilotAuthLogin(userId, 'replaced');

  try {
    ensureCopilotHomeDir(userId);
  } catch (error) {
    if (error instanceof CopilotCredentialsError) {
      throw new CopilotAuthLoginError(error.message, 500);
    }
    throw error;
  }

  const device = await requestDeviceCode();
  const startedAtMs = Date.now();

  let resolveCompletion!: () => void;
  let rejectCompletion!: (err: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Don't crash the process if no one awaits completion (poll-based UIs).
  completion.catch(() => {});

  const session: LoginSession = {
    id: crypto.randomUUID(),
    userId,
    userKey,
    startedAt: new Date(startedAtMs).toISOString(),
    expiresAt: new Date(startedAtMs + ttlMs).toISOString(),
    authUrl: device.verification_uri,
    deviceCode: device.user_code,
    internalDeviceCode: device.device_code,
    pollIntervalMs: Math.max(1, device.interval) * 1000,
    cancelled: false,
    done: false,
    ttlTimer: undefined as unknown as NodeJS.Timeout,
    pollTimer: null,
    completion,
    resolveCompletion,
    rejectCompletion,
  };

  session.ttlTimer = setTimeout(() => {
    if (activeLogins.get(userKey)?.id === session.id && !session.done) {
      session.done = true;
      teardown(session);
      session.rejectCompletion(
        new CopilotAuthLoginError('Copilot login expired before authorization', 408),
      );
    }
  }, ttlMs);
  session.ttlTimer.unref?.();

  activeLogins.set(userKey, session);
  logSession(session, 'login-started', { expiresAt: session.expiresAt });
  scheduleNextPoll(session);

  return publicSession(session);
}

/**
 * Block until the named login finishes (token persisted) or fails. The
 * frontend can either await this or poll `/api/copilot-auth/status`.
 */
export async function waitForCopilotAuthLoginCompletion(
  userId: number | string,
  loginSessionId: string,
  options: { completeWaitMs?: number } = {},
): Promise<Awaited<ReturnType<typeof getCopilotAuthStatus>>> {
  const userKey = normalizeUserKey(userId);
  const session = activeLogins.get(userKey);
  if (!session) {
    throw new CopilotAuthLoginError('No active Copilot authentication session', 404);
  }
  if (session.id !== loginSessionId) {
    throw new CopilotAuthLoginError(
      'Copilot authentication session has been replaced',
      409,
    );
  }

  const completeWaitMs = options.completeWaitMs ?? EXIT_WAIT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CopilotAuthLoginError('Copilot login did not finish in time', 504)),
      completeWaitMs,
    );
    timer.unref?.();
  });

  try {
    await Promise.race([session.completion, timeout]);
  } finally {
    clearTimeout(timer);
  }

  const status = await getCopilotAuthStatus(userId);
  if (!status.authenticated) {
    throw new CopilotAuthLoginError(
      `Copilot login finished but auth.json is not usable: ${status.reason ?? 'unknown'}`,
      500,
    );
  }
  logSession(session, 'login-verified', {
    authPath: resolveCopilotAuthJsonPath(userId),
  });
  return status;
}

export function clearCopilotAuthLoginSessions(): void {
  for (const session of activeLogins.values()) {
    session.cancelled = true;
    teardown(session);
    if (!session.done) {
      session.done = true;
      session.rejectCompletion(new CopilotAuthLoginError('login cleanup', 409));
    }
  }
  activeLogins.clear();
}
