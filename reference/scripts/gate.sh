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
# insurance (typecheck, no-JS guard) — caught here instead of after a red push.
#
# NOTE: `pnpm lint` is intentionally NOT in this gate. CI does not run it, and the
# repo's eslint@10 flat-config currently CRASHES (exit 2, not findings) — including it
# would make the gate redder than CI, the opposite of "no surprises". Re-add only once
# CI runs lint AND the eslint config is fixed.

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # -> reference/

echo "=== gate: CI-equivalent — install (frozen lockfile) ==="
env -u NODE_ENV pnpm install --frozen-lockfile

echo "=== gate: CI-equivalent — unit tests (pnpm test:run = vitest run) ==="
env -u NODE_ENV pnpm test:run

echo "=== gate: beyond-CI — typecheck (tsc --noEmit) ==="
env -u NODE_ENV pnpm run typecheck

echo "=== gate: beyond-CI — no-JS guard (TypeScript-only invariant) ==="
env -u NODE_ENV pnpm run guard-no-js

echo ""
echo "=== gate: PASSED ==="
