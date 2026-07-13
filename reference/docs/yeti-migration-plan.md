# Bottega + Yeti Migration Plan

> **Implementation status:** The non-optional phases of this plan are now
> implemented. For current configuration, behavior, and operating guidance,
> read [`github-automation.md`](./github-automation.md). Automatic merge and
> optional Yeti maintenance jobs remain deferred.

## Goal

Unify Bottega and Yeti behind one Bottega runtime without rebuilding either
product wholesale.

The resulting system supports both existing entry paths:

1. A user creates a task in Bottega and runs it interactively.
2. A GitHub issue, pull request event, or scheduled scan creates or resumes the
   same kind of Bottega task automatically.

Bottega remains the source of truth for tasks, agent runs, conversations,
transcripts, and worktrees. GitHub issues, labels, comments, pull requests, and
checks are inputs and projections of that state. Yeti stops owning AI execution
or worktrees.

## Scope

This plan migrates the smallest useful Yeti workflow:

```text
Needs Refinement issue
  -> Bottega task + planning agent
  -> plan comment + Ready label
  -> human applies Refined
  -> implementation/review loop
  -> PR agent opens and maintains PR
  -> review or CI event resumes PR agent
  -> optional policy-controlled merge
```

It also provides a narrow scheduler seam through which repository maintenance
jobs can be moved later.

### Explicit non-goals

- A generic DAG or user-configurable workflow engine.
- A general task-source plugin framework.
- Parallel execution waves, milestones, or cross-task dependencies.
- Importing historical Yeti runs, logs, or AI output.
- Replacing Bottega's provider and transcript abstractions.
- Reimplementing Yeti's dashboard inside Bottega before the core workflow works.
- Keeping two live databases synchronized.

## Architectural decisions

### Bottega owns canonical state

Every GitHub issue or pull request that receives agent work maps to one Bottega
task. The task document is the canonical request, plan, checklist, and review
scratchpad. SQLite is the canonical workflow state. GitHub labels and comments
are updated from Bottega state but do not replace it.

Polling and webhooks both call the same idempotent reconciliation functions.
Webhooks reduce latency; polling repairs missed events.

### Reuse existing agent roles

Do not port Yeti jobs as new Bottega agent types.

| Yeti behavior | Bottega implementation |
|---|---|
| `issue-refiner` | Existing planning agent |
| `plan-reviewer` | Defer initially; later run an existing review-style prompt before approval |
| `issue-worker` | Existing implementation/review loop |
| `ci-fixer` | Resume the existing PR agent with current check evidence |
| `review-addresser` | Resume the existing PR agent with current review evidence |
| `auto-merger` | Defer until the unified PR reconciliation flow is stable |
| Maintenance jobs | Discovery functions that create ordinary Bottega tasks |

A **job** discovers or reconciles work. An **agent run** reasons about one task.
Only the existing Bottega agent runner starts model work.

### Keep the existing workflow flags for the first migration

Do not replace Bottega's task flags with a new state-machine schema during this
migration. The existing `planification_complete`, `workflow_complete`,
`workflow_blocked`, `workflow_run_count`, and `pr_agent_complete` fields are
sufficient for the first unified workflow.

Structured run outcomes are a worthwhile later cleanup, particularly to avoid
treating a harness crash as successful completion, but they are not required to
remove Yeti's duplicate runtime.

### Guard application-owned effects

Port Yeti's autonomy tiers:

| Tier | Allowed GitHub effects |
|---|---|
| `advisory` | Comment, label, reaction |
| `issues` | Advisory effects plus create issue |
| `pr` | Issues effects plus push and create PR |
| `automerge` | PR effects plus merge |

Check the tier before starting optional work, then check it again immediately
before each application-owned GitHub or Git side effect.

This firewall is an application policy guard, not a complete security boundary.
Bottega agents have shell access and can potentially invoke `git` or `gh`
directly with ambient host credentials. Enforcing autonomy against a malicious
or prompt-injected agent would require restricted tools, isolated credentials,
or sandboxing and is outside this migration. Do not claim that the tier alone
prevents every agent-initiated side effect.

