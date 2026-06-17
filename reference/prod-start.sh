#!/usr/bin/env bash
# Production Bottega launcher (single process): build the client, then run the
# Node/tsx server which ALSO serves the built React app from dist/ (no vite, no proxy).
set -euo pipefail
export PATH="/usr/bin:$PATH"
cd "$(dirname "$0")"

echo "[prod-start] building client bundle (vite build -> dist/)..."
pnpm exec vite build

echo "[prod-start] starting single-process server (tsx serves API + built client)..."
exec pnpm exec tsx server/index.ts
