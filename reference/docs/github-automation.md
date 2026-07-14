# GitHub Automation

Bottega can use GitHub issues, pull requests, reviews, and checks as inputs to
the same task and agent runtime used by the web UI. Bottega remains the source
of truth for tasks, conversations, transcripts, agent runs, and worktrees;
GitHub is an intake channel and a projection of selected task state.

## Capabilities

For a linked and enabled project, Bottega can:

- Import an open issue labeled `Needs Refinement` into a task and worktree.
- Run the planning agent and publish its completed task document as one stable
  GitHub plan comment.
- Replace `Needs Refinement` with `Ready` when planning completes.
- Incorporate later human issue comments and rerun planning before
  implementation starts.
- Start the implementation/review/refinement loop when a planned issue is
  labeled `Refined` and the project permits PR automation.
- Link a task to its pull request and project the issue to `In Review`.
- Resume the PR agent for failed checks, failed commit statuses, merge
  conflicts, unresolved human review threads, or a current human
  `CHANGES_REQUESTED` review with a body.
- Resume the PR agent when a human posts the configured `@trigger` in a pull
  request conversation.
- Import an actionable same-repository pull request as a repair task when no
  existing task can be linked to it. Fork pull requests are not imported.
- Repair missed webhook deliveries through periodic repository reconciliation.
- Show linked GitHub issue and pull request URLs in task details.

Webhook and polling paths call the same keyed, idempotent reconciliation code.
Repeated delivery does not intentionally create duplicate tasks, running
agents, plan comments, or PR repair runs.

## Requirements

The Bottega host must have:

- A local checkout configured as the project's repository folder.
- A configured server-side GitHub authentication mode. In App mode, trusted
  server code uses repository-scoped installation credentials; model processes
  do not receive those credentials.
- Network access to GitHub.
- A `GITHUB_WEBHOOK_SECRET` shared with the configured App or repository webhook
  for low-latency event delivery.

The project owner must be an active Bottega user with agent model settings and
credentials for every configured provider. In legacy host mode, projects using
the `pr` or `automerge` tier also require a Git name and email for the owner. App
mode uses the App bot's commit identity instead. Bottega checks these
prerequisites before an administrator can enable automation.

An existing task keeps its task owner's provider credentials and model
settings. A task imported directly from GitHub is owned by the project owner.

## GitHub App Setup

Use one private GitHub App per Bottega deployment. The App can be installed on
multiple organizations or accounts and can serve multiple selected
repositories. Do not create a separate App or configure a global installation
ID for each project.

1. In GitHub, create a GitHub App and set its homepage URL to the Bottega
   deployment URL.
2. Set the webhook URL to
   `https://<bottega-host>/api/webhooks/github`, create a random webhook secret,
   and enable webhook delivery.
3. Grant repository permissions for **Contents: Read and write**, **Issues: Read
   and write**, **Pull requests: Read and write**, **Checks: Read**, and **Commit
   statuses: Read**. Metadata read access is included automatically. Grant
   **Workflows: Read and write** only when Bottega is allowed to publish changes
   under `.github/workflows/`.
4. Subscribe to **Issues**, **Issue comments**, **Pull requests**, **Pull request
   reviews**, **Pull request review comments**, **Check runs**, **Check suites**,
   and **Repository** events. Installation lifecycle and repository-selection
   events are delivered automatically.
5. Install the App and select only repositories that Bottega may automate.
6. Generate an RSA private key. Store the downloaded PEM outside the repository,
   owned by the Bottega service account, and set its mode to `0600` in
   production.
7. Configure the deployment environment and restart Bottega:

```dotenv
GITHUB_AUTH_MODE=app
GITHUB_APP_CLIENT_ID=Iv1.example
# GITHUB_APP_ID=123456  # JWT issuer fallback when client ID is unavailable
GITHUB_APP_PRIVATE_KEY_PATH=/var/lib/bottega/github-app.pem
BOTTEGA_EXTERNAL_URL=https://bottega.example.com
GITHUB_WEBHOOK_SECRET=<same-secret-configured-on-the-app>
```

`BOTTEGA_EXTERNAL_URL` and `GITHUB_WEBHOOK_SECRET` are an optional pair. Omitting
both leaves App authentication available in polling-only mode and reports
degraded webhook health; configuring only one is an error. App configuration is
read at startup and changes require a restart. Bottega validates the auth mode,
App identifier, private key, key ownership/mode, and webhook pair before opening
the HTTP listener. Invalid App configuration therefore fails startup instead of
leaving automation to fail later.

