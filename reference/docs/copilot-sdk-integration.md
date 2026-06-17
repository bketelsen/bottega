# GitHub Copilot SDK integration

Copilot is the fourth agent backend, registered as the provider `'copilot'`. It
reuses the same provider abstraction as Anthropic/Codex/OpenCode — the
`LlmProvider` interface, the `ProviderCredentialStore`, the `UnifiedMessage`
streaming union, and per-user `(provider, model, effort)` agent settings. This
doc covers only what is Copilot-specific.

## The SDK in one paragraph

`@github/copilot-sdk` exposes the Copilot CLI agent loop as an embeddable
library. The entry point `CopilotClient` is a **long-lived JSON-RPC client**
that bundles and manages its own Copilot CLI runtime subprocess
(`client.start()` / `client.stop()`). Sessions come from
`client.createSession({ model, workingDirectory, onPermissionRequest })` and
`client.resumeSession(sessionId, ...)`; a `CopilotSession` is an **EventEmitter**
(`session.on(handler)` → unsubscribe), with `session.send(prompt|MessageOptions)`,
`session.abort()`, and `session.disconnect()`. Models come from the runtime via
`client.listModels()`. Auth is a GitHub token passed to the constructor
(`gitHubToken`).

## Two architectural differences from the other providers

1. **EventEmitter → async generator bridge.** `ProviderRunResult.events` is an
   `AsyncIterable<UnifiedMessage>`, but Copilot delivers events through
   callbacks. `providers/copilot/eventBridge.ts` (`AsyncPushQueue`) adapts the
   `session.on(...)` firehose into an async iterable: the provider's `on`
   handler maps each event and `push()`es it; `session.idle`/`session.error`
   `close()` the queue; a rejected `send` `fail()`s it.

2. **Long-lived per-user client pool.** A `CopilotClient` is expensive to start
   and is meant to be reused across turns — like OpenCode's `opencode serve`
   pool, not Codex's spawn-per-turn. `providers/copilot/clientPool.ts` keeps one
   started client per user, idle-reaped (15 min) and invalidated on auth change
   (the running client captured the old token at construction).

## Auth: GitHub device/OAuth flow

`copilotAuthFlow.ts` runs the standard GitHub OAuth **device flow** over HTTPS
(no PTY): `POST /login/device/code` → show the verification URL + user code →
poll `POST /login/oauth/access_token` until an `access_token` comes back →
persist it via `copilotCredentials.writeCopilotAuth` (mode 0600 under
`~/.config/bottega/users/{id}/copilot/auth.json`). The OAuth client id defaults
to the GitHub CLI's public client id; override with `COPILOT_OAUTH_CLIENT_ID`.

The token is handed to the SDK at client construction (`gitHubToken`), never via
env. `buildCopilotSdkEnv(userId)` only tags `BOTTEGA_USER_ID` onto the turn's
env so `CopilotProvider` can resolve the pooled client (same mechanism as
OpenCode).

## Models

The catalog is dynamic (like OpenCode), fetched live via `client.listModels()`
and surfaced at `GET /api/copilot-auth/models`. Models are persisted as
`copilot/<modelId>`; `parseCopilotModel` strips the prefix before handing the
bare id to `createSession`.

## Event mapping

`providers/copilot/mapEvent.ts` (`createCopilotEventMapper`) maps Copilot
`SessionEvent`s to `UnifiedMessage[]`:

| Copilot event | UnifiedMessage |
|---|---|
| `user.message` | `user` |
| `assistant.message` | `assistant` (text, model, output tokens) |
| `assistant.message_delta` | `stream_delta` (text) |
| `assistant.reasoning` | `assistant_thinking` |
| `assistant.reasoning_delta` | `stream_delta` (thinking) |
| `tool.execution_start` | `tool_use` |
| `tool.execution_complete` | `tool_result` (isError from `!success`) |
| `assistant.usage` | folded into the terminal `result` |
| `session.idle` | `result` (clean end) |
| `session.error` | `result` with `isError: true` |

Reasoning deltas are the one capability richer than Codex
(`supportsThinkingDelta: true`); AskUserQuestion, MCP, images, and the per-tool
context-usage breakdown are off in v1.

## REST routes (`/api/copilot-auth/*`)

`GET /status`, `POST /start`, `POST /complete`, `POST /cancel`, `DELETE /`,
`GET /models`. Mutations invalidate the pooled client.

## Key files

- `shared/providers/models.ts`, `capabilities.ts`, `types.ts` — `copilot` in the
  provider union, dynamic-model guard, capability matrix.
- `server/services/providers/copilot/` — `index.ts` (provider), `clientPool.ts`,
  `eventBridge.ts`, `mapEvent.ts`, `copilotOptionsBuilder.ts`, `messageMirror.ts`.
- `server/services/copilotCredentials.ts`, `copilotAuthFlow.ts`,
  `credentials/copilot.ts`.
- `server/routes/copilotAuth.ts`.
- `server/services/conversation/startCopilotConversation.ts`.
- `src/components/CopilotAuthPanel.tsx`; catalog plumbing in
  `AgentModelsTab.tsx` / `AgentModelSettingRow.tsx` / `useProviderModelSelection.ts`.
