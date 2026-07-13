import { describe, expect, it } from 'vitest';

import { GitHubRepositorySchema, normalizeGitHubRepository } from './github.js';

describe('GitHubRepositorySchema', () => {
  it.each([
    [' Owner/Repo ', 'owner/repo'],
    ['https://github.com/Owner/Repo.git', 'owner/repo'],
    ['http://github.com/Owner/Repo/', 'owner/repo'],
    ['github.com/Owner/Repo', 'owner/repo'],
    ['git@github.com:Owner/Repo.git', 'owner/repo'],
    ['ssh://git@github.com/Owner/Repo', 'owner/repo'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeGitHubRepository(input)).toBe(expected);
    expect(GitHubRepositorySchema.parse(input)).toBe(expected);
  });

  it.each([
    '',
    'owner',
    'owner/repo/issues',
    'https://example.com/owner/repo',
    'git@example.com:owner/repo',
    '-owner/repo',
    'owner/repo-',
  ])('rejects malformed repository %s', (input) => {
    expect(GitHubRepositorySchema.safeParse(input).success).toBe(false);
  });
});
