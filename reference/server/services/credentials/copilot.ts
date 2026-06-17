// GitHub Copilot adapter for the ProviderCredentialStore interface.
//
// Wraps the per-user copilotCredentials.ts helpers so the credential
// registry can hand the orchestrator a Copilot env (which only carries
// BOTTEGA_USER_ID — the GitHub token is injected at client construction in
// the pool) without orchestrator code knowing anything about COPILOT_HOME.
//
// `write` takes the GitHub token string directly. The device/OAuth login
// flow (`copilotAuthFlow.ts`) writes the file itself, so this write path is
// reserved for any direct token-set fallback.

import {
  buildCopilotSdkEnv,
  clearCopilotAuth,
  getCopilotAuthStatus,
  readCopilotToken,
  resolveCopilotAuthJsonPath,
  writeCopilotAuth,
} from '../copilotCredentials.js';
import type { ProviderCredentialStore } from './types.js';

export const copilotCredentialStore: ProviderCredentialStore = {
  read(userId) {
    const { token, authPath } = readCopilotToken(userId);
    return { token, tokenPath: authPath };
  },

  write(userId, payload) {
    // The payload is the raw GitHub token string.
    const token = payload.trim();
    if (!token) {
      throw new Error('Copilot credential payload must be a non-empty GitHub token');
    }
    const { authPath } = writeCopilotAuth(userId, { gitHubToken: token });
    return { tokenPath: authPath };
  },

  clear(userId) {
    return clearCopilotAuth(userId);
  },

  async getStatus(userId) {
    const status = await getCopilotAuthStatus(userId);
    return {
      authenticated: status.authenticated,
      status: status.status,
      tokenPath: status.authPath ?? resolveCopilotAuthJsonPath(userId),
      ...(status.tokenFingerprint !== undefined
        ? { tokenFingerprint: status.tokenFingerprint }
        : {}),
      ...(status.login !== undefined ? { email: status.login } : {}),
      ...(status.reason !== undefined ? { reason: status.reason } : {}),
    };
  },

  buildSdkEnv(userId) {
    return buildCopilotSdkEnv(userId);
  },
};
