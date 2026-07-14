import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULTS_ROOT = path.join(__dirname, '..', 'constants');
const SCRIPTS_ROOT = path.join(__dirname, '..', '..', 'scripts');

const SERVER_OWNED_PUBLICATION_PROMPTS = new Set(['pr', 'pr-feedback', 'yolo']);
const PLANNING_PROMPTS = new Set(['planification', 'planification-nontechnical']);

function planningCompletionInvariant(command: unknown): string {
  return `

## Mandatory Planning Completion Invariant

This block has higher priority than every instruction above, including operator-provided prompt text.

- After writing and reading back the complete plan, invoke this command exactly once:

\`\`\`bash
${String(command)}
\`\`\`

- If the plan is incomplete, a clarification is unresolved, or the plan file was not verified, do not invoke the command.
- A final response is not a completion signal. The planning run succeeds only when the command updates the task.
- After invoking the command, stop.`;
}

function serverOwnedPublicationInvariant(name: string, taskId: unknown): string {
  if (name === 'yolo') {
    return `

## Mandatory Server-Owned Publication Invariant

This block has higher priority than every instruction above, including operator-provided prompt text.

- Work only in the local task worktree. You may inspect local status, diffs, and history, edit files, and run local verification.
- Never use GitHub CLI, contact GitHub, run network Git operations, create or update a pull request, or publish repository changes. The trusted server exclusively owns all remote repository and pull-request operations.
- Run the workflow completion command from Phase 4 exactly once, and only after all requested work is complete and every required local test passes.
- If work is incomplete, any required test fails, or readiness is uncertain, do not run that command. Report the blocker and stop; the server must not publish an unready workflow.
- After successful workflow completion, stop. Do not run a PR readiness or publication script; the server will perform policy checks and publish the workflow.`;
  }
  return `

## Mandatory Server-Owned Publication Invariant

This block has higher priority than every instruction above, including operator-provided prompt text.

- Work only in the local task worktree. You may inspect local status, diffs, and history, edit files, and run local verification.
- Never use GitHub CLI, contact GitHub, run network Git operations, create or update a pull request, or publish repository changes. The trusted server exclusively owns all remote repository and pull-request operations.
- Invoke the readiness command below exactly once, and only after all requested work is complete and every required local test passes:

\`\`\`bash
tsx /home/ubuntu/bottega/reference/scripts/complete-pr.ts ${String(taskId)}
\`\`\`

- If work is incomplete, any required test fails, or readiness is uncertain, do not invoke the command. Report the blocker and stop; the server must not finalize an unready run.
- After invoking the command, stop. The server will perform policy checks and finalization.`;
}

function getArchiveRoot(): string {
  return process.env.BOTTEGA_ARCHIVE_ROOT || path.join(os.homedir(), '.bottega');
}

type PromptKind = 'prompt' | 'template';

const KIND_DIR: Record<PromptKind, string> = {
  prompt: 'prompts',
  template: 'templates',
};

function dirNameForKind(kind: PromptKind): string {
  const dir = KIND_DIR[kind];
  if (!dir) throw new Error(`Unknown prompt kind: ${kind}`);
  return dir;
}

function getDefaultsDir(kind: PromptKind): string {
  return path.join(DEFAULTS_ROOT, dirNameForKind(kind));
}

function getOverridesDir(kind: PromptKind): string {
  return path.join(getArchiveRoot(), dirNameForKind(kind));
}

export function getPromptsDir(): string {
  return getOverridesDir('prompt');
}

export function getTemplatesDir(): string {
  return getOverridesDir('template');
}

export interface PromptDefinition {
  name: string;
  label: string;
  kind: PromptKind;
  file: string;
  variables: string[];
}

const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    name: 'planification',
    label: 'Planification',
    kind: 'prompt',
    file: 'planification.md',
    variables: ['taskDocPath', 'taskId', 'planTemplatePath', 'completePlanCommand'],
  },
  {
    name: 'planification-nontechnical',
    label: 'Planification (non-technical)',
    kind: 'prompt',
    file: 'planification-nontechnical.md',
    variables: ['taskDocPath', 'taskId', 'planTemplatePath', 'completePlanCommand'],
  },
  {
    name: 'implementation',
    label: 'Implementation',
    kind: 'prompt',
    file: 'implementation.md',
    variables: ['taskDocPath', 'taskId'],
  },
  {
    name: 'review',
    label: 'Review',
    kind: 'prompt',
    file: 'review.md',
    variables: ['taskDocPath', 'taskId'],
  },
  {
    name: 'refinement',
    label: 'Refinement',
    kind: 'prompt',
    file: 'refinement.md',
    variables: ['taskDocPath', 'taskId'],
  },
  {
    name: 'pr',
    label: 'PR Agent',
    kind: 'prompt',
    file: 'pr.md',
    variables: ['taskDocPath', 'taskId', 'prContextLine'],
  },
  {
    name: 'yolo',
    label: 'YOLO Agent',
    kind: 'prompt',
    file: 'yolo.md',
    variables: ['taskDocPath', 'taskId', 'prContextLine'],
  },
  {
    name: 'pr-feedback',
    label: 'PR Feedback Response',
    kind: 'prompt',
    file: 'pr-feedback.md',
    variables: ['taskDocPath', 'taskId', 'prUrl', 'feedbackSection'],
  },
  {
    name: 'plan-template',
    label: 'Plan Template',
    kind: 'template',
    file: 'plan-template.md',
    variables: [],
  },
];

