# GitHub App Service Identity Plan

**Status:** Implemented; deployment cutover requires `GITHUB_AUTH_MODE=app`
**Reference implementation:** Yeti's GitHub App authentication (`src/github-app.ts`)
**Target:** Bottega GitHub automation introduced by
[`yeti-migration-plan.md`](./yeti-migration-plan.md)

## Goal

Give Bottega a distinct, repository-scoped GitHub service identity for automated
work without deliberately passing installation tokens to model subprocesses.

When configured, automated GitHub activity should appear as the deployment's
GitHub App bot:

- Plan and status comments are authored by `bottega[bot]`.
- Labels are changed by `bottega[bot]`.
- Task branches are pushed using short-lived installation credentials.
- Pull requests are opened and updated by `bottega[bot]`.
- Automated commits use the bot's Git name and GitHub noreply address.
- Human maintainers can review and approve bot-authored pull requests.

Bottega users continue to own tasks, model credentials, conversations, and
notifications. A task owner determines which model account performs reasoning;
the GitHub App determines which GitHub identity performs automation.

## Why This Replaces Per-User OAuth for Automation

Per-user GitHub OAuth solves attribution by making a task owner's token
available to Git and `gh`. That is the wrong default for automated work:

- A classic OAuth `repo` token can reach every repository the user can reach.
- An unrestricted agent could read or misuse a token placed in its environment.
- Different task owners produce inconsistent automation identity and branch
  protection behavior.
- A user's departure or revoked token can disable project-wide automation.
- Automated PRs authored by a maintainer cannot be approved by that maintainer.

A GitHub App provides a stable bot identity, installation-selected repository
access, explicit permissions, and short-lived tokens. Per-user OAuth may still
be considered later for a deliberately human-attributed manual action, but it
is not part of this plan.

## Scope

This plan includes:

- GitHub App JWT generation and installation discovery.
- Repository-downscoped installation token minting and refresh.
- App authentication for the existing GitHub client.
- App authentication for trusted server-side Git fetch and push operations.
- Bot identity for comments, PRs, and commits.
- Removal of ambient GitHub credentials from automated agent paths.
- A server-owned PR finalization path so agents do not need GitHub credentials.
- Project readiness checks, health reporting, and administrator UI.
- Webhook installation validation and App webhook configuration.
- Migration from ambient host `gh` authentication.

This plan does not include:

- Automatic merge. The existing `automerge` tier remains reserved.
- A user-facing GitHub OAuth connection.
- A general secret broker or provider credential redesign.
- A complete sandbox for model subprocesses.
- Historical reassignment of existing comments, commits, or PRs.
- A GitHub App marketplace or multi-tenant hosted App.

## Current State

The credential-free prompt and UI contract is implemented: PR-family prompts
assign only local editing and verification to agents, append a non-overridable
server-publication invariant after operator templates, and use
`complete-pr.ts` as an explicit run-scoped readiness signal. The task-detail CI
repair action starts a real PR agent run rather than an ordinary conversation.
YOLO does not use the PR-run signal; after its local `complete-workflow.ts`
signal, the server owns publication.

The remaining paragraphs describe the legacy behavior this plan replaces and
the server-side publication work required for the complete cutover.

Bottega currently uses the host's ambient `gh` and Git credentials:

- `server/services/github/client.ts` shells out to `gh` without an explicit
  authentication environment.
- `server/services/worktree.ts` fetches and pushes through the checkout's
  configured `origin`.
- `server/services/github/identity.ts` calls `/user` and caches that login as
  Bottega's self identity.
- The PR agent is prompted to push and create or update a PR from its shell.
- Project autonomy checks guard application-owned effects but are not a
  credential boundary for a shell-capable agent.

Consequently, comments and PRs appear as whichever account authenticated `gh`
on the host. A server with personal Git credentials can also make those
credentials reachable through inherited `HOME`, Git configuration, SSH keys,
or an SSH agent.

## Yeti Lessons

### Retain

Yeti's implementation established useful, tested behavior:

1. Sign App JWTs with Node's `crypto` using RS256.
2. Use the App client ID as `iss` (GitHub also accepts the numeric App ID),
   backdate `iat` by 30 seconds, and expire the JWT after 10 minutes.
3. Use direct HTTP with `Authorization: Bearer` for App-level endpoints. `gh`
   does not reliably send an App JWT using the required authorization form.
4. Refresh one-hour installation tokens five minutes before expiration.
5. Deduplicate concurrent refreshes.
6. Keep the last valid token after a transient refresh failure, but never use it
   after expiration.
7. Resolve the App slug explicitly because installation tokens cannot use
   `GET /user`.
