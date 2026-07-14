import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { queue } = vi.hoisted(() => ({ queue: vi.fn() }));

vi.mock('../services/webhookService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/webhookService.js')>();
  return { ...actual, queueGitHubWebhook: queue };
});

import webhooksRoutes from './webhooks.js';

describe('GitHub webhook route', () => {
  const secret = 'webhook-secret';
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    queue.mockReturnValue(true);
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    delete process.env.GITHUB_AUTH_MODE;
    app = express();
    app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhooksRoutes);
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_AUTH_MODE;
  });

  function post(event: string, payload: unknown, valid = true) {
    const body = JSON.stringify(payload);
    const signature = `sha256=${crypto
      .createHmac('sha256', valid ? secret : 'wrong')
      .update(body)
      .digest('hex')}`;
    return request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', event)
      .set('X-GitHub-Delivery', 'delivery-1')
      .set('X-Hub-Signature-256', signature)
      .send(body);
  }

  it('validates the signature against the untouched raw body', async () => {
    const response = await post('issues', { repository: { full_name: 'org/repo' } }, false);
    expect(response.status).toBe(401);
    expect(queue).not.toHaveBeenCalled();
  });

  it('accepts before asynchronous reconciliation settles', async () => {
    const payload = {
      action: 'labeled',
      issue: { number: 4 },
      repository: { full_name: 'org/repo' },
    };

    const response = await post('issues', payload);
    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      status: 'accepted',
      event: 'issues',
      repository: 'org/repo',
      delivery: 'delivery-1',
    });
    expect(queue).toHaveBeenCalledWith({ event: 'issues', payload });
  });

  it('ignores unsupported events without dispatching', async () => {
    const response = await post('push', { repository: { full_name: 'org/repo' } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ignored', event: 'push' });
    expect(queue).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON after valid HMAC verification', async () => {
    const body = '{invalid';
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    const response = await request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'issues')
      .set('X-GitHub-Delivery', 'delivery-1')
      .set('X-Hub-Signature-256', signature)
      .send(body);
    expect(response.status).toBe(400);
  });

  it.each([
    ['null payload', null],
    ['array payload', []],
    ['malformed repository', { repository: { full_name: 'org/repo/issues' } }],
  ])('returns 400 for a validly signed %s', async (_description, payload) => {
    const response = await post('issues', payload);
    expect(response.status).toBe(400);
    expect((response.body as { error?: unknown }).error).toBe('Invalid webhook payload');
    expect(queue).not.toHaveBeenCalled();
  });

  it('preserves unknown envelope fields while normalizing the repository', async () => {
    const payload = {
      action: 'opened',
      issue: { number: 4 },
      installation: { id: 12 },
      repository: { full_name: 'Org/Repo', id: 34 },
    };
    const response = await post('issues', payload);
    expect(response.status).toBe(202);
    expect(queue).toHaveBeenCalledWith({
      event: 'issues',
      payload: {
        ...payload,
        repository: { ...payload.repository, full_name: 'org/repo' },
      },
    });
  });

  it('validates delivery and event headers separately', async () => {
    const body = JSON.stringify({ repository: { full_name: 'org/repo' } });
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    const missingDelivery = await request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'issues')
      .set('X-Hub-Signature-256', signature)
      .send(body);
    expect((missingDelivery.body as { code?: unknown }).code).toBe('GITHUB_DELIVERY_INVALID');

    const missingEvent = await request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Delivery', 'delivery-2')
      .set('X-Hub-Signature-256', signature)
      .send(body);
    expect((missingEvent.body as { code?: unknown }).code).toBe('GITHUB_EVENT_INVALID');
  });

  it('rejects malformed signature headers without dispatching', async () => {
    const response = await request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'issues')
      .set('X-GitHub-Delivery', 'delivery-1')
      .set('X-Hub-Signature-256', 'not-a-signature')
      .send('{}');
    expect(response.status).toBe(401);
    expect(queue).not.toHaveBeenCalled();
  });

  it('requires app identities for automation but permits installation events without a repository', async () => {
    process.env.GITHUB_AUTH_MODE = 'app';
    const automationPayload = {
      action: 'opened',
      issue: { number: 1 },
      repository: { id: 2, full_name: 'org/repo' },
    };
    expect((await post('issues', automationPayload)).status).toBe(400);
    expect((await post('issues', {
      ...automationPayload,
      installation: { id: 10 },
    })).status).toBe(202);

    const response = await post('installation', {
      action: 'suspended',
      installation: { id: 10 },
    });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      status: 'accepted',
      event: 'installation',
      delivery: 'delivery-1',
    });
  });

  it('requires added and removed arrays for installation repository events', async () => {
    process.env.GITHUB_AUTH_MODE = 'app';
    const response = await post('installation_repositories', {
      action: 'added',
      installation: { id: 10 },
      repositories_added: [],
    });
    expect(response.status).toBe(400);
  });

  it('rejects valid deliveries after webhook shutdown starts', async () => {
    queue.mockReturnValue(false);
    const response = await post('issues', {
      action: 'opened',
      issue: { number: 4 },
      repository: { full_name: 'org/repo' },
    });
    expect(response.status).toBe(503);
  });

  it('reports webhook health', async () => {
    expect((await request(app).get('/api/webhooks/health')).body).toEqual({
      status: 'ok',
      webhookSecretConfigured: true,
    });
  });
});
