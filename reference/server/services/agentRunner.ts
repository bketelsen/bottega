/**
 * Agent Runner Service
 *
 * Manages agent runs - creating records, linking to conversations,
 * and initiating streaming via the ConversationAdapter.
 *
 * Agent lifecycle (status updates, chaining) is handled centrally
 * by the ConversationAdapter when streaming completes.
 */

import { tasksDb, agentRunsDb, conversationsDb, projectsDb, userDb, appSettingsDb } from '../database/db.js';
import { startConversation } from './conversationAdapter.js';
import { updateUserBadge } from './notifications.js';
import { buildContextPrompt, getTaskDocPath } from './documentation.js';
import { getPullRequestStatus, rebaseOnMain } from './worktree.js';
import { getCredentialStore } from './credentials/registry.js';
import { ProviderCredentialsMissingError } from './credentials/types.js';
import type { AgentModelSetting } from '../../shared/types/agentModelSettings.js';
import {
  generateImplementationMessage,
  generateReviewMessage,
  generateRefinementMessage,
  generatePlanificationMessage,
  generatePrAgentMessage,
  generatePrAgentCommentMessage,
  generatePrAgentReviewMessage,
  generateYoloMessage,
} from '../constants/agentPrompts.js';
import { loadAgentModelSettings, resolveReviewAgentSetting } from './agentModelSettings.js';
import type { AgentRunRow, CreatedConversation } from '../database/db.js';
import type {
  AgentType,
  BroadcastFn,
  BroadcastToTaskSubscribersFn,
} from '@shared/websocket/messages';
import { assertCapability } from './github/capabilities.js';

export interface StartAgentRunOptions {
  broadcastFn?: BroadcastFn | undefined;
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
  userId?: number | undefined;
  webhookContext?: {
    comments?: unknown;
    [key: string]: unknown;
  } | undefined;
}

type AgentRunnerBroadcastDefaults = Pick<
  StartAgentRunOptions,
  'broadcastFn' | 'broadcastToTaskSubscribersFn'
>;

let broadcastDefaults: AgentRunnerBroadcastDefaults = {};

export function configureAgentRunnerBroadcastDefaults(
  defaults: AgentRunnerBroadcastDefaults,
): void {
  broadcastDefaults = { ...defaults };
}

export interface StartAgentRunResult {
  agentRun: AgentRunRow;
  conversation: CreatedConversation;
  claudeSessionId: string;
}

export class AgentAlreadyRunningError extends Error {
  constructor(public readonly runningAgent: AgentRunRow | null) {
    super('An agent is already running for this task');
    this.name = 'AgentAlreadyRunningError';
  }
}

function assertPrAgentCapability(projectId: number, userId: number | undefined): void {
  if (userId == null) return;
  const project = projectsDb.getById(projectId, userId);
  if (!project?.github_repo) return;
  assertCapability(project, 'push');
  assertCapability(project, 'createPR');
}

function isRunningAgentConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const sqliteError = error as { code?: string; message?: string };
  return (
    sqliteError.code?.startsWith('SQLITE_CONSTRAINT') === true
    && (
      sqliteError.message?.includes('task_agent_runs.task_id') === true
      || sqliteError.message?.includes('idx_task_agent_runs_one_running') === true
    )
  );
}

/**
 * Start an agent run for a task
 * Creates agent run record, conversation, and starts streaming via adapter
 */
