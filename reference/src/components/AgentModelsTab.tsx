// Settings → Agent Models (per-user). Lists all six agents with a
// provider/model/effort picker each, filtered to the providers the current
// user has connected. Replaces the old admin-only global agent_model_settings
// editor (which lived in the Prompts tab).

import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { api } from '../utils/api';
import AgentModelSettingRow from './AgentModelSettingRow';
import {
  AGENT_TYPES_WITH_SETTINGS,
  EFFORTS_FOR_UI,
  type AgentModelSetting,
  type AgentModelSettings,
} from '../../shared/types/agentModelSettings';
import type { AgentType } from '../../shared/types/db';
import type { Provider } from '../../shared/providers/types';
import type { OpenCodeModelEntry } from '../../shared/api/openCodeAuth';
import type { CopilotModelEntry } from '../../shared/api/copilotAuth';
import type { ClaudeModelEntry } from '../../shared/api/auth';
import type { CodexModelEntry } from '../../shared/api/codexAuth';

const AGENT_LABELS: Record<AgentType, string> = {
  planification: 'Planning',
  implementation: 'Implementation',
  refinement: 'Refinement',
  review: 'Review',
  pr: 'PR',
  yolo: 'YOLO',
};

function AgentModelsTab() {
  const [settings, setSettings] = useState<AgentModelSettings | null>(null);
  const [needsSeeding, setNeedsSeeding] = useState(false);
  const [connected, setConnected] = useState<Provider[]>([]);
  const [openCodeModels, setOpenCodeModels] = useState<OpenCodeModelEntry[] | null>(null);
  const [isLoadingOpenCodeModels, setLoadingOpenCodeModels] = useState(false);
  const [copilotModels, setCopilotModels] = useState<CopilotModelEntry[] | null>(null);
  const [isLoadingCopilotModels, setLoadingCopilotModels] = useState(false);
  const [claudeModels, setClaudeModels] = useState<ClaudeModelEntry[] | null>(null);
  const [isLoadingClaudeModels, setLoadingClaudeModels] = useState(false);
  const [codexModels, setCodexModels] = useState<CodexModelEntry[] | null>(null);
  const [isLoadingCodexModels, setLoadingCodexModels] = useState(false);
  const [isLoading, setLoading] = useState(true);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const loadOpenCodeModels = useCallback(async () => {
    setLoadingOpenCodeModels(true);
    try {
      const res = await api.openCodeAuth.models();
      if (!res.ok) {
        setOpenCodeModels([]);
        return;
      }
      const body = await res.json();
      setOpenCodeModels(body.models);
    } catch {
      setOpenCodeModels([]);
    } finally {
      setLoadingOpenCodeModels(false);
    }
  }, []);

  const loadCopilotModels = useCallback(async () => {
    setLoadingCopilotModels(true);
    try {
      const res = await api.copilotAuth.models();
      if (!res.ok) {
        setCopilotModels([]);
        return;
      }
      const body = await res.json();
      setCopilotModels(body.models);
    } catch {
      setCopilotModels([]);
    } finally {
      setLoadingCopilotModels(false);
    }
  }, []);

  const loadClaudeModels = useCallback(async () => {
    setLoadingClaudeModels(true);
    try {
      const res = await api.claudeAuth.models();
      setClaudeModels(res.ok ? (await res.json()).models : []);
    } catch {
      setClaudeModels([]);
    } finally {
      setLoadingClaudeModels(false);
    }
  }, []);

  const loadCodexModels = useCallback(async () => {
    setLoadingCodexModels(true);
    try {
      const res = await api.codexAuth.models();
      setCodexModels(res.ok ? (await res.json()).models : []);
    } catch {
      setCodexModels([]);
    } finally {
      setLoadingCodexModels(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const [settingsRes, providersRes] = await Promise.all([
          api.userAgentModelSettings.get(),
          api.userAgentModelSettings.connectedProviders(),
        ]);
        if (providersRes.ok) {
          const body = await providersRes.json();
          setConnected(body.connected);
          if (body.connected.includes('anthropic')) void loadClaudeModels();
          if (body.connected.includes('openai')) void loadCodexModels();
          if (body.connected.includes('opencode')) void loadOpenCodeModels();
          if (body.connected.includes('copilot')) void loadCopilotModels();
        }
        if (settingsRes.ok) {
          const body = await settingsRes.json();
          if (body.needsSeeding) {
            setNeedsSeeding(true);
          } else {
            setSettings(body.settings);
          }
        } else {
          setError('Failed to load agent model settings');
        }
      } catch {
        setError('Failed to load agent model settings');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadClaudeModels, loadCodexModels, loadOpenCodeModels, loadCopilotModels]);

  const updateAgentSetting = useCallback(
    async (agent: AgentType, patch: Partial<AgentModelSetting>) => {
      if (!settings) return;
      const current = settings[agent];

      // Provider change resets model/effort to that provider's first option so
      // an Anthropic → OpenAI flip doesn't leave 'opus' under OpenAI's namespace.
      let merged: AgentModelSetting;
      if (patch.provider && patch.provider !== current.provider) {
        const p = patch.provider;
        const firstLiveModel = p === 'anthropic'
          ? claudeModels?.[0]
          : p === 'openai'
            ? codexModels?.[0]
            : p === 'opencode'
              ? openCodeModels?.[0]
              : copilotModels?.[0];
        const nextModel = firstLiveModel?.id ?? null;
        if (nextModel === null) {
          setError(
            `The ${p} catalog is still loading or that provider isn't connected. ` +
              `Connect ${p} in Settings → Providers, then try again.`,
          );
          return;
        }
        const modelWithEffort = firstLiveModel as
          | { defaultEffort?: string | null; supportedEfforts?: string[] }
          | undefined;
        const effort = modelWithEffort?.defaultEffort
          ?? modelWithEffort?.supportedEfforts?.[0]
          ?? EFFORTS_FOR_UI[p][0]
          ?? null;
        merged = { provider: p, model: nextModel, effort };
      } else {
        merged = { ...current, ...patch };
      }

      const next: AgentModelSettings = { ...settings, [agent]: merged };
      const previous = settings;
      setSettings(next);
      setSaving(true);
      setError(null);
      setStatusMsg(null);
      try {
        const res = await api.userAgentModelSettings.update(next);
        if (!res.ok) {
          setSettings(previous);
          setError('Failed to save agent model settings');
          return;
        }
        const body = await res.json();
        setSettings(body.settings);
        setStatusMsg('Saved');
      } catch {
        setSettings(previous);
        setError('Failed to save agent model settings');
      } finally {
        setSaving(false);
      }
    },
    [settings, claudeModels, codexModels, openCodeModels, copilotModels],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading agent models...
      </div>
    );
  }

  if (needsSeeding || !settings) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        <AlertCircle className="w-5 h-5 mx-auto mb-2" />
        Connect a provider in <span className="font-medium">Settings → Providers</span> to
        configure your agent models.
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-[400px]">
      <div className="pb-3 border-b border-border">
        <h3 className="text-base font-semibold text-foreground">Agent Models</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose which provider and model each agent runs on. Only providers you've connected
          are selectable.
        </p>
      </div>

      {error && (
        <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {statusMsg && !error && (
        <div className="mt-3 p-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded text-sm text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
          {isSaving && <Loader2 className="w-3 h-3 animate-spin" />}
          {statusMsg}
        </div>
      )}

      <div className="mt-2">
        {AGENT_TYPES_WITH_SETTINGS.map((agent) => (
          <AgentModelSettingRow
            key={agent}
            agentType={agent}
            label={AGENT_LABELS[agent]}
            setting={settings[agent]}
            connectedProviders={connected}
            openCodeModels={openCodeModels}
            isLoadingOpenCodeModels={isLoadingOpenCodeModels}
            copilotModels={copilotModels}
            isLoadingCopilotModels={isLoadingCopilotModels}
            claudeModels={claudeModels}
            isLoadingClaudeModels={isLoadingClaudeModels}
            codexModels={codexModels}
            isLoadingCodexModels={isLoadingCodexModels}
            disabled={isSaving}
            onChange={updateAgentSetting}
          />
        ))}
      </div>
    </div>
  );
}

export default AgentModelsTab;