After restart, check **Admin > GitHub App** or request
`GET /api/admin/github-app/health`. The response identifies configuration and
permission problems without exposing the private key or installation tokens. It
also reports the App and bot identity, last successful metadata check and token
mint, and enabled projects that still lack a verified repository or installation
ID.
For each existing project, open GitHub automation settings and save or re-enable
automation. This verifies the repository, discovers its installation, and
persists canonical repository and installation IDs. A project is App-ready only
when both IDs match GitHub.

For a production cutover, create and install the App while
`GITHUB_AUTH_MODE=host` remains active. Then switch to `app`, restart, confirm
the admin health indicator, and verify every enabled project through its
project settings. Keep the host credentials available only for rollback until
these checks pass. Then remove host `GH_TOKEN`/`GITHUB_TOKEN`, Git credential
helpers, and SSH keys from the service account. Provider subprocesses never
receive App credentials in either mode.

To roll back during the compatibility period, set `GITHUB_AUTH_MODE=host`,
restore the service account's host GitHub credentials, and restart. Do not
delete stored repository or installation IDs; they can be reused after the App
configuration is repaired. Host mode is deprecated and emits a warning at every
startup; it remains only as a temporary rollback path.

## Project Configuration

Only administrators can change GitHub project settings. Create or edit a
project and configure:

- **GitHub repository**: a unique repository identity. `owner/name`, GitHub
  HTTPS URLs, and GitHub SSH URLs are accepted and stored canonically as
  lowercase `owner/name`.
- **Automation enabled**: the project-level kill switch. Disabling it stops new
  webhook and polling work for the project.
- **Autonomy tier**: the maximum GitHub effects Bottega may perform.

New projects default to disabled `advisory` automation. Configure the
repository and owner prerequisites before enabling it.

## Autonomy Tiers

| Tier | Application-owned GitHub effects |
|---|---|
| `advisory` | Comments, labels, and reactions |
| `issues` | Advisory effects plus issue creation |
| `pr` | Issues effects plus pushes and pull request creation |
| `automerge` | PR effects plus merge capability |

The current workflow requires `pr` or higher to automatically start
implementation from a `Refined` issue and to launch a PR agent. At lower tiers,
users can still manually run the local implementation/review/refinement loop,
but Bottega will not launch the PR agent or perform application-owned pushes.

Automatic merge is not currently enabled. The `automerge` tier reserves the
capability for a future merge policy; setting it does not make Bottega merge a
pull request.

Capabilities are checked before optional work starts and again immediately
before application-owned publication effects. PR agents edit and test locally,
then explicitly mark their run ready. Trusted server code alone performs remote
Git and pull-request operations after those checks. Shell isolation remains a
separate defense against unrelated ambient host credentials.

## Issue Workflow

Use these case-insensitive labels:

| Label | Meaning |
|---|---|
| `Needs Refinement` | Import or revise the issue and run planning |
| `Ready` | Bottega published a completed plan for human review |
| `Refined` | A human approved the planned issue for implementation |
| `In Review` | Bottega linked the task to a pull request |

The normal flow is:

1. Add `Needs Refinement` to an open issue.
2. Bottega creates one task and worktree, imports the issue and human comments,
   and starts planning.
3. When the agent explicitly completes planning, Bottega creates or updates a
   marked plan comment and changes the issue label to `Ready`.
4. Add comments to request planning changes. Before implementation begins,
   Bottega returns the issue to `Needs Refinement`, updates the task document,
   and reruns planning.
5. Apply `Refined` when the plan is accepted. At `pr` autonomy or higher,
   Bottega starts implementation and removes the approval labels. At a lower
   tier, the task waits for manual execution.
6. The normal implementation, review, and refinement agents operate on the
   task worktree. The server commits and publishes the initial branch, creates
   or finds the pull request, links it to the task, and only then starts a PR
   repair agent with current evidence.

An unlabeled issue is never imported merely because someone comments on it.
Bot-authored and Bottega-authored comments are excluded from human feedback.

## Pull Request Feedback

Bottega considers an open pull request actionable when current evidence
contains at least one of:

- A merge conflict.
- A failed check run or classic commit status.
- An unresolved human review thread.
- The latest review from a human reviewer is `CHANGES_REQUESTED` and includes a
  non-empty body.
