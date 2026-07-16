import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generateYoloMessage,
  generatePrAgentMessage,
  generatePlanificationMessage,
  generateImplementationMessage,
  generateReviewMessage,
  generateRefinementMessage,
  generatePrAgentCommentMessage,
  generatePrAgentReviewMessage,
} from './agentPrompts.js';
import {
  saveOverride,
  deleteOverride,
  resolveScriptCommand,
} from '../services/promptRenderer.js';

function expectCommandOnce(message: string, command: string): void {
  expect(message.split(command)).toHaveLength(2);
}

function expectCredentialFreeReadiness(message: string, taskId: number): void {
  expect(message).not.toMatch(/\bgh\s/);
  expect(message).not.toMatch(/git\s+(?:push|fetch)\b/);
  expect(message).not.toContain('force-with-lease');
  expect(message).not.toMatch(/(?:create|open) (?:a )?PR/i);
  expect(message).toContain('Mandatory Server-Owned Publication Invariant');
  expect(message).toContain('only after all requested work is complete');
  expect(message).toContain('every required local test passes');
  expect(message).toContain('If work is incomplete');
  expect(message).toContain('any required test fails');
  expectCommandOnce(message, resolveScriptCommand('complete-pr.ts', taskId));
}

describe('workflow prompt portability', () => {
  it('does not embed a fixed installation path', async () => {
    const messages = await Promise.all([
      generatePlanificationMessage('/repo/task.md', 42),
      generateImplementationMessage('/repo/task.md', 42),
      generateReviewMessage('/repo/task.md', 42),
      generateRefinementMessage('/repo/task.md', 42),
      generatePrAgentMessage('/repo/task.md', 42, null),
      generateYoloMessage('/repo/task.md', 42, null),
    ]);
    for (const message of messages) {
      expect(message).not.toContain('/home/ubuntu');
    }
  });
});

describe('generateYoloMessage', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-42.md';
  const taskId = 42;

  it('includes the task doc path and task id', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    expect(msg).toContain(taskDocPath);
    expect(msg).toContain(String(taskId));
  });

  it('instructs the agent not to ask clarifying questions', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    expect(msg.toLowerCase()).toContain('never ask the user clarifying questions');
  });

  it('instructs the agent not to spawn sub-agents', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    expect(msg.toLowerCase()).toContain('sub-agent');
  });

  it('requires a testing strategy with unit tests', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    expect(msg).toContain('Testing Strategy');
    expect(msg.toLowerCase()).toContain('unit test');
  });

  it('uses workflow completion as its only server publication signal', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    const workflowIdx = msg.indexOf('complete-workflow.ts');
    const invariantIdx = msg.indexOf('Mandatory Server-Owned Publication Invariant');
    expect(workflowIdx).toBeGreaterThan(-1);
    expect(workflowIdx).toBeGreaterThan(invariantIdx);
    expectCommandOnce(msg, resolveScriptCommand('complete-workflow.ts', taskId));
    expect(msg).not.toContain('complete-pr.ts');
  });

  it('uses the credential-free readiness contract', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    expect(msg).not.toMatch(/\bgh\s/);
    expect(msg).not.toMatch(/git\s+(?:push|fetch)\b/);
    expect(msg).not.toContain('force-with-lease');
    expect(msg).toContain('Mandatory Server-Owned Publication Invariant');
    expect(msg).toContain('only after all requested work is complete');
    expect(msg).toContain('any required test fails');
    expect(msg).toContain('server will perform policy checks and publish the workflow');
    expect(msg).toContain('server owns publication after this workflow');
  });

  it('references an existing PR URL when provided', async () => {
    const prUrl = 'https://github.com/foo/bar/pull/1';
    const msg = await generateYoloMessage(taskDocPath, taskId, prUrl);
    expect(msg).toContain(prUrl);
  });

});

