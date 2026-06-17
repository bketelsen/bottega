// CopilotProvider — implements `LlmProvider` for the GitHub Copilot SDK.
//
// Mirrors the structure of `OpenCodeProvider` (the closest analogue: a
// long-lived per-user client, not Codex's spawn-per-turn). Differences vs.
// the others:
//   - The Copilot session is an EventEmitter (`session.on(handler)`), not an
//     async iterable. We bridge it to `ProviderRunResult.events` through an
//     `AsyncPushQueue` (see `eventBridge.ts`).
//   - The `CopilotClient` is pooled per user (`clientPool.ts`); the GitHub
//     token is injected at client construction, never via env.
//
// As with OpenCode, the orchestrator passes the user id via the env
// (`BOTTEGA_USER_ID`, tagged in by the credential store's `buildSdkEnv`) so
// the shared `ProviderRunOptions` shape stays provider-neutral.

import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';

import { getCapabilities } from '@shared/providers/capabilities';
import type {
  ProviderCapabilities,
  ProviderRunOptions,
  ProviderRunResult,
  UnifiedMessage,
  UnifiedUserMessage,
} from '@shared/providers/types';
import type { LlmProvider, LoadTranscriptOptions } from '../types.js';

import { AsyncPushQueue } from './eventBridge.js';
import { createCopilotEventMapper } from './mapEvent.js';
import {
  buildCopilotMessage,
  buildCopilotResumeConfig,
  buildCopilotSessionConfig,
} from './copilotOptionsBuilder.js';
import {
  getOrSpawnCopilotClient,
  type CopilotClientHandle,
} from './clientPool.js';

interface ActiveCopilotSession {
  session: CopilotSession;
  abortController: AbortController;
}

const ACTIVE_SESSIONS = new Map<string, ActiveCopilotSession>();

function extractUserIdFromEnv(
  env: Record<string, string | undefined> | undefined,
): number {
  const raw = env?.['BOTTEGA_USER_ID'];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `CopilotProvider could not resolve user id from env (BOTTEGA_USER_ID=${
        raw === undefined ? '<unset>' : JSON.stringify(raw)
      }). The credential store's buildSdkEnv tags this in; routes that pass options.env must use it.`,
    );
  }
  return n;
}

function buildSyntheticUser(
  prompt: string,
  providerSessionId: string | null,
): UnifiedUserMessage {
  return {
    type: 'user',
    id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    provider: 'copilot',
    providerSessionId,
    raw: { type: 'user', content: prompt },
    content: prompt,
  };
}

/**
 * Wire the session's event callbacks into the push-queue, fire the prompt,
 * and tear everything down on the terminal event (`session.idle` /
 * `session.error`) or on abort. Returns nothing — the queue is the channel.
 */
function driveSession(
  session: CopilotSession,
  options: ProviderRunOptions,
  abortController: AbortController,
  queue: AsyncPushQueue<UnifiedMessage>,
): void {
  const mapper = createCopilotEventMapper(session.sessionId);
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    try {
      unsubscribe();
    } catch {
      // ignore
    }
    ACTIVE_SESSIONS.delete(session.sessionId);
    // Release the session's in-memory resources; on-disk state is preserved
    // so the conversation can be resumed later.
    void session.disconnect().catch(() => {});
    queue.close();
  };

  const unsubscribe = session.on((event: SessionEvent) => {
    if (finished) return;
    for (const unified of mapper.map(event)) {
      queue.push(unified);
    }
    const type = (event as { type?: string }).type;
    if (type === 'session.idle' || type === 'session.error') {
      finish();
    }
  });

  abortController.signal.addEventListener('abort', () => {
    if (finished) return;
    void session.abort().catch(() => {});
    finish();
  });

  // Fire the prompt. A rejected send is terminal — surface it through the
  // queue so the orchestrator's failed-streaming path fires.
  void session.send(buildCopilotMessage(options)).catch((err: unknown) => {
    if (finished) return;
    console.error('[CopilotProvider] session.send rejected', err);
    queue.fail(err instanceof Error ? err : new Error(String(err)));
  });
}

