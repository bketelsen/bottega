// Copilot-flavoured `startConversation` — the fourth-provider branch of the
// orchestrator.
//
// Structurally identical to `startOpenCodeConversation.ts`: Copilot, like
// OpenCode, runs on a long-lived per-user client (pooled), resolves its
// session id synchronously (`client.createSession` returns it before any
// event lands), and threads the user id through `options.env`
// (`BOTTEGA_USER_ID`). The differences are cosmetic — the provider singleton,
// the credential store name, the mirror, and the `copilot/<id>` model prefix.
//
// What this branch does NOT do (capability flags): no AskUserQuestion, no MCP
// wait, no image attachments, no live context-usage breakdown. Copilot DOES
// emit reasoning deltas (`supportsThinkingDelta`), which flow through as
// `stream_delta` UnifiedMessages and are rendered by the existing path.

import { promises as fs } from 'fs';
import { conversationsDb, tasksDb } from '../../database/db.js';
import { resolveResumeModelEffort } from '../agentModelSettings.js';
import { getWorktreeProjectPath, worktreeExists } from '../worktree.js';
import { generateConversationTitle } from '../titleGenerator.js';
import { createContextUsageTracker } from '../contextUsageTracker.js';
import { getCredentialStore } from '../credentials/registry.js';
import { copilotProvider } from '../providers/copilot/index.js';
import { mirrorCopilotEvent } from '../providers/copilot/messageMirror.js';
import { activeSessions } from './sessionState.js';
import { validateAndNormalizeOptions } from './sdkOptions.js';
import { handleImages, cleanupTempFiles, handleVideoRecording } from './media.js';
import {
  handleStreamingStarted,
  handleStreamingComplete,
  composeAsync,
} from './streamingLifecycle.js';
import { buildAgentRunCompletionHandler } from './agentRunLifecycle.js';
import { resolveSlashCommand } from './slashCommands.js';
import type { ConversationOptions, ProviderTerminationOutcome, StreamingContext } from './types.js';
import type { BroadcastFn } from '@shared/websocket/messages';
import type { UnifiedMessage } from '@shared/providers/types';

function composeOnComplete(ctx: StreamingContext): (outcome: ProviderTerminationOutcome) => Promise<void> {
  return composeAsync<ProviderTerminationOutcome>(
    () => handleStreamingComplete(ctx),
    buildAgentRunCompletionHandler(ctx),
  );
}

function isCopilotSuccess(unified: UnifiedMessage): boolean {
  return unified.type === 'result' &&
    !unified.isError &&
    (unified.raw as { type?: string } | null)?.type === 'session.idle';
}

