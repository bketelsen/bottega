import express, { type Request, type Response } from 'express';
import {
  isSupportedGitHubEvent,
  queueGitHubWebhook,
  validateGitHubWebhookSignature,
} from '../services/webhookService.js';
import { GitHubWebhookEnvelopeSchema } from '../../shared/schemas/webhooks.js';

const router = express.Router();

router.post('/github', (req: Request, res: Response<unknown>) => {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  if (
    !validateGitHubWebhookSignature(
      req.body as Buffer,
      signature,
      process.env.GITHUB_WEBHOOK_SECRET,
    )
  ) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse((req.body as Buffer).toString('utf8')) as unknown;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const parsedPayload = GitHubWebhookEnvelopeSchema.safeParse(parsedJson);
  if (!parsedPayload.success) {
    return res.status(400).json({ error: 'Invalid webhook payload', issues: parsedPayload.error.issues });
  }
  const payload = parsedPayload.data;

  const event = req.headers['x-github-event'] as string | undefined;
  if (!event || !isSupportedGitHubEvent(event)) {
    return res.status(200).json({ status: 'ignored', event });
  }

  const repository = payload.repository.full_name;

  if (!queueGitHubWebhook(event, payload)) {
    return res.status(503).json({ error: 'Webhook service is shutting down' });
  }

  // Reconciliation starts on the next event-loop turn so acceptance remains immediate.
  res.status(202).json({ status: 'accepted', event, repository });
});

router.get('/health', (_req: Request, res: Response<unknown>) => {
  res.json({
    status: 'ok',
    webhookSecretConfigured: !!process.env.GITHUB_WEBHOOK_SECRET,
  });
});

export default router;
