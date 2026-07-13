import { describe, expect, it } from 'vitest';

import {
  assertCapability,
  can,
  GitHubCapabilityError,
  type AutonomyTier,
  type GitHubAction,
  type GitHubProject,
} from './capabilities.js';

const actions: GitHubAction[] = ['comment', 'label', 'reaction', 'createIssue', 'push', 'createPR', 'merge'];

function project(tier: AutonomyTier, enabled: 0 | 1 = 1): GitHubProject {
  return {
    id: 7,
    user_id: 2,
    name: 'Bottega',
    repo_folder_path: '/tmp/bottega',
    subproject_path: null,
    active_worktree_task_id: null,
    serve_symlink_path: null,
    systemd_service_name: null,
    app_url: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    github_repo: 'owner/repo',
    github_automation_enabled: enabled,
    autonomy_tier: tier,
  };
}

describe('GitHub capability firewall', () => {
  it.each([
    ['advisory', ['comment', 'label', 'reaction']],
    ['issues', ['comment', 'label', 'reaction', 'createIssue']],
    ['pr', ['comment', 'label', 'reaction', 'createIssue', 'push', 'createPR']],
    ['automerge', actions],
  ] as const)('%s allows the expected cumulative actions', (tier, allowed) => {
    for (const action of actions) {
      expect(can(project(tier), action), action).toBe(allowed.includes(action as never));
    }
  });

  it('denies every action when automation is disabled or the repository is absent', () => {
    const noRepo = { ...project('automerge'), github_repo: null };
    for (const action of actions) {
      expect(can(project('automerge', 0), action)).toBe(false);
      expect(can(noRepo, action)).toBe(false);
    }
  });

  it('throws a structured denial', () => {
    expect(() => assertCapability(project('advisory'), 'merge')).toThrow(GitHubCapabilityError);
    try {
      assertCapability(project('advisory'), 'merge');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'GITHUB_CAPABILITY_DENIED',
        projectId: 7,
        action: 'merge',
        autonomyTier: 'advisory',
        automationEnabled: true,
      });
    }
  });
});
