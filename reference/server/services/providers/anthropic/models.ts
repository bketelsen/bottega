import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import { buildClaudeSdkEnv } from '../../claudeCredentials.js';

const MODEL_LIST_TIMEOUT_MS = 15_000;

export interface ClaudeModelListEntry {
  id: string;
  name: string;
  description: string;
  supportedEfforts: string[];
  defaultEffort: string | null;
}

export function mapClaudeModels(models: ModelInfo[]): ClaudeModelListEntry[] {
  return models.map((model) => ({
    id: model.value,
    name: model.displayName,
    description: model.description,
    supportedEfforts: model.supportedEffortLevels ?? [],
    defaultEffort: model.supportedEffortLevels?.includes('high')
      ? 'high'
      : (model.supportedEffortLevels?.[0] ?? null),
  }));
}

export async function listClaudeModels(userId: number): Promise<ClaudeModelListEntry[]> {
  async function* idlePrompt(): AsyncGenerator<never, void, unknown> {
    yield* [] as never[];
  }

  const abortController = new AbortController();
  const queryInstance = query({
    prompt: idlePrompt(),
    options: {
      env: buildClaudeSdkEnv(userId),
      settingSources: [],
      abortController,
    },
  });
  const timeout = setTimeout(() => abortController.abort(), MODEL_LIST_TIMEOUT_MS);

  try {
    return mapClaudeModels(await queryInstance.supportedModels());
  } finally {
    clearTimeout(timeout);
    queryInstance.close();
  }
}
