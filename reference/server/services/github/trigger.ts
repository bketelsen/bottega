import { appSettingsDb } from '../../database/db.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function githubPrTriggerMentionPattern(): RegExp {
  const trigger = appSettingsDb.getValue('github_pr_trigger') || 'bottega';
  return new RegExp(`(^|\\W)@${escapeRegExp(trigger)}(?![\\w-])`, 'i');
}

export function hasGitHubPrTriggerMention(body: string | null | undefined): boolean {
  return githubPrTriggerMentionPattern().test(body ?? '');
}
