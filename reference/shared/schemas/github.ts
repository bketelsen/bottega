import { z } from 'zod';

const OWNER_PART = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const REPOSITORY_PART = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/i;

function repositoryParts(value: string): [string, string] | null {
  let candidate = value.trim();
  const prefix = candidate.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:|github\.com\/)/i,
  );
  if (prefix) candidate = candidate.slice(prefix[0].length);
  else if (candidate.includes('://') || candidate.includes('@') || candidate.includes(':')) return null;

  candidate = candidate.replace(/\/$/, '').replace(/\.git$/i, '');
  const parts = candidate.split('/');
  if (
    parts.length !== 2
    || !OWNER_PART.test(parts[0]!)
    || !REPOSITORY_PART.test(parts[1]!)
  ) {
    return null;
  }
  return [parts[0]!, parts[1]!];
}

export const GitHubRepositorySchema = z.string().transform((value, context) => {
  const parts = repositoryParts(value);
  if (!parts) {
    context.addIssue({
      code: 'custom',
      message: 'GitHub repository must be owner/name or a supported GitHub URL',
    });
    return z.NEVER;
  }
  return `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
});

export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;

export function normalizeGitHubRepository(value: string): GitHubRepository {
  return GitHubRepositorySchema.parse(value);
}