### Use the task or project owner as the automation identity

Every agent run requires an acting Bottega user with agent model settings and
provider credentials. GitHub reconciliation preserves `tasks.user_id` for an
existing member-owned task and falls back to `projects.user_id` for a newly
imported or ownerless task. Do not add a service-user model in the first
migration.

Before `github_automation_enabled` can be turned on, validate that the project
owner is active, has Git identity where required, has model settings for the
agents the workflow uses, and has valid provider credentials. If validation
fails, keep automation disabled and return an actionable error. A configurable
service user can be added later without changing reconciliation.

## Minimal data model changes

Use columns rather than a generalized external-reference model. The initial
integration is intentionally GitHub-specific.

### `projects`

Add:

```sql
ALTER TABLE projects ADD COLUMN github_repo TEXT;
ALTER TABLE projects ADD COLUMN github_automation_enabled INTEGER NOT NULL
  DEFAULT 0 CHECK (github_automation_enabled IN (0, 1));
ALTER TABLE projects ADD COLUMN autonomy_tier TEXT NOT NULL DEFAULT 'advisory'
  CHECK (autonomy_tier IN ('advisory', 'issues', 'pr', 'automerge'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_github_repo
  ON projects(github_repo COLLATE NOCASE)
  WHERE github_repo IS NOT NULL;
```

- `github_repo` is the canonical `owner/name` used by GitHub reconciliation.
  Normalize it to lowercase before storage and lookup.
- `github_automation_enabled` is the per-project operational kill switch. New
  and migrated projects remain disabled until their acting-user prerequisites
  are validated.
- Existing local-only projects leave it `NULL` and behave exactly as before.
- Existing and newly linked projects default to `advisory`; raising autonomy is
  an explicit administrator action.

Continue using `repo_folder_path` for worktrees. For a repository currently
managed only by Yeti, clone it once into a stable Bottega-owned path and create
the project against that path. Do not port Yeti's clone cache in the first
phase.

### `tasks`

Add:

```sql
ALTER TABLE tasks ADD COLUMN github_issue_number INTEGER;
ALTER TABLE tasks ADD COLUMN github_pr_number INTEGER;
ALTER TABLE tasks ADD COLUMN github_plan_comment_id INTEGER;
ALTER TABLE tasks ADD COLUMN github_last_human_comment_id INTEGER;
ALTER TABLE tasks ADD COLUMN github_pr_evidence_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_github_issue
  ON tasks(project_id, github_issue_number)
  WHERE github_issue_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_github_pr
  ON tasks(project_id, github_pr_number)
  WHERE github_pr_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_agent_runs_one_running
  ON task_agent_runs(task_id)
  WHERE status = 'running';
```

These fields cover both common shapes:

- An issue-backed feature task starts with `github_issue_number`; the PR agent
  later fills `github_pr_number`.
- A repair task discovered from an existing PR has only `github_pr_number`.

`github_plan_comment_id` lets planning update one stable comment instead of
posting duplicates. `github_last_human_comment_id` prevents both dropped
feedback and repeated re-planning. `github_pr_evidence_hash` prevents polling
the same failed checks or review comments from repeatedly restarting the PR
agent.

The partial unique index is the authoritative one-running-agent-per-task guard.
Before creating it on an existing database, mark duplicate `running` rows
failed, retaining at most the newest row. Update `startAgentRun` to translate a
constraint violation into its existing already-running result rather than a
server error.

### No other tables in the first migration

Do not add tables for scheduler runs, webhook deliveries, external events,
approval policies, or GitHub comments initially.

- Existing `task_agent_runs` and conversations provide execution history.
- Existing application logs provide scan diagnostics.
- GitHub delivery redelivery is made safe through idempotent reconciliation.
- The `Refined` label is the human approval input; Bottega task flags remain the
  execution state.

If operational history becomes necessary after cutover, add `job_runs` as a
separate observability change rather than coupling it to this migration.

## Minimal code changes

### 1. Extend shared and database types

Modify:

