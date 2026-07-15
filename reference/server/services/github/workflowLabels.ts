// Canonical Bottega workflow labels for GitHub issue intake.
//
// These four labels drive the label-gated issue → plan → implement → PR flow
// (see `reconcile.ts`). They are the single source of truth: `reconcile.ts`
// imports the individual names from here, and `GitHubClient.ensureLabels`
// provisions the full set on a repository when automation is enabled so
// operators no longer have to create them by hand.

export interface WorkflowLabelSpec {
  /** Exact label name as it appears on GitHub. */
  name: string;
  /** 6-hex color, no leading '#'. */
  color: string;
  /** Human-readable description shown in the GitHub labels UI. */
  description: string;
}

export const WORKFLOW_LABELS: readonly WorkflowLabelSpec[] = [
  {
    name: 'Needs Refinement',
    color: 'fbca04',
    description: 'Bottega: triggers issue import + planning',
  },
  {
    name: 'Ready',
    color: '0e8a16',
    description: "Bottega: plan posted, awaiting human approval (add 'Refined' to proceed)",
  },
  {
    name: 'Refined',
    color: '1d76db',
    description: 'Bottega: plan approved — run implementation through PR',
  },
  {
    name: 'In Review',
    color: '5319e7',
    description: 'Bottega: work is in review',
  },
] as const;

// Named exports for the reconcile state machine. Kept in lockstep with
// WORKFLOW_LABELS so there is exactly one place a label name is spelled.
export const PLAN_LABEL = 'Needs Refinement';
export const READY_LABEL = 'Ready';
export const APPROVED_LABEL = 'Refined';
export const REVIEW_LABEL = 'In Review';
