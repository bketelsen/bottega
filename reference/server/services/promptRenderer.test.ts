import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  render,
  extractVariables,
  findUnknownVariables,
  loadPrompt,
  loadDefault,
  saveOverride,
  deleteOverride,
  hasOverride,
  getOverrideMtime,
  listPromptNames,
  getPromptDefinition,
  getPromptsDir,
  getTemplatesDir,
  renderPrompt,
  resolvePromptPath,
  resolveScriptCommand,
} from './promptRenderer.js';

describe('promptRenderer', () => {
  let archiveRoot: string;

  beforeEach(() => {
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-test-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
  });

  afterEach(() => {
    if (archiveRoot && fs.existsSync(archiveRoot)) {
      fs.rmSync(archiveRoot, { recursive: true, force: true });
    }
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
  });

  describe('render', () => {
    it('substitutes single {{var}}', () => {
      expect(render('hello {{name}}', { name: 'world' })).toBe('hello world');
    });

    it('substitutes multiple occurrences of the same var', () => {
      expect(render('{{x}} and {{x}}', { x: '5' })).toBe('5 and 5');
    });

    it('throws on missing variable', () => {
      expect(() => render('hi {{missing}}', {})).toThrow(/Missing prompt variable: missing/);
    });

    it('renders nullish values as empty string', () => {
      expect(render('a{{x}}b', { x: null })).toBe('ab');
      expect(render('a{{x}}b', { x: undefined })).toBe('ab');
    });

    it('coerces non-string values', () => {
      expect(render('id={{id}}', { id: 42 })).toBe('id=42');
    });

    it('leaves malformed placeholders as literals', () => {
      expect(render('hi {{name', { name: 'x' })).toBe('hi {{name');
    });
  });

  describe('extractVariables', () => {
    it('returns deduplicated names', () => {
      expect(extractVariables('{{a}} {{b}} {{a}}')).toEqual(['a', 'b']);
    });

    it('returns empty for no placeholders', () => {
      expect(extractVariables('plain text')).toEqual([]);
    });
  });

  describe('findUnknownVariables', () => {
    it('returns empty when all vars are in the allowlist', () => {
      expect(findUnknownVariables('planification', 'hi {{taskDocPath}} {{taskId}}')).toEqual([]);
    });

    it('returns unknown names', () => {
      expect(findUnknownVariables('planification', 'hi {{taskDocPath}} {{bogus}} {{nope}}'))
        .toEqual(['bogus', 'nope']);
    });

    it('throws for unknown prompt name', () => {
      expect(() => findUnknownVariables('nonsense', '')).toThrow(/Unknown prompt/);
    });
  });

  describe('listPromptNames / getPromptDefinition', () => {
    it('registers every prompt in the definitions table', () => {
      const names = listPromptNames();
      expect(names).toContain('planification');
      expect(names).toContain('plan-template');
      expect(names).toContain('pr-feedback');
      // pr-comment + pr-review were merged into pr-feedback; _ci-instructions
      // was inlined into pr.md / yolo.md and removed.
      expect(names).not.toContain('pr-comment');
      expect(names).not.toContain('pr-review');
      expect(names).not.toContain('_ci-instructions');
      expect(names.length).toBeGreaterThanOrEqual(9);
    });

    it('returns null for unknown definition', () => {
      expect(getPromptDefinition('nope')).toBeNull();
    });

    it('returns labels and variables', () => {
      const def = getPromptDefinition('pr');
      expect(def!.label).toBe('PR Agent');
      expect(def!.variables).toEqual(['taskDocPath', 'taskId', 'prContextLine']);
    });

    it('marks plan-template as a template kind with no variables', () => {
      const def = getPromptDefinition('plan-template');
      expect(def!.kind).toBe('template');
      expect(def!.variables).toEqual([]);
    });

    it('registers the Global prompt as a variable-free agent prompt', () => {
      const def = getPromptDefinition('global');
      expect(def).not.toBeNull();
      expect(def!.kind).toBe('prompt');
      expect(def!.variables).toEqual([]);
      expect(listPromptNames()).toContain('global');
    });

    it('exposes planTemplatePath as an allowed variable on planification prompts', () => {
      expect(getPromptDefinition('planification')!.variables).toContain('planTemplatePath');
      expect(getPromptDefinition('planification-nontechnical')!.variables).toContain('planTemplatePath');
    });
  });

  describe('loadPrompt fallback chain', () => {
    it('returns default when no override', () => {
      const content = loadPrompt('implementation');
      expect(content).toContain('@agent-Implement');
    });

    it('returns override when present', () => {
      saveOverride('implementation', 'CUSTOM IMPL CONTENT {{taskId}}');
      expect(loadPrompt('implementation')).toBe('CUSTOM IMPL CONTENT {{taskId}}');
    });

    it('falls back after delete', () => {
      saveOverride('implementation', 'CUSTOM');
      deleteOverride('implementation');
      expect(loadPrompt('implementation')).toContain('@agent-Implement');
    });
  });

  describe('saveOverride / deleteOverride / hasOverride / mtime', () => {
    it('hasOverride flips after save and delete', () => {
      expect(hasOverride('review')).toBe(false);
      saveOverride('review', 'x');
      expect(hasOverride('review')).toBe(true);
      deleteOverride('review');
      expect(hasOverride('review')).toBe(false);
    });

    it('deleteOverride is idempotent', () => {
      expect(deleteOverride('review')).toBe(false);
    });

    it('mtime returns null without override and a number with one', () => {
      expect(getOverrideMtime('review')).toBeNull();
      saveOverride('review', 'x');
      expect(typeof getOverrideMtime('review')).toBe('number');
    });

    it('saveOverride creates the prompts dir if missing', () => {
      saveOverride('review', 'x');
      expect(fs.existsSync(getPromptsDir())).toBe(true);
    });

    it('throws on unknown prompt name to block path traversal', () => {
      expect(() => saveOverride('../etc/passwd', 'x')).toThrow(/Unknown prompt/);
    });
  });

  describe('loadDefault', () => {
    it('reads bundled default file', () => {
      expect(loadDefault('planification')).toContain('@agent-Plan');
    });

    it('throws for unknown prompt', () => {
      expect(() => loadDefault('nope')).toThrow();
    });
  });

  describe('renderPrompt', () => {
    it('loads and renders the implementation prompt', () => {
      const out = renderPrompt('implementation', { taskDocPath: '/x/y.md', taskId: 7 });
      expect(out).toContain('/x/y.md');
      expect(out).toContain('Start implementing now.');
    });

    it('renders the pr prompt with the server-owned publication invariant', () => {
      const out = renderPrompt('pr', {
        taskDocPath: '/x/y.md',
        taskId: 99,
        prContextLine: '- No PR exists yet',
      });
      expect(out).toContain('Mandatory Server-Owned Publication Invariant');
      expect(out).toContain(resolveScriptCommand('complete-pr.ts', 99));
      expect(out).not.toMatch(/\bgh\s/);
      expect(out).not.toMatch(/git\s+(?:push|fetch)\b/);
    });

    it('appends the invariant after a PR-family override', () => {
      saveOverride('pr-feedback', 'UNSAFE CUSTOM TEXT {{taskId}}');
      const out = renderPrompt('pr-feedback', {
        taskDocPath: '/x/y.md',
        taskId: 99,
        prUrl: 'https://example.test/pr/1',
        feedbackSection: 'feedback',
      });
      expect(out.indexOf('UNSAFE CUSTOM TEXT')).toBeLessThan(
        out.indexOf('Mandatory Server-Owned Publication Invariant'),
      );
      expect(out.split(resolveScriptCommand('complete-pr.ts', 99))).toHaveLength(2);
    });

    it('appends runtime-owned READY and BLOCKED commands to the review prompt', () => {
      const out = renderPrompt('review', { taskDocPath: '/x/y.md', taskId: 99 });
      expect(out).toContain('Mandatory Review Completion Invariant');
      expect(out.split(resolveScriptCommand('complete-workflow.ts', 99))).toHaveLength(2);
      expect(out.split(resolveScriptCommand('block-workflow.ts', 99))).toHaveLength(2);
    });
  });

  describe('Global prompt injection', () => {
    it('injects nothing when the Global prompt is empty (default)', () => {
      const out = renderPrompt('implementation', { taskDocPath: '/x/y.md', taskId: 7 });
      expect(out).not.toContain('Global Operator Instructions');
    });

    it('prepends the Global prompt to a rendered agent prompt when set', () => {
      saveOverride('global', 'Use `brew` to install missing dependencies, never `apt`.');
      const out = renderPrompt('implementation', { taskDocPath: '/x/y.md', taskId: 7 });
      expect(out).toContain('Global Operator Instructions');
      expect(out).toContain('Use `brew` to install missing dependencies, never `apt`.');
      // Global text sits ABOVE the base prompt body.
      expect(out.indexOf('Global Operator Instructions')).toBeLessThan(out.indexOf('/x/y.md'));
    });

    it('keeps mandatory invariants below the Global prompt (invariants stay authoritative)', () => {
      saveOverride('global', 'Operator rule.');
      const out = renderPrompt('pr', {
        taskDocPath: '/x/y.md',
        taskId: 99,
        prContextLine: '- No PR exists yet',
      });
      expect(out.indexOf('Global Operator Instructions')).toBeLessThan(
        out.indexOf('Mandatory Server-Owned Publication Invariant'),
      );
    });

    it('is a no-op when the Global prompt is only whitespace', () => {
      saveOverride('global', '   \n\t  \n');
      const out = renderPrompt('review', { taskDocPath: '/x/y.md', taskId: 7 });
      expect(out).not.toContain('Global Operator Instructions');
    });

    it('never injects the Global prompt into itself', () => {
      saveOverride('global', 'Operator rule.');
      const out = renderPrompt('global', {});
      expect(out).toBe('Operator rule.');
      expect(out).not.toContain('Global Operator Instructions');
    });
  });

  describe('templates (kind: "template")', () => {
    it('loads the bundled default plan-template', () => {
      const content = loadDefault('plan-template');
      expect(content).toContain('## Original Request');
    });

    it('saveOverride for a template writes under templates/, not prompts/', () => {
      saveOverride('plan-template', '# Custom plan template\n');
      expect(fs.existsSync(path.join(archiveRoot, 'templates', 'plan-template.md'))).toBe(true);
      expect(fs.existsSync(path.join(archiveRoot, 'prompts', 'plan-template.md'))).toBe(false);
    });

    it('saveOverride creates the templates dir if missing', () => {
      saveOverride('plan-template', 'x');
      expect(fs.existsSync(getTemplatesDir())).toBe(true);
    });

    it('loadPrompt returns the template override when set, default otherwise', () => {
      expect(loadPrompt('plan-template')).toContain('## Original Request');
      saveOverride('plan-template', '# CUSTOM');
      expect(loadPrompt('plan-template')).toBe('# CUSTOM');
      deleteOverride('plan-template');
      expect(loadPrompt('plan-template')).toContain('## Original Request');
    });

    it('findUnknownVariables is a no-op for templates (markers are literal text)', () => {
      // Templates are read as-is by the agent, never rendered. Any {{ … }} inside
      // them is literal markdown and must NOT be flagged as an unknown variable.
      expect(findUnknownVariables('plan-template', '{{ task title }} {{ anything else }}')).toEqual([]);
    });
  });

  describe('resolvePromptPath', () => {
    it('returns the bundled default path when no override exists', () => {
      const p = resolvePromptPath('plan-template');
      expect(p).toMatch(/server\/constants\/templates\/plan-template\.md$/);
    });

    it('returns the override path under the archive root once an override is saved', () => {
      saveOverride('plan-template', '# CUSTOM');
      const p = resolvePromptPath('plan-template');
      expect(p).toBe(path.join(archiveRoot, 'templates', 'plan-template.md'));
    });

    it('falls back to the default path after the override is deleted', () => {
      saveOverride('plan-template', '# CUSTOM');
      deleteOverride('plan-template');
      const p = resolvePromptPath('plan-template');
      expect(p).toMatch(/server\/constants\/templates\/plan-template\.md$/);
    });
  });

  describe('resolveScriptCommand', () => {
    it('carries a custom database path into provider subprocesses', () => {
      const previousDatabasePath = process.env.DATABASE_PATH;
      process.env.DATABASE_PATH = "/tmp/bottega's data.db";
      try {
        const command = resolveScriptCommand('complete-plan.ts', 42);
        expect(command).toContain(`DATABASE_PATH='/tmp/bottega'"'"'s data.db'`);
        expect(command).toContain("/scripts/complete-plan.ts' '42'");
      } finally {
        if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
        else process.env.DATABASE_PATH = previousDatabasePath;
      }
    });
  });
});