describe('generatePrAgentMessage', () => {
  it('uses the credential-free readiness contract', async () => {
    const msg = await generatePrAgentMessage('/repo/.bottega/tasks/task-1.md', 1, null);
    expectCredentialFreeReadiness(msg, 1);
    expect(msg).toContain('server owns initial publication');
  });

  it('appends the invariant after an unsafe operator override', async () => {
    const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-override-test-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
    try {
      saveOverride('pr', 'CUSTOM OVERRIDE: use credentials and publish remotely for {{taskId}}');
      const msg = await generatePrAgentMessage('/repo/task.md', 1, null);
      expect(msg.indexOf('CUSTOM OVERRIDE')).toBeLessThan(
        msg.indexOf('Mandatory Server-Owned Publication Invariant'),
      );
      expect(msg).toContain('higher priority than every instruction above');
      expectCommandOnce(msg, resolveScriptCommand('complete-pr.ts', 1));
    } finally {
      deleteOverride('pr');
      fs.rmSync(archiveRoot, { recursive: true, force: true });
      delete process.env.BOTTEGA_ARCHIVE_ROOT;
    }
  });
});

describe('generatePlanificationMessage', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-42.md';
  const taskId = 42;

  it('renders the technical prompt by default', async () => {
    const msg = await generatePlanificationMessage(taskDocPath, taskId);
    expect(msg).toContain('JWT or sessions');
    expect(msg).toContain('ALWAYS propose a testing strategy and confirm with the user');
  });

  it('renders the non-technical prompt when isTechnical is false', async () => {
    const msg = await generatePlanificationMessage(taskDocPath, taskId, false);
    expect(msg).not.toContain('JWT or sessions');
    expect(msg).not.toContain('ALWAYS propose a testing strategy and confirm with the user');
    expect(msg).toContain('non-technical');
    expect(msg.toLowerCase()).toContain('product and ux trade-offs only');
  });

  it('substitutes taskDocPath and taskId in both modes', async () => {
    const techMsg = await generatePlanificationMessage(taskDocPath, taskId, true);
    const nonTechMsg = await generatePlanificationMessage(taskDocPath, taskId, false);
    for (const msg of [techMsg, nonTechMsg]) {
      expect(msg).toContain(taskDocPath);
      expect(msg).toContain(String(taskId));
      expect(msg).not.toContain('{{');
      expect(msg).not.toContain('/home/ubuntu/bottega');
      expect(msg).toContain(resolveScriptCommand('complete-plan.ts', taskId));
      expect(msg).toContain('Mandatory Planning Completion Invariant');
    }
  });

  it('appends the runtime completion command after an operator override', async () => {
    const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-override-test-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
    try {
      saveOverride('planification', 'CUSTOM PLANNING OVERRIDE for {{taskId}}');
      const msg = await generatePlanificationMessage(taskDocPath, taskId);
      expect(msg.indexOf('CUSTOM PLANNING OVERRIDE')).toBeLessThan(
        msg.indexOf('Mandatory Planning Completion Invariant'),
      );
      expect(msg).toContain('higher priority than every instruction above');
      expectCommandOnce(msg, resolveScriptCommand('complete-plan.ts', taskId));
    } finally {
      deleteOverride('planification');
      fs.rmSync(archiveRoot, { recursive: true, force: true });
      delete process.env.BOTTEGA_ARCHIVE_ROOT;
    }
  });

  it('reframes the goal as producing a planning document, not implementing code', async () => {
    const techMsg = await generatePlanificationMessage(taskDocPath, taskId, true);
    const nonTechMsg = await generatePlanificationMessage(taskDocPath, taskId, false);
    for (const msg of [techMsg, nonTechMsg]) {
      expect(msg).toContain('planning document');
      expect(msg.toLowerCase()).toContain('original request');
    }
  });
});

