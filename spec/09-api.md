---
id: 09-api
title: HTTP API
status: normative
authoritative_for: http-contract
summary: >-
  Authoritative REST + SSE contract: error shape, every route, the conversation event stream, uploads.
covers: [rest-api, sse, error-codes, pagination, uploads]
depends_on: [02-data-model, 06-auth, 18-multi-user]
required_by: [10-frontend]
decisions: [Q1, Q2, Q3, Q7, Q10]
milestones: [M1, M2, M4, M5, M6]
spec_version: 1
updated: 2026-02-20
---

# 09 — HTTP API (authoritative contract)

Base path `/api`. All bodies and responses are JSON (`application/json`) except SSE and file
downloads. All routes except `POST /api/auth/login` and `GET /api/health` require
authentication (`06-auth.md`).

## 0. Conventions

**Errors** — always this shape, with the HTTP status matching:

```json
{ "error": { "code": "validation_error", "message": "Human readable.",
             "details": [{ "path": "name", "message": "must not be empty" }] } }
```

**Authorization.** Every route resolves against the request principal per
[18-multi-user.md](18-multi-user.md) §4: invisible resources return `404 not_found` (never leak
existence), visible-but-not-writable return `403 forbidden`, and admin-only routes
(§5 of that file: `/api/providers/*`, `/api/extensions/*`, `PATCH /api/tools/:name`, all
`*/rescan`, `/api/users/*`, settings, audit reads, and `GET /api/fs/browse` for non-admins)
return `403 forbidden` naming the required role.

Codes used: `unauthenticated`, `invalid_credentials`, `csrf_check_failed`, `forbidden`,
`not_found`, `validation_error`, `profile_name_taken`, `workspace_name_taken`,
`path_not_absolute`, `path_not_found`, `path_not_directory`, `path_not_writable`,
`path_not_allowed`, `path_denylisted`, `path_already_registered`, `path_escape`,
`skill_invalid`, `tool_name_taken`, `model_unavailable`, `workspace_missing`,
`profile_not_found`, `conversation_busy`, `immutable_after_start`, `too_many_runs`,
`rate_limited`, `provider_not_configured`, `internal_error`.

**Pagination** — `?limit=` (default 50, max 200) `&cursor=` (opaque). Responses:
`{ items: [...], nextCursor: string | null }`.

**Headers** — clients MUST send `X-Requested-With: piui` on mutating requests.

**Ids** — uuidv4 strings.

---

## 1. Health & meta

### `GET /api/health`
```json
{ "ok": true, "version": "x.y.z", "piVersion": "0.85.1",
  "defaultCredentials": true, "container": true, "insecureTransportOk": true }
```
`container` and `insecureTransportOk` reflect `PIUI_CONTAINER` / `PIUI_INSECURE_TRANSPORT_OK`
and are rendered on the Settings/About page so the deployment posture is never guesswork
([19-deployment.md](19-deployment.md) §5).

### `GET /api/meta`
```json
{
  "searchProvider": { "id": "brave", "configured": true },
  "workspaceRoots": ["/home/me/projects"],
  "limits": { "maxUploadMb": 10, "maxConcurrentRuns": 4, "maxRunMinutes": 30 },
  "platform": "linux"
}
```

---

## 2. Auth

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/auth/login` | `{ username, password }` | `200 { user }` / `401` / `429` |
| POST | `/api/auth/logout` | — | `204` |
| GET | `/api/auth/me` | — | `200 { user, stepUpValidUntil: string \| null }` — `user.roles` drives admin-only UI / `401` |
| POST | `/api/auth/step-up` | `{ password }` | `204` / `401` / `429` — see [14-credentials.md](14-credentials.md) §5 |

---

## 3. Models

### `GET /api/models`
`200 { items: ModelInfo[], credentialsRevision: number }` — all registered models, `available`
reflecting credentials. Cached 60 s in memory; the cache MUST be invalidated by any credential
mutation and `credentialsRevision` bumped. `?refresh=1` forces
`modelRuntime.refresh({ allowNetwork: true })` with a 15 s deadline and returns
`{ items, refresh: { aborted, errors: [{provider, message}] } }`.

### Providers & credentials

**Specified in full in [14-credentials.md](14-credentials.md) §3** (decision Q1 = B: API-key
management from the UI). Summary of routes:

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/providers` | `{ items: ProviderStatus[], credentialWritesEnabled, authPath }` — no secrets, ever |
| POST | `/api/providers/:id/auth/start` | `{ type?: "api_key", apiKey?, env? }` → `AuthFlowView` |
| POST | `/api/providers/:id/auth/respond` | `{ flowId, promptId, value }` → `AuthFlowView` |
| GET | `/api/providers/auth-flows/:flowId?wait=&since=` | long-poll the flow view |
| POST | `/api/providers/:id/auth/cancel` | `{ flowId }` |
| DELETE | `/api/providers/:id/auth` | `runtime.logout()`; `409 credential_not_removable` for env-sourced auth |
| POST | `/api/providers/:id/verify` | non-mutating re-check ("Test" button) |
| POST | `/api/auth/step-up` | `{ password }` → `204`; required within 10 min for every write route above |

