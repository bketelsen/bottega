---
name: bottega
description: "Use when driving Bottega through its REST API: auth tokens/API keys, projects, tasks, agent workflows, YOLO mode, PR readiness polling, and merge cleanup."
---

# Bottega API Operator

Use this skill when a user asks an agent to operate Bottega itself through the API, automate tasks, start or advance workflows, monitor a PR to ready, or merge and clean up completed work.

## Assumptions

- Default API base: `http://localhost:3001` unless the user provides another URL.
- Auth is app-level Bottega auth, not provider auth. Provider credentials for Claude, Codex, OpenCode, or Copilot are separate and must already be configured for the acting user before agent runs can start.
- Prefer a per-user API key (`ccui_...`) for automation. JWT login tokens also work.
- Never print secrets back to the user unless the endpoint shows the secret once and the user explicitly requested generation.

## Environment

Use these shell variables in examples and scripts:

```bash
BOTTEGA_URL="http://localhost:3001"
BOTTEGA_TOKEN="ccui_or_jwt_token_here"
```

All protected requests use:

```bash
-H "Authorization: Bearer $BOTTEGA_TOKEN"
```

## Get An Auth Token

1. Check setup status:

```bash
curl -s "$BOTTEGA_URL/api/auth/status"
```

2. If `needsSetup` is true, bootstrap the first admin user:

```bash
curl -s -X POST "$BOTTEGA_URL/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"replace-me"}'
```

The response contains `token`. Save it as `BOTTEGA_TOKEN`.

3. If setup is complete, log in:

```bash
curl -s -X POST "$BOTTEGA_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"USER","password":"PASSWORD"}'
```

The response contains a JWT `token`. Bottega refreshes JWTs on authenticated requests using the `X-Refreshed-Token` response header; update stored JWTs from that header when writing long-running automation. API keys do not use rolling refresh.

4. For durable automation, generate a per-user API key after authenticating with a JWT:

```bash
curl -s -X POST "$BOTTEGA_URL/api/account/api-key" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"
```

The response contains `{ "key": "ccui_..." }` exactly once. Store that as `BOTTEGA_TOKEN` for future scripted calls.

## Token Sanity Checks

Verify the current principal:

```bash
curl -s "$BOTTEGA_URL/api/auth/user" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"
```

Check API key status:

```bash
curl -s "$BOTTEGA_URL/api/account/api-key" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"
```

Revoke an API key only when explicitly asked:

```bash
curl -s -X DELETE "$BOTTEGA_URL/api/account/api-key" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"
```

## Projects

List accessible projects:

```bash
curl -s "$BOTTEGA_URL/api/projects" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"
```

Create a project:

```bash
curl -s -X POST "$BOTTEGA_URL/api/projects" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Project","repoFolderPath":"/absolute/path/to/repo"}'
```

For monorepos, include `subprojectPath`:

```json
{"name":"Web App","repoFolderPath":"/repo/root","subprojectPath":"apps/web"}
```

Project access is membership-scoped. Admins can see all projects; non-admins only see projects where they are members.

## Create Tasks

Create a normal pipeline task:

```bash
curl -s -X POST "$BOTTEGA_URL/api/projects/$PROJECT_ID/tasks" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Fix checkout bug","description":"Reproduce the checkout failure, fix it, add tests, and open a PR."}'
```

The response is the task row. Important fields:

- `id`: task id.
- `status`: `pending`, `in_progress`, `in_review`, or `completed`.
- `workflow_complete`: review marked the work ready.
- `workflow_blocked`: the loop needs human help.
- `planification_complete`: planning finished.
- `pr_agent_complete`: PR agent or YOLO run finished.
- `yolo_mode`: single-agent YOLO workflow flag.

Read or update the task document:

```bash
curl -s "$BOTTEGA_URL/api/tasks/$TASK_ID/documentation" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"

curl -s -X PUT "$BOTTEGA_URL/api/tasks/$TASK_ID/documentation" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Task\n\nDetailed request here."}'
```

## Start And Advance Workflows

Start an agent run:

```bash
curl -s -X POST "$BOTTEGA_URL/api/tasks/$TASK_ID/agent-runs" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agentType":"planification"}'
```

Valid `agentType` values are:

- `planification`: writes the plan, then stops at the plan-review gate for technical users.
- `implementation`: implements the checked plan.
- `review`: verifies work; may set `workflow_complete` or `workflow_blocked`.
- `pr`: creates/verifies the PR, drives CI green, and sets `pr_agent_complete`.
- `refinement`: optional extra polish step if enabled by the deployment.
- `yolo`: single-agent end-to-end mode for tasks created with `yolo_mode: true`.

List runs for a task:

```bash
curl -s "$BOTTEGA_URL/api/tasks/$TASK_ID/agent-runs" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"
```

Poll a task:

```bash
curl -s "$BOTTEGA_URL/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"
```

Normal pipeline behavior:

