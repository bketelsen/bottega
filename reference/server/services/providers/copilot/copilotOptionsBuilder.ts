// Map generic `ProviderRunOptions` onto the Copilot SDK's session/message
// shapes.
//
// Reference: `node_modules/@github/copilot-sdk/dist/types.d.ts`
//   - `SessionConfig` (createSession): model, workingDirectory,
//     reasoningEffort, onPermissionRequest, ...
//   - `MessageOptions` (send): prompt, agentMode, ...
//
// The persisted model id is `copilot/<bareModelId>`; `parseCopilotModel`
// strips the prefix to the bare id the SDK consumes (mirrors
// `parseOpenCodeModel`).

import { approveAll } from '@github/copilot-sdk';
import type {
  MessageOptions,
  ResumeSessionConfig,
  SessionConfig,
} from '@github/copilot-sdk';
import type { ProviderRunOptions } from '@shared/providers/types';

// The SDK's `ReasoningEffort` union is not re-exported at the package root,
// so we mirror it locally. Values are structurally assignable to the SDK's
// `SessionConfig.reasoningEffort` field.
type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export class InvalidCopilotModelError extends Error {
  constructor(received: string | undefined) {
    super(
      `Invalid Copilot model identifier: ${
        received === undefined || received === ''
          ? '<empty>'
          : JSON.stringify(received)
      }. Expected the canonical persisted form 'copilot/<modelId>'.`,
    );
    this.name = 'InvalidCopilotModelError';
  }
}

export interface ParsedCopilotModel {
  modelId: string;
}

/**
 * Parse the canonical persisted form `'copilot/<modelId>'` into the bare
 * `modelId` the SDK's `createSession({ model })` expects.
 *
 * `parseCopilotModel('copilot/gpt-5')` → `{ modelId: 'gpt-5' }`.
 *
 * @throws InvalidCopilotModelError if `model` is empty or unprefixed.
 */
export function parseCopilotModel(model: string): ParsedCopilotModel {
  if (!model) throw new InvalidCopilotModelError(model);
  const idx = model.indexOf('/');
  if (idx < 0) throw new InvalidCopilotModelError(model);
  const prefix = model.slice(0, idx);
  const tail = model.slice(idx + 1);
  if (prefix !== 'copilot' || tail.length === 0) {
    throw new InvalidCopilotModelError(model);
  }
  return { modelId: tail };
}

// Copilot's reasoning effort vocabulary. Bottega's `copilot` provider has no
// separate effort dimension in v1 (the catalog is the model), but if a caller
// ever supplies one we forward only values the SDK accepts.
const COPILOT_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
];

function normalizeEffort(effort: string | null | undefined): ReasoningEffort | undefined {
  if (!effort) return undefined;
  return (COPILOT_REASONING_EFFORTS as readonly string[]).includes(effort)
    ? (effort as ReasoningEffort)
    : undefined;
}

/**
 * Build the `createSession` config. Permission requests are auto-approved
 * (`approveAll`) — Bottega runs Copilot in its task worktree under the same
 * bypass-by-default posture as the other providers; mid-turn permission
 * round-trips to the user are not wired in v1 (capability
 * `supportsAskUserQuestion = false`).
 */
export function buildCopilotSessionConfig(options: ProviderRunOptions): SessionConfig {
  const { modelId } = parseCopilotModel(options.model);
  const effort = normalizeEffort(options.effort);
  const config: SessionConfig = {
    clientName: 'bottega',
    model: modelId,
    workingDirectory: options.cwd,
    onPermissionRequest: approveAll,
    ...(options.customSystemPrompt
      ? { systemMessage: { mode: 'append', content: options.customSystemPrompt } }
      : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  };
  return config;
}

/**
 * Build the `resumeSession` config. The model is re-supplied on resume so the
 * turn is deterministic (the orchestrator reads it back off the conversation
 * row), matching the OpenCode resume contract.
 */
export function buildCopilotResumeConfig(
  options: ProviderRunOptions,
): ResumeSessionConfig {
  const { modelId } = parseCopilotModel(options.model);
  const effort = normalizeEffort(options.effort);
  const config: ResumeSessionConfig = {
    clientName: 'bottega',
    model: modelId,
    workingDirectory: options.cwd,
    onPermissionRequest: approveAll,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
  return config;
}

/**
 * Build the `session.send` argument. `plan` permission mode maps onto
 * Copilot's `agentMode: 'plan'` (read-only planning, never edits disk),
 * preserving the spirit of Anthropic's plan mode.
 */
export function buildCopilotMessage(options: ProviderRunOptions): MessageOptions {
  const prompt = options.prompt ?? '';
  return {
    prompt,
    ...(options.permissionMode === 'plan' ? { agentMode: 'plan' as const } : {}),
  };
}