Additional error codes: `provider_not_found`, `provider_ambient_only`,
`auth_type_not_supported`, `too_many_flows`, `flow_not_found`, `flow_not_prompting`,
`flow_prompt_mismatch`, `credential_not_removable`, `credential_writes_disabled`,
`step_up_required`, `insecure_transport`.

---

## 4. Profiles

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/profiles` | `{ items: Profile[] }` without `agentsMd` (replaced by `agentsMdSize`), plus `usedByConversations: number`. Scoped to own + `shared`; each item carries `ownerId`, `visibility`, `isOwn`. |
| POST | `/api/profiles` | body: `{ name, description?, agentsMd?, skillIds?, toolNames?, memory?: { enabled, path? }, defaults? }` → `201 Profile` |
| GET | `/api/profiles/:id` | full `Profile` incl. `agentsMd`, `memory.sizeBytes`, `resolvedTools: ToolDescriptor[]`, `warnings: string[]` |
| PATCH | `/api/profiles/:id` | partial; same validation as POST → `200 Profile`. `visibility` patchable by owner or admin (`[V2]` in the UI) |
| DELETE | `/api/profiles/:id` | `200 { affectedConversations: number }` |
| POST | `/api/profiles/:id/duplicate` | copies row + directory (`"<name> copy"`) → `201 Profile` |
| GET | `/api/profiles/:id/memory` | `200 { path, enabled, sizeBytes, modifiedAt, content, truncated }` (content max 512 KB) |
| PUT | `/api/profiles/:id/memory` | `{ content }` — human curation → `200 { sizeBytes }` |
| DELETE | `/api/profiles/:id/memory` | move file to trash → `204` |
| GET | `/api/profiles/:id/memory/download` | `text/markdown` attachment |

---

## 5. Workspaces

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/workspaces` | `{ items: Workspace[] }` with `status` and `activeConversations: number` |
| POST | `/api/workspaces` | `{ name, path, description?, create?: boolean, gitInit?: boolean }` → `201 Workspace` |
| GET | `/api/workspaces/:id` | `Workspace` |
| PATCH | `/api/workspaces/:id` | `{ name?, description?, path?, trusted? }` — `path` change allowed only if no conversation has started in it, else `409 immutable_after_start`; `trusted` toggles project prompt/skill loading ([15](15-commands-and-input.md) §3.3) |
| GET | `/api/workspaces/:id/project-resources` | `200 { hasPiDir, prompts: string[], skills: string[], extensions: string[], settings: boolean, trusted }` — drives the trust dialog |
| DELETE | `/api/workspaces/:id` | record only → `200 { affectedConversations: number }` |
| POST | `/api/workspaces/validate` | `{ path, create?: boolean }` → `200 { ok: true, normalizedPath, status }` or `400` with a code — used for live form feedback |
| GET | `/api/workspaces/:id/tree?path=&depth=1` | see `04-workspaces.md` §3 |
| GET | `/api/workspaces/:id/file?path=` | `200 { path, content, size, truncated, language }` / `415 binary_file` |
| GET | `/api/workspaces/:id/git` | `200 { available: boolean, branch?, ahead?, behind?, dirtyCount?, staged?, lastCommit? }` |
| GET | `/api/fs/browse?path=` | directory picker helper: `200 { path, parent, dirs: string[] }`; honors the denylist and `PIUI_WORKSPACE_ROOTS`; never lists file contents |

---

