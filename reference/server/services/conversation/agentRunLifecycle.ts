// Agent-run-specific completion handling: status updates, broadcasts,
// chaining (implementation ↔ review loop, refinement → PR pipeline,
// planification auto-chain for non-technical users), and the push
// notification fired for any task conversation.
//
// Built as a hook factory matching the createContextUsageTracker pattern:
// `buildAgentRunCompletionHandler(ctx)` returns `(outcome) => Promise<void>`
// suitable for composition into a streaming loop's `onComplete` hook.
//
// `handleAgentChaining` uses dynamic `await import('../agentRunner.js')` —
// agentRunner imports startConversation, which transitively imports this
// module, so a static import would create a load-time cycle. Keep it
// dynamic.

import { tasksDb, agentRunsDb, userDb } from '../../database/db.js';
import { worktreeExists } from '../worktree.js';
import { notifyClaudeComplete } from '../notifications.js';
import type { ProviderTerminationOutcome, StreamingContext } from './types.js';
import type { AgentType } from '@shared/websocket/messages';

// Maximum number of agent iterations before auto-blocking (prevents infinite loops).
// Only affects automatic agent chaining, not manual conversations.
export const MAX_WORKFLOW_RUNS = 25;

/**
 * Build an `onComplete` handler for a streaming session. The returned
 * function:
 * 1. Looks up any linked agent run for this conversation.
 *    - If `status === 'running'`: persist the provider's authoritative
 *      outcome, completing and chaining only on success.
 *    - If `status === 'failed'`: the user already clicked Stop (which writes
 *      this synchronously in `abortSession`) → no-op. Don't chain.
 *    - Any other status: shouldn't happen at runtime; log and stop.
 * 2. Fires a push notification for any task conversation (whether or not
 *    there's a linked agent run).
 *
 * No-op if `ctx.taskId` is not set.
 */
export function buildAgentRunCompletionHandler(
  ctx: StreamingContext,
): (outcome: ProviderTerminationOutcome) => Promise<void> {
  return async function onAgentRunComplete(outcome): Promise<void> {
    const { conversationId, taskId, userId, broadcastToTaskSubscribersFn } = ctx;
    if (!taskId) return;

    const agentRuns = agentRunsDb.getByTask(taskId);
    const linkedAgentRun = agentRuns.find((r) => r.conversation_id === conversationId);

    let shouldChain = false;

    if (linkedAgentRun) {
      const { id: agentRunId, agent_type: agentType, status } = linkedAgentRun;
      // Read the task AFTER the turn so `planification_complete` reflects any
      // completion signal written during this turn.
      const completedTask = tasksDb.getById(taskId);

      const broadcastRunStatus = (nextStatus: 'completed' | 'failed'): void => {
        if (broadcastToTaskSubscribersFn) {
          broadcastToTaskSubscribersFn(taskId, {
            type: 'agent-run-updated',
            agentRun: {
              id: agentRunId,
              status: nextStatus,
              agent_type: agentType,
              conversation_id: conversationId,
            },
          });
        }
      };

      if (status === 'running') {
        // A planification turn that ends successfully WITHOUT the completion
        // signal is almost always the planner asking the user a clarifying
        // question. That is a non-terminal waiting state — NOT a failure — so
        // leave the run 'running' and let a reply in the same conversation
        // finish the plan (the `status === 'running'` branch will complete and
        // chain it on that turn). The user can still Stop the run to fail it.
        const awaitingClarification = outcome === 'success'
          && agentType === 'planification'
          && !completedTask?.planification_complete;

        if (awaitingClarification) {
          console.log(
            `[ConversationAdapter] Planning run ${agentRunId} awaiting clarification — run stays active`,
          );
        } else {
          const nextStatus = outcome === 'success' ? 'completed' : 'failed';
          agentRunsDb.updateStatus(agentRunId, nextStatus);
          console.log(`[ConversationAdapter] Agent run ${agentRunId} (${agentType}) ${nextStatus}`);
          broadcastRunStatus(nextStatus);

          if (outcome === 'success') {
            if (agentType === 'planification') {
              shouldChain = (await finalizePlanificationSuccess(taskId)).chain;
            } else if (agentType === 'pr') {
              try {
                const { finalizePrAgentRun } = await import('../github/finalize.js');
                const result = await finalizePrAgentRun(taskId, agentRunId);
                if (!result.success && !result.skipped) {
                  console.error(`[ConversationAdapter] Failed to finalize task ${taskId} PR: ${result.error}`);
                }
              } catch (err) {
                console.error(`[ConversationAdapter] Failed to finalize task ${taskId} PR:`, err);
              }
            } else if (agentType === 'yolo') {
              if (completedTask?.workflow_complete) {
                try {
                  const { ensureTaskPullRequest } = await import('../prService.js');
                  const result = await ensureTaskPullRequest(taskId);
                  if (!result.success) {
                    console.error(`[ConversationAdapter] Failed to publish YOLO task ${taskId}: ${result.error}`);
                  }
                } catch (err) {
                  console.error(`[ConversationAdapter] Failed to publish YOLO task ${taskId}:`, err);
                }
              }
            } else if (
              agentType === 'implementation' ||
              agentType === 'review' ||
              agentType === 'refinement'
            ) {
              shouldChain = true;
            }
          }
        }
      } else if (
        agentType === 'planification'
        && outcome === 'success'
        && (status === 'failed' || status === 'blocked')
        && completedTask?.planification_complete
      ) {
        // Recovery: an earlier turn — or the startup orphan-sweep after a
        // restart during the clarification wait — left this planning run
        // failed, but a later turn in the SAME conversation has now written
        // the plan and set planification_complete. Transition to completed and
        // resume chaining so the workflow isn't stranded.
        agentRunsDb.updateStatus(agentRunId, 'completed');
        console.log(
          `[ConversationAdapter] Recovered planning run ${agentRunId} to completed after clarification`,
        );
        broadcastRunStatus('completed');
        shouldChain = (await finalizePlanificationSuccess(taskId)).chain;
      } else {
        // status='failed' (user aborted) is the expected non-running case.
        // Anything else is a state we didn't model — log so it's visible.
        console.log(
          `[ConversationAdapter] Agent run ${agentRunId} (${agentType}) status='${status}' on stream end — no chain`,
        );
      }
    }

    if (shouldChain && linkedAgentRun) {
      await handleAgentChaining(taskId, linkedAgentRun.agent_type, ctx);
    }

    // Push notification for any task conversation (manual or agent-run-driven).
    // Sent even on abort — the user already knows they aborted, but reaching
    // a clean loop end is still something to notify about.
    if (userId) {
      const taskInfo = tasksDb.getById(taskId);
      const taskTitle = taskInfo?.title || null;
      const projectId = taskInfo?.project_id ?? null;
      const workflowComplete = !!taskInfo?.workflow_complete;
      const agentType = linkedAgentRun?.agent_type || null;

      notifyClaudeComplete(userId, taskTitle, taskId, conversationId, projectId, {
        agentType,
        workflowComplete,
      }).catch((err: unknown) => {
        console.error('[ConversationAdapter] Failed to send notification:', err);
      });
    }
  };
}

