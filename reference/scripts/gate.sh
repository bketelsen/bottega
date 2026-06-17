#!/usr/bin/env bash
set -euo pipefail

# Bottega quality gate.
# Single authoritative pre-merge / pre-push check — agents and humans verify the
# EXIT CODE, not the output. Run from anywhere; it cd's to the app dir (reference/).
# Assumes deps are installed (this gate validates; it does not install — except the
# CI-mirror step below, which runs the exact `pnpm install --frozen-lockfile` CI does
# so a clean lockfile drift is caught here too).
#
# `env -u NODE_ENV` clears an inherited NODE_ENV=production (the prod systemd unit sets
# it) so pnpm does not skip the devDependencies (vitest / tsc / vite) the checks need.
#
# === What GitHub CI actually runs (.github/workflows/unit-tests.yml) ===
#   pnpm install --frozen-lockfile   &&   pnpm test:run
# The two steps under "CI-equivalent" below are byte-for-byte that. If THOSE pass,
# the PR's Unit Tests check will pass. Everything after is stricter-than-CI local
# insurance (typecheck, lint) — caught here instead of after a red push.
#
# `pnpm lint` (eslint) IS in this gate as beyond-CI insurance. It is error-strict but
# warning-tolerant: eslint exits non-zero only on ERRORS, so the ~hundreds of intentional
# `no-unsafe-*` warnings (kept for opportunistic cleanup, see eslint.config.ts) do not
# block. CI still does not run lint; this catches lint errors locally before a push.

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # -> reference/

echo "=== gate: CI-equivalent — install (frozen lockfile) ==="
env -u NODE_ENV pnpm install --frozen-lockfile

echo "=== gate: CI-equivalent — unit tests (pnpm test:run = vitest run) ==="
env -u NODE_ENV pnpm test:run

echo "=== gate: beyond-CI — typecheck (tsc --noEmit) ==="
env -u NODE_ENV pnpm run typecheck

# `pnpm run lint` runs the no-JS guard first via its prelint hook (prelint = pnpm
# guard-no-js), so the TypeScript-only invariant is covered here too — no separate step.
echo "=== gate: beyond-CI — lint (eslint; prelint runs the no-JS guard) ==="
env -u NODE_ENV pnpm run lint

echo ""
echo "=== gate: PASSED ==="
