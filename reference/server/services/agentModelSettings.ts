// Per-user agent (provider, model, effort) resolution.
//
// Each user has a row in `user_agent_model_settings` holding their full
// Record<AgentType, AgentModelSetting>. This replaces the old GLOBAL
// `app_settings.agent_model_settings` blob so each user runs agents on a
// provider/model they actually have credentials for.
//
// Determinism (feedback_deterministic_model_no_fallbacks): resolution NEVER
// silently defaults a model. An unseeded user — or one with a missing/invalid
// entry — throws `MissingUserAgentSettingsError` so the caller fails loud. In
// practice the blocking first-login provider modal guarantees a seed exists
// before any agent can run. The only legacy tolerance is the D6 `provider ??
// 'anthropic'` coercion, which keeps backfilled pre-multi-provider rows valid
// (their model was always an Anthropic model).

import {
  userAgentModelSettingsDb,
  userDb,
  agentRunsDb,
} from '../database/db.js';
import { getCredentialStore } from './credentials/registry.js';
import { listOpenCodeModels } from './providers/opencode/index.js';
import { listCopilotModels } from './providers/copilot/index.js';
import { listClaudeModels } from './providers/anthropic/models.js';
import { listCodexModels } from './providers/openai/models.js';
import {
  AGENT_TYPES_WITH_SETTINGS,
  isValidAgentModelSetting,
  isAgentTypeWithSettings,
  buildSeedSettings,
  defaultSettingForProvider,
  type AgentModelSetting,
  type AgentModelSettings,
} from '../../shared/types/agentModelSettings.js';
import { isEffortForProvider } from '../../shared/providers/models.js';
import type { Provider } from '../../shared/providers/types.js';
import type { ConversationRow } from '../../shared/types/db.js';

/** Thrown when a user has no usable agent model settings (unseeded/invalid). */
export class MissingUserAgentSettingsError extends Error {
  readonly userId: number;
  constructor(userId: number, detail: string) {
    super(`No valid agent model settings for user ${userId}: ${detail}`);
    this.name = 'MissingUserAgentSettingsError';
    this.userId = userId;
  }
}

/**
 * Load a user's full per-agent settings. Throws `MissingUserAgentSettingsError`
 * when the row is absent or any of the six agents is missing/invalid — callers
 * must not get a silent default.
 */
