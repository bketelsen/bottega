// Per-provider model + effort shapes.
//
// Model catalogs are owned by each provider and fetched live for the current
// user. Persisted model ids remain valid strings even when a provider later
// removes them from its picker, so validation checks storage shape rather than
// freezing an upstream catalog here.
//
// Effort values remain protocol-level unions used for persisted-value shape
// validation. The model-specific subsets shown in the UI come from each live
// catalog.
//   - Anthropic efforts: low / medium / high / xhigh / max.
//   - OpenAI efforts: minimal / low / medium / high / xhigh
//     (mirrors the TS Codex SDK's `ModelReasoningEffort` union — see
//     `openai/codex/sdk/typescript/src/threadOptions.ts`).
//
// Per docs/opencode/00-context-decisions.md § R15 + § D5 + § D6:
//   - OpenCode models: curated subset of the Zen catalog, prefixed
//     'opencode/' for unambiguous persistence. The agent runner strips
//     the prefix before passing modelID to the SDK.
//   - OpenCode efforts: none — reasoning lives inside the modelID.

import type { Provider } from './types.js';

export const ANTHROPIC_MODELS = [] as const;
export type AnthropicModel = string;

export const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

export const OPENAI_MODELS = [] as const;
export type OpenAIModel = string;

export const OPENAI_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type OpenAIEffort = (typeof OPENAI_EFFORTS)[number];

// The Zen catalog is owned by OpenCode (≈40 models, churned by their
// team). Bottega does NOT hardcode it — the source of truth is the
// live OpenCode server's `GET /config/providers` endpoint, surfaced
// to the frontend via `GET /api/opencode-auth/models`. The settings
// UI fetches that list to populate its dropdown. Storage uses
// `opencode/<modelID>` (D5) so a row persisted today survives even
// after the upstream catalog changes.
//
// Why no enum: when this was a hand-curated list it contained ids
// Zen no longer serves (`qwen3-coder`, `kimi-k2-thinking`). The
// Phase 12.3 marquee run failed instantly with
// `Model not found: opencode/qwen3-coder`. See
// `feedback_no_guessing_external_lists` in the memory store.
export const OPENCODE_MODELS = [] as const;
// Storage shape: `opencode/<bare-modelID>`. The bare modelID is whatever
// Zen serves at any given time; we don't constrain it at the type level
// because doing so would re-create the problem this comment exists to
// prevent.
export type OpenCodeModel = `opencode/${string}`;

// OpenCode has no reasoning_effort dimension — reasoning is encoded into the
// modelID (e.g. `kimi-k2-thinking` is its own model). UI hides the effort
// dropdown when the array is empty.
export const OPENCODE_EFFORTS = [] as const;
export type OpenCodeEffort = never;

// Copilot mirrors OpenCode: the model catalog is owned upstream by GitHub
// (queried live from the started `CopilotClient`), so Bottega does NOT
// hardcode it. Storage uses `copilot/<modelID>` for unambiguous persistence;
// the provider strips the prefix before handing the bare model id to the SDK.
export const COPILOT_MODELS = [] as const;
export type CopilotModel = `copilot/${string}`;

// Copilot has no separate reasoning_effort dimension in v1 — reasoning is
// encoded in the chosen model. UI hides the effort dropdown when empty.
export const COPILOT_EFFORTS = [] as const;
export type CopilotEffort = never;

export const PROVIDERS = ['anthropic', 'openai', 'opencode', 'copilot'] as const;

/**
 * Return the model list for a provider. Used by the settings UI and
 * server-side validation when a settings entry's `provider` decides
 * which model namespace is in scope.
 */
export function modelsForProvider(provider: Provider): readonly string[] {
  if (provider === 'anthropic') return ANTHROPIC_MODELS;
  if (provider === 'openai') return OPENAI_MODELS;
  if (provider === 'copilot') return COPILOT_MODELS;
  return OPENCODE_MODELS;
}

export function effortsForProvider(provider: Provider): readonly string[] {
  if (provider === 'anthropic') return ANTHROPIC_EFFORTS;
  if (provider === 'openai') return OPENAI_EFFORTS;
  if (provider === 'copilot') return COPILOT_EFFORTS;
  return OPENCODE_EFFORTS;
}

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

export function isAnthropicModel(value: unknown): value is AnthropicModel {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('/');
}

export function isAnthropicEffort(value: unknown): value is AnthropicEffort {
  return typeof value === 'string' && (ANTHROPIC_EFFORTS as readonly string[]).includes(value);
}

export function isOpenAIModel(value: unknown): value is OpenAIModel {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('/');
}

export function isOpenAIEffort(value: unknown): value is OpenAIEffort {
  return typeof value === 'string' && (OPENAI_EFFORTS as readonly string[]).includes(value);
}

// Prefix-only check — the Zen catalog is dynamic (see the OPENCODE_MODELS
// comment). Anything past `opencode/` is opaque to Bottega; runtime
// validation happens at the SDK boundary where OpenCode itself returns
// `Model not found: ...` for an unknown ID.
export function isOpenCodeModel(value: unknown): value is OpenCodeModel {
  return typeof value === 'string' && value.startsWith('opencode/') && value.length > 'opencode/'.length;
}

export function isOpenCodeEffort(value: unknown): value is OpenCodeEffort {
  // OpenCode has no efforts — nothing satisfies this guard.
  void value;
  return false;
}

// Prefix-only check — the Copilot catalog is dynamic (see the COPILOT_MODELS
// comment). Anything past `copilot/` is opaque to Bottega; runtime validation
// happens at the SDK boundary where Copilot rejects an unknown model id.
export function isCopilotModel(value: unknown): value is CopilotModel {
  return typeof value === 'string' && value.startsWith('copilot/') && value.length > 'copilot/'.length;
}

export function isCopilotEffort(value: unknown): value is CopilotEffort {
  // Copilot has no efforts — nothing satisfies this guard.
  void value;
  return false;
}

/** True when `model` is a valid model for `provider`. */
export function isModelForProvider(
  provider: Provider,
  model: unknown,
): model is string {
  if (typeof model !== 'string') return false;
  // Prefixed providers keep their namespace check. Claude and Codex model ids
  // are unprefixed opaque values returned by their authenticated live catalog.
  if (provider === 'opencode') return isOpenCodeModel(model);
  if (provider === 'copilot') return isCopilotModel(model);
  if (provider === 'anthropic') return isAnthropicModel(model);
  return isOpenAIModel(model);
}

/** True when `effort` is a valid effort for `provider`. */
export function isEffortForProvider(
  provider: Provider,
  effort: unknown,
): effort is string {
  if (typeof effort !== 'string') return false;
  return effortsForProvider(provider).includes(effort);
}