async function* streamUnified(
  session: CopilotSession,
  options: ProviderRunOptions,
  abortController: AbortController,
  resolveSessionId: (id: string) => void,
  capturePid: (pid: number | null) => void,
): AsyncGenerator<UnifiedMessage, void, unknown> {
  // The Copilot SDK never echoes the outgoing prompt back as an event, so —
  // like Codex and OpenCode — we synthesise the user-side row ourselves.
  resolveSessionId(session.sessionId);
  // The Copilot runtime subprocess is owned by the pooled client, not this
  // turn; no per-turn pid to surface.
  capturePid(null);
  yield buildSyntheticUser(options.prompt ?? '', session.sessionId);

  const queue = new AsyncPushQueue<UnifiedMessage>();
  driveSession(session, options, abortController, queue);

  for await (const unified of queue) {
    yield unified;
  }
}

export class CopilotProvider implements LlmProvider {
  readonly name = 'copilot' as const;

  getCapabilities(): ProviderCapabilities {
    return getCapabilities('copilot');
  }

  async startTurn(options: ProviderRunOptions): Promise<ProviderRunResult> {
    const userId = extractUserIdFromEnv(options.env);
    const handle = await getOrSpawnCopilotClient(userId);
    const session = await handle.client.createSession(
      buildCopilotSessionConfig(options),
    );
    return this.runOnSession(handle, session, options);
  }

  async sendTurnMessage(
    options: ProviderRunOptions & { resumeSessionId: string },
  ): Promise<ProviderRunResult> {
    const userId = extractUserIdFromEnv(options.env);
    const handle = await getOrSpawnCopilotClient(userId);
    const session = await handle.client.resumeSession(
      options.resumeSessionId,
      buildCopilotResumeConfig(options),
    );
    return this.runOnSession(handle, session, options);
  }

  private runOnSession(
    _handle: CopilotClientHandle,
    session: CopilotSession,
    options: ProviderRunOptions,
  ): ProviderRunResult {
    const abortController = options.abortController ?? new AbortController();
    let resolveSessionId!: (id: string) => void;
    const providerSessionId$ = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });
    void providerSessionId$.then((id) => {
      ACTIVE_SESSIONS.set(id, { session, abortController });
    });

    let pid: number | null = null;
    const capturePid = (p: number | null): void => {
      pid = p;
    };

    return {
      events: streamUnified(
        session,
        options,
        abortController,
        resolveSessionId,
        capturePid,
      ),
      providerSessionId$,
      abort: () => abortController.abort(),
      get pid() {
        return pid;
      },
    };
  }

  abortTurn(providerSessionId: string): boolean {
    const active = ACTIVE_SESSIONS.get(providerSessionId);
    if (!active) return false;
    active.abortController.abort();
    void active.session.abort().catch(() => {});
    ACTIVE_SESSIONS.delete(providerSessionId);
    return true;
  }

  async loadTranscript(options: LoadTranscriptOptions): Promise<UnifiedMessage[]> {
    // Copilot events are mirrored into the same `messages` SQLite table the
    // other providers use. Reuse the existing reader and re-stamp the
    // provider so downstream consumers don't see 'anthropic' on Copilot rows.
    const { loadAnthropicTranscript } = await import('../anthropic/sessionStore.js');
    const entries = await loadAnthropicTranscript(options);
    return entries.map((e) => ({ ...e, provider: 'copilot' }));
  }
}

export const copilotProvider = new CopilotProvider();

/**
 * Bottega-facing Copilot model record for the settings UI. `id` is the
 * Bottega-persisted form `copilot/<bareModelId>` — drop it straight into an
 * agent_model_settings row.
 */
export interface CopilotModelListEntry {
  id: string;
  bareModelId: string;
  name: string;
}

/**
 * Fetch the live Copilot model catalog for `userId` by reusing (or spawning)
 * their pooled client and calling `client.listModels()`. Throws the same
 * errors the pool does (missing token → typed credential error); callers
 * should surface those as 401-ish responses rather than 5xx.
 */
export async function listCopilotModels(
  userId: number,
): Promise<CopilotModelListEntry[]> {
  const handle = await getOrSpawnCopilotClient(userId);
  const models = await handle.client.listModels();
  const entries: CopilotModelListEntry[] = models.map((m) => ({
    id: `copilot/${m.id}`,
    bareModelId: m.id,
    name: m.name ?? m.id,
  }));
  entries.sort((a, b) => a.bareModelId.localeCompare(b.bareModelId));
  return entries;
}
