// Settings → Providers — GitHub Copilot auth.
//
// Copilot authenticates with a GitHub token provisioned through the GitHub
// device/OAuth flow (mirrors the Codex device-auth panel, minus the
// paste-auth fallback): the user clicks Connect, opens the verification URL,
// enters the one-time code, and the panel polls /status until the background
// poll persists the token and flips to "Connected".

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, Trash2, ExternalLink, Copy } from 'lucide-react';
import { api } from '../utils/api';
import { Button } from './ui/button';
import type { CopilotAuthStatusResponse } from '../../shared/api/copilotAuth';

export function CopilotAuthPanel() {
  const [status, setStatus] = useState<CopilotAuthStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [startingLogin, setStartingLogin] = useState(false);
  const pollTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.copilotAuth.status();
      if (!res.ok) {
        setError('Failed to read Copilot auth status');
        setStatus(null);
        return;
      }
      setStatus(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll status while a device login is in flight so the panel collapses the
  // URL/code back to "Connected" once the background poll persists the token.
  useEffect(() => {
    const active = status?.loginSession?.active === true && !status.authenticated;
    if (!active) {
      if (pollTimer.current !== null) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    if (pollTimer.current !== null) return;
    pollTimer.current = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      if (pollTimer.current !== null) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [status?.loginSession?.active, status?.authenticated, refresh]);

  const handleStartLogin = async () => {
    setStartingLogin(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.copilotAuth.start();
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Failed to start Copilot login');
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartingLogin(false);
    }
  };

  const handleCancelLogin = async () => {
    setStartingLogin(true);
    try {
      if (status?.loginSession?.loginSessionId) {
        await api.copilotAuth.cancel(status.loginSession.loginSessionId);
      }
      await refresh();
    } finally {
      setStartingLogin(false);
    }
  };

  const handleClear = async () => {
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.copilotAuth.clear();
      if (!res.ok) {
        setError('Failed to clear Copilot auth');
        return;
      }
      const body = await res.json();
      setInfo(body.cleared ? 'Copilot token removed.' : 'Nothing to remove.');
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="copilot-auth-panel">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">GitHub Copilot</h3>
        <p className="text-sm text-muted-foreground">
          Authorize Bottega with your GitHub account so agents configured for
          Copilot can run. The token is stored under
          <code className="ml-1">~/.config/bottega/users/&lt;id&gt;/copilot/</code>
          with mode 0600 — no other user can read it.
        </p>
      </div>

      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm">
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading…</span>
            </>
          ) : status?.authenticated ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span className="font-medium">Connected</span>
              {status.login && (
                <span className="text-muted-foreground">— {status.login}</span>
              )}
              {status.tokenFingerprint && (
                <code className="text-muted-foreground">…{status.tokenFingerprint}</code>
              )}
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4 text-amber-600" />
              <span>Not connected</span>
              {status?.reason && (
                <span className="text-muted-foreground">— {status.reason}</span>
              )}
            </>
          )}
        </div>

        {status?.authenticated && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleClear}
            disabled={submitting}
            data-testid="copilot-auth-clear"
          >
            <Trash2 className="w-3 h-3 mr-1" /> Disconnect
          </Button>
        )}
      </div>

      {/* Device-flow: when a login is in flight, render the URL + code; the
          poll loop above swaps state back to Connected once authorized. */}
      {!status?.authenticated && status?.loginSession?.active === true && (
        <div className="space-y-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900 rounded-lg p-4">
          <div className="text-sm font-medium">
            Open the authorization URL and enter the one-time code:
          </div>
          {status.loginSession.authUrl && (
            <a
              href={status.loginSession.authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 underline inline-flex items-center gap-1 text-sm"
              data-testid="copilot-auth-login-url"
            >
              {status.loginSession.authUrl} <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {status.loginSession.deviceCode && (
            <div className="flex items-center gap-2">
              <code className="bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded font-mono text-base">
                {status.loginSession.deviceCode}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(status.loginSession!.deviceCode!);
                  setInfo('Code copied to clipboard');
                }}
              >
                <Copy className="w-3 h-3 mr-1" /> Copy
              </Button>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancelLogin}
            disabled={startingLogin}
          >
            Cancel login
          </Button>
        </div>
      )}

      {!status?.authenticated && !status?.loginSession?.active && (
        <div>
          <Button
            onClick={handleStartLogin}
            disabled={startingLogin}
            data-testid="copilot-auth-start"
          >
            {startingLogin ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Connect with GitHub
          </Button>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {info && !error && (
        <div className="p-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded text-sm text-emerald-700 dark:text-emerald-300">
          {info}
        </div>
      )}
    </div>
  );
}

export default CopilotAuthPanel;
