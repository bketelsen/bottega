import express, { type Request, type Response } from 'express';
import {
  queueGitHubWebhook,
  validateGitHubWebhookSignature,
} from '../services/webhookService.js';
import {
  GitHubDeliveryHeaderSchema,
  GitHubEventHeaderSchema,
  GitHubSignatureHeaderSchema,
  isSupportedGitHubEvent,
  parseGitHubWebhookDelivery,
} from '../../shared/schemas/webhooks.js';

const router = express.Router();

router.post('/github', (req: Request, res: Response<unknown>) => {
  const signatureResult = GitHubSignatureHeaderSchema.safeParse(req.headers['x-hub-signature-256']);
  if (
    !signatureResult.success
    || !Buffer.isBuffer(req.body)
    || !validateGitHubWebhookSignature(
      req.body,
      signatureResult.data,
      process.env.GITHUB_WEBHOOK_SECRET,
    )
  ) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const deliveryResult = GitHubDeliveryHeaderSchema.safeParse(req.headers['x-github-delivery']);
  if (!deliveryResult.success) {
    return res.status(400).json({
      error: 'Invalid GitHub delivery header',
      code: 'GITHUB_DELIVERY_INVALID',
    });
  }

  const eventResult = GitHubEventHeaderSchema.safeParse(req.headers['x-github-event']);
  if (!eventResult.success) {
    return res.status(400).json({ error: 'Invalid GitHub event header', code: 'GITHUB_EVENT_INVALID' });
  }
  const event = eventResult.data;
  if (!isSupportedGitHubEvent(event)) {
    return res.status(200).json({ status: 'ignored', event });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(req.body.toString('utf8')) as unknown;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const parsedDelivery = parseGitHubWebhookDelivery(
    event,
    parsedJson,
    process.env.GITHUB_AUTH_MODE?.trim() === 'app',
  );
  if (!parsedDelivery.success) {
    return res.status(400).json({ error: 'Invalid webhook payload', issues: parsedDelivery.error.issues });
  }
  const delivery = parsedDelivery.data;

  const repository = delivery.event === 'installation_repositories'
    ? undefined
    : delivery.payload.repository?.full_name;

  if (!queueGitHubWebhook(delivery)) {
    return res.status(503).json({ error: 'Webhook service is shutting down' });
  }

  // Reconciliation starts on the next event-loop turn so acceptance remains immediate.
  res.status(202).json({
    status: 'accepted',
    event,
    delivery: deliveryResult.data,
    ...(repository ? { repository } : {}),
  });
});

router.get('/health', (_req: Request, res: Response<unknown>) => {
  res.json({
    status: 'ok',
    webhookSecretConfigured: !!process.env.GITHUB_WEBHOOK_SECRET,
  });
});

export default router;
