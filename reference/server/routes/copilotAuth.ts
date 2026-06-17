// /api/copilot-auth/* — GitHub Copilot authentication, per-user scoped.
//
// Routes:
//   - GET    /status   — does this user have a usable GitHub token? Plus any
//                        in-flight device login.
//   - POST   /start    — begin the device/OAuth login; returns the GitHub
//                        verification URL + user code for the UI.
//   - POST   /complete — block until the in-flight login finishes (optional;
//                        the UI may instead poll /status).
//   - POST   /cancel   — cancel an in-flight device login.
//   - DELETE /         — clear the per-user GitHub token.
//   - GET    /models   — live Copilot model catalog for this user.
//
// Every mutation that changes the token ends by invalidating the per-user
// pooled `CopilotClient` (it captured the previous token at construction).

import express, { type Request, type Response } from 'express';
import {
  CopilotCredentialsError,
  clearCopilotAuth,
  getCopilotAuthStatus,
} from '../services/copilotCredentials.js';
import {
  CopilotAuthLoginError,
  cancelCopilotAuthLogin,
  getActiveCopilotAuthLogin,
  startCopilotAuthLogin,
  waitForCopilotAuthLoginCompletion,
} from '../services/copilotAuthFlow.js';
import { listCopilotModels } from '../services/providers/copilot/index.js';
import { invalidateCopilotClient } from '../services/providers/copilot/clientPool.js';
import { seedAgentSettingsAfterConnect } from '../services/agentModelSettings.js';
import { validateBody } from '../middleware/validate.js';
import {
  CancelCopilotAuthBodySchema,
  type CancelCopilotAuthBody,
  CompleteCopilotAuthBodySchema,
  type CompleteCopilotAuthBody,
} from '../../shared/schemas/copilotAuth.js';
import type {
  CopilotAuthStatusResponse,
  StartCopilotAuthResponse,
  CancelCopilotAuthResponse,
  ClearCopilotAuthResponse,
  CopilotModelsResponse,
} from '../../shared/api/copilotAuth.js';
import type { ApiError } from '../../shared/api/_common.js';

const router = express.Router();

interface CopilotAuthErrorBody {
  error: string;
  code: 'COPILOT_AUTH_STORAGE_ERROR' | 'COPILOT_AUTH_FLOW_ERROR';
}

function authErrorResponse(
  res: Response<CopilotAuthErrorBody | ApiError>,
  error: unknown,
): Response {
  if (error instanceof CopilotAuthLoginError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: 'COPILOT_AUTH_FLOW_ERROR',
    });
  }
  if (error instanceof CopilotCredentialsError) {
    return res.status(400).json({
      error: error.message,
      code: 'COPILOT_AUTH_STORAGE_ERROR',
    });
  }
  console.error('[CopilotAuth] Error:', error);
  return res.status(500).json({
    error: error instanceof Error ? error.message : 'Internal error',
    code: 'COPILOT_AUTH_STORAGE_ERROR',
  });
}

router.get(
  '/status',
  async (req: Request, res: Response<CopilotAuthStatusResponse | CopilotAuthErrorBody>) => {
    try {
      const status = await getCopilotAuthStatus(req.user!.id);
      const activeLogin = getActiveCopilotAuthLogin(req.user!.id);
      res.json({
        authenticated: status.authenticated,
        status: status.status,
        tokenFingerprint: status.tokenFingerprint ?? null,
        login: status.login ?? null,
        reason: status.authenticated ? null : (status.reason ?? null),
        loginSession: activeLogin
          ? {
              active: true,
              loginSessionId: activeLogin.loginSessionId,
              authUrl: activeLogin.authUrl,
              deviceCode: activeLogin.deviceCode,
              startedAt: activeLogin.startedAt,
              expiresAt: activeLogin.expiresAt,
            }
          : null,
      });
    } catch (error) {
      authErrorResponse(res as Response<CopilotAuthErrorBody | ApiError>, error);
    }
  },
);

router.post(
  '/start',
  async (req: Request, res: Response<StartCopilotAuthResponse | CopilotAuthErrorBody>) => {
    try {
      const login = await startCopilotAuthLogin(req.user!.id);
      res.status(201).json({
        loginSessionId: login.loginSessionId,
        authUrl: login.authUrl,
        deviceCode: login.deviceCode,
        startedAt: login.startedAt,
        expiresAt: login.expiresAt,
      });
    } catch (error) {
      authErrorResponse(res as Response<CopilotAuthErrorBody | ApiError>, error);
    }
  },
);

router.post(
  '/complete',
  validateBody(CompleteCopilotAuthBodySchema),
  async (req: Request, res: Response<CopilotAuthStatusResponse | CopilotAuthErrorBody>) => {
    const { loginSessionId } = req.validated!.body as CompleteCopilotAuthBody;
    try {
      await waitForCopilotAuthLoginCompletion(req.user!.id, loginSessionId);
      // The freshly-written token must replace whatever the pool cached.
      await invalidateCopilotClient(req.user!.id);
      await seedAgentSettingsAfterConnect(req.user!.id);
      const status = await getCopilotAuthStatus(req.user!.id);
      res.status(201).json({
        authenticated: status.authenticated,
        status: status.status,
        tokenFingerprint: status.tokenFingerprint ?? null,
        login: status.login ?? null,
        reason: status.authenticated ? null : (status.reason ?? null),
        loginSession: null,
      });
    } catch (error) {
      authErrorResponse(res as Response<CopilotAuthErrorBody | ApiError>, error);
    }
  },
);

router.post(
  '/cancel',
  validateBody(CancelCopilotAuthBodySchema),
  (req: Request, res: Response<CancelCopilotAuthResponse | CopilotAuthErrorBody>) => {
    const { loginSessionId } = req.validated!.body as CancelCopilotAuthBody;
    try {
      const active = getActiveCopilotAuthLogin(req.user!.id);
      if (active && active.loginSessionId !== loginSessionId) {
        res.json({ cancelled: false });
        return;
      }
      const cancelled = cancelCopilotAuthLogin(req.user!.id, 'user-cancelled');
      res.json({ cancelled });
    } catch (error) {
      authErrorResponse(res as Response<CopilotAuthErrorBody | ApiError>, error);
    }
  },
);

router.delete(
  '/',
  async (req: Request, res: Response<ClearCopilotAuthResponse | CopilotAuthErrorBody>) => {
    try {
      const cleared = clearCopilotAuth(req.user!.id);
      await invalidateCopilotClient(req.user!.id);
      res.json({ cleared });
    } catch (error) {
      authErrorResponse(res as Response<CopilotAuthErrorBody | ApiError>, error);
    }
  },
);

// Live Copilot catalog from the user's pooled client. Returns an empty list
// (200 OK) when the user has no token configured — the settings UI uses that
// to show a "connect first" hint rather than an error.
router.get(
  '/models',
  async (req: Request, res: Response<CopilotModelsResponse | CopilotAuthErrorBody>) => {
    const userId = req.user!.id;
    try {
      const status = await getCopilotAuthStatus(userId);
      if (!status.authenticated) {
        res.json({ models: [] });
        return;
      }
      const models = await listCopilotModels(userId);
      res.json({ models });
    } catch (error) {
      authErrorResponse(res as Response<CopilotAuthErrorBody | ApiError>, error);
    }
  },
);

export default router;