8. Validate the private key path and file permissions.
9. Configure the App webhook URL and secret through `PATCH /app/hook/config`.
10. Keep polling as recovery for missed webhook events.

Yeti predates GitHub's recommendation to use the App client ID and converts its
issuer to a number. Do not copy that conversion: a client-ID issuer such as
`Iv1...` is a JSON string, while an App-ID fallback is a JSON number. Both forms
must be covered by a real GitHub App integration test.

### Do Not Retain

Yeti was a mostly single-installation daemon. These choices do not fit
Bottega's multi-user and multi-project runtime:

- One installation ID in global configuration.
- One module-global installation token.
- Writing the token to `process.env.GH_TOKEN` or `GITHUB_TOKEN`.
- Letting model and provider subprocesses inherit the token.
- Running `gh auth setup-git`, which mutates persistent host configuration.
- Falling back silently to a personal `gh` login after App initialization
  fails.
- A single global login and rate-limit state for every repository.
- Assuming token lifetime at agent start is sufficient for later effects.

## Architectural Decisions

### One App, many installations

One Bottega deployment uses one GitHub App. The App may be installed on multiple
accounts and on selected repositories within each account.

Do not configure one installation ID globally. Resolve the installation for
each project repository with an App JWT and persist the mapping on the project.

Use one App per Bottega deployment. A GitHub App has one webhook configuration;
multiple deployments sharing one App would overwrite each other's callback
URL unless a separate webhook fan-out service were introduced.

### Repository identity is numeric

`projects.github_repo` remains the canonical display name, but GitHub repository
ID becomes the durable identity. Names can change; IDs do not.

Webhook dispatch and token acquisition must verify both repository ID and
installation ID against the enabled project.

### Installation tokens are request-scoped

Installation tokens live only inside the App authentication service cache and
the environment of a trusted, short-lived server subprocess. They are never:

- Stored in SQLite.
- Written to `process.env`.
- Included in argv, logs, errors, remote URLs, or persistent Git config.
- Passed to Claude, Codex, OpenCode, or Copilot.

Mint tokens restricted to the target repository and the minimum permission
profile needed by the operation.

### Enabled App mode fails closed

Authentication mode is explicit:

```text
app   - require a valid App installation; never use ambient credentials
host  - legacy ambient host authentication during migration
```

If `app` mode is selected and token acquisition fails, the operation fails with
an actionable integration error. It must not fall back to host credentials.

### Agents prepare; the server publishes

Agents edit and test a worktree without GitHub credentials. Trusted server code
commits remaining changes, pushes branches, and creates or updates pull
requests after fresh policy checks.

This turns the existing autonomy checks into an enforceable boundary for the
App credential. It is still not a complete shell sandbox: an agent could try to
use other ambient host credentials unless deployment isolation removes them.

## Configuration

Add restart-required deployment settings:

```dotenv
# app = require GitHub App auth; host = legacy ambient gh auth
GITHUB_AUTH_MODE=host

GITHUB_APP_CLIENT_ID=
# Optional diagnostic identifier; accepted as JWT issuer fallback
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY_PATH=
BOTTEGA_EXTERNAL_URL=

# Existing shared secret used to validate App webhook deliveries
GITHUB_WEBHOOK_SECRET=
```

Rules:

- `host` remains the default for one compatibility release.
- `app` requires an App client ID (or App ID fallback) and private key path and
  refuses to initialize with partial core authentication configuration.
- `BOTTEGA_EXTERNAL_URL` and `GITHUB_WEBHOOK_SECRET` are an optional pair. If
  both are absent, App authentication runs in polling-only mode with degraded
  webhook health. Supplying only one is a configuration error.
- Production App mode requires the PEM file to be owned by the service account
  and have mode `0600`. Development may warn; production should fail.
- Private key contents and installation tokens never enter app settings or
  SQLite.
- App configuration changes require restart.

## GitHub App Permissions

Request these repository permissions:

| Permission | Access | Used for |
|---|---|---|
| Metadata | Read | Automatically included repository metadata access |
| Contents | Read/write | Fetch and push task branches |
| Issues | Read/write | Issue intake, comments, and labels |
| Pull requests | Read/write | PR creation, review evidence, and comments |
| Checks | Read | Check-run evidence |
| Commit statuses | Read | Classic status evidence |

Add Workflows write only if Bottega must push changes under
`.github/workflows/`. Keep it out of the base profile when workflow-file edits
are prohibited.

Subscribe the App to:

- Issues
- Issue comments
- Pull requests
- Pull request reviews
- Pull request review comments
- Check runs
- Check suites
- Repository events, including rename

