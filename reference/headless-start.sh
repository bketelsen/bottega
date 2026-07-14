#!/usr/bin/env bash
# Headless Bottega launcher (API only): no `vite build`, no frontend served.
# Runs the same Node/tsx server with HEADLESS=1 so it serves the REST API +
# WebSocket and the OpenAPI docs, but no static assets or SPA fallback.
#
# Suitable for container/daemon deployments that configure the server purely
# through environment variables (JWT_SECRET is required); a .env file is
# optional here.
set -euo pipefail
cd "$(dirname "$0")"

echo "[headless-start] starting API-only server (no vite build, frontend disabled)..."
HEADLESS=1 exec pnpm exec tsx server/index.ts