function unifiedToWireMessage(unified: UnifiedMessage): Record<string, unknown> | null {
  switch (unified.type) {
    case 'user':
      return {
        type: 'user',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        message: { role: 'user', content: unified.content },
      };
    case 'assistant':
      return {
        type: 'assistant',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        parent_tool_use_id: unified.isSubAgent ? '__copilot_subagent__' : null,
        message: {
          id: unified.id,
          model: unified.model ? `copilot/${unified.model.replace(/^copilot\//, '')}` : null,
          ...(unified.usage ? { usage: unified.usage } : {}),
          content: [{ type: 'text', text: unified.text }],
        },
      };
    case 'tool_use':
      return {
        type: 'assistant',
        uuid: `${unified.id}:wire`,
        session_id: unified.providerSessionId,
        parent_tool_use_id: null,
        message: {
          id: unified.id,
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
        type: 'user',
        uuid: `${unified.id}:wire`,
        session_id: unified.providerSessionId,
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
        type: 'assistant',
        uuid: `${unified.id}:thinking`,
        session_id: unified.providerSessionId,
        parent_tool_use_id: null,
        message: {
          id: unified.id,
          content: [{ type: 'thinking', thinking: unified.text }],
        },
      };
    case 'result':
      return {
        type: 'result',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        is_error: unified.isError,
        ...(unified.usage ? { usage: unified.usage } : {}),
        ...(unified.errors ? { errors: unified.errors } : {}),
      };
    case 'system':
      return {
        type: 'system',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        subtype: unified.subtype ?? 'copilot',
      };
    case 'stream_delta':
      return null;
  }
}

function broadcastUnified(
  broadcastFn: BroadcastFn | undefined,
  conversationId: number,
  unified: UnifiedMessage,
): void {
  if (!broadcastFn) return;
  const wire = unifiedToWireMessage(unified);
  if (!wire) return;
  broadcastFn(conversationId, {
    type: 'ai-response',
    data: wire as never,
    provider: 'copilot',
  });
  broadcastFn(conversationId, {
    type: 'claude-response',
    data: wire as never,
  });
}

/**
 * Resume an existing Copilot conversation. Mirrors `sendOpenCodeMessage`.
 */
export async function sendCopilotMessage(
  conversationId: number,
  message: string | null,
  options: ConversationOptions = {},
): Promise<void> {
  const normalizedOptions = validateAndNormalizeOptions(options, 'sendCopilotMessage');
  const { broadcastFn, broadcastToTaskSubscribersFn, userId, permissionMode } =
    normalizedOptions;

  const conversation = conversationsDb.getById(conversationId);
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }
  const resumeSessionId =
    conversation.provider_session_id ?? conversation.claude_conversation_id;
  if (!resumeSessionId) {
    throw new Error(
      `Copilot conversation ${conversationId} has no provider_session_id yet`,
    );
  }

  const taskId = conversation.task_id;
  const taskWithProject = taskId ? tasksDb.getWithProject(taskId) : null;
  if (!taskWithProject) {
    throw new Error(`Task for conversation ${conversationId} not found`);
  }
  const projectId = taskWithProject.project_id;

  let projectPath: string;
  if (conversation.session_path) {
    projectPath = conversation.session_path;
  } else {
    projectPath = taskWithProject.repo_folder_path;
    if (await worktreeExists(projectPath, taskId)) {
      projectPath = getWorktreeProjectPath(
        projectPath,
        taskId,
        taskWithProject.subproject_path,
      );
    }
  }

  const copilotEnv = getCredentialStore('copilot').buildSdkEnv(userId);
  const promptText = message ?? '';

  const userOverride = resolveResumeModelEffort(conversation, userId);
  const model = normalizedOptions.model ?? userOverride.model;
  if (!model) {
    throw new Error(`Conversation ${conversationId} has no stored model to resume with`);
  }
  if (model !== conversation.model) {
    conversationsDb.updateModelEffort(conversationId, model, conversation.effort);
  }

  const abortController = new AbortController();
  const run = await copilotProvider.sendTurnMessage({
    cwd: projectPath,
    prompt: promptText,
    resumeSessionId,
    model,
    effort: null,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    env: copilotEnv,
    abortController,
  });

  const ctx: StreamingContext = {
    conversationId,
    taskId: taskId ?? undefined,
    claudeSessionId: resumeSessionId,
    userId,
    broadcastFn,
    broadcastToTaskSubscribersFn,
    isNewSession: false,
  };

  activeSessions.set(resumeSessionId, {
    instance: run,
    abortController,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths: [],
    tempDir: null,
    conversationId,
    taskId: taskId ?? null,
    projectId,
    userId: userId ?? null,
  });

  handleStreamingStarted(ctx);

  const contextUsageTracker = createContextUsageTracker({
    conversationId,
    broadcastFn,
  });

  try {
    let outcome: ProviderTerminationOutcome = 'error';
    for await (const unified of run.events) {
      broadcastUnified(broadcastFn, conversationId, unified);
      await mirrorCopilotEvent(
        { projectFolderPath: projectPath, providerSessionId: resumeSessionId },
        unified,
      ).catch((err) => {
        console.warn('[ConversationAdapter] Copilot resume mirror failed:', err);
      });
      if (unified.type === 'result') {
        outcome = isCopilotSuccess(unified) ? 'success' : 'error';
        await contextUsageTracker.onResult({
          type: 'result',
          ...(unified.usage ? { modelUsage: { copilot: unified.usage } } : {}),
        } as never);
      }
    }

    activeSessions.delete(resumeSessionId);
    if (broadcastFn && outcome === 'success') {
      broadcastFn(conversationId, {
        type: 'claude-complete',
        sessionId: resumeSessionId,
        exitCode: 0,
        isNewSession: false,
      });
    }
    await composeOnComplete(ctx)(abortController.signal.aborted && outcome !== 'success' ? 'aborted' : outcome);
  } catch (error) {
    console.error('[ConversationAdapter] Copilot resume error:', error);
    activeSessions.delete(resumeSessionId);
    if (broadcastFn) {
      const errMsg = error instanceof Error ? error.message : String(error);
      broadcastFn(conversationId, {
        type: 'claude-error',
        error: errMsg,
      });
    }
    await composeOnComplete(ctx)(abortController.signal.aborted ? 'aborted' : 'error');
    throw error;
  }
}