- `shared/types/db.ts`
- `server/database/init.sql`
- `server/database/db.ts`
- Project and task API response schemas where rows are exposed

Add `AutonomyTier` and the columns above. Follow the existing startup migration
style so current Bottega databases are upgraded in place. Project settings
mutations for `github_repo`, `github_automation_enabled`, and `autonomy_tier`
must enforce administrator authorization on the server; hiding controls in the
UI is not sufficient.

### 2. Extract task creation

The current task route performs task-row creation, worktree creation, document
seeding, and rollback inline. Extract that flow into a shared
`createTaskWithWorkspace` service used by both `server/routes/tasks.ts` and
GitHub reconciliation. Preserve rollback when worktree or document creation
fails. The reconciler passes `projects.user_id` as the task owner and stores the
GitHub identity on the new task.

### 3. Add a GitHub client

Add `server/services/github/client.ts` by extracting the narrow parts of Yeti's
`src/github.ts` needed by this workflow:

- Execute `gh api` with argv rather than a shell command.
- Retry transient failures with bounded backoff.
- Stop retrying while GitHub is rate-limited.
- Read issues, labels, comments, PRs, reviews, and check status.
- Create or update comments and labels.
- Merge a PR.
- Deduplicate concurrent identical reads.

Do not move Yeti's full cache or every GitHub helper at once. Add operations only
when a migrated workflow calls them.

All mutation methods accept a `ProjectRow` and call the capability firewall
before invoking `gh`.

### 4. Add the capability firewall

Add `server/services/github/capabilities.ts`, adapted from Yeti's
`src/capability.ts`.

It should export:

```ts
type GitHubAction =
  | 'comment'
  | 'label'
  | 'reaction'
  | 'createIssue'
  | 'push'
  | 'createPR'
  | 'merge';

function can(project: ProjectRow, action: GitHubAction): boolean;
function assertCapability(project: ProjectRow, action: GitHubAction): void;
```

Use `can` for preflight decisions and `assertCapability` inside the client or
Git service immediately before the effect.

### 5. Add one reconciliation service

Add `server/services/github/reconcile.ts`. Keep all workflow routing here rather
than distributing GitHub conditions across route handlers.

Serialize reconciliation through an in-memory lock keyed by task, falling back
to project plus external number before the task exists. Bottega is a
single-process runtime; this lock prevents concurrent webhook and polling paths
from racing on task-document and cursor updates. Database unique indexes remain
the durable backstop for task identity and running-agent creation.

It exposes four idempotent functions:

```ts
reconcileRefinementIssue(projectId, issueNumber): Promise<void>
reconcileApprovedIssue(projectId, issueNumber): Promise<void>
reconcilePullRequest(projectId, prNumber): Promise<void>
reconcileRepository(projectId): Promise<void>
```

#### `reconcileRefinementIssue`

1. Load the issue and confirm it is open and either has `Needs Refinement` or
   has newer human feedback while still awaiting implementation.
2. Find the task by `(project_id, github_issue_number)`.
3. If absent, create a normal Bottega task and worktree through
   `createTaskWithWorkspace`, owned by `projects.user_id`.
4. Seed the task document with issue title, body, URL, and current human
   comments. Record the highest imported human comment ID and treat all imported
   text as untrusted context.
5. If a newer human comment exists before implementation has started, wait for
   any running agent to finish, replace `Ready` with `Needs Refinement`, update
   a dedicated feedback section in the task document, advance
   `github_last_human_comment_id` only after the write succeeds, and reset
   `planification_complete`.
6. If planning has not completed and no agent is running, start the existing
   planning agent through `startAgentRun` using `projects.user_id`.
7. When planning completes, publish or update the plan comment, replace `Needs
   Refinement` with `Ready`, and save `github_plan_comment_id`.

The planning completion hook should call a small `syncPlannedTaskToGitHub(taskId)`
helper. Interactive projects with no `github_repo` are a no-op.

Add a task-document section update helper rather than an unconstrained append.
It may perform read-modify-write only after confirming no task agent is running;
this avoids clobbering an agent edit. It should replace a stable generated
section so retries do not duplicate feedback. Existing UI edits still share
Bottega's current whole-document concurrency limitations.