Installation lifecycle and installation repository-selection events are sent
to GitHub Apps automatically; they are handled even though they are not
selectable subscriptions. Checks read access supports normal completion
events. Do not advertise or depend on `rerequested` or `requested_action`
unless Checks write permission is deliberately added.

Changing App permissions requires the installation owner to approve the new
permissions before GitHub grants them. Surface pending or insufficient
permissions as degraded integration health.

## Data Model

### Projects

Add nullable columns:

```sql
ALTER TABLE projects ADD COLUMN github_repository_id INTEGER;
ALTER TABLE projects ADD COLUMN github_installation_id INTEGER;
```

Add a partial unique index for repository ID:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_github_repository_id
  ON projects(github_repository_id)
  WHERE github_repository_id IS NOT NULL;
```

The existing `github_repo` unique index remains during migration. A project is
App-ready only when name, repository ID, and installation ID agree with GitHub.

Do not add a unique installation index: one installation serves many
repositories.

### Agent runs

PR publication must not run solely because an SDK stream ended. Add explicit
finalization state to `task_agent_runs`:

```sql
ALTER TABLE task_agent_runs ADD COLUMN github_finalize_status TEXT NOT NULL
  DEFAULT 'none'
  CHECK (github_finalize_status IN
    ('none', 'ready', 'finalizing', 'finalized', 'failed'));
ALTER TABLE task_agent_runs ADD COLUMN github_finalize_head_sha TEXT;
ALTER TABLE task_agent_runs ADD COLUMN github_finalize_error TEXT;
ALTER TABLE task_agent_runs ADD COLUMN github_finalize_started_at DATETIME;
```

Only PR runs use these fields initially. A PR agent marks its run `ready` after
it has completed edits and local verification. The lifecycle handler finalizes
only when:

- The provider turn ended successfully rather than aborting or crashing.
- The run is still the current PR run for the task.
- `github_finalize_status` is `ready`.
- The worktree still exists.

Use compare-and-set updates for `ready|failed -> finalizing`. A `finalizing`
lease may be reclaimed only after `github_finalize_started_at` exceeds a fixed
timeout. Before every retry or lease reclaim, inspect remote branch and PR state
to determine which effects already succeeded.

## App Authentication Service

Add `server/services/github/appAuth.ts`.

Suggested public contract:

```ts
export interface GitHubRepositoryAuth {
  token: string;
  expiresAt: number;
  installationId: number;
  repositoryId: number;
  repository: string;
  botLogin: string;
  botUserId: number;
  botEmail: string;
}

export async function resolveRepositoryInstallation(
  repository: string,
): Promise<{
  repositoryId: number;
  installationId: number;
  canonicalFullName: string;
}>;

export async function getRepositoryAuth(
  projectId: number,
  action: GitHubAction,
): Promise<GitHubRepositoryAuth>;

export async function getGitHubAppHealth(): Promise<GitHubAppHealth>;
export function invalidateInstallation(installationId: number): void;
```

### JWT generation

Generate a new App JWT for App-level calls:

```json
{
  "iss": "Iv1.app-client-id",
  "iat": "now - 30 seconds",
  "exp": "now + 10 minutes"
}
```

Use direct `fetch` with:

```text
Authorization: Bearer <app-jwt>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

Prefer the App client ID as a string issuer; the numeric App ID is an accepted
number fallback. Never apply `Number(...)` to a client ID. Client-ID issuer
support post-dates Yeti's implementation, whose numeric-only comment is no
longer the complete GitHub contract. Never pass an App JWT through `GH_TOKEN`.

### Installation discovery

At project validation:

1. Normalize `owner/name`.
2. Call `GET /repos/{owner}/{repo}/installation` with the App JWT.
3. Reject an installation whose `suspended_at` is non-null.
4. Mint a test token restricted by repository name.
5. Call `GET /repos/{owner}/{repo}` with that installation token.
6. Verify the returned canonical `full_name` and numeric repository ID.
7. Return and persist GitHub's canonical `full_name` with the repository and
   installation IDs rather than retaining user-entered casing or a stale name.

Do not guess an installation or accept a name-only match after discovery fails.

### Installation token minting

Call:

```text
POST /app/installations/{installationId}/access_tokens
```

Downscope the request to the one repository being operated on. For the initial
cutover, use one automation permission profile matching the App's minimal
registered permissions. Per-action permission profiles are a later hardening
option; Bottega's capability checks still gate every action.

Cache by:

```text
installationId + repositoryId + permissionProfile
```

Each cache entry stores token and expiration. Refresh when less than five
minutes remain. Use one in-flight refresh promise per key.

