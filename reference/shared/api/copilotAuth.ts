// Typed REST contracts for /api/copilot-auth/*.
//
// Copilot uses a per-user GitHub token provisioned through a PTY-driven
// device/OAuth login (mirrors Codex's device-auth flow). Models come from a
// live runtime catalog (mirrors OpenCode), persisted as `copilot/<modelId>`.

export interface CopilotAuthStatusResponse {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  /** Last-6 of the GitHub token when present, null when missing. */
  tokenFingerprint: string | null;
  /** GitHub login/handle when resolvable, else null. */
  login: string | null;
  /** Failure reason when not authenticated. */
  reason: string | null;
  /** Active device-auth login (when one is in flight). */
  loginSession: {
    active: true;
    loginSessionId: string;
    authUrl: string | null;
    deviceCode: string | null;
    startedAt: string;
    expiresAt: string;
  } | null;
}

export interface StartCopilotAuthResponse {
  loginSessionId: string;
  authUrl: string | null;
  deviceCode: string | null;
  startedAt: string;
  expiresAt: string;
}

export interface CancelCopilotAuthResponse {
  cancelled: boolean;
}

export interface ClearCopilotAuthResponse {
  cleared: boolean;
}

/** A single Copilot model row, as surfaced to the settings UI. */
export interface CopilotModelEntry {
  /** Bottega-persisted form: `copilot/<bareModelId>`. */
  id: string;
  /** Bare model id without the `copilot/` prefix (what the SDK expects). */
  bareModelId: string;
  /** Human-readable label, e.g. "GPT-5" or "Claude Sonnet 4.5". */
  name: string;
}

/** Response of `GET /api/copilot-auth/models`. */
export interface CopilotModelsResponse {
  /** Live Copilot catalog for the calling user. Empty when the user has no
   * Copilot credentials configured. */
  models: CopilotModelEntry[];
}