After implementation has started, issue comments no longer reset planning.
Process them through the same comment cursor, add them to the task's generated
feedback section while no agent is editing it, and expose them to the next
implementation, review, or PR run as evidence.

#### `reconcileApprovedIssue`

1. Load the issue and confirm it is open with `Refined`.
2. Load or create the task through the same internal task-import helper used by
   refinement. If its plan is incomplete, start planning when possible and
   return without starting implementation.
3. Require a completed plan, `workflow_complete = 0`,
   `pr_agent_complete = 0`, and no running agent.
4. Require that no implementation, review, or PR agent run has ever been
   created for the task. Chaining, not polling, owns the workflow after its
   first implementation run starts.
5. Require project autonomy `pr` or higher; otherwise leave the task awaiting
   manual execution and log the reason.
6. Start the existing implementation agent through `startAgentRun` using the
   project owner. Only after the run row is created, remove `Ready` and
   `Refined`. If startup fails, leave both labels intact.

This preserves Yeti's human approval boundary without adding a new approval
table or task status.

#### `reconcilePullRequest`

1. Find the task by `(project_id, github_pr_number)` or by the linked issue.
2. If no task exists, create a PR-repair task only when a supported event needs
   work; do not import every open PR.
3. Collect current check failures, mergeability, and unresolved human review
   comments.
4. Compute a stable evidence hash from the PR head SHA, failed check IDs and
   conclusions, unresolved review comment IDs, and merge-conflict state.
5. If the hash is new, update a stable evidence section in the task document
   while no agent is running.
6. If actionable evidence exists, the hash differs from
   `github_pr_evidence_hash`, and no agent is running, resume or start the
   existing PR agent. Persist the hash only after the run row is created.
7. Allow an explicit `@bottega` request to force reconciliation by incorporating
   that comment ID into the hash.

Do not create separate CI-fixer and review-addresser agent types. Both provide
new evidence to the same terminal PR workflow. Auto-merge is deferred until
this reconciliation path has completed cutover and proven stable.

#### `reconcileRepository`

Perform bounded scans for:

- Open `Needs Refinement` issues.
- Open `Refined` issues.
- Known task PRs with failed checks, conflicts, or unresolved reviews.

Call the three item-level functions. Item-level idempotency makes polling and
webhooks safe to overlap. Process `Priority` items first. `Needs Plan Review` is
not consumed until the deferred plan-reviewer workflow is migrated.

### 6. Replace the existing GitHub webhook dispatch

Modify `server/routes/webhooks.ts` rather than adding a second webhook server.

Retain HMAC verification, but replace the current direct `@bottega` agent-start
path rather than adding a parallel handler. All relevant events dispatch once
to reconciliation:

- `issues` label changes: refinement or approval reconciliation.
- `issue_comment`: refinement before implementation, PR reconciliation after
  implementation, and forced PR reconciliation for `@bottega`.
- `pull_request_review` and review comments: PR reconciliation.
- `check_run` and `check_suite`: PR reconciliation after failure or completion.
- `pull_request` synchronize/reopen: PR reconciliation.

Suppress Bottega-authored comments by the stable HTML marker and the resolved
host `gh` login. Do not blanket-ignore `[bot]` events: bot-authored checks and PR
events may still be actionable, and Dependabot support may be added later.

Respond to GitHub before starting long-running work, dispatch reconciliation
asynchronously, and log failures. This intentionally changes the current route,
which awaits agent startup before responding. Polling is the recovery path if
the process exits after acknowledging a webhook.

### 7. Add a small recovery scheduler

Add `server/services/github/scheduler.ts`, using only these Yeti scheduler
behaviors:

- Configurable interval.
- No overlapping scan for the same project.
- Startup staggering.
- Stop and drain during server shutdown.

Do not port dynamic job registration, daily scheduling, run-history tables, or
deployment update sentinels in the first migration. The project-level
`github_automation_enabled` switch is the minimum pause control during cutover.