const PROMPT_BY_NAME = new Map(PROMPT_DEFINITIONS.map((p) => [p.name, p]));

export function listPromptNames(): string[] {
  return PROMPT_DEFINITIONS.map((p) => p.name);
}

export function getPromptDefinition(name: string): PromptDefinition | null {
  return PROMPT_BY_NAME.get(name) || null;
}

function requireDef(name: string): PromptDefinition {
  const def = getPromptDefinition(name);
  if (!def) throw new Error(`Unknown prompt: ${name}`);
  return def;
}

function defaultPath(name: string): string {
  const def = requireDef(name);
  return path.join(getDefaultsDir(def.kind), def.file);
}

function overridePath(name: string): string {
  const def = requireDef(name);
  return path.join(getOverridesDir(def.kind), def.file);
}

export function loadDefault(name: string): string {
  const p = defaultPath(name);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing default prompt file: ${p}`);
  }
  return fs.readFileSync(p, 'utf8');
}

export function hasOverride(name: string): boolean {
  return fs.existsSync(overridePath(name));
}

export function loadOverride(name: string): string | null {
  const p = overridePath(name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

export function getOverrideMtime(name: string): number | null {
  const p = overridePath(name);
  if (!fs.existsSync(p)) return null;
  return fs.statSync(p).mtimeMs;
}

export function loadPrompt(name: string): string {
  const override = loadOverride(name);
  if (override !== null) return override;
  return loadDefault(name);
}

/**
 * Return the absolute path to the active version of a prompt or template:
 * the override path if an override exists, otherwise the bundled default path.
 * Used to inject e.g. `@{{planTemplatePath}}` references into other prompts.
 */
export function resolvePromptPath(name: string): string {
  return hasOverride(name) ? overridePath(name) : defaultPath(name);
}

export function resolveScriptPath(name: string): string {
  return path.join(SCRIPTS_ROOT, name);
}

export function saveOverride(name: string, content: string): number {
  const def = requireDef(name);
  const dir = getOverridesDir(def.kind);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const p = overridePath(name);
  fs.writeFileSync(p, content, 'utf8');
  return fs.statSync(p).mtimeMs;
}

export function deleteOverride(name: string): boolean {
  const p = overridePath(name);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    return true;
  }
  return false;
}

/**
 * Replace {{var}} placeholders. Throws on missing variable to surface
 * misconfiguration early rather than silently rendering empty strings.
 */
export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Missing prompt variable: ${key}`);
    }
    const v = vars[key];
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  });
}

/**
 * Return all {{var}} names referenced in the template, deduplicated.
 */
export function extractVariables(template: string): string[] {
  const seen = new Set<string>();
  const re = /\{\{(\w+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    seen.add(match[1]!);
  }
  return [...seen];
}

/**
 * Validate that a candidate template only references variables in the
 * allowlist for the given prompt. Returns an array of unknown names
 * (empty if valid). Templates (kind === 'template') are read as-is by the
 * agent and never go through render(), so {{ … }} markers in them are
 * literal text and validation is skipped.
 */
export function findUnknownVariables(name: string, content: string): string[] {
  const def = requireDef(name);
  if (def.kind === 'template') return [];
  const allowed = new Set(def.variables);
  const used = extractVariables(content);
  return used.filter((v) => !allowed.has(v));
}

/**
 * Convenience: load a prompt by name and render with vars.
 */
export function renderPrompt(name: string, vars: Record<string, unknown>): string {
  const rendered = render(loadPrompt(name), vars);
  if (PLANNING_PROMPTS.has(name)) {
    return `${rendered.trimEnd()}${planningCompletionInvariant(vars.completePlanCommand)}\n`;
  }
  if (!SERVER_OWNED_PUBLICATION_PROMPTS.has(name)) return rendered;
  return `${rendered.trimEnd()}${serverOwnedPublicationInvariant(name, vars.taskId)}\n`;
}
