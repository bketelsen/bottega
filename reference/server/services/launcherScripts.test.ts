import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REFERENCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.each(['prod-start.sh', 'headless-start.sh'])('%s', (launcher) => {
  it('preserves the operator-provided PATH for pnpm', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-launcher-'));
    tempDirs.push(tempDir);
    const capturePath = path.join(tempDir, 'paths.txt');
    const fakePnpmPath = path.join(tempDir, 'pnpm');
    fs.writeFileSync(fakePnpmPath, '#!/bin/sh\nprintf "%s\\n" "$PATH" >> "$CAPTURE_PATH"\n');
    fs.chmodSync(fakePnpmPath, 0o755);

    const injectedPath = `${tempDir}:/operator/node/bin:/usr/bin:/bin`;
    const result = spawnSync('bash', [path.join(REFERENCE_ROOT, launcher)], {
      encoding: 'utf8',
      env: { ...process.env, CAPTURE_PATH: capturePath, PATH: injectedPath },
    });

    expect(result.status, result.stderr).toBe(0);
    const observedPaths = fs.readFileSync(capturePath, 'utf8').trim().split('\n');
    expect(observedPaths.length).toBe(launcher === 'prod-start.sh' ? 2 : 1);
    expect(observedPaths).toEqual(observedPaths.map(() => injectedPath));
  });
});
