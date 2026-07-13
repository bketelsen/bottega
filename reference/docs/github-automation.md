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
- GitHub CLI (`gh`) installed and authenticated as the account Bottega uses for
  GitHub reads and mutations.
- Network access to GitHub.
- A `GITHUB_WEBHOOK_SECRET` shared with the repository webhook for low-latency
  event delivery.

The project owner must be an active Bottega user with agent model settings and
credentials for every configured provider. Projects using the `pr` or
`automerge` tier also require a Git name and email for the owner. Bottega checks
these prerequisites before an administrator can enable automation.

An existing task keeps its task owner's provider credentials and model
settings. A task imported directly from GitHub is owned by the project owner.

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
before application-owned push and PR effects. The automation switch and tiers
are operational policy controls, not a security sandbox: agents have shell
access and may have ambient host credentials. Strong isolation requires
restricted tools, isolated credentials, or a sandbox outside this feature.

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
   task worktree. The PR agent then pushes the branch, creates or updates the
   pull request, and links it to the task.

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

## Webhook Setup

Create a repository webhook with:

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
test GitHub authentication or delivery reachability.

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
2. Confirm automation is enabled and the tier permits the requested effect.
3. Confirm `gh auth status` succeeds for the Bottega server account.
4. Confirm the project owner still has valid provider credentials and model
   settings.
5. Check `GET /api/webhooks/health` and GitHub's webhook delivery history.
6. Confirm the expected label or actionable PR evidence is still present.
7. Check whether the task is completed, blocked, missing its worktree, already
   running an agent, or at the workflow run limit.
8. Wait for recovery polling or restart the server to schedule an initial scan.

Re-delivering a webhook is safe; reconciliation is designed to be idempotent.