If refresh fails:

- Continue using the previous token only while it is unexpired.
- Never serve it after expiration.
- Invalidate immediately on an authentication 401.
- Re-resolve installation mapping on a repository or installation 404.
- Redact GitHub response bodies before logging if they could contain secrets.

### Bot identity

Resolve App metadata once at startup with `GET /app`. Derive the login as
`${slug}[bot]`, then resolve that bot user's numeric ID. Build the Git identity:

```text
name:  bottega[bot]
email: <bot-user-id>+bottega[bot]@users.noreply.github.com
```

Do not assume App ID and bot user ID are the same.

## Authenticated Command Execution

Extend `RunCommandOptions` in `server/services/shell.ts`:

```ts
interface RunCommandOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  env?: Record<string, string | undefined>;
}
```

When `env` is supplied, build a deliberate child environment. Strip inherited
GitHub credential variables before applying the trusted overlay.

### `gh` environment

For trusted GitHub client calls:

```text
GH_TOKEN=<installation-token>
GH_CONFIG_DIR=<empty deployment-owned directory>
```

The empty config directory prevents fallback to a host user's `gh` login. Only
`GH_TOKEN` is required; do not set redundant token variables.

### Git environment

For trusted remote Git calls:

```text
GH_TOKEN=<installation-token>
GH_CONFIG_DIR=<empty directory>
GIT_TERMINAL_PROMPT=0
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_SYSTEM=/dev/null
```

Supply invocation-local `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, and
`GIT_CONFIG_VALUE_n` entries for:

- An empty `credential.helper` value that resets inherited and local helpers.
- `credential.https://github.com.helper=!gh auth git-credential`
- `credential.https://github.com.username=x-access-token`
- Rewriting `git@github.com:` to `https://github.com/`
- Rewriting `ssh://git@github.com/` to `https://github.com/`

This supports existing SSH-form remotes without changing the persisted remote.
Reject remotes outside `github.com`, remotes containing embedded userinfo, and
unsupported URL forms. Do not place the token in the URL or install a
persistent helper.

## GitHub Client Changes

Make `server/services/github/client.ts` project-authenticated:

1. Every production operation requires `GitHubProject` or a resolved repository
   auth context; bare repository-string overloads are removed or confined to
   host-mode test helpers.
2. Reads request a read profile.
3. Mutations reload project policy before token acquisition and again at the
   existing immediate effect boundary.
4. The runner receives an explicit App environment.
5. Project/auth context is threaded through `read`, `readPages`, GraphQL reads,
   and nested evidence helpers.
6. Read deduplication keys include installation and repository identity.
7. Rate-limit circuit state is keyed by installation ID rather than globally.

App-level bootstrap calls remain in `appAuth.ts`; repository calls remain in
the existing client.

`GitHubIdentity` should no longer call `/user` in App mode. Installation tokens
cannot use that endpoint. Provide the known bot login from `appAuth.ts` and keep
stable Bottega comment markers as a second self-detection mechanism.

## Worktree and Commit Identity

When creating a worktree for an App-authenticated project, configure that
worktree locally:

```bash
git config --local user.name "bottega[bot]"
git config --local user.email "<bot-id>+bottega[bot]@users.noreply.github.com"
```

This ensures commits created by an agent or the trusted finalizer use the bot
identity without modifying global or main-checkout configuration.

Optionally append the task owner's configured identity as a `Co-authored-by`
trailer. Do not silently make a human the author of model-generated changes.

Existing worktrees receive local bot identity lazily before their next trusted
commit. Do not rewrite existing commits.

## Server-Owned PR Finalization

Add `server/services/github/finalize.ts` with one keyed lock per task.

Suggested operations:

```ts
export async function ensureTaskPullRequest(taskId: number): Promise<number>;
export async function finalizePrAgentRun(agentRunId: number): Promise<void>;
```

### Initial PR

After implementation/review/refinement completes and before launching the PR
agent:

1. Reload task, project, worktree, and autonomy state.
2. Obtain repository App auth for `push`.
3. Set or verify worktree-local bot Git identity.
4. Commit remaining changes.
5. Push the task branch.
6. Recheck `createPR` immediately before PR creation.
7. Find an existing open branch PR or create one through `GitHubClient`.
8. Persist `github_pr_number` and project `In Review` to the linked issue.
9. Start the PR agent with the current PR evidence.

Use the task title for the initial PR title. Generate a deterministic body from
the task document and linked issue. The agent does not need to create the PR.

### PR repair

For an existing PR:

1. Reconciliation writes failed checks and human review evidence into the task
   document.