export function loadAgentModelSettings(userId: number): AgentModelSettings {
  const raw = userAgentModelSettingsDb.getRaw(userId);
  if (!raw) {
    throw new MissingUserAgentSettingsError(userId, 'no settings row');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MissingUserAgentSettingsError(
      userId,
      `unparseable settings JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MissingUserAgentSettingsError(userId, 'settings is not an object');
  }

  const blob = parsed as Record<string, unknown>;
  const result = {} as AgentModelSettings;

  for (const agentType of AGENT_TYPES_WITH_SETTINGS) {
    const entry = blob[agentType];
    if (!entry || typeof entry !== 'object') {
      throw new MissingUserAgentSettingsError(userId, `missing entry for '${agentType}'`);
    }
    const e = entry as { provider?: unknown; model?: unknown; effort?: unknown };
    // D6 legacy compat: backfilled rows from before the `provider` field read
    // back as 'anthropic'. The model is still validated against that provider.
    const candidate = {
      provider: e.provider ?? 'anthropic',
      model: e.model,
      effort: e.effort ?? null,
    };
    if (!isValidAgentModelSetting(candidate)) {
      throw new MissingUserAgentSettingsError(userId, `invalid entry for '${agentType}'`);
    }
    result[agentType] = candidate;
  }

  return result;
}

/** Persist a user's full per-agent settings (caller supplies all six). */
export function saveAgentModelSettings(userId: number, settings: AgentModelSettings): void {
  userAgentModelSettingsDb.set(userId, JSON.stringify(settings));
}

// Highest-priority connected provider wins when seeding a new user.
const SEED_PROVIDER_PRIORITY: readonly Provider[] = [
  'anthropic',
  'openai',
  'opencode',
  'copilot',
];

/**
 * Seed a user's agent settings from their first connected provider, if they
 * have none yet. Returns true when a seed was written. Returns false when the
 * user already has settings, has no connected provider, or chose OpenCode but
 * its live catalog yields no model id (never guess an OpenCode id). Invoked
 * after a successful provider-connect so the blocking modal can be dismissed.
 */
export async function ensureUserAgentModelSettings(userId: number): Promise<boolean> {
  if (userAgentModelSettingsDb.getRaw(userId)) return false;

  let chosen: Provider | null = null;
  for (const provider of SEED_PROVIDER_PRIORITY) {
    try {
      const status = await getCredentialStore(provider).getStatus(userId);
      if (status.authenticated) {
        chosen = provider;
        break;
      }
    } catch {
      // getStatus is non-throwing for the core providers; be defensive anyway.
    }
  }
  if (!chosen) return false;

  let firstModelId: string | null = null;
  let defaultEffort: string | null = null;
  if (chosen === 'anthropic') {
    try {
      const models = await listClaudeModels(userId);
      firstModelId = models[0]?.id ?? null;
      defaultEffort = models[0]?.defaultEffort ?? null;
    } catch {
      firstModelId = null;
    }
  } else if (chosen === 'openai') {
    try {
      const models = await listCodexModels(userId);
      firstModelId = models[0]?.id ?? null;
      defaultEffort = models[0]?.defaultEffort ?? null;
    } catch {
      firstModelId = null;
    }
  } else if (chosen === 'opencode') {
    try {
      const models = await listOpenCodeModels(userId);
      firstModelId = models[0]?.id ?? null;
    } catch {
      firstModelId = null;
    }
  } else if (chosen === 'copilot') {
    try {
      const models = await listCopilotModels(userId);
      firstModelId = models[0]?.id ?? null;
    } catch {
      firstModelId = null;
    }
  }
  if (!firstModelId) return false;
  if (defaultEffort !== null && !isEffortForProvider(chosen, defaultEffort)) {
    defaultEffort = null;
  }

  const seed = buildSeedSettings(chosen, firstModelId, defaultEffort);
  if (!seed) return false;

  saveAgentModelSettings(userId, seed);
  userDb.completeOnboarding(userId);
  return true;
}

/** First live (modelId, defaultEffort) for a provider, or nulls on any error. */
async function firstLiveModel(
  provider: Provider,
  userId: number,
): Promise<{ modelId: string | null; defaultEffort: string | null }> {
  try {
    if (provider === 'anthropic') {
      const m = await listClaudeModels(userId);
      return { modelId: m[0]?.id ?? null, defaultEffort: m[0]?.defaultEffort ?? null };
    }
    if (provider === 'openai') {
      const m = await listCodexModels(userId);
      return { modelId: m[0]?.id ?? null, defaultEffort: m[0]?.defaultEffort ?? null };
    }
    if (provider === 'opencode') {
      const m = await listOpenCodeModels(userId);
      return { modelId: m[0]?.id ?? null, defaultEffort: null };
    }
    const m = await listCopilotModels(userId);
    return { modelId: m[0]?.id ?? null, defaultEffort: null };
  } catch {
    return { modelId: null, defaultEffort: null };
  }
}

/**
 * Resolve the (provider, model, effort) for an adversarial `review` run.
 *
 * When cross-model review is enabled, the reviewer must run on a provider
 * DIFFERENT from `authorProvider` (the provider that wrote the code) so the
 * review isn't blind to its own author's mistakes. Selection:
 *
 *   1. If `authorProvider` is unknown, return the user's configured review
 *      setting unchanged (nothing to diversify against).
 *   2. Gather the user's connected providers minus `authorProvider`. If none
 *      remain (single-provider user), return the configured review setting —
 *      this is the graceful fallback that keeps one-provider users working.
 *   3. If the configured review provider already differs from the author and is
 *      connected, keep it (respects the user's explicit choice).
 *   4. Otherwise pick the highest-priority connected alternate, reusing a model
 *      the user already configured for that provider, else its first live model.
 */
export async function resolveReviewAgentSetting(
  userId: number,
  authorProvider: Provider | null,
): Promise<AgentModelSetting> {
  const settings = loadAgentModelSettings(userId);
  const configured = settings.review;
  if (!authorProvider) return configured;

  const connectedAlternates: Provider[] = [];
  for (const provider of SEED_PROVIDER_PRIORITY) {
    if (provider === authorProvider) continue;
    try {
      const status = await getCredentialStore(provider).getStatus(userId);
      if (status.authenticated) connectedAlternates.push(provider);
    } catch {
      // getStatus is non-throwing for core providers; be defensive anyway.
    }
  }
  if (connectedAlternates.length === 0) return configured;

  // Respect an explicit, already-diverse, still-connected review choice.
  if (
    configured.provider !== authorProvider &&
    connectedAlternates.includes(configured.provider)
  ) {
    return configured;
  }

  const chosen = connectedAlternates[0];
  if (!chosen) return configured;

  // Reuse a model the user already configured for the chosen provider.
  for (const agentType of AGENT_TYPES_WITH_SETTINGS) {
    const s = settings[agentType];
    if (s.provider === chosen) {
      return { provider: chosen, model: s.model, effort: s.effort };
    }
  }

  const { modelId, defaultEffort } = await firstLiveModel(chosen, userId);
  const fallback = defaultSettingForProvider(chosen, modelId, defaultEffort);
  // No live model id for the alternate — fall back to the configured review
  // setting rather than starting a run with no model.
  return fallback ?? configured;
}

/**
 * Convenience wrapper for the provider-connect routes: seed-on-connect that
 * never throws, so a seeding hiccup can't turn a successful connect into an
 * error response. Safe to call after every successful credential write.
 */
export async function seedAgentSettingsAfterConnect(userId: number): Promise<void> {
  try {
    await ensureUserAgentModelSettings(userId);
  } catch (err) {
    console.error('[agentModelSettings] seed-on-connect failed for user', userId, err);
  }
}

/**
 * Resolve the (model, effort) to resume a conversation with. Re-resolves from
 * the RESUMING user's per-user setting for the conversation's agent type — but
 * only when that setting targets the SAME provider (provider is session-bound
 * and can't be switched on resume). Falls back to the conversation's stored
 * model/effort for: programmatic resumes (no userId), manual conversations
 * (no agent run), an unseeded resuming user, or a provider mismatch.
 */
export function resolveResumeModelEffort(
  conversation: Pick<ConversationRow, 'id' | 'provider' | 'model' | 'effort'>,
  userId: number | undefined,
): { model: string | null; effort: string | null } {
  const stored = { model: conversation.model, effort: conversation.effort };
  if (userId == null) return stored;

  const agentRun = agentRunsDb.getByConversationId(conversation.id);
  if (!agentRun || !isAgentTypeWithSettings(agentRun.agent_type)) return stored;

  let settings: AgentModelSettings;
  try {
    settings = loadAgentModelSettings(userId);
  } catch {
    // Resuming user is unseeded/invalid — don't break resume.
    return stored;
  }

  const setting = settings[agentRun.agent_type];
  if (setting.provider !== conversation.provider) return stored;
  return { model: setting.model, effort: setting.effort };
}