## 6. Skills

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/skills` | `{ items: SkillSummary[] }` incl. `usedByProfiles: number`, `missing?: true` |
| POST | `/api/skills` | `{ name, description, body, template?: "basic"\|"script"\|"reference" }` → creates dir + `SKILL.md` → `201 SkillSummary` |
| GET | `/api/skills/:id` | `SkillSummary` + `files: { path, size }[]` + `skillMd: { name, description, body }` |
| PATCH | `/api/skills/:id` | `{ name?, description?, body?, enabled? }` → rewrites `SKILL.md` |
| DELETE | `/api/skills/:id` | `200 { affectedProfiles: string[] }` |
| GET | `/api/skills/:id/files/*` | raw file content (text only, 512 KB cap) |
| PUT | `/api/skills/:id/files/*` | `{ content }` — create/overwrite a file inside the skill dir; path traversal rejected |
| DELETE | `/api/skills/:id/files/*` | remove a file (never `SKILL.md`) |
| POST | `/api/skills/import` | JSON: `{ path }` to register an external dir **or** `{ skillMd }` → `201 SkillSummary` |
| POST | `/api/skills/import-zip` | multipart `.zip` → `201 SkillSummary`. *(Erratum, M7: fastify binds one content-type parser per path, so the zip upload has its own route rather than sharing `/api/skills/import`.)* |
| POST | `/api/skills/rescan` | `200 { added, updated, missing }` |
| POST | `/api/skills/:id/validate` | `200 { errors: string[], warnings: string[] }` |
| POST | `/api/skills/:id/test` | `201 { conversationId, ephemeral: true }` (see `05-skills-and-tools.md` A.4) |

---

## 7. Tools

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/tools` | `{ items: ToolDescriptor[] }` (all kinds) incl. `usedByProfiles: number`, plus `webSearch: { provider, configured }` |
| PATCH | `/api/tools/:name` | `{ enabled }` — global enable/disable, works for built-ins too |
| POST | `/api/tools/http` | HTTP tool create: `{ name, label, description, method, urlTemplate, headers, bodyTemplate?, parameters, timeoutMs? }` → `201 ToolDescriptor` |
| GET | `/api/tools/http/:id` | full definition with header values masked |
| PATCH | `/api/tools/http/:id` | partial update |
| DELETE | `/api/tools/http/:id` | `200 { affectedProfiles: string[] }` |
| POST | `/api/tools/http/:id/test` | `{ params }` → `200 { status, durationMs, body, truncated }` |
| POST | `/api/tools/web_search/test` | `{ query }` → `200 { results: [...] }` / `503 provider_not_configured` |

---

## 7a. Users `[V2]`

`GET/POST/PATCH/DELETE /api/users` — admin only; create, set role, deactivate, reset password.
Deactivation invalidates that user's `auth_sessions` immediately. Shape and rationale in
[18-multi-user.md](18-multi-user.md) §7. These routes MUST NOT exist in V1 (`404`), but the role
checks they depend on MUST.

## 7b. Extensions

Full contract in [16-extensions.md](16-extensions.md) §9. Routes:
`GET /api/extensions`, `GET /api/extensions/:id`, `POST /api/extensions`,
`POST /api/extensions/fetch`, `PATCH /api/extensions/:id`, `DELETE /api/extensions/:id`,
`POST /api/extensions/rescan`, `POST /api/conversations/:id/ui-response`.
Mutations require step-up and are refused when `PIUI_DISABLE_EXTENSION_INSTALL=1`.
Error codes: `extension_name_taken`, `extension_load_failed`, `extension_not_editable`,
`extension_install_disabled`, `extension_too_large`.

---

## 8. Conversations

### `GET /api/conversations?mode=&archived=&limit=&cursor=`
`200 { items: ConversationSummary[], nextCursor }` sorted by `last_message_at DESC`.

### `POST /api/conversations`
```ts
{
  mode: "chat" | "agent";
  provider: string; modelId: string; thinkingLevel?: ThinkingLevel;
  profileId?: string;        // agent only, required
  workspaceId?: string;      // agent only, required
  webSearch?: boolean;       // chat only (agent derives it from the profile)
  title?: string;
  timezone?: string;
  initialMessage?: string;   // optional: immediately prompts
  initialImages?: { fileName: string; mimeType: string; dataBase64: string }[];
}
```
→ `201 { conversation: ConversationDetail, warnings: string[] }`

`ConversationDetail` = `ConversationSummary` + `{ tools: ToolDescriptor[], systemPromptPreview: string, profileSnapshot?: {...}, state: ConversationRuntimeState }`.

`systemPromptPreview` is truncated to 4 KB and exists so the user can see what the model was
told. It MUST be the real composed prompt, not a guess.

### `GET /api/conversations/:id`
`200 ConversationDetail`. Creates the `LiveSession` lazily only if needed for `state`;
otherwise reports `isStreaming: false`.

### `GET /api/conversations/:id/messages`
`200 { messages: UiMessage[], seq: number }` — full projected transcript from the pi session
file (or the live session when loaded). `seq` is the current event sequence so a client can
attach to the stream without a race.

### `PATCH /api/conversations/:id`
`{ title?, archived?, provider?, modelId?, thinkingLevel?, webSearch? }`
- model/thinking/webSearch changes are rejected while streaming (`409 conversation_busy`);
- `profileId`/`workspaceId` are **not** patchable after `session_path` is set
  (`409 immutable_after_start`);
- setting `title` sets `titleLocked = true`.
→ `200 ConversationDetail`

### `DELETE /api/conversations/:id`
Deletes the row, moves the pi session file to trash, removes uploads and scratch dir → `204`.

### `POST /api/conversations/:id/messages`
```ts
{ text: string;
  images?: { fileName: string; mimeType: string; dataBase64: string }[];
  streamingBehavior?: "steer" | "followUp"; }
```
- idle → `session.prompt()`; `202 { accepted: true, queuedAs: null }`
- streaming + `streamingBehavior` → `202 { accepted: true, queuedAs: "steer" | "followUp" }`
- streaming without it → `409 conversation_busy`
- above the global run cap → `429 too_many_runs`

The response returns as soon as the prompt is **accepted** (mirroring pi's `preflightResult`);
all output arrives over SSE. The route MUST NOT await the whole run.

### `POST /api/conversations/:id/abort`
`200 { restored: { steering: string[], followUp: string[] } }` — clears the queue first (so the
client can restore the text in the composer), then aborts, then waits for idle (max 5 s).

### `POST /api/conversations/:id/queue/clear`
`200 { steering: string[], followUp: string[] }`

### `GET /api/conversations/:id/commands`
`200 { items: CommandDescriptor[] }` — built-ins + the profile's skills + prompt templates from
all enabled sources. Full shape and semantics in
[15-commands-and-input.md](15-commands-and-input.md) §1.

### `GET /api/prompts` / `POST /api/prompts/rescan`
`200 { items: { name, description, argumentHint?, location, path }[] }` /
`200 { added, updated, removed }` — see [15-commands-and-input.md](15-commands-and-input.md) §5.

### `POST /api/conversations/:id/compact`
`{ customInstructions?: string }` → `200 { summary, tokensBefore, estimatedTokensAfter, cost }`

### `GET /api/conversations/:id/stats`
`200 { tokens: {...}, cost: number, contextUsage: { tokens, contextWindow, percent } | null,
messages: { user, assistant, toolCalls } }`

### `GET /api/conversations/:id/export?format=md|json|html`
- `md`: rendered transcript (tool calls as fenced blocks),
- `json`: `{ conversation, messages: UiMessage[] }`,
- `html`: delegate to pi's HTML export when the live session exists, else render server-side.

### Forking `[LATER, design now]`
`POST /api/conversations/:id/fork { entryId }` → `201 { conversationId }` using
`AgentSessionRuntime.fork`. `GET /api/conversations/:id/tree` returns pi's entry tree for a
branch navigator. Not required for V1, but the API shape MUST be reserved.

---

## 9. Streaming

### `GET /api/conversations/:id/events`
`text/event-stream`. Headers: `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
`X-Accel-Buffering: no`.

Frames:
```
id: 42
event: message
data: {"type":"block_delta","seq":42,...}

```
- `event:` is always `message` (single channel); the discriminator is `data.type`.
- On connect: the server sends `snapshot` (full `UiMessage[]` + state) **unless** the request
  carried `Last-Event-ID` (or `?since=<seq>`) that still lives in the ring buffer, in which
  case it replays from `since+1`.
- If `since` is stale/unknown → send `snapshot` (client MUST handle a snapshot at any time by
  replacing its state).
- `ping` every 20 s. Client reconnect: `EventSource` default, plus manual retry with
  exponential backoff capped at 10 s if `EventSource` gives up.
- Multiple concurrent subscribers per conversation are supported (two tabs) and receive
  identical frames.

### `GET /api/events` `[V1]`
A second, global SSE channel for cross-cutting notifications:
`{ type: "conversation_state", conversationId, isStreaming }`,
`{ type: "conversation_title", conversationId, title }`,
`{ type: "conversation_done", conversationId }`,
`{ type: "skills_changed" }`, `{ type: "providers_changed" }`,
`{ type: "extensions_changed" }`, `{ type: "ping" }`.
Used to keep the sidebar list and badges live without polling.

---

## 10. Uploads

### `POST /api/uploads` (multipart, field `file`)
`201 { id, url: "/api/uploads/<conversationId>/<id>", mimeType, size }`
- accepted: `image/png|jpeg|webp|gif`, max `PIUI_MAX_UPLOAD_MB`,
- validated by magic bytes, not just the declared type,
- stored under `$PIUI_HOME/uploads/<conversationId>/`; `conversationId` is a required form field.
- `GET /api/uploads/:conversationId/:id` serves the file with `Content-Disposition: inline`,
  `Content-Security-Policy: sandbox`, and a strict content type.

Alternatively, small images MAY be inlined as base64 in `POST /messages` (the API supports
both); the client SHOULD use the upload endpoint above 256 KB.
