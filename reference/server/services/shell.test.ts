import { afterEach, describe, expect, it } from 'vitest';

import { runCommand } from './shell.js';

const CREDENTIAL_NAMES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const;

describe('runCommand environment', () => {
  const original = Object.fromEntries(CREDENTIAL_NAMES.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const name of CREDENTIAL_NAMES) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('removes inherited GitHub credentials before applying the trusted overlay', async () => {
    for (const name of CREDENTIAL_NAMES) process.env[name] = `inherited-${name}`;

    const { stdout } = await runCommand(
      process.execPath,
      ['-e', `process.stdout.write(JSON.stringify({
        GH_TOKEN: process.env.GH_TOKEN,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
        GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
        GITHUB_ENTERPRISE_TOKEN: process.env.GITHUB_ENTERPRISE_TOKEN,
        GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      }))`],
      { env: { GH_TOKEN: 'trusted-token', GH_CONFIG_DIR: '/tmp/isolated-gh' } },
    );

    expect(JSON.parse(stdout)).toEqual({
      GH_TOKEN: 'trusted-token',
      GH_CONFIG_DIR: '/tmp/isolated-gh',
    });
    expect(process.env.GITHUB_TOKEN).toBe('inherited-GITHUB_TOKEN');
  });
});
