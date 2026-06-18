// HTTP serving concerns that differ between the normal (UI-serving) deployment
// and the headless (API-only) deployment.
//
// In the default deployment a single Node process serves the REST API + the
// built React SPA from `dist/`. When `HEADLESS` is set the process serves the
// API + WebSocket only: no static assets, no SPA history fallback. Instead the
// root path returns a small JSON service banner and unmatched routes return a
// JSON 404 (rather than Express's default HTML).
//
// The OpenAPI spec + docs UI are served in BOTH modes — they're most useful
// headless, but harmless with the UI present.
//
// Directory arguments are injectable so the serving wiring can be exercised in
// tests without a built `dist/` on disk; they default to the real locations.

import express, { type Application, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const OPENAPI_PATH = path.join(ROOT_DIR, 'docs', 'openapi.json');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');

/** True when the server should run API-only (no frontend serving). */
export function isHeadless(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.HEADLESS ?? '');
}

let cachedSpec: Record<string, unknown> | null = null;

/** Parse and cache the hand-maintained OpenAPI spec from `docs/openapi.json`. */
export function getOpenApiSpec(): Record<string, unknown> {
  if (cachedSpec === null) {
    cachedSpec = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8')) as Record<string, unknown>;
  }
  return cachedSpec;
}

let cachedVersion: string | null = null;

function appVersion(): string {
  if (cachedVersion === null) {
    try {
      const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { version?: unknown };
      cachedVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
    } catch {
      cachedVersion = 'unknown';
    }
  }
  return cachedVersion;
}

// Scalar standalone, loaded from CDN. Serving an HTML string (not a .js file)
// keeps the no-JS guard green and needs no build step or extra dependency.
const DOCS_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bottega API Reference</title>
  </head>
  <body>
    <script id="api-reference" data-url="/api/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>
`;

/**
 * Serve the OpenAPI spec at `/api/openapi.json` and an interactive docs UI at
 * `/api/docs`. Must be registered BEFORE the authenticated `/api` routers so the
 * public spec isn't gated behind a token.
 */
export function registerApiDocs(app: Application): void {
  app.get('/api/openapi.json', (_req: Request, res: Response) => {
    res.json(getOpenApiSpec());
  });
  app.get('/api/docs', (_req: Request, res: Response) => {
    res.type('html').send(DOCS_HTML);
  });
}

/** Serve static assets (`public/`) and the built SPA bundle (`dist/`). */
export function registerStaticFrontend(
  app: Application,
  dirs: { publicDir?: string; distDir?: string } = {},
): void {
  app.use(express.static(dirs.publicDir ?? PUBLIC_DIR));
  app.use(express.static(dirs.distDir ?? DIST_DIR));
}

/** SPA history fallback: any non-`/api` GET returns the built `index.html`. */
export function registerSpaFallback(app: Application, distDir: string = DIST_DIR): void {
  // Express 5 dropped bare "*" string routes; use a negative-lookahead RegExp.
  app.get(/^(?!\/api).*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

/**
 * Headless serving: a JSON service banner at `/` and a JSON 404 catch-all for
 * every unmatched route (there is no SPA to fall back to). Register LAST.
 */
export function registerHeadlessRoutes(app: Application): void {
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'bottega',
      version: appVersion(),
      mode: 'headless',
      endpoints: {
        health: '/health',
        api: '/api',
        docs: '/api/docs',
        openapi: '/api/openapi.json',
      },
    });
  });

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });
}