2. The PR agent edits and tests locally without GitHub credentials.
3. The agent invokes a narrow local script that marks its current run
   `github_finalize_status='ready'`.
4. A successful lifecycle completion compare-and-sets the run to `finalizing`.
5. The finalizer commits remaining changes and pushes the branch.
6. It records the pushed head SHA and marks the run `finalized`.
7. Webhook or polling reconciliation observes the new head and evidence.

If a rebase changed published history, use `--force-with-lease` against the
expected remote SHA. Never use an unconditional force push.

### Idempotency and recovery

Before any retry, inspect:

- Current local head.
- Current remote task branch head.
- Existing open PR for the branch.
- Stored PR number and finalized head SHA.

These checks make retries safe across:

- Push success followed by process crash.
- PR creation success followed by database write failure.
- Duplicate lifecycle completion.
- Concurrent manual and automated finalization.

The manual Create PR and Push Changes routes must call the same finalizer rather
than bypassing it through ambient worktree commands.

All other remote Git operations must also use a project-aware trusted Git
execution abstraction. This includes worktree creation fetches, existing-PR
branch fetches, sync, rebase fetches, PR status lookup, cleanup fetch/pull, and
GitHub-backed task import through `taskCreation.ts`. Local status, diff, branch,
and commit operations may remain direct. Require `projectId` or an already
resolved repository-auth context at every remote seam.

## Agent Environment Isolation

All provider launch paths must explicitly remove:

```text
GH_TOKEN
GITHUB_TOKEN
GH_ENTERPRISE_TOKEN
GITHUB_ENTERPRISE_TOKEN
SSH_AUTH_SOCK
```

Set for model subprocesses:

```text
GH_CONFIG_DIR=<empty per-run directory>
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_SYSTEM=/dev/null
GIT_TERMINAL_PROMPT=0
```

Prevent Git from using inherited SSH identities for remote operations. The
exact mechanism must not break local Git commands; use an invocation-level SSH
configuration that has no identity files and batch mode enabled.

OpenCode currently preserves host GitHub configuration deliberately. Remove
that behavior before App mode is enabled. Cover the concrete launch seams in
`claudeCredentials.ts`, `codexCredentials.ts`, `openCodeCredentials.ts`,
`openCodeServerPool.ts`, and `providers/copilot/clientPool.ts`. OpenCode's
`opencode serve` process is long-lived, so isolation must be applied when its
per-user pool process is spawned; a per-conversation environment cannot change
an existing process. Recreate any existing pool after the isolation behavior
changes and keep pool keys at least user-scoped.

Copilot's credential builder already strips `GH_TOKEN` and `GITHUB_TOKEN`; the
remaining work is to verify that its long-lived pooled CLI process cannot see
host GitHub configuration or credentials. If the Copilot SDK does not permit an
isolated child environment, add an isolated launcher rather than assuming
conversation options affect its pooled process. Copilot's model credential
remains separate and must never be overwritten by the App token.

Provider subprocess isolation prevents accidental service-token inheritance,
but shell access is not a complete security boundary. Production deployments
should also remove host personal GitHub credentials from the Bottega service
account and consider container or user isolation and outbound network policy.

## Lifecycle Outcome Correction

The current conversation lifecycle may mark a run completed when a provider
stream terminates after a catastrophic SDK error. App-owned publication must
not use that state alone.

Before enabling automatic finalization:

1. Normalize provider termination into `success`, `aborted`, or `error`.
2. Persist `failed` for `error` and user abort.
3. Chain agents and publish GitHub effects only on `success`.
4. Require the explicit PR-run `ready` signal in addition to `success`.

Planning publication should retain its existing
`planification_complete` defense.

## Webhook Integration

Keep the existing raw-body HMAC verification and Zod envelope validation.

Validate webhook headers separately from JSON body schemas:

- `X-GitHub-Delivery`
- `X-GitHub-Event`

Use event-specific body schemas:

- Repository automation events require `installation.id`, `repository.id`, and
  `repository.full_name`.
- `installation` events require installation ID and action; their repository
  list is optional.
- `installation_repositories` events require installation ID plus
  `repositories_added` and `repositories_removed`.

The current route unconditionally reads `payload.repository.full_name`; move
that read behind the repository-event branch of the discriminated union before
accepting lifecycle events. `routes/webhooks.ts` remains responsible for raw
body handling, signature verification, header extraction, and controlled HTTP
responses. `webhookService.ts` selects the event-specific schema, validates
repository/installation identity, performs project lookup and enable checks,
and dispatches reconciliation or lifecycle invalidation.

Before queueing reconciliation:

1. Find the project by repository ID, with canonical name fallback only during
   migration.
