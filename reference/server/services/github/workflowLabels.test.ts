import { describe, expect, it } from 'vitest';

import {
  WORKFLOW_LABELS,
  PLAN_LABEL,
  READY_LABEL,
  APPROVED_LABEL,
  REVIEW_LABEL,
} from './workflowLabels.js';

describe('workflowLabels', () => {
  it('defines the four canonical workflow labels', () => {
    expect(WORKFLOW_LABELS.map((label) => label.name)).toEqual([
      'Needs Refinement',
      'Ready',
      'Refined',
      'In Review',
    ]);
  });

  it('keeps the named constants in lockstep with WORKFLOW_LABELS', () => {
    const names = new Set(WORKFLOW_LABELS.map((label) => label.name));
    for (const name of [PLAN_LABEL, READY_LABEL, APPROVED_LABEL, REVIEW_LABEL]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it('uses valid 6-hex colors and non-empty descriptions', () => {
    for (const label of WORKFLOW_LABELS) {
      expect(label.color).toMatch(/^[0-9a-f]{6}$/);
      expect(label.description.length).toBeGreaterThan(0);
    }
  });
});