- Start `planification` first.
- For technical users, planning stops after `planification_complete` so a human can inspect the plan. Start `implementation` manually when approved.
- After implementation starts, Bottega chains implementation and review automatically until review sets `workflow_complete`, review sets `workflow_blocked`, or the iteration cap blocks the task.
- When `workflow_complete` is set, Bottega chains into the PR finish pipeline and starts `pr`.
- `pr` is terminal. Completion is recorded by `pr_agent_complete`.

Manual overrides:

```bash
curl -s -X PUT "$BOTTEGA_URL/api/tasks/$TASK_ID/workflow-complete" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"complete":true}'

curl -s -X POST "$BOTTEGA_URL/api/tasks/$TASK_ID/resume" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"
```

Use manual flag changes sparingly. The intended path is to let agents set workflow flags through their completion scripts.

## YOLO Mode

YOLO mode is selected at task creation with `yolo_mode: true`:

```bash
curl -s -X POST "$BOTTEGA_URL/api/projects/$PROJECT_ID/tasks" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Small safe change","description":"Make the targeted change, test it, and open a PR.","yolo_mode":true}'
```

Then start the YOLO agent:

```bash
curl -s -X POST "$BOTTEGA_URL/api/tasks/$TASK_ID/agent-runs" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agentType":"yolo"}'
```

YOLO plans, implements, tests, marks workflow complete, creates or verifies the PR, waits on CI, and sets `pr_agent_complete` in one continuous conversation. Use it for smaller, well-scoped, lower-risk work where the independent review step is less important.

## Wait For PR Ready

Poll PR status with:

```bash
curl -s "$BOTTEGA_URL/api/tasks/$TASK_ID/pull-request" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"
```

Possible response shapes:

```json
{"success":true,"exists":false}
```

```json
{
  "success": true,
  "exists": true,
  "url": "https://github.com/org/repo/pull/123",
  "state": "OPEN",
  "mergeable": "MERGEABLE",
  "ciStatus": { "status": "passed", "checks": [] }
}
```

Treat a PR as ready when all of these are true:

- The task has `pr_agent_complete` set to `1`.
- `GET /api/tasks/:id/pull-request` returns `success: true` and `exists: true`.
- `ciStatus.status` is `passed` or `none`, depending on the repository's expected checks.
- `mergeable` indicates mergeable, commonly `MERGEABLE`.
- The PR `state` is open.

If `ciStatus.status` is `pending` or `mergeable` is unknown, wait and poll again. Use bounded polling. If `ciStatus.status` is `failed` after the PR agent has completed, report the failure instead of merging.

Example bounded poll loop:

```bash
for i in $(seq 1 60); do
  curl -s "$BOTTEGA_URL/api/tasks/$TASK_ID" \
    -H "Authorization: Bearer $BOTTEGA_TOKEN"
  curl -s "$BOTTEGA_URL/api/tasks/$TASK_ID/pull-request" \
    -H "Authorization: Bearer $BOTTEGA_TOKEN"
  sleep 10
done
```

## Merge And Cleanup

Only merge after the PR is ready and the user asked to merge, or the automation's mandate explicitly includes merge-and-cleanup.

Call:

```bash
curl -s -X POST "$BOTTEGA_URL/api/tasks/$TASK_ID/merge-cleanup" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"
```

Successful response:

```json
{"success":true}
```

The response may also include `serverSwitched`, `serverSwitchMessage`, `serverSwitchWarning`, or `serverSwitchError` if the task worktree was the active web-server target. Report those fields to the user.

After merge cleanup, re-check the task and PR status:

```bash
curl -s "$BOTTEGA_URL/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"
curl -s "$BOTTEGA_URL/api/tasks/$TASK_ID/pull-request" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN"
```

## The `is_technical` Flag

`is_technical` is a user role flag returned as `is_technical: 0 | 1` on user objects. It has one orchestration effect:

- Technical users (`is_technical: 1`) keep the manual plan-review gate. After `planification` completes, the loop stops until someone manually starts `implementation`.
- Non-technical users (`is_technical: 0`) skip that gate. When planning completes, Bottega auto-starts implementation if the task is not blocked and has not hit the iteration cap.

Non-technical planning also uses the `planification-nontechnical` prompt variant. This flag does not grant admin privileges and does not change project membership authorization.

Update the current user's profile:

```bash
curl -s -X PUT "$BOTTEGA_URL/api/auth/profile" \
  -H "Authorization: Bearer $BOTTEGA_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"isTechnical":false}'
```

Note the API uses camelCase `isTechnical` in the request body and snake_case `is_technical` in user responses and database-shaped rows.

## Error Handling

- `401`: token missing, invalid, expired, or JWT token version was invalidated. Log in again or use a valid API key.
- `403`: user lacks project membership, admin rights, or provider credentials for the selected agent's harness.
- `404`: task/project/run does not exist or is not visible to the caller.
- `409`: an agent is already running for this task; poll current runs and wait.

For any mutating action, first verify the target ids with `GET /api/projects`, `GET /api/tasks/:id`, and `GET /api/tasks/:id/pull-request` where relevant.