At startup, schedule `reconcileRepository` only for projects with a non-null
`github_repo` and `github_automation_enabled = 1`. A default 10-minute poll is
sufficient because, as in Yeti, webhooks provide the normal low-latency path and
polling repairs missed events.

### 8. Link PR creation back to the task

Modify the existing PR agent completion path so that, after a PR is discovered
or created, it stores `github_pr_number` on the task. The PR agent remains
responsible for branch push, PR creation, conflict repair, and CI work.

When the PR is linked, remove `Ready` and `Refined` if still present and add
`In Review` to the issue. Search for an existing PR by task branch before
creating one.

Do not introduce a second branch naming convention. Yeti-created work moves to
Bottega's existing `task/{id}-{title}` branches as tasks are migrated.

### 9. Add minimal settings UI

Extend project create/edit with three administrator-only fields:

- GitHub repository (`owner/name`).
- GitHub automation enabled.
- Autonomy tier.

Enforce the same restriction in project mutation routes. Enabling automation
runs the acting-user validation described above and refuses the change when the
project owner is not ready to run the configured agents.

Add read-only GitHub issue and PR links to task detail. Do not port Yeti's queue,
job, policy, log, or learning pages initially.

### 10. Add configuration

Add:

```dotenv
GITHUB_RECONCILE_INTERVAL_MS=600000
GITHUB_WEBHOOK_SECRET=
```

Continue using the host's authenticated `gh` CLI for the first migration. Do
not combine Yeti's GitHub App token refresh with Bottega's per-user credential
model in the same change. GitHub App support can be added later behind the
client without changing reconciliation.

## Implementation phases

Each phase is independently deployable and should pass `scripts/gate.sh`.

### Phase 1: Schema and advisory issue planning

Deliver:

- Project/task schema and API fields.
- Database-enforced one-running-agent constraint.
- Shared task/workspace creation service.
- Project-owner acting-user validation.
- GitHub client read/comment/label operations.
- Capability firewall.
- `reconcileRefinementIssue`.
- Issue-label webhook handling.
- Planning completion publication.
- Human-comment cursor and plan revision behavior.
- Project settings fields and task links.

Run every linked project at `advisory` with automation disabled by default.
After validation, the system may import issues, run the planning agent, post
plans, and change labels. Application-owned code cannot push or create PRs at
this tier; unrestricted agent shell access remains outside that guarantee.

Acceptance test:

1. Label an issue `Needs Refinement`.
2. Confirm exactly one Bottega task and worktree are created.
3. Confirm planning runs once.
4. Redeliver the webhook and confirm no duplicate task, run, or comment.
5. Confirm the plan comment is updated in place and the issue becomes `Ready`.
6. Add human feedback and confirm one revised planning run updates the same
   comment.
7. Disable project automation and confirm webhook and polling work stops.

### Phase 2: Approved issue execution

Deliver:

- `reconcileApprovedIssue`.
- `Refined` webhook handling.
- `pr` autonomy checks around push and PR creation.
- Initial-run gates and approval-label removal.
- Task `github_pr_number` linkage.
- `In Review` label transition.

Enable `pr` autonomy for one test repository only.

Acceptance test:

1. Apply `Refined` to a planned issue.
2. Confirm the existing implementation/review loop runs.
3. Confirm one PR is created and linked to the task.
4. Redeliver webhooks and confirm no duplicate agent or PR starts.
5. Lower autonomy to `advisory` and confirm a second approved issue cannot push.
6. Leave the original issue `Refined` temporarily and confirm polling does not
   restart completed implementation.

### Phase 3: PR reconciliation

Deliver:

- `reconcilePullRequest`.
- Check, review, comment, and PR webhook routing.
- Evidence updates in the task document.
- Stable PR-evidence fingerprinting.
- PR-agent resume behavior.
- Polling fallback for known task PRs.
- Replacement of the existing direct `@bottega` dispatch path.

Acceptance test:

1. Cause a linked PR check to fail.
2. Confirm one PR-agent run starts with the failure evidence.
3. Post a human review comment and confirm the same task resumes.
4. Confirm the unchanged evidence fingerprint does not trigger another run.
5. Confirm a Bottega-marked comment does not retrigger work while bot-authored
   check events are still reconciled.