2. Verify the payload installation ID matches the project.
3. Verify automation is enabled.
4. Reject or ignore mismatched installations rather than dispatching by name.

Handle installation suspension, deletion, repository removal, and repository
rename events by invalidating token caches and marking affected projects as
degraded. Subscribe to the repository event and match renames by repository ID
before updating canonical `github_repo`. Do not erase project settings
automatically; require an administrator to repair or select a replacement
installation.

At startup, App mode may call `PATCH /app/hook/config` with the App JWT to set:

```text
<BOTTEGA_EXTERNAL_URL>/api/webhooks/github
```

Webhook configuration failure should not stop polling, but health must report
the degraded state prominently. Event subscriptions and changed permissions
still require operator action in GitHub.

Persistent webhook delivery storage is not required initially because current
reconciliation is idempotent. Add delivery retention only if audit history or
cross-process replay suppression becomes an operational requirement.

## Capability Enforcement

Preserve the existing capability matrix and fresh checks:

| Tier | App effects |
|---|---|
| `advisory` | Comment, label, reaction |
| `issues` | Advisory plus issue creation |
| `pr` | Issues plus branch push and PR creation |
| `automerge` | Reserved merge capability |

`getRepositoryAuth(projectId, action)` must check capability before minting or
returning a token. The caller checks again immediately before the effect to
cover policy changes between preparation and execution.

The App's granted permissions are an upper bound; the Bottega autonomy tier is
the project-specific lower bound. Both must allow the action.

Do not implement merge as part of this work. App-authenticated merge still
requires a separate policy that validates expected head SHA, draft state,
checks, reviews, unresolved threads, branch protection, and merge method. A
GitHub App cannot approve its own PR.

## Administrator Experience

Add a GitHub App integration section that reports:

- Authentication mode.
- App slug and bot login.
- App ID and private-key readability, never key contents.
- Webhook URL and configuration status.
- Last successful App metadata request.
- Installation count and suspension state.
- Required and granted permission status.
- Last successful token mint timestamp, never token value.

Project settings should prefer selecting a discovered installed repository over
free-text entry. Keep free-text `owner/name` as an advanced discovery action.

Before enabling project automation, display and validate:

- Repository and installation identity.
- Installation status.
- Missing or pending permissions.
- App bot identity for commits and PRs.
- Project autonomy effects.
- Whether workflow-file writes are permitted.
- Project-owner model and provider readiness.

Health and readiness errors need stable API codes, including:

```text
GITHUB_APP_NOT_CONFIGURED
GITHUB_APP_KEY_INVALID
GITHUB_INSTALLATION_NOT_FOUND
GITHUB_INSTALLATION_SUSPENDED
GITHUB_REPOSITORY_NOT_SELECTED
GITHUB_APP_PERMISSION_MISSING
GITHUB_APP_TOKEN_FAILED
GITHUB_FINALIZATION_NOT_READY
```

## Implementation Phases

Each phase must pass `scripts/gate.sh` and remain deployable independently.

### Phase 1: App bootstrap and repository discovery

Deliver:

- App configuration parsing and validation.
- JWT generation and direct App API client.
- App metadata and bot identity resolution.
- Repository-to-installation discovery.
- Project repository and installation ID columns.
- Admin health endpoint and basic status UI.
- No production mutation path changes.

Acceptance:

1. Start in `host` mode with no App settings; existing behavior is unchanged.
2. Start in `app` mode with partial settings; startup reports an actionable
   configuration error.
3. Resolve two repositories in different installations correctly.
4. Refuse to enable a project where the App is not installed.
5. Display the bot login without calling `/user` with an installation token.

### Phase 2: Installation token broker and App-authenticated reads

Deliver:

- Repository-downscoped token minting.
- Five-minute refresh buffer and per-key in-flight deduplication.
- Explicit command environments.
- Installation-keyed rate-limit state.
- App-authenticated GitHub reads and polling.
- No process-global token mutation.

Acceptance:

1. Concurrent reads for one repository mint one token.
2. Concurrent reads in different installations never share tokens.
3. A token near expiry refreshes once.
4. An expired token is never returned after refresh failure.
5. Tests prove no token reaches parent environment, argv, logs, or Git config.

### Phase 3: Bot comments, labels, and webhook identity

Deliver:

- App-authenticated advisory mutations.
- Bot self-identity integration.
- Repository and installation webhook validation.
- Validation and health reporting for an operator-configured App webhook.
- Installation lifecycle cache invalidation.

Acceptance:

