/**
 * Agent Prompt Generators (Server-Side)
 *
 * Each generator loads a markdown template (with optional user override at
 * ~/.bottega/prompts/{name}.md), pre-builds any dynamic sections (loops,
 * conditionals) in JS, then injects them via {{var}} substitution. Edit the
 * markdown templates in server/constants/prompts/ — or via the Settings UI —
 * to change agent behavior without touching code.
 */

import { renderPrompt, resolvePromptPath, resolveScriptCommand } from '../services/promptRenderer.js';

interface FileContext {
  path?: string;
  line?: number | null;
  startLine?: number | null;
  diffHunk?: string | null;
  side?: string | null;
}

interface CommentWebhookContext {
  commentBody?: string;
  commentAuthor?: string;
  fileContext?: FileContext | null;
}

interface ReviewComment {
  commentBody?: string;
  commentAuthor?: string;
  fileContext?: FileContext | null;
}

interface ReviewWebhookContext {
  reviewBody?: string | null;
  reviewAuthor?: string;
  comments?: ReviewComment[];
}

export async function generatePlanificationMessage(
  taskDocPath: string,
  taskId: number,
  isTechnical: boolean = true,
): Promise<string> {
  const promptName = isTechnical ? 'planification' : 'planification-nontechnical';
  const planTemplatePath = resolvePromptPath('plan-template');
  const completePlanCommand = resolveScriptCommand('complete-plan.ts', taskId);
  return renderPrompt(promptName, { taskDocPath, taskId, planTemplatePath, completePlanCommand });
}

export async function generateImplementationMessage(
  taskDocPath: string,
  taskId: number,
): Promise<string> {
  return renderPrompt('implementation', { taskDocPath, taskId });
}

export async function generateReviewMessage(taskDocPath: string, taskId: number): Promise<string> {
  return renderPrompt('review', { taskDocPath, taskId });
}

export async function generateRefinementMessage(
  taskDocPath: string,
  taskId: number,
): Promise<string> {
  return renderPrompt('refinement', { taskDocPath, taskId });
}

export async function generatePrAgentMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
): Promise<string> {
  const prContextLine = prUrl
    ? `- Existing PR: ${prUrl}`
    : '- No PR is linked yet; the server owns initial publication';
  return renderPrompt('pr', { taskDocPath, taskId, prContextLine });
}

export async function generateYoloMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
): Promise<string> {
  const prContextLine = prUrl
    ? `- Existing PR: ${prUrl}`
    : '- No PR is linked yet; the server owns publication after this workflow';
  return renderPrompt('yolo', { taskDocPath, taskId, prContextLine });
}

export async function generatePrAgentCommentMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
  webhookContext: CommentWebhookContext,
): Promise<string> {
  const { commentBody, commentAuthor, fileContext } = webhookContext || {};

  const quotedComment = commentBody
    ? commentBody
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    : '> (empty comment)';

  let fileLocationSection = '';
  if (fileContext?.path) {
    const lineInfo =
      fileContext.startLine && fileContext.line && fileContext.startLine !== fileContext.line
        ? `lines ${fileContext.startLine}-${fileContext.line}`
        : fileContext.line
          ? `line ${fileContext.line}`
          : '';

    fileLocationSection = `
### Comment Location
- **File**: \`${fileContext.path}\`${lineInfo ? `\n- **Line**: ${lineInfo}` : ''}${fileContext.side ? `\n- **Side**: ${fileContext.side === 'LEFT' ? 'Original code (before changes)' : 'New code (after changes)'}` : ''}
`;

    if (fileContext.diffHunk) {
      fileLocationSection += `
### Code Context (from diff)
\`\`\`diff
${fileContext.diffHunk}
\`\`\`
`;
    }
  }

  const feedbackSection = `## User Feedback
**@${commentAuthor || 'unknown'}** left the following comment on the PR:

${quotedComment}
${fileLocationSection}`;

  return renderPrompt('pr-feedback', { taskDocPath, taskId, prUrl, feedbackSection });
}

export async function generatePrAgentReviewMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
  webhookContext: ReviewWebhookContext,
): Promise<string> {
  const { reviewBody, reviewAuthor, comments } = webhookContext || {};

  let reviewBodySection = '';
  if (reviewBody) {
    const quotedReview = reviewBody
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    reviewBodySection = `
### Review Summary
**@${reviewAuthor || 'unknown'}** wrote:

${quotedReview}
`;
  }

  let inlineCommentsSection = '';
  if (comments && comments.length > 0) {
    const commentEntries = comments
      .map((c, i) => {
        const { commentBody, commentAuthor, fileContext } = c;
        let entry = `#### ${i + 1}. `;

        if (fileContext?.path) {
          const lineInfo =
            fileContext.startLine &&
            fileContext.line &&
            fileContext.startLine !== fileContext.line
              ? `lines ${fileContext.startLine}-${fileContext.line}`
              : fileContext.line
                ? `line ${fileContext.line}`
                : '';
          entry += `\`${fileContext.path}\`${lineInfo ? ` (${lineInfo})` : ''}`;
        } else {
          entry += 'General comment';
        }

        entry += `\n**@${commentAuthor || 'unknown'}**:`;
        entry += `\n${commentBody || '(empty comment)'}`;

        if (fileContext?.diffHunk) {
          entry += `\n\n<details><summary>Code context (from diff)</summary>\n\n\`\`\`diff\n${fileContext.diffHunk}\n\`\`\`\n</details>`;
        }

        return entry;
      })
      .join('\n\n');

    inlineCommentsSection = `
### Inline Comments (${comments.length})
${commentEntries}
`;
  }

  const feedbackSection = `## User Feedback${reviewBodySection}${inlineCommentsSection}`;

  return renderPrompt('pr-feedback', { taskDocPath, taskId, prUrl, feedbackSection });
}

/**
 * Agent type identifiers
 */
export const AGENT_TYPE = {
  PLANIFICATION: 'planification',
  IMPLEMENTATION: 'implementation',
  REFINEMENT: 'refinement',
  REVIEW: 'review',
  PR: 'pr',
} as const;