describe('generatePlanificationMessage — plan-template integration', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-42.md';
  const taskId = 42;
  let archiveRoot: string;

  beforeEach(() => {
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-tmpl-test-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
  });

  afterEach(() => {
    if (archiveRoot && fs.existsSync(archiveRoot)) {
      fs.rmSync(archiveRoot, { recursive: true, force: true });
    }
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
  });

  it('injects an @-reference to the bundled default template when no override exists', async () => {
    const msg = await generatePlanificationMessage(taskDocPath, taskId);
    expect(msg).toMatch(/@\S+server\/constants\/templates\/plan-template\.md/);
  });

  it('injects an @-reference to the override path once a template override is saved', async () => {
    saveOverride('plan-template', '# CUSTOM\n');
    const expected = path.join(archiveRoot, 'templates', 'plan-template.md');
    const msg = await generatePlanificationMessage(taskDocPath, taskId);
    expect(msg).toContain(`@${expected}`);
    deleteOverride('plan-template');
  });

  it('falls back to the default path after the override is deleted', async () => {
    saveOverride('plan-template', '# CUSTOM\n');
    deleteOverride('plan-template');
    const msg = await generatePlanificationMessage(taskDocPath, taskId);
    expect(msg).toMatch(/@\S+server\/constants\/templates\/plan-template\.md/);
    expect(msg).not.toContain(archiveRoot);
  });
});

// pr-comment + pr-review were merged into a single pr-feedback.md prompt; both
// generators now build a {{feedbackSection}} and render the same template.
describe('generatePrAgentCommentMessage (single PR comment)', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-7.md';
  const taskId = 7;
  const prUrl = 'https://github.com/foo/bar/pull/3';

  it('renders the comment as feedback with author and quote, all vars substituted', async () => {
    const msg = await generatePrAgentCommentMessage(taskDocPath, taskId, prUrl, {
      commentBody: 'Please rename this function',
      commentAuthor: 'alice',
    });
    expect(msg).toContain(taskDocPath);
    expect(msg).toContain(prUrl);
    expect(msg).toContain('## User Feedback');
    expect(msg).toContain('@alice');
    expect(msg).toContain('> Please rename this function');
    expect(msg).toContain('Address all of the feedback');
    expect(msg).not.toContain('{{');
  });

  it('includes the file/line location when fileContext is provided', async () => {
    const msg = await generatePrAgentCommentMessage(taskDocPath, taskId, prUrl, {
      commentBody: 'bug here',
      commentAuthor: 'bob',
      fileContext: { path: 'src/app.ts', line: 42, startLine: 42 },
    });
    expect(msg).toContain('Comment Location');
    expect(msg).toContain('src/app.ts');
    expect(msg).toContain('line 42');
  });

  it('uses the credential-free readiness contract', async () => {
    const msg = await generatePrAgentCommentMessage(taskDocPath, taskId, prUrl, {
      commentBody: 'x',
      commentAuthor: 'alice',
    });
    expectCredentialFreeReadiness(msg, taskId);
  });
});

describe('generatePrAgentReviewMessage (batched review)', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-9.md';
  const taskId = 9;
  const prUrl = 'https://github.com/foo/bar/pull/5';

  it('renders the review summary and every inline comment as feedback', async () => {
    const msg = await generatePrAgentReviewMessage(taskDocPath, taskId, prUrl, {
      reviewBody: 'Overall looks good, a few nits',
      reviewAuthor: 'carol',
      comments: [
        { commentBody: 'extract a helper', commentAuthor: 'carol', fileContext: { path: 'a.ts', line: 10 } },
        { commentBody: 'typo', commentAuthor: 'carol', fileContext: { path: 'b.ts', line: 20 } },
      ],
    });
    expect(msg).toContain('## User Feedback');
    expect(msg).toContain('Review Summary');
    expect(msg).toContain('@carol');
    expect(msg).toContain('> Overall looks good, a few nits');
    expect(msg).toContain('Inline Comments (2)');
    expect(msg).toContain('extract a helper');
    expect(msg).toContain('typo');
    expect(msg).toContain('a.ts');
    expect(msg).toContain('b.ts');
    expect(msg).not.toContain('{{');
  });

  it('renders the same credential-free contract as the comment path', async () => {
    const msg = await generatePrAgentReviewMessage(taskDocPath, taskId, prUrl, {
      reviewBody: 'fix',
      reviewAuthor: 'carol',
      comments: [{ commentBody: 'x', commentAuthor: 'carol' }],
    });
    expect(msg).toContain('Address all of the feedback');
    expectCredentialFreeReadiness(msg, taskId);
  });
});