export async function startCopilotConversation(
  taskId: number,
  message: string,
  options: ConversationOptions = {},
): Promise<{ conversationId: number; claudeSessionId: string }> {
  const normalizedOptions = validateAndNormalizeOptions(options, 'startCopilotConversation');
  const {
    broadcastFn,
    broadcastToTaskSubscribersFn,
    userId,
    permissionMode,
    images,
    customSystemPrompt,
    videoConfig,
  } = normalizedOptions;

  // Copilot turns always run on an explicit `copilot/<id>` model. Copilot has
  // no effort dimension in v1, so effort is always null.
  const model = normalizedOptions.model;
  if (!model) {
    throw new Error('startCopilotConversation requires an explicit model');
  }

  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} not found`);
  }

  let projectPath = taskWithProject.repo_folder_path;
  if (await worktreeExists(projectPath, taskId)) {
    projectPath = getWorktreeProjectPath(projectPath, taskId, taskWithProject.subproject_path);
  }

  // Per-user Copilot env (tags BOTTEGA_USER_ID). Throws if the user has no
  // provisioned token, matching the other providers' fail-closed posture.
  const copilotEnv = getCredentialStore('copilot').buildSdkEnv(userId);

  let conversationId = options.conversationId;
  if (!conversationId) {
    const conversation = conversationsDb.create(taskId, 'copilot', model, null);
    conversationId = conversation.id;
    console.log(
      `[ConversationAdapter] Created Copilot conversation ${conversationId} for task ${taskId} (model=${model})`,
    );
  }

  const imageResult = images && images.length > 0
    ? await handleImages(message, images, projectPath)
    : { modifiedCommand: message, tempImagePaths: [] as string[], tempDir: null };
  // Copilot v1 is text-only — images are silently stripped.
  const finalMessageRaw = imageResult.modifiedCommand;
  const finalMessage = await resolveSlashCommand(finalMessageRaw, projectPath);
  const promptText = (finalMessage ?? message) +
    (customSystemPrompt ? `\n\n[System]\n${customSystemPrompt}` : '');

  const abortController = new AbortController();

  const run = await copilotProvider.startTurn({
    cwd: projectPath,
    prompt: promptText,
    model,
    effort: null,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    env: copilotEnv,
    abortController,
  });

  const { tempImagePaths, tempDir } = imageResult;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error('Copilot session creation timeout'));
    }, 60000);

    const ctx: StreamingContext = {
      conversationId: conversationId,
      taskId,
      claudeSessionId: null,
      userId,
      broadcastFn,
      broadcastToTaskSubscribersFn,
      isNewSession: true,
      videoConfig,
    };

    const contextUsageTracker = createContextUsageTracker({
      conversationId: conversationId,
      broadcastFn,
    });

    // Copilot resolves the session id synchronously inside startTurn
    // (createSession returns it before any event lands), so the first
    // emitted UnifiedMessage already carries `providerSessionId`. The
    // pre-session buffer is a defensive no-op in case that contract changes.
    const preSessionBuffer: UnifiedMessage[] = [];

    void (async () => {
      try {
        let outcome: ProviderTerminationOutcome = 'error';
        for await (const unified of run.events) {
          if (
            !resolved &&
            unified.providerSessionId &&
            ctx.claudeSessionId === null
          ) {
            const sid = unified.providerSessionId;
            ctx.claudeSessionId = sid;
            conversationsDb.updateClaudeId(conversationId, sid);
            conversationsDb.updateProviderSessionId(conversationId, sid);
            conversationsDb.updateSessionPath(conversationId, projectPath);
            activeSessions.set(sid, {
              instance: run,
              abortController,
              startTime: Date.now(),
              status: 'active',
              tempImagePaths,
              tempDir,
              conversationId: conversationId,
              taskId,
              projectId: taskWithProject.project_id,
              userId: userId ?? null,
            });

            generateConversationTitle(
              conversationId,
              message,
              broadcastFn,
              userId,
              taskId,
              broadcastToTaskSubscribersFn,
            );

            handleStreamingStarted(ctx);

            if (broadcastFn) {
              broadcastFn(conversationId, {
                type: 'conversation-created',
                conversationId: conversationId,
                claudeSessionId: sid,
              });
              broadcastFn(conversationId, {
                type: 'session-created',
                sessionId: sid,
              });
            }
            if (broadcastToTaskSubscribersFn) {
              broadcastToTaskSubscribersFn(taskId, {
                type: 'conversation-added',
                conversation: {
                  id: conversationId,
                  task_id: taskId,
                  claude_conversation_id: sid,
                  created_at: new Date().toISOString(),
                },
              });
            }

            clearTimeout(timeout);
            resolved = true;
            resolve({ conversationId: conversationId, claudeSessionId: sid });
          }

          broadcastUnified(broadcastFn, conversationId, unified);

          if (ctx.claudeSessionId) {
            if (preSessionBuffer.length > 0) {
              const sid = ctx.claudeSessionId;
              for (const buffered of preSessionBuffer) {
                const patched = { ...buffered, providerSessionId: sid };
                await mirrorCopilotEvent(
                  { projectFolderPath: projectPath, providerSessionId: sid },
                  patched,
                ).catch((err) => {
                  console.warn('[ConversationAdapter] Copilot mirror failed (buffered):', err);
                });
              }
              preSessionBuffer.length = 0;
            }
            await mirrorCopilotEvent(
              {
                projectFolderPath: projectPath,
                providerSessionId: ctx.claudeSessionId,
              },
              unified,
            ).catch((err) => {
              console.warn('[ConversationAdapter] Copilot mirror failed:', err);
            });
          } else {
            preSessionBuffer.push(unified);
          }

          if (unified.type === 'result') {
            outcome = isCopilotSuccess(unified) ? 'success' : 'error';
            await contextUsageTracker.onResult({
              type: 'result',
              ...(unified.usage ? { modelUsage: { copilot: unified.usage } } : {}),
            } as never);
          }
        }

        if (ctx.claudeSessionId) {
          activeSessions.delete(ctx.claudeSessionId);
        }
        await cleanupTempFiles(tempImagePaths, tempDir);
        if (ctx.videoConfig) {
          await handleVideoRecording(ctx.videoConfig);
        }

        if (broadcastFn && outcome === 'success') {
          broadcastFn(conversationId, {
            type: 'claude-complete',
            sessionId: ctx.claudeSessionId,
            exitCode: 0,
            isNewSession: true,
          });
        }

        await composeOnComplete(ctx)(abortController.signal.aborted && outcome !== 'success' ? 'aborted' : outcome);
      } catch (error) {
        console.error('[ConversationAdapter] Copilot streaming error:', error);
        if (ctx.claudeSessionId) {
          activeSessions.delete(ctx.claudeSessionId);
        }
        await cleanupTempFiles(tempImagePaths, tempDir);
        if (ctx.videoConfig?.tempDir) {
          await fs.rm(ctx.videoConfig.tempDir, { recursive: true, force: true }).catch(() => {});
        }

        if (!resolved) {
          clearTimeout(timeout);
          await composeOnComplete(ctx)(abortController.signal.aborted ? 'aborted' : 'error');
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (broadcastFn) {
          const errMsg = error instanceof Error ? error.message : String(error);
          broadcastFn(conversationId, {
            type: 'claude-error',
            error: errMsg,
          });
        }
        await composeOnComplete(ctx)(abortController.signal.aborted ? 'aborted' : 'error');
      }
    })();
  });
}
