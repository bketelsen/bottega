/*
 * useProviderModelSelection.ts — shared provider + model selection state.
 *
 * Every place that starts a conversation lets the user pick an explicit
 * (provider, model) pair (the system never defaults a model server-side).
 * This hook centralises that selection — the OpenCode catalog fetch, the
 * provider→model reset, and the derived dropdown options — so the picker is
 * identical across the New Conversation modal, the Ask-a-Question modal, and
 * the Fix-CI modal. Render it with `<ProviderModelPicker />`.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { api } from '../utils/api';
import { PROVIDERS } from '../../shared/providers/models';
import { useConnectedProviders } from '../contexts/ConnectedProvidersContext';
import type { Provider } from '../../shared/providers/types';

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  opencode: 'OpenCode',
  copilot: 'GitHub Copilot',
};

interface LiveModelEntry {
  id: string;
  name: string;
  status?: 'active' | 'deprecated';
}

type ModelCatalogs = Record<Provider, LiveModelEntry[] | null>;

/** First selectable model for a provider, given the (maybe-unloaded) dynamic catalogs. */
export function firstModelFor(
  p: Provider,
  catalogs: ModelCatalogs,
): string {
  return catalogs[p]?.[0]?.id ?? '';
}

/**
 * The provider a fresh conversation should default to: the highest-priority
 * provider the user has actually connected. Priority follows `PROVIDERS`
 * (anthropic > openai > opencode), matching how the server seeds per-agent
 * settings from a user's first connected provider — so the conversation
 * default lines up with the agent default. Falls back to `'anthropic'` only
 * when nothing is connected yet (the app-wide ConnectedProviders gate makes
 * that transient).
 */
export function preferredProvider(connected: Provider[]): Provider {
  return PROVIDERS.find((p) => connected.includes(p)) ?? 'anthropic';
}

export interface ProviderModelSelection {
  provider: Provider;
  model: string;
  setModel: (m: string) => void;
  handleProviderChange: (next: Provider) => void;
  modelOptions: Array<{ value: string; label: string }>;
  loadingOpenCodeModels: boolean;
  /**
   * Providers the user can pick — the ones they've connected. The picker
   * renders only these, so a user with (say) only OpenCode connected never
   * lands on the Anthropic option and never trips the Claude-auth gate.
   */
  availableProviders: Provider[];
  /** Reset the selection back to the preferred connected provider. */
  reset: () => void;
}

export function useProviderModelSelection(): ProviderModelSelection {
  const { connected } = useConnectedProviders();
  // Restrict the picker to connected providers, in canonical priority order.
  // Until the connected set has loaded, fall back to all providers so the
  // dropdown is never empty.
  const availableProviders = useMemo<Provider[]>(
    () => (connected.length > 0 ? PROVIDERS.filter((p) => connected.includes(p)) : [...PROVIDERS]),
    [connected],
  );

  const [provider, setProvider] = useState<Provider>(() => preferredProvider(connected));
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const [model, setModel] = useState('');
  // Set once the user picks a provider by hand, so the connected-set effect
  // below stops overriding their choice.
  const userPickedRef = useRef(false);
  const [catalogs, setCatalogs] = useState<ModelCatalogs>({
    anthropic: null,
    openai: null,
    opencode: null,
    copilot: null,
  });
  const [loadingProviders, setLoadingProviders] = useState<Provider[]>([]);

  const loadModels = useCallback(async (target: Provider) => {
    setLoadingProviders((current) => [...new Set([...current, target])]);
    try {
      const res = target === 'anthropic'
        ? await api.claudeAuth.models()
        : target === 'openai'
          ? await api.codexAuth.models()
          : target === 'opencode'
            ? await api.openCodeAuth.models()
            : await api.copilotAuth.models();
      const models = res.ok ? (await res.json()).models : [];
      setCatalogs((current) => ({ ...current, [target]: models }));
      setModel((current) => (
        current === '' && providerRef.current === target ? (models[0]?.id ?? '') : current
      ));
    } catch {
      setCatalogs((current) => ({ ...current, [target]: [] }));
    } finally {
      setLoadingProviders((current) => current.filter((provider) => provider !== target));
    }
  }, []);

  // Switch provider + reset the model to that provider's first option. For
  // OpenCode this kicks off the (lazy, per-user) catalog fetch on first use.
  const applyProvider = useCallback(
    (next: Provider) => {
      setProvider(next);
      if (catalogs[next] === null) {
        setModel('');
        void loadModels(next);
      } else {
        setModel(firstModelFor(next, catalogs));
      }
    },
    [catalogs, loadModels],
  );

  const handleProviderChange = useCallback(
    (next: Provider) => {
      userPickedRef.current = true;
      applyProvider(next);
    },
    [applyProvider],
  );

  // Snap to the preferred connected provider once we know what's connected
  // (the set loads asynchronously), unless the user has already picked one by
  // hand. Also lazily fetches the OpenCode catalog when OpenCode is the
  // default — so a connect-OpenCode-only user opens the modal with their
  // models already populated.
  useEffect(() => {
    if (userPickedRef.current || connected.length === 0) return;
    const preferred = preferredProvider(connected);
    if (preferred !== provider) {
      applyProvider(preferred);
    } else if (catalogs[preferred] === null && !loadingProviders.includes(preferred)) {
      setModel('');
      void loadModels(preferred);
    }
  }, [
    connected,
    provider,
    catalogs,
    loadingProviders,
    applyProvider,
    loadModels,
  ]);

  const modelOptions = useMemo<Array<{ value: string; label: string }>>(
    () => (catalogs[provider] ?? []).map((entry) => ({
      value: entry.id,
      label: entry.status === 'deprecated' ? `${entry.name} (deprecated)` : entry.name,
    })),
    [provider, catalogs],
  );

  // `reset` must keep a STABLE identity: callers wire it into open/close
  // effects (e.g. `[isOpen, resetProviderModel]`). If its identity changed when
  // the OpenCode catalog resolved, those effects would re-run mid-open and wipe
  // user input. So read `connected`/`applyProvider` through refs instead of
  // depending on them.
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const applyProviderRef = useRef(applyProvider);
  applyProviderRef.current = applyProvider;

  const reset = useCallback(() => {
    userPickedRef.current = false;
    applyProviderRef.current(preferredProvider(connectedRef.current));
    // Keep the fetched OpenCode catalog cached across opens (per-user, stable).
  }, []);

  return {
    provider,
    model,
    setModel,
    handleProviderChange,
    modelOptions,
    // Historical field name retained for picker callers; all catalogs are live.
    loadingOpenCodeModels: loadingProviders.includes(provider),
    availableProviders,
    reset,
  };
}
