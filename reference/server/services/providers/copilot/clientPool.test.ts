import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopilotClient } from '@github/copilot-sdk';

import { writeCopilotAuth } from '../../copilotCredentials.js';
import {
  _resetCopilotClientPool,
  getOrSpawnCopilotClient,
  shutdownAllCopilotClients,
  type CreateClientFn,
} from './clientPool.js';

describe('copilot client pool credential isolation', () => {
  let tempRoot: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-copilot-pool-'));
    originalRoot = process.env['COPILOT_CONFIG_ROOT'];
    process.env['COPILOT_CONFIG_ROOT'] = tempRoot;
  });

  afterEach(async () => {
    await shutdownAllCopilotClients();
    _resetCopilotClientPool();
    if (originalRoot === undefined) delete process.env['COPILOT_CONFIG_ROOT'];
    else process.env['COPILOT_CONFIG_ROOT'] = originalRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('passes isolated env to the long-lived runtime without replacing explicit auth', async () => {
    writeCopilotAuth(7, { gitHubToken: 'per-user-model-token' });
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => [] as Error[]);
    const createClient = vi.fn((_args: Parameters<CreateClientFn>[0]) => ({
      start,
      stop,
      forceStop: vi.fn(async () => {}),
    } as unknown as CopilotClient));
    _resetCopilotClientPool({
      createClient,
      reapIntervalMs: Number.POSITIVE_INFINITY,
    });

    await getOrSpawnCopilotClient(7);

    expect(createClient).toHaveBeenCalledTimes(1);
    const args = createClient.mock.calls[0]![0];
    expect(args.gitHubToken).toBe('per-user-model-token');
    expect(args.env['COPILOT_SDK_AUTH_TOKEN']).toBeUndefined();
    expect(args.env['GH_TOKEN']).toBeUndefined();
    expect(args.env['GITHUB_TOKEN']).toBeUndefined();
    expect(args.env['SSH_AUTH_SOCK']).toBeUndefined();
    expect(args.env['GH_CONFIG_DIR']).toBe(path.join(tempRoot, '7', 'copilot', 'gh'));
    expect(args.env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(args.env['GIT_CONFIG_SYSTEM']).toBe('/dev/null');
    expect(args.env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(start).toHaveBeenCalledOnce();
  });
});
