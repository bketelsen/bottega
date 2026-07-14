import fs from 'fs';

const HOST_GITHUB_CREDENTIAL_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'SSH_AUTH_SOCK',
  'GH_CONFIG_DIR',
] as const;

const ISOLATED_GIT_SSH_COMMAND = [
  'ssh',
  '-F', '/dev/null',
  '-o', 'IdentityFile=none',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'BatchMode=yes',
  '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no',
  '-o', 'StrictHostKeyChecking=yes',
].join(' ');

/** Prevent a provider subprocess and its tools from discovering host GitHub credentials. */
export function isolateProviderGitHubEnv(
  env: Record<string, string | undefined>,
  ghConfigDir: string,
): Record<string, string | undefined> {
  for (const key of HOST_GITHUB_CREDENTIAL_KEYS) delete env[key];

  fs.mkdirSync(ghConfigDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(ghConfigDir, 0o700);
  env['GH_CONFIG_DIR'] = ghConfigDir;
  if (process.platform !== 'win32') {
    env['GIT_CONFIG_GLOBAL'] = '/dev/null';
    env['GIT_CONFIG_SYSTEM'] = '/dev/null';
  }
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_SSH_COMMAND'] = ISOLATED_GIT_SSH_COMMAND;
  return env;
}