6. Confirm simultaneous poll and webhook delivery still starts at most one run.

### Phase 4: Yeti cutover

Deliver:

- Scheduler startup and graceful drain.
- Operational documentation and cutover runbook.
- A documented archive of Yeti operational state that is not imported.

Cutover one repository at a time:

1. Exclude the repository from Yeti's `allowedRepos`, or pause overlapping jobs
   globally during the handoff and update `allowedRepos` before resuming them.
2. Add or link the repository as a Bottega project.
3. Confirm the project owner has model settings and provider credentials for
   all agents used by the workflow.
4. Set `github_repo`; leave autonomy `advisory` and automation disabled.
5. Enable automation, run reconciliation, and inspect imported open work.
6. Raise autonomy to `pr` after advisory validation.
7. Remove the repository from Yeti after a full issue-to-PR and PR-repair cycle
   succeeds.

No historical data migration is required. Open GitHub items are discovered and
mapped to new Bottega tasks; closed Yeti history remains in GitHub and the old
Yeti database as an archive. Explicitly archive Yeti's CI-fix attempt counters,
fix commit SHAs, pending learnings, and `job_shas`; these are not imported and
must not be assumed available after cutover.

Yeti already provides webhook-plus-polling dispatch, pause/resume, deployment
quiescing, queue triage, manual job triggers, issue-level logs, and live config
editing. The unified system initially replaces only dispatch and per-project
pause. Operators continue using Yeti's dashboard for repositories not yet
migrated and use Bottega tasks plus `github_automation_enabled` for migrated
repositories. The reduced controls are an accepted temporary limitation.

### Phase 5: Optional maintenance jobs

After Yeti no longer executes feature or PR work, migrate jobs individually.
Each maintenance job should only discover a condition and create an ordinary
Bottega task. Account explicitly for all 14 Yeti jobs:

| Yeti job | Initial disposition |
|---|---|
| `issue-refiner` | Replaced in phases 1-2 |
| `issue-worker` | Replaced in phase 2 |
| `ci-fixer` | Replaced in phase 3 |
| `review-addresser` | Replaced in phase 3 |
| `auto-merger` | Deferred |
| `plan-reviewer` | Deferred; `Needs Plan Review` is not consumed |
| `doc-maintainer` | Migrate first as task discovery |
| `repo-standards` | Migrate second |
| `issue-auditor` | Migrate third; preserve `Priority` semantics |
| `improvement-identifier` | Migrate fourth as task discovery |
| `learning-consolidator` | Migrate only after defining a replacement learning store |
| `mkdocs-update` | Deferred; old `job_shas` are not imported |
| `triage-yeti-errors` | Deferred with the Yeti error-issue system |
| `prompt-evaluator` | Deferred |

Discord commands, deployment updating, and Yeti error-issue creation are also
deferred until there is a demonstrated need in the unified service.

### Phase 6: Optional auto-merge

Implement auto-merge only after PR reconciliation is stable. Initially consider
only PRs linked to Bottega tasks. Require passing checks, mergeability, autonomy
`automerge`, and either an approved review or an `LGTM` comment newer than the
latest non-merge commit. Use squash merge.

Dependabot and documentation-only auto-merge remain disabled until their Yeti
workflows are migrated with their existing distinct rules. Do not generalize
auto-merge to every PR in a linked repository.

## Concurrency and idempotency rules

These rules are required before enabling `pr` autonomy:

1. The unique task indexes prevent duplicate issue/PR imports.
2. Reconciliation always loads or creates by external identity before acting.
3. The partial unique index on running agent rows is the authoritative
   one-running-agent-per-task guard; in-memory or pre-insert checks are only an
   optimization.
4. Webhook and polling paths call the same functions and pass through the same
   keyed reconciliation lock.
5. GitHub comments use a stable task marker and update the stored comment ID.
6. PR creation first searches by task branch before creating a new PR.
7. A scheduler scan cannot overlap itself for the same project.
8. Application-owned capability checks occur again at every side effect.
9. Human issue comments are processed once using
   `github_last_human_comment_id`.