export async function startAgentRun(
  taskId: number,
  agentType: AgentType,
  options: StartAgentRunOptions = {},
): Promise<StartAgentRunResult> {
  const {
    broadcastFn,
    broadcastToTaskSubscribersFn,
    userId,
  } = { ...broadcastDefaults, ...options };

  // Get task and project info
  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} not found`);
  }
  const effectiveUserId = userId ?? taskWithProject.user_id ?? undefined;

  // Task doc lives in the central archive, not the worktree — survives PR merge
  const taskDocPath = getTaskDocPath(taskWithProject.project_id, taskId);

  // Adversarial cross-model review decision (opt-in via `review_cross_model`).
  // Resolved once here so the review prompt (which tells the model it did NOT
  // write the code) and the run's actual provider stay in agreement. A real
  // cross-provider review only happens when an alternate connected provider
  // exists; single-provider users fall back to their configured review setting
  // and get the ordinary (non-adversarial) review prompt.
  let reviewOverride: AgentModelSetting | null = null;
  let reviewIsAdversarial = false;
  if (
    agentType === 'review' &&
    effectiveUserId != null &&
    appSettingsDb.getValue('review_cross_model') === 'true'
  ) {
    const authorProvider =
      agentRunsDb
        .getByTask(taskId)
        .find((r) => r.agent_type !== 'review')?.provider ?? null;
    reviewOverride = await resolveReviewAgentSetting(effectiveUserId, authorProvider);
    reviewIsAdversarial = authorProvider != null && reviewOverride.provider !== authorProvider;
    if (reviewIsAdversarial) {
      console.log(
        `[AgentRunner] Cross-model review: ${authorProvider} authored -> reviewing with ${reviewOverride.provider}`,
      );
    }
  }

  // Generate message based on agent type
  let message: string;
  switch (agentType) {
    case 'planification': {
      // Tech-vs-non-tech follows the user *triggering* the run, not the
      // task creator. effectiveUserId already falls back to the task owner
      // when no acting user is supplied (programmatic callers).
      const actor = effectiveUserId ? userDb.getUserById(effectiveUserId) : null;
      const actorIsTechnical = actor ? actor.is_technical !== 0 : true;
      message = await generatePlanificationMessage(taskDocPath, taskId, actorIsTechnical);
      break;
    }
    case 'implementation':
      message = await generateImplementationMessage(taskDocPath, taskId);
      break;
    case 'review':
      message = await generateReviewMessage(taskDocPath, taskId, reviewIsAdversarial);
      break;
    case 'refinement':
      message = await generateRefinementMessage(taskDocPath, taskId);
      break;
    case 'pr': {
      assertPrAgentCapability(taskWithProject.project_id, effectiveUserId);
      // Before the PR agent runs, deterministically bring the branch up to
      // date with origin/<main>. A task can sit behind main after a long
      // implement⇄review loop; a clean rebase here means the PR is mergeable
      // without relying on the model. If the rebase hits conflicts it is
      // safely aborted (see rebaseOnMain) and the PR prompt resolves them.
      const rebaseResult = await rebaseOnMain(
        taskWithProject.repo_folder_path,
        taskId,
        { projectId: taskWithProject.project_id },
      );
      if (rebaseResult.success) {
        console.log(`[AgentRunner] Rebased task ${taskId} branch onto main before PR agent`);
      } else if (rebaseResult.conflicts) {
        console.log(
          `[AgentRunner] Rebase of task ${taskId} hit conflicts; PR agent will resolve them`,
        );
      } else {
        console.warn(
          `[AgentRunner] Could not rebase task ${taskId} before PR agent: ${rebaseResult.error}`,
        );
      }

      // IMPORTANT: Use main repo path (not worktree path) for getPullRequestStatus
      // getPullRequestStatus internally derives the worktree path from repo + taskId
      const prStatus = await getPullRequestStatus(
        taskWithProject.repo_folder_path,
        taskId,
        { projectId: taskWithProject.project_id },
      );
      const prUrl = prStatus.exists ? prStatus.url ?? null : null;

      // Use review-specific prompt if triggered by webhook with review comments
      // Use comment-specific prompt if triggered by webhook with single comment context
      const webhookCtx = options.webhookContext;
      if (webhookCtx?.comments) {
        // Shape is validated by the webhook route (commit 5: zod boundary).
        message = await generatePrAgentReviewMessage(taskDocPath, taskId, prUrl, webhookCtx as never);
      } else if (webhookCtx) {
        message = await generatePrAgentCommentMessage(taskDocPath, taskId, prUrl, webhookCtx as never);
      } else {
        message = await generatePrAgentMessage(taskDocPath, taskId, prUrl);
      }
      break;
    }
    case 'yolo': {
      const yoloPrStatus = await getPullRequestStatus(
        taskWithProject.repo_folder_path,
        taskId,
        { projectId: taskWithProject.project_id },
      );
      const yoloPrUrl = yoloPrStatus.exists ? yoloPrStatus.url ?? null : null;
      message = await generateYoloMessage(taskDocPath, taskId, yoloPrUrl);
      break;
    }
    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }

  // Resolve THIS USER's configured provider for this agent up-front so we can
  // (a) validate the right backend's credentials before we start
  // touching task state and (b) stamp the right provider on the new
  // task_agent_runs and conversations rows below. Settings are per-user; an
  // unseeded user throws (fail loud) rather than silently defaulting.
  if (effectiveUserId == null) {
    throw new Error(`Cannot start agent run for task ${taskId}: no acting user to resolve agent model settings`);
  }
  const agentSettings = loadAgentModelSettings(effectiveUserId)[agentType];
  let { provider, model, effort } = agentSettings;
  if (reviewOverride) {
    ({ provider, model, effort } = reviewOverride);
  }

  // Fail closed if the user has no credentials for the configured
  // provider. Surfaces as a typed ProviderCredentialsMissingError so
  // the route layer can render a "Connect <provider>" prompt rather
  // than a server-side stacktrace.
  try {
    getCredentialStore(provider).read(effectiveUserId);
  } catch (err) {
    throw new ProviderCredentialsMissingError(
      provider,
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }

  // The partial unique index makes this insert the authoritative reservation.
  // Pre-insert checks in callers are only an optimization.
  let agentRun: AgentRunRow;
  try {
    agentRun = agentRunsDb.create(taskId, agentType, null, provider);
  } catch (error) {
    if (isRunningAgentConstraintError(error)) {
      throw new AgentAlreadyRunningError(getRunningAgentForTask(taskId));
    }
    throw error;
  }
  console.log(
    `[AgentRunner] Created agent run ${agentRun.id} (${agentType}) for task ${taskId} (provider=${provider})`,
  );

  let conversationId: number | null = null;
  try {
    // Losing reservation races never reach this increment.
    tasksDb.incrementRunCount(taskId);

    // Set agent run status to 'running' immediately
    agentRunsDb.updateStatus(agentRun.id, 'running');
    agentRun.status = 'running';

    // Create conversation. Stamp the configured (provider, model, effort) so
    // follow-up messages dispatch to the right backend and resume on the exact
    // same model.
    const conversation = conversationsDb.create(taskId, provider, model, effort);
    conversationId = conversation.id;
    console.log(
      `[AgentRunner] Created conversation ${conversation.id} for task ${taskId} (provider=${provider}, model=${model})`,
    );

    // Link conversation to agent run
    agentRunsDb.linkConversation(agentRun.id, conversation.id);
    console.log(`[AgentRunner] Linked conversation ${conversation.id} to agent run ${agentRun.id}`);

    // Broadcast agent run created/running to task subscribers
    if (broadcastToTaskSubscribersFn) {
      broadcastToTaskSubscribersFn(taskId, {
        type: 'agent-run-updated',
        agentRun: {
          id: agentRun.id,
          status: 'running',
          agent_type: agentType,
          conversation_id: conversation.id,
        },
      });
    }

    // Update task status to 'in_progress' if it's currently 'pending'
    if (taskWithProject.status === 'pending') {
      tasksDb.update(taskId, { status: 'in_progress' });
      console.log(`[AgentRunner] Updated task ${taskId} status to in_progress`);

      // Send badge update notification (fire and forget)
      if (userId) {
        updateUserBadge(userId).catch((err: unknown) => {
          console.error('[AgentRunner] Failed to update badge:', err);
        });
      }
    }

    // Build context prompt from task markdown + input files (central archive)
    const contextPrompt = buildContextPrompt(taskWithProject.project_id, taskId);

    // Prevent implementation and yolo agents from delegating to sub-agents.
    const disallowedTools = agentType === 'implementation' || agentType === 'yolo' ? ['Agent'] : [];

    // Re-read capability state immediately before handing control to the agent.
    if (agentType === 'pr') {
      assertPrAgentCapability(taskWithProject.project_id, effectiveUserId);
    }

    // The adapter handles streaming lifecycle, status updates, and chaining.
    const { claudeSessionId } = await startConversation(taskId, message, {
      broadcastFn,
      broadcastToTaskSubscribersFn,
      userId: effectiveUserId,
      customSystemPrompt: contextPrompt,
      permissionMode: 'bypassPermissions',
      conversationId: conversation.id,
      provider,
      model,
      ...(effort !== null ? { effort } : {}),
      disallowedTools,
    });

    return { agentRun, conversation, claudeSessionId };
  } catch (error) {
    agentRunsDb.updateStatus(agentRun.id, 'failed');
    broadcastToTaskSubscribersFn?.(taskId, {
      type: 'agent-run-updated',
      agentRun: {
        id: agentRun.id,
        status: 'failed',
        agent_type: agentType,
        conversation_id: conversationId,
      },
    });
    throw error;
  }
}

/**
 * Check if an agent is currently running for a task
 */
export function getRunningAgentForTask(taskId: number): AgentRunRow | null {
  const allRuns = agentRunsDb.getByTask(taskId);
  return allRuns.find((r) => r.status === 'running') || null;
}

/**
 * Force-complete all running agent runs for a task
 * Used for recovery from stuck states
 */
export function forceCompleteRunningAgents(taskId: number): number {
  const agentRuns = agentRunsDb.getByTask(taskId);
  let count = 0;

  for (const run of agentRuns) {
    if (run.status === 'running') {
      agentRunsDb.updateStatus(run.id, 'completed');
      console.log(`[AgentRunner] Force-completed stuck agent run ${run.id}`);
      count++;
    }
  }

  return count;
}
