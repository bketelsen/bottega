import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedMessage } from '@shared/providers/types';

const completionHandler = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../../database/db.js', () => ({
  tasksDb: { getWithProject: vi.fn(), getById: vi.fn() },
  conversationsDb: {
    create: vi.fn(),
    getById: vi.fn(),
    updateClaudeId: vi.fn(),
    updateProviderSessionId: vi.fn(),
    updateModelEffort: vi.fn(),
    updateSessionPath: vi.fn(),
  },
  agentRunsDb: { getByTask: vi.fn(() => []), updateStatus: vi.fn() },
  userDb: { getUserById: vi.fn() },
  db: {},
}));

vi.mock('../agentModelSettings.js', () => ({
  resolveResumeModelEffort: vi.fn((conversation: { model: string | null; effort: string | null }) => ({
    model: conversation.model,
    effort: conversation.effort,
  })),
}));

vi.mock('../worktree.js', () => ({
  worktreeExists: vi.fn(async () => false),
  getWorktreeProjectPath: vi.fn((path: string) => path),
}));

vi.mock('../titleGenerator.js', () => ({ generateConversationTitle: vi.fn() }));
vi.mock('../contextUsageTracker.js', () => ({
  createContextUsageTracker: vi.fn(() => ({ onResult: vi.fn(async () => {}) })),
}));
vi.mock('../credentials/registry.js', () => ({
  getCredentialStore: vi.fn(() => ({ buildSdkEnv: () => ({ BOTTEGA_USER_ID: '1' }) })),
}));
vi.mock('../providers/copilot/index.js', () => ({
  copilotProvider: { startTurn: vi.fn(), sendTurnMessage: vi.fn(), abortTurn: vi.fn(() => false) },
}));
vi.mock('../providers/copilot/messageMirror.js', () => ({ mirrorCopilotEvent: vi.fn(async () => {}) }));
vi.mock('./media.js', () => ({
  handleImages: vi.fn(async (message: string) => ({
    modifiedCommand: message,
    tempImagePaths: [],
    tempDir: null,
  })),
  cleanupTempFiles: vi.fn(async () => {}),
  handleVideoRecording: vi.fn(async () => {}),
}));
vi.mock('./slashCommands.js', () => ({ resolveSlashCommand: vi.fn(async (message: string | null) => message) }));
vi.mock('./agentRunLifecycle.js', () => ({
  buildAgentRunCompletionHandler: vi.fn(() => completionHandler),
}));

import { conversationsDb, tasksDb } from '../../database/db.js';
import { copilotProvider } from '../providers/copilot/index.js';
import { startCopilotConversation } from './startCopilotConversation.js';

const SID = 'copilot-session';

function buildFakeRun(events: UnifiedMessage[]) {
  return {
    providerSessionId$: Promise.resolve(SID),
    abort: vi.fn(),
    pid: null,
    async *events() {
      for (const event of events) yield event;
    },
  };
}

async function waitForCompletion(): Promise<void> {
  const started = Date.now();
  while (completionHandler.mock.calls.length === 0) {
    if (Date.now() - started > 1500) throw new Error('timed out waiting for completion');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('startCopilotConversation termination outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tasksDb.getWithProject).mockReturnValue({
      id: 1,
      project_id: 7,
      repo_folder_path: '/repo',
      user_id: 1,
    } as never);
    vi.mocked(conversationsDb.create).mockReturnValue({ id: 11 } as never);
  });

  it.each([
    {
      name: 'session.idle',
      events: [{
        type: 'result', id: 'idle', provider: 'copilot', providerSessionId: SID,
        raw: { type: 'session.idle' }, isError: false,
      }] as UnifiedMessage[],
      outcome: 'success',
    },
    {
      name: 'mapped error',
      events: [{
        type: 'result', id: 'error', provider: 'copilot', providerSessionId: SID,
        raw: { type: 'session.error' }, isError: true,
      }] as UnifiedMessage[],
      outcome: 'error',
    },
    {
      name: 'EOF without session.idle',
      events: [{
        type: 'assistant', id: 'assistant', provider: 'copilot', providerSessionId: SID,
        raw: null, text: 'partial', isSubAgent: false,
      }] as UnifiedMessage[],
      outcome: 'error',
    },
  ])('reports $outcome for $name', async ({ events, outcome }) => {
    const fakeRun = buildFakeRun(events);
    vi.mocked(copilotProvider.startTurn).mockResolvedValueOnce({
      providerSessionId$: fakeRun.providerSessionId$,
      abort: fakeRun.abort,
      pid: null,
      events: fakeRun.events(),
    });

    await startCopilotConversation(1, 'hi', {
      userId: 1,
      provider: 'copilot',
      model: 'copilot/gpt-5',
    });
    await waitForCompletion();

    expect(completionHandler).toHaveBeenCalledWith(outcome);
  });
});
