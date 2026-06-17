// Copilot transcript mirror.
//
// Persists each `UnifiedMessage` emitted by `CopilotProvider` into the same
// `messages` SQLite table the Anthropic/Codex/OpenCode paths write to via
// `sqliteSessionStore`. The frontend's `/api/conversations/:id/messages`
// reader fetches off that table, so reloaded Copilot conversations show their
// history exactly the same way the other providers do.
//
// SQLite is the single source of truth; the Copilot runtime keeps its own
// copy under `COPILOT_HOME` but the runtime deliberately does not read it.
// Mirror writes are idempotent on `uuid`.

import { sqliteSessionStore } from '../../sqliteSessionStore.js';
import { resolveProjectKey } from '../../conversationContentStore.js';
import type { UnifiedMessage } from '@shared/providers/types';

interface MirrorContext {
  /** cwd / worktree path used when the Copilot turn started. */
  projectFolderPath: string;
  /** Copilot session id; equals the conversation's `provider_session_id`. */
  providerSessionId: string;
}

function unifiedToTranscriptEntry(unified: UnifiedMessage): {
  uuid: string;
  type: string;
  timestamp: string;
  [key: string]: unknown;
} | null {
  const timestamp = new Date().toISOString();

  switch (unified.type) {
    case 'user':
      return {
        uuid: unified.id,
        type: 'user',
        timestamp,
        message: { role: 'user', content: unified.content },
      };
    case 'assistant': {
      // Copilot reports a bare model id (e.g. `gpt-5`); re-prefix to the
      // canonical persisted form for unambiguous usage attribution.
      const canonicalModel = unified.model
        ? unified.model.startsWith('copilot/')
          ? unified.model
          : `copilot/${unified.model}`
        : null;
      return {
        uuid: unified.id,
        type: 'assistant',
        timestamp,
        parent_tool_use_id: unified.isSubAgent ? '__copilot_subagent__' : null,
        message: {
          id: unified.id,
          role: 'assistant',
          model: canonicalModel,
          ...(unified.usage ? { usage: unified.usage } : {}),
          content: [{ type: 'text', text: unified.text }],
        },
      };
    }
    case 'tool_use':
      return {
        uuid: `${unified.id}:tool_use`,
        type: 'assistant',
        timestamp,
        message: {
          id: unified.id,
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: unified.toolUseId,
              name: unified.toolName,
              input: unified.toolInput,
            },
          ],
        },
      };
    case 'tool_result':
      return {
        uuid: `${unified.id}:tool_result`,
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: unified.toolUseId,
              content: unified.content,
              ...(unified.isError ? { is_error: true } : {}),
            },
          ],
        },
      };
    case 'assistant_thinking':
      return {
        uuid: `${unified.id}:thinking`,
        type: 'assistant',
        timestamp,
        message: {
          id: unified.id,
          role: 'assistant',
          content: [{ type: 'thinking', thinking: unified.text }],
        },
      };
    case 'result':
      return {
        uuid: unified.id,
        type: 'result',
        timestamp,
        is_error: unified.isError,
        ...(unified.usage ? { usage: unified.usage } : {}),
        ...(unified.errors ? { errors: unified.errors } : {}),
      };
    case 'system':
      return {
        uuid: unified.id,
        type: 'system',
        timestamp,
        subtype: unified.subtype ?? 'copilot',
      };
    case 'stream_delta':
      return null;
  }
}

/**
 * Append a single `UnifiedMessage` to the `messages` table under the Copilot
 * session id. Idempotent on `uuid`.
 */
export async function mirrorCopilotEvent(
  ctx: MirrorContext,
  unified: UnifiedMessage,
): Promise<void> {
  const entry = unifiedToTranscriptEntry(unified);
  if (!entry) return;
  await sqliteSessionStore.append(
    {
      projectKey: resolveProjectKey(ctx.projectFolderPath),
      sessionId: ctx.providerSessionId,
      subpath: '',
      provider: 'copilot',
    },
    [entry],
  );
}