1. A plan comment appears as the App bot.
2. The same comment does not retrigger reconciliation.
3. A webhook with a valid signature but wrong installation ID is ignored.
4. Suspending the installation stops new work and reports degraded health.
5. Polling continues to repair missed valid deliveries.
6. An `installation.deleted` delivery with no `repository` field is accepted
   without dereferencing `repository.full_name` and invalidates the installation.
7. An `installation_repositories` delivery validates its added and removed
   repository lists without requiring a singular repository field.

### Phase 4: Trusted publication and credential-free PR agents

Deliver:

- Invocation-local Git credential environment.
- SSH-form remote rewrite to HTTPS.
- Worktree-local bot commit identity.
- Initial server-owned commit, push, and PR creation.
- Provider termination outcome correction.
- Explicit PR finalization readiness signal.
- PR repair finalizer and compare-and-set lease state.
- Agent prompt changes that remove push and `gh` mutation instructions.
- Removal of ambient GitHub credentials from every provider environment.
- OpenCode host GitHub configuration removal.
- Manual Create PR and Push routes moved to the shared finalizer.
- Every remote Git operation moved behind project-aware trusted auth.
- Immediate capability rechecks.

Acceptance:

1. A bot-authored commit and PR appear under the App identity.
2. A human project member can review the bot-authored PR.
3. Disabling automation immediately before push prevents the push.
4. Lowering autonomy after push but before PR creation prevents PR creation.
5. Both HTTPS and SSH-form remotes work without persistent remote changes.
6. A crash after PR creation is recovered without a duplicate PR.
7. A PR agent can repair code and request finalization without a GitHub token.
8. The server pushes the repair as the bot.
9. A crashed, aborted, or non-ready run never pushes.
10. Duplicate completion invokes at most one push.
11. Claude, Codex, OpenCode, and Copilot follow the same publication path.
12. An agent printing its environment cannot obtain an installation token.
13. The PR agent cannot perform a second publication using ambient host auth.

Phase 4 is one cutover unit. Do not deploy server-owned initial PR creation
while the existing PR prompt still instructs the agent to push or run `gh pr
create`.

### Phase 5: Operational hardening

Deliver only after the App-authenticated publication path is proven:

- Optional App webhook URL auto-configuration.
- Discovered repository selector UI.
- Expanded installation and permission health telemetry.
- Optional per-action installation-token permission profiles.
- Optional workflow-file write policy.
- Optional task-owner co-author trailers.

These features are not prerequisites for repository isolation or bot identity.
Keep the initial App cutover on one repository-downscoped automation token
profile, operator-configured webhooks, existing repository entry with server
validation, and basic actionable health.

### Phase 6: App-required cutover

Deliver:

- Existing-project installation backfill and status report.
- Deployment runbook.
- `GITHUB_AUTH_MODE=app` production switch.
- Removal of host personal GitHub credentials from the service account.
- Deprecation warning for host mode.

Acceptance:

1. Every enabled project has matching repository and installation IDs.
2. No Bottega automation process depends on `gh auth status` for a person.
3. Restart, webhook, and polling recovery work with only App credentials.
4. Repositories outside App installation selection are inaccessible.
5. Existing open tasks and PRs continue under the new bot identity without
   duplicate comments or PRs.

## File-Level Change Map

```text
reference/.env.example                              modify
reference/docs/github-automation.md                 modify
reference/docs/github-app-service-identity-plan.md  add

reference/server/database/init.sql                  modify
reference/server/database/db.ts                     modify
reference/server/database/githubMigrations.ts       modify

reference/server/services/shell.ts                  modify
reference/server/services/github/appAuth.ts         add
reference/server/services/github/appAuth.test.ts    add
reference/server/services/github/client.ts          modify
reference/server/services/github/identity.ts        modify
reference/server/services/github/finalize.ts        add
reference/server/services/github/finalize.test.ts   add
reference/server/services/github/reconcile.ts       modify
reference/server/services/github/scheduler.ts       modify
reference/server/services/worktree.ts               modify
reference/server/services/taskCreation.ts           modify
reference/server/services/prService.ts              modify or remove wrapper
reference/server/services/agentRunner.ts            modify
reference/server/services/webhookService.ts          modify event schemas/identity dispatch
reference/server/services/claudeCredentials.ts       modify agent env
reference/server/services/codexCredentials.ts        modify agent env
reference/server/services/openCodeCredentials.ts     modify agent env
reference/server/services/openCodeServerPool.ts      modify agent env
reference/server/services/providers/copilot/clientPool.ts modify agent env
reference/server/services/conversation/agentRunLifecycle.ts modify outcomes/finalization
reference/server/services/conversation/startConversation.ts modify outcome plumbing
reference/server/constants/agentPrompts.ts           modify PR contract
reference/server/index.ts                            modify App lifecycle

reference/server/routes/projects.ts                  modify readiness
reference/server/routes/tasks.ts                     modify PR/push routes
reference/server/routes/webhooks.ts                  modify headers/raw-body routing
reference/server/routes/admin.ts                     modify integration health routes

reference/shared/api/admin.ts                        modify
reference/shared/api/projects.ts                     modify
reference/shared/schemas/admin.ts                    modify
reference/shared/schemas/projects.ts                 modify
reference/shared/schemas/webhooks.ts                 modify
reference/shared/types/db.ts                         modify

reference/src/components/GitHubProjectSettings.tsx   modify
reference/src/components/Admin/GitHubAppStatus.tsx   add
```

