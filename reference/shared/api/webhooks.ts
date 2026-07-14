// Request/response shapes for /api/webhooks/*.
//
// The GitHub webhook receives raw bodies (HMAC validation precedes JSON
// parse), so the request body is opaque from the route's perspective —
// we don't type the inbound shape here. Outbound responses follow the
// accepted deliveries return 202 before reconciliation starts; unsupported
// deliveries return 200 so GitHub does not retry expected no-ops.

import { expectType } from './_common';

// ---- POST /api/webhooks/github -------------------------------------------

export interface WebhookAcceptedResponse {
  status: 'accepted';
  event: string;
  repository?: string;
  delivery: string;
}

export interface WebhookIgnoredResponse {
  status: 'ignored';
  // Specific reason. Common values include:
  //   - 'no @bottega mention'
  //   - 'could not determine branch'
  //   - 'branch not in task format'
  //   - 'task not found' / 'already completed' / 'already running'
  //   - `not a ${expectedAction} event`
  //   - `not a PR comment`
  reason?: string;
  // Some early branches return only `{ status: 'ignored', event }`.
  event?: string;
}

export type GitHubWebhookResponse =
  | WebhookAcceptedResponse
  | WebhookIgnoredResponse;

// ---- GET /api/webhooks/health --------------------------------------------

export interface WebhookHealthResponse {
  status: 'ok';
  webhookSecretConfigured: boolean;
}

// ---- Type-level smoke checks ---------------------------------------------

expectType<GitHubWebhookResponse>({
  status: 'accepted',
  event: 'issues',
  repository: 'owner/repo',
  delivery: 'delivery-id',
});
expectType<GitHubWebhookResponse>({ status: 'ignored' });
