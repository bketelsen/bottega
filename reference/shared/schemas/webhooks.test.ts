import { describe, expect, it } from 'vitest';

import { parseGitHubWebhookDelivery } from './webhooks.js';

describe('GitHub webhook schemas', () => {
  it('requires app repository and installation identities for automation events', () => {
    expect(parseGitHubWebhookDelivery('issues', {
      action: 'opened',
      issue: { number: 1 },
      installation: { id: 10 },
      repository: { id: 100, full_name: 'Owner/Repo', private: true },
      sender: { login: 'octocat' },
    }, true)).toMatchObject({
      success: true,
      data: {
        event: 'issues',
        payload: {
          repository: { full_name: 'owner/repo', private: true },
          sender: { login: 'octocat' },
        },
      },
    });
    expect(parseGitHubWebhookDelivery('issues', {
      action: 'opened',
      issue: { number: 1 },
      repository: { id: 100, full_name: 'owner/repo' },
    }, true).success).toBe(false);
  });

  it('allows installation events without repositories', () => {
    expect(parseGitHubWebhookDelivery('installation', {
      action: 'suspended',
      installation: { id: 10 },
    }, true).success).toBe(true);
  });

  it('requires both repository change arrays', () => {
    expect(parseGitHubWebhookDelivery('installation_repositories', {
      action: 'added',
      installation: { id: 10 },
      repositories_added: [],
      repositories_removed: [],
    }, true).success).toBe(true);
    expect(parseGitHubWebhookDelivery('installation_repositories', {
      action: 'added',
      installation: { id: 10 },
      repositories_added: [],
    }, true).success).toBe(false);
  });

  it('keeps host payloads compatible without numeric identities', () => {
    expect(parseGitHubWebhookDelivery('issues', {
      action: 'opened',
      issue: { number: 1 },
      repository: { full_name: 'owner/repo' },
    }, false).success).toBe(true);
  });
});
