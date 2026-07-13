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
    app = express();
    app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhooksRoutes);
  });

  afterEach(() => delete process.env.GITHUB_WEBHOOK_SECRET);

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
    });
    expect(queue).toHaveBeenCalledWith('issues', payload);
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
      installation: { id: 12 },
      repository: { full_name: 'Org/Repo', id: 34 },
    };
    const response = await post('issues', payload);
    expect(response.status).toBe(202);
    expect(queue).toHaveBeenCalledWith('issues', {
      ...payload,
      repository: { ...payload.repository, full_name: 'org/repo' },
    });
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
