import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isHeadless,
  getOpenApiSpec,
  registerApiDocs,
  registerStaticFrontend,
  registerSpaFallback,
  registerHeadlessRoutes,
} from './serving.js';

// A bare app that mirrors how index.ts wires public meta routes + a couple of
// representative API routes, so we can assert serving behavior without booting
// the full server (which has startup side effects).
function baseApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/auth/status', (_req, res) =>
    res.json({ needsSetup: true, isAuthenticated: false }),
  );
  return app;
}

describe('isHeadless', () => {
  const original = process.env.HEADLESS;
  afterEach(() => {
    if (original === undefined) delete process.env.HEADLESS;
    else process.env.HEADLESS = original;
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('is true for %s', (v) => {
    process.env.HEADLESS = v;
    expect(isHeadless()).toBe(true);
  });

  it.each(['', '0', 'false', 'no', 'off', 'nope'])('is false for "%s"', (v) => {
    process.env.HEADLESS = v;
    expect(isHeadless()).toBe(false);
  });

  it('is false when unset', () => {
    delete process.env.HEADLESS;
    expect(isHeadless()).toBe(false);
  });
});

describe('OpenAPI docs (both modes)', () => {
  let app: express.Application;
  beforeEach(() => {
    app = baseApp();
    registerApiDocs(app);
  });

  it('serves the spec at /api/openapi.json', async () => {
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/health']).toBeDefined();
  });

  it('serves the docs UI at /api/docs', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('/api/openapi.json');
  });

  it('getOpenApiSpec returns a parsed object', () => {
    const spec = getOpenApiSpec();
    expect(spec.openapi).toBe('3.1.0');
  });
});

describe('headless serving', () => {
  let app: express.Application;
  beforeEach(() => {
    app = baseApp();
    registerApiDocs(app);
    registerHeadlessRoutes(app);
  });

  it('keeps /health working', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('keeps the API working', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
  });

  it('serves a JSON service banner at /', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('headless');
    expect(res.body.endpoints.openapi).toBe('/api/openapi.json');
  });

  it('returns a JSON 404 for unknown non-API routes (no SPA fallback)', async () => {
    const res = await request(app).get('/dashboard/anything');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error).toBe('Not found');
    expect(res.body.path).toBe('/dashboard/anything');
  });

  it('returns a JSON 404 for unknown API routes', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});

describe('non-headless SPA fallback', () => {
  let tmpDist: string;
  beforeEach(() => {
    tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-dist-'));
    fs.writeFileSync(path.join(tmpDist, 'index.html'), '<!doctype html><title>SPA</title>');
  });
  afterEach(() => {
    fs.rmSync(tmpDist, { recursive: true, force: true });
  });

  it('serves index.html for non-API routes', async () => {
    const app = baseApp();
    registerStaticFrontend(app, { distDir: tmpDist });
    registerSpaFallback(app, tmpDist);

    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.text).toContain('SPA');
  });

  it('does NOT intercept /api routes (regex excludes /api)', async () => {
    const app = baseApp();
    registerSpaFallback(app, tmpDist);

    // /api/auth/status is a real route -> still JSON, not the SPA shell.
    const ok = await request(app).get('/api/auth/status');
    expect(ok.status).toBe(200);
    expect(ok.body.needsSetup).toBe(true);

    // An unknown /api route is not caught by the fallback -> default 404,
    // and crucially does not return the SPA index.html.
    const missing = await request(app).get('/api/nope');
    expect(missing.text).not.toContain('SPA');
  });
});