10. PR evidence triggers once per `github_pr_evidence_hash`, except for an
    explicit forced request.

Use a visible marker in Bottega-authored comments:

```html
<!-- bottega:task:<taskId>:plan -->
```

If `github_plan_comment_id` is missing, search for the marker before creating a
comment. This recovers safely from a database write failure after GitHub accepts
the comment.

## Test plan

### Unit tests

- Autonomy tier/action matrix.
- GitHub transient retry and rate-limit behavior.
- Bot/self-comment filtering.
- Issue and PR identity lookup.
- Plan marker rendering and recovery.
- Reconciliation decision tables for labels, checks, reviews, and autonomy.
- Human-comment cursor and plan-reset behavior.
- PR-evidence hash stability and forced-trigger behavior.
- Running-agent unique-constraint error handling.
- Keyed reconciliation lock serialization.
- Scheduler non-overlap and drain.

### Integration tests

Mock `gh` at the process boundary and exercise:

- Issue webhook -> task creation -> planning start.
- Duplicate webhook -> no duplicate task or run.
- Planning completion -> comment update and label transition.
- New human feedback -> one plan revision and in-place comment update.
- `Refined` -> implementation start only at `pr` autonomy.
- Completed implementation plus stale `Refined` -> no restart.
- Check/review event -> linked PR-agent run.
- Unchanged check/review evidence -> no additional run.
- Concurrent webhook/poll -> one running task agent.
- Existing `@bottega` trigger -> one forced reconciliation, not two starts.
- Project automation disabled -> no webhook or polling work.
- Existing local Bottega projects remain unaffected.

### Manual verification

For each implementation phase:

1. Run `bash scripts/gate.sh` from `reference/` and verify exit code 0.
2. Exercise the acceptance test against a disposable GitHub repository.
3. Confirm no existing project, task, conversation, or worktree was deleted or
   renamed.
4. Restart during an active scan and confirm the existing orphan-run recovery
   and the new poller recover without duplicate work.

## Expected file-level change set

The initial four phases should be achievable with this bounded footprint:

```text
reference/
  shared/types/db.ts                         modify
  shared/schemas/projects.ts                 modify
  shared/schemas/tasks.ts                    modify as needed
  server/database/init.sql                   modify
  server/database/db.ts                      modify
  server/routes/projects.ts                  modify
  server/routes/tasks.ts                     modify as needed
  server/routes/webhooks.ts                  modify
  server/services/agentRunner.ts             modify
  server/services/taskCreation.ts            add
  server/services/documentation.ts           modify
  server/services/github/client.ts           add
  server/services/github/capabilities.ts     add
  server/services/github/reconcile.ts        add
  server/services/github/scheduler.ts        add
  server/services/conversation/
    agentRunLifecycle.ts                     modify planning/PR sync hooks
  src/components/...project edit form...     modify
  src/components/TaskDetailView.tsx          modify
  .env.example                               modify
```

Tests should be colocated with the affected modules. Avoid creating abstraction
layers beyond these four GitHub service files until a second integration needs
them.

## Completion criteria

The migration is complete when:

- One Bottega task represents each actively managed GitHub issue or PR.
- All model execution goes through Bottega's provider runtime.
- All model transcripts are stored in Bottega SQLite.
- All worktrees are created and owned by Bottega.
- Webhooks and polling safely converge on the same reconciliation code.
- Project automation can be paused and application-owned effects honor project
  autonomy.
- Planning, implementation, review, and PR repair work without Yeti running for
  the migrated repository.
- The project owner is explicitly validated as the acting user for automation.
- Repeated issue comments, checks, reviews, polls, and webhook deliveries do not
  duplicate tasks, comments, PRs, or agent runs.
- Existing interactive/local Bottega tasks continue to work unchanged.
- Yeti can be stopped for migrated feature and PR work without abandoning active
  tasks; any deferred maintenance jobs are explicitly retired or migrated
  first, and GitHub remains the archive for historical output.