/**
 * Post-success handling for a planification run. GitHub-backed planning is
 * terminal here — human approval / reconciliation owns the transition to
 * implementation, so we sync the freshly-written plan up and do NOT chain.
 * Local (non-GitHub) planning chains straight into the implementation loop.
 */
async function finalizePlanificationSuccess(taskId: number): Promise<{ chain: boolean }> {
  const task = tasksDb.getById(taskId);
  if (task?.github_issue_number) {
    if (task.planification_complete) {
      try {
        const { syncPlannedTaskToGitHub } = await import('../github/reconcile.js');
        await syncPlannedTaskToGitHub(taskId);
      } catch (err) {
        console.error(`[ConversationAdapter] Failed to sync planned task ${taskId} to GitHub:`, err);
      }
    }
    return { chain: false };
  }
  return { chain: true };
}

/**
 * Handle agent chaining (implementation ↔ review loop, and PR agent triggering).
 */
async function handleAgentChaining(
  taskId: number,
  agentType: AgentType,
  context: StreamingContext,
): Promise<void> {
  const { broadcastFn, broadcastToTaskSubscribersFn, userId } = context;
  const task = tasksDb.getById(taskId);

  // Planification → implementation auto-chain for non-technical users.
  // Technical users keep the current manual-Run gate. The decision tracks
  // the user who triggered planification (carried on StreamingContext),
  // not the task creator — fall back to the task owner only when the
  // context has no userId.
  if (agentType === 'planification') {
    const actorUserId = userId ?? tasksDb.getWithProject(taskId)?.user_id ?? null;
    const actor = actorUserId ? userDb.getUserById(actorUserId) : null;
    const actorIsNonTechnical = actor?.is_technical === 0;

    if (!actorIsNonTechnical) {
      return;
    }
    if (task?.workflow_blocked) {
      console.log(`[ConversationAdapter] Task ${taskId} workflow blocked, skipping planification auto-chain`);
      return;
    }
    if ((task?.workflow_run_count ?? 0) >= MAX_WORKFLOW_RUNS) {
      console.log(`[ConversationAdapter] Task ${taskId} hit max iterations, skipping planification auto-chain`);
      return;
    }

    console.log(
      `[ConversationAdapter] Auto-starting implementation after planification for non-technical owner (task ${taskId})`,
    );
    const { startAgentRun } = await import('../agentRunner.js');
    setTimeout(async () => {
      try {
        await startAgentRun(taskId, 'implementation', { broadcastFn, broadcastToTaskSubscribersFn, userId });
      } catch (err) {
        console.error(`[ConversationAdapter] Failed to auto-start implementation after planification:`, err);
      }
    }, 1000);
    return;
  }

  // workflow_complete → run refinement → PR pipeline
  if (task?.workflow_complete) {
    if (agentType === 'refinement') {
      tasksDb.markRefinementComplete(taskId);
      // Fall through to PR check
    } else if (!task?.refinement_complete) {
      console.log(`[ConversationAdapter] Starting refinement agent for task ${taskId}`);
      const { startAgentRun } = await import('../agentRunner.js');
      setTimeout(async () => {
        try {
          await startAgentRun(taskId, 'refinement', { broadcastFn, broadcastToTaskSubscribersFn, userId });
        } catch (err) {
          console.error(`[ConversationAdapter] Failed to start refinement agent:`, err);
        }
      }, 1000);
      return;
    }

    if (!task?.pr_agent_complete) {
      const taskWithProject = tasksDb.getWithProject(taskId);
      if (!taskWithProject) {
        console.log(`[ConversationAdapter] Task ${taskId} not found, skipping PR agent`);
        return;
      }
      const hasWorktree = await worktreeExists(taskWithProject.repo_folder_path, taskId);

      if (hasWorktree) {
        console.log(`[ConversationAdapter] Publishing initial PR for task ${taskId}`);
        try {
          const { ensureTaskPullRequest } = await import('../prService.js');
          const result = await ensureTaskPullRequest(taskId);
          if (!result.success) {
            console.error(`[ConversationAdapter] Failed to publish initial PR for task ${taskId}: ${result.error}`);
          }
        } catch (err) {
          console.error(`[ConversationAdapter] Failed to publish initial PR for task ${taskId}:`, err);
        }
        return;
      }
    }

    console.log(`[ConversationAdapter] Task ${taskId} workflow complete, stopping loop`);
    return;
  }

  if (task?.workflow_blocked) {
    console.log(`[ConversationAdapter] Task ${taskId} workflow blocked, stopping loop`);
    return;
  }

  if ((task?.workflow_run_count ?? 0) >= MAX_WORKFLOW_RUNS) {
    console.log(
      `[ConversationAdapter] Task ${taskId} reached max iterations (${MAX_WORKFLOW_RUNS}), auto-blocking`,
    );
    tasksDb.blockWorkflow(taskId);

    if (broadcastToTaskSubscribersFn) {
      // broadcastToTaskSubscribers splices `taskId` in itself; passing it
      // again here would be redundant.
      broadcastToTaskSubscribersFn(taskId, {
        type: 'task-blocked',
        reason: 'max_iterations',
      });
    }
    return;
  }

  const nextType: AgentType = agentType === 'implementation' ? 'review' : 'implementation';
  console.log(`[ConversationAdapter] Chaining ${agentType} -> ${nextType} for task ${taskId}`);

  const { startAgentRun, getRunningAgentForTask } = await import('../agentRunner.js');

  setTimeout(async () => {
    try {
      const freshTask = tasksDb.getById(taskId);
      if (freshTask?.workflow_complete) {
        console.log(`[ConversationAdapter] Task ${taskId} workflow complete (re-check), stopping loop`);
        return;
      }
      if (freshTask?.workflow_blocked) {
        console.log(`[ConversationAdapter] Task ${taskId} workflow blocked (re-check), stopping loop`);
        return;
      }
      const runningAgent = getRunningAgentForTask(taskId);
      if (runningAgent) {
        console.log(`[ConversationAdapter] Another agent already running, skipping chain`);
        return;
      }

      await startAgentRun(taskId, nextType, { broadcastFn, broadcastToTaskSubscribersFn, userId });
    } catch (err) {
      // Loud log and stop. We used to also INSERT a placeholder 'failed' run
      // for the agent type we couldn't start — but that creates a sibling
      // row out of nowhere and confuses the dashboard. The parent run is
      // already marked 'completed'; the loop simply pauses here until the
      // user retries or the next loop trigger fires.
      console.error(`[ConversationAdapter] Failed to chain to ${nextType}:`, err);
    }
  }, 1000);
}
