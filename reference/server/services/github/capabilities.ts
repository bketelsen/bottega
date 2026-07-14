import type { AutonomyTier, ProjectRow } from '../../../shared/types/db.js';

export type { AutonomyTier };

export type GitHubAction =
  | 'read'
  | 'comment'
  | 'label'
  | 'reaction'
  | 'createIssue'
  | 'push'
  | 'createPR'
  | 'merge';

export type GitHubProject = ProjectRow;

const MINIMUM_TIER: Record<GitHubAction, AutonomyTier> = {
  read: 'advisory',
  comment: 'advisory',
  label: 'advisory',
  reaction: 'advisory',
  createIssue: 'issues',
  push: 'pr',
  createPR: 'pr',
  merge: 'automerge',
};

const TIER_RANK: Record<AutonomyTier, number> = {
  advisory: 0,
  issues: 1,
  pr: 2,
  automerge: 3,
};

export class GitHubCapabilityError extends Error {
  readonly code = 'GITHUB_CAPABILITY_DENIED';

  constructor(
    readonly projectId: number,
    readonly action: GitHubAction,
    readonly autonomyTier: AutonomyTier,
    readonly automationEnabled: boolean,
  ) {
    const reason = automationEnabled
      ? `autonomy tier "${autonomyTier}" does not allow "${action}"`
      : 'GitHub automation is disabled';
    super(`GitHub capability denied for project ${projectId}: ${reason}`);
    this.name = 'GitHubCapabilityError';
  }
}

export function can(project: GitHubProject, action: GitHubAction): boolean {
  if (!project.github_repo) return false;
  if (action === 'read') return true;
  return project.github_automation_enabled === 1
    && TIER_RANK[project.autonomy_tier] >= TIER_RANK[MINIMUM_TIER[action]];
}

export function assertCapability(project: GitHubProject, action: GitHubAction): void {
  if (!can(project, action)) {
    throw new GitHubCapabilityError(
      project.id,
      action,
      project.autonomy_tier,
      project.github_automation_enabled === 1,
    );
  }
}