- A human PR comment contains the configured trigger mention.

The trigger defaults to `@bottega` and can be changed under application
settings. Store the name without `@`; matching is case-insensitive and works
next to punctuation.

Evidence is written into a generated section of the task document. A stable
hash prevents unchanged evidence from starting another run. Reconciliation
also refuses to start a PR agent for completed, blocked, or PR-complete tasks,
for tasks without a worktree, while another agent is running, or after the
shared workflow run limit is reached.

Review threads remain human-controlled: the agent can address feedback, but a
human or GitHub-side automation must resolve the thread. New commits change the
evidence hash, so the workflow run cap is the final guard against standing
feedback causing an unbounded repair loop.

PR repair agents do not query GitHub or publish changes. They consume evidence
already captured in the task document, edit and test the local worktree, and
invoke `complete-pr.ts` exactly once only when all requested work and local
verification pass. Successful agent completion plus that run-scoped readiness
signal allows the server finalizer to commit and publish the repair. Incomplete
work, failed tests, aborted runs, and ordinary conversations cannot request
finalization. The task-detail **Fix CI** action starts this real PR agent run.

## Webhook Setup

In App mode, configure the webhook on the GitHub App as described in
**GitHub App Setup**. The same App-level endpoint receives repository events
from every installation; do not create duplicate repository webhooks.

In legacy host mode, create a repository webhook with:

- **Payload URL**: `https://<bottega-host>/api/webhooks/github`
- **Content type**: `application/json`
- **Secret**: the same value as `GITHUB_WEBHOOK_SECRET`
- **Events**: issues, issue comments, pull requests, pull request reviews, pull
  request review comments, check runs, and check suites

Bottega validates `X-Hub-Signature-256` against the raw request body before
parsing the payload. Accepted deliveries return `202` and run asynchronously.
Unsupported events return an ignored response. During graceful shutdown,
Bottega stops accepting new deliveries and drains accepted reconciliation.

Check webhook configuration at:

```text
GET /api/webhooks/health
```

The response reports whether the webhook secret is configured; it does not
test GitHub authentication or delivery reachability. In App mode, use
`GET /api/admin/github-app/health` as the separate authentication health check.

## Recovery Polling

The recovery scheduler starts with the server and scans enabled projects every
10 minutes by default. Configure the interval in milliseconds with:

```bash
GITHUB_RECONCILE_INTERVAL_MS=600000
```

Polling reuses bounded issue and open-PR listings, skips closed pull requests,
and uses a bounded unknown-PR discovery budget. It repairs missed events for
managed issues and PRs and can discover recent actionable same-repository pull
requests. Webhooks remain the normal low-latency path.

Concurrent events for one PR are coalesced to one active reconciliation plus at
most one trailing pass, so bursts of check events do not cause an equivalent
burst of full GitHub reads.

## Operational Notes

- Bottega's authenticated GitHub account is treated as self; its unmarked
  comments do not become human evidence. A transient identity lookup failure is
  retried rather than cached permanently.
- Plan comments contain a stable marker. If a maintainer deletes one, Bottega
  recreates it on the next successful plan synchronization.
- Turning automation off prevents new webhook and polling starts; it does not
  terminate an agent that is already running.
- Removing a task worktree prevents automated PR repair from falling back to
  and modifying the project's main checkout.
- The server broadcasts background-created agent runs and startup failures to
  connected task clients, so webhook and polling work appears without reload.
- Auto-merge and Yeti maintenance-job migration are intentionally deferred.

## Troubleshooting

If an issue or PR does not trigger work:

1. Confirm the project repository identity matches the webhook repository.
2. In App mode, confirm the App is installed on the repository and the project
   settings report matching repository and installation IDs.
3. Confirm automation is enabled and the tier permits the requested effect.
4. Confirm the configured server-side GitHub authentication mode is healthy.
5. Confirm the project owner still has valid provider credentials and model
   settings.
6. Check `GET /api/webhooks/health` and GitHub's webhook delivery history.
7. Confirm the expected label or actionable PR evidence is still present.
8. Check whether the task is completed, blocked, missing its worktree, already
   running an agent, or at the workflow run limit.
9. Wait for recovery polling or restart the server to schedule an initial scan.

Re-delivering a webhook is safe; reconciliation is designed to be idempotent.
