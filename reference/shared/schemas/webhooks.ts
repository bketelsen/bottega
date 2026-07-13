import { z } from 'zod';

import { GitHubRepositorySchema } from './github.js';

export const GitHubWebhookEnvelopeSchema = z
  .object({
    repository: z
      .object({
        full_name: GitHubRepositorySchema,
      })
      .passthrough(),
  })
  .passthrough();

export type GitHubWebhookEnvelope = z.infer<typeof GitHubWebhookEnvelopeSchema>;