Adjust exact route/component placement to existing conventions rather than
creating parallel abstractions.

## Testing Strategy

### Unit tests

- JWT structure, client-ID or App-ID issuer, timestamps, and signature
  verification.
- Client-ID remains a JSON string and App-ID fallback remains a JSON number.
- PEM missing, unreadable, malformed, and unsafe permissions.
- App metadata and bot user resolution.
- Repository installation discovery and rename handling.
- Token request repository and permission downscoping.
- Per-key cache hit, refresh threshold, and in-flight deduplication.
- Last-good-token behavior and expired-token rejection.
- 401 invalidation and 404 mapping refresh.
- Installation-keyed rate-limit circuit behavior.
- Environment redaction and SSH remote rewriting.
- Worktree-local Git identity.
- Finalizer compare-and-set transitions and idempotency.
- Successful, failed, and aborted provider outcomes.
- No token in any provider SDK environment.

### Integration tests

- Two repositories under one installation.
- Two repositories under different installations.
- Wrong installation in a valid webhook payload.
- Installation lifecycle delivery without a singular repository object.
- Installation repository-selection delivery with added/removed lists.
- Installation suspension and repository removal.
- Comment and label mutation under bot identity.
- Push success followed by process failure before DB update.
- PR creation success followed by process failure before linkage.
- Concurrent webhook, polling, and manual finalization.
- Capability or automation change between preparation and effect.
- Existing PR repair with normal push and force-with-lease rebase push.

### Manual acceptance

Use a disposable App installation and two repositories:

1. Install the App on only the first repository.
2. Verify the second project cannot enable automation.
3. Run issue planning and confirm the plan comment is bot-authored.
4. Approve the issue and confirm commits and PR are bot-authored.
5. Approve the bot PR as a human account.
6. Trigger a failing check and confirm credential-free repair plus server push.
7. Remove the repository from the installation and confirm automation stops.
8. Restore selection and confirm polling recovers without duplicate work.

## Rollback

Before Phase 6, rollback is configuration-only:

1. Disable project automation.
2. Set `GITHUB_AUTH_MODE=host`.
3. Restart Bottega.

Database additions are nullable and remain harmless. Existing task and PR links
are preserved.

After production removes host credentials, rollback requires restoring a
dedicated service account credential or repairing App configuration. Never
restore a maintainer's personal credential as an undocumented fallback.

## Security Properties

After App-mode cutover:

- Installation tokens are not deliberately passed to model subprocesses.
- Installation tokens are short-lived and repository-downscoped.
- Under `GITHUB_AUTH_MODE=app` after Phase 6 removes host credentials, enabled
  automation cannot silently use a host person's GitHub identity.
- GitHub policy changes are rechecked immediately before trusted effects.
- Repository installation selection limits the App independently of Bottega
  policy.
- Human users remain able to review bot-authored PRs.

This does not make same-UID shell-capable agents fully safe. A `0600` private
key owned by the Bottega service account is still readable by an agent running
as that account, and a same-UID process may inspect other process state. The
initial design prevents accidental installation-token inheritance, not
malicious same-host exfiltration. The deployment runbook must remove personal
GitHub credentials from the service account. A strong secret boundary requires
agents to run under a different UID or container with the PEM excluded from
their mount namespace; stricter threat models also require network and
filesystem sandboxing or a separate privileged effect worker.

## Completion Criteria

The migration is complete when:

1. Every enabled linked project has verified repository and installation IDs.
2. Comments, labels, pushes, commits, and PRs use the App bot identity.
3. No installation token is process-global or present in a provider subprocess.
4. No automated GitHub effect relies on personal host credentials.
5. PR publication is server-owned, explicit, idempotent, and policy-checked.
6. Webhooks validate repository and installation identity and polling remains a
   recovery path.
7. Multi-installation concurrency and token isolation tests pass.
8. The full `scripts/gate.sh` check passes.
