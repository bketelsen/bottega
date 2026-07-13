import { githubClient, type GitHubClient } from './client.js';

export const BOTTEGA_COMMENT_MARKER = '<!-- bottega:';

type IdentityClient = Pick<GitHubClient, 'getSelf'>;

export class GitHubIdentity {
  private login: string | undefined;
  private inFlight: Promise<string | null> | undefined;

  constructor(private readonly client: IdentityClient) {}

  resolveLogin(): Promise<string | null> {
    if (this.login) return Promise.resolve(this.login);
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.lookup().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  reset(): void {
    this.login = undefined;
    this.inFlight = undefined;
  }

  private async lookup(): Promise<string | null> {
    try {
      const login = (await this.client.getSelf()).login.trim();
      if (!login) return null;
      this.login = login;
      return login;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[GitHub] Could not resolve authenticated GitHub login:', message);
      return null;
    }
  }
}

export function isBottegaComment(
  body: string | null | undefined,
  authorLogin: string | null | undefined,
  bottegaLogin: string | null,
): boolean {
  return (
    (body?.toLowerCase().includes(BOTTEGA_COMMENT_MARKER) ?? false) ||
    (!!authorLogin && !!bottegaLogin && authorLogin.toLowerCase() === bottegaLogin.toLowerCase())
  );
}

export const githubIdentity = new GitHubIdentity(githubClient);
