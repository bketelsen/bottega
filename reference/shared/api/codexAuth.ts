// Typed REST contracts for /api/codex-auth/*.

export interface CodexAuthStatusResponse {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  method: 'oauth' | 'api_key' | null;
  email: string | null;
  tokenFingerprint: string | null;
  /** Unverified expiry embedded in a local OAuth JWT, when one is parseable. */
  tokenExpiresAt: string | null;
  tokenExpired: boolean | null;
  /** Whether auth.json contains a refresh token; this does not prove upstream validity. */
  refreshable: boolean;
  reason: string | null;
  /** Active device-auth login (when one is in flight). */
  login: {
    active: true;
    loginSessionId: string;
    authUrl: string | null;
    deviceCode: string | null;
    startedAt: string;
    expiresAt: string;
  } | null;
}

export interface StartCodexAuthResponse {
  loginSessionId: string;
  authUrl: string | null;
  deviceCode: string | null;
  startedAt: string;
  expiresAt: string;
}

export interface CancelCodexAuthResponse {
  cancelled: boolean;
}

export interface PasteCodexAuthResponse {
  authenticated: true;
  status: 'authenticated';
  method: 'oauth' | 'api_key';
  tokenFingerprint: string;
}

export interface ClearCodexAuthResponse {
  cleared: boolean;
}

export interface CodexModelEntry {
  id: string;
  name: string;
  description: string;
  supportedEfforts: string[];
  defaultEffort: string | null;
}

export interface CodexModelsResponse {
  models: CodexModelEntry[];
}
