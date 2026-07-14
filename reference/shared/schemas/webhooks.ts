import { z } from 'zod';

import { GitHubRepositorySchema } from './github.js';

const PositiveIdSchema = z.number().int().positive();
const ActionSchema = z.string().trim().min(1);

const RepositorySchema = z.object({
  id: PositiveIdSchema,
  full_name: GitHubRepositorySchema,
}).passthrough();

const HostRepositorySchema = RepositorySchema.partial({ id: true });
const InstallationSchema = z.object({ id: PositiveIdSchema }).passthrough();
const NumberedSchema = z.object({ number: PositiveIdSchema }).passthrough();
const UserSchema = z.object({ login: z.string() }).passthrough();
const CommentSchema = z.object({
  id: PositiveIdSchema.optional(),
  body: z.string().nullable().optional(),
  user: UserSchema.optional(),
}).passthrough();
const ReviewSchema = z.object({
  body: z.string().nullable().optional(),
  user: UserSchema.optional(),
}).passthrough();
const IssueSchema = NumberedSchema.extend({ pull_request: z.unknown().optional() });
const CheckSchema = z.object({
  conclusion: z.string().nullable().optional(),
  pull_requests: z.array(NumberedSchema),
}).passthrough();

const baseEnvelope = z.object({ action: ActionSchema }).passthrough();
const hostRepositoryEnvelope = baseEnvelope.extend({
  repository: HostRepositorySchema,
  installation: InstallationSchema.optional(),
});
const appIdentity = z.object({
  repository: RepositorySchema,
  installation: InstallationSchema,
});

export const GitHubDeliveryHeaderSchema = z.string().trim().min(1).max(255);
export const GitHubEventHeaderSchema = z.string().trim().min(1).max(100);
export const GitHubSignatureHeaderSchema = z.string().regex(/^sha256=[a-f0-9]{64}$/i);

export const GITHUB_SUPPORTED_EVENTS = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_run',
  'check_suite',
  'repository',
  'installation',
  'installation_repositories',
] as const;

export type GitHubSupportedEvent = (typeof GITHUB_SUPPORTED_EVENTS)[number];

const envelopeSchemas = {
  issues: hostRepositoryEnvelope.extend({ issue: NumberedSchema }),
  issue_comment: hostRepositoryEnvelope.extend({
    issue: IssueSchema,
    comment: CommentSchema,
  }),
  pull_request: hostRepositoryEnvelope.extend({ pull_request: NumberedSchema }),
  pull_request_review: hostRepositoryEnvelope.extend({
    pull_request: NumberedSchema,
    review: ReviewSchema,
  }),
  pull_request_review_comment: hostRepositoryEnvelope.extend({
    pull_request: NumberedSchema,
    comment: CommentSchema,
  }),
  check_run: hostRepositoryEnvelope.extend({ check_run: CheckSchema }),
  check_suite: hostRepositoryEnvelope.extend({ check_suite: CheckSchema }),
  repository: hostRepositoryEnvelope,
  installation: baseEnvelope.extend({
    installation: InstallationSchema,
    repository: RepositorySchema.optional(),
  }),
  installation_repositories: baseEnvelope.extend({
    installation: InstallationSchema,
    repositories_added: z.array(RepositorySchema),
    repositories_removed: z.array(RepositorySchema),
  }),
} satisfies Record<GitHubSupportedEvent, z.ZodType>;

export type GitHubWebhookEnvelopeByEvent = {
  [Event in GitHubSupportedEvent]: z.infer<(typeof envelopeSchemas)[Event]>;
};

export type GitHubWebhookDelivery = {
  [Event in GitHubSupportedEvent]: {
    event: Event;
    payload: GitHubWebhookEnvelopeByEvent[Event];
  };
}[GitHubSupportedEvent];

export function isSupportedGitHubEvent(event: string): event is GitHubSupportedEvent {
  return (GITHUB_SUPPORTED_EVENTS as readonly string[]).includes(event);
}

export function parseGitHubWebhookDelivery(
  event: GitHubSupportedEvent,
  value: unknown,
  appMode: boolean,
): { success: true; data: GitHubWebhookDelivery } | { success: false; error: z.ZodError } {
  const baseSchema = envelopeSchemas[event];
  const schema = appMode && event !== 'installation' && event !== 'installation_repositories'
    ? baseSchema.and(appIdentity)
    : baseSchema;
  const result = schema.safeParse(value);
  if (!result.success) return result;

  // The event selects the schema above, preserving the event/payload correlation.
  return { success: true, data: { event, payload: result.data } as GitHubWebhookDelivery };
}
