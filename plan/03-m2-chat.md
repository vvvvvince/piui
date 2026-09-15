---
id: plan-03
title: M2 — Credentials, pi bridge, streaming, chat mode
status: plan
summary: >-
  Credential management first, then the pi adapters, the SessionHub and SSE contract, and the
  chat UI with TUI-parity input. The milestone that proves the architecture; highest risk.
milestone: M2
est_days: "5–7"
covers: [credentials, auth-flow, model-service, agent-runner, session-hub, sse, event-projection, chat-ui, tui-input]
spec_refs: [14-credentials, 07-chat-mode, 09-api, 10-frontend, 01-architecture, 02-data-model, 15-commands-and-input]
depends_on: [plan-02]
blocks: [plan-04, plan-05]
risk: high
plan_version: 1
updated: 2026-02-20
---

# M2 — Credentials, pi bridge, streaming, chat mode

**Context to load:** `14-credentials`, `07-chat-mode`, `09-api`, `10-frontend`,
`15-commands-and-input` §4, `01-architecture` §4, `02-data-model` §§4–5. (~15k)

**Goal:** a user can configure a provider key in the UI, start a chat, watch tokens stream, and
survive a reload *and* a server restart. This is the milestone that proves the architecture.

Order matters: **credentials first** (that is how you get a working model), then the pi bridge,
then the hub, then the UI.

---

## 1. Credentials (`14-credentials.md`, decision Q1 = B)

- `pi/credentials.ts`: `CredentialService` wrapping pi's credential surface + an `AuthFlow`
  state machine (start → prompts → respond → done/cancel), flow TTL, prefill auto-answer,
  `promptId` mismatch rejection, `CredentialSynchronizationError` → success-with-warning.
- Routes per `14-credentials.md` §3 (they replace `09-api.md` §3's provider table):
  `GET /api/providers`, `POST /api/providers/:id/auth/start|respond|cancel`,
  `GET /api/providers/auth-flows/:flowId?wait=&since=`, `DELETE /api/providers/:id/auth`,
  `POST /api/providers/:id/verify`. All admin-only, all step-up-gated, all refused when
  `PIUI_DISABLE_CREDENTIAL_WRITES=1` (`403 credential_writes_disabled`) or over plaintext
  without `PIUI_INSECURE_TRANSPORT_OK` (`insecure_transport`).
- Storage: `PIUI_PI_AUTH_PATH`, enforce `0600`.
- **Secret hygiene is a test, not a habit:** a fixture key pushed through start/respond/error
  paths must appear in no log line, no audit row, no response body.
- UI: `/settings/providers` with `ProviderTable` + `CredentialDialog` (add/replace/delete/test).

## 2. Models

- `pi/model-service.ts`: one shared `ModelRuntime` created at boot with
  `authPath: config.piAuthPath`.
- `GET /api/models` → `{ items: ModelInfo[], credentialsRevision }`, 60 s in-memory cache,
  invalidated + revision bumped by **any** credential mutation; `?refresh=1` →
  `refresh({ allowNetwork: true })` with a 15 s deadline and per-provider errors.

## 3. pi bridge (the only place importing pi)

- `pi/resources.ts` — `DefaultResourceLoader` per conversation with the overrides from
  `01-architecture.md` §4.3 (see spike **S2**); chat mode contributes no AGENTS.md and no skills.
  Test: **no host extension, skill or project setting is loaded**.
- `pi/agent-runner.ts` — exactly the interface in §4.1:
  `createSession({ config: ResolvedSessionConfig, sessionManager }) → { session, dispose }`.
  Chat mode: `tools: []` + web tools later, scratch cwd `$PIUI_HOME/scratch/<conversationId>`,
  system prompt override from `07-chat-mode.md` §2.
- `SettingsManager.inMemory({...})` — piui owns settings, never mutates the user's global pi
  settings; `enableSkillCommands: true`, `enableInstallTelemetry: false`.

## 4. SessionHub + SSE (highest-risk component)

- `session/hub.ts`: `LiveSession { session, subscribers, ring buffer, seq }`, keyed by
  conversation id, created lazily on first prompt or first SSE attach.
- Ring buffer cap 2000 events / 8 MB. `seq` strictly increasing from 1 per conversation.
- `session/event-map.ts`: `AgentSessionEvent → UiEvent[]` (spike **S4**), with **delta
  coalescing**: buffer `text_delta`/`thinking_delta`, flush at most every 50 ms or 1 KB per
  content block, and always on block end.
- `session/transcript.ts`: pi messages → `UiMessage[]` (spike **S5**); tool call + result merged
  into **one** `tool` block; thinking kept but collapsed; `stopReason: "error"` → `role:"error"`
  message; tool output truncated to 16 KB with `outputTruncated`.
- `GET /api/conversations/:id/events`: `snapshot` on connect unless a live `Last-Event-ID` /
  `?since=` allows replay from `since+1`; stale/unknown → `snapshot`; `ping` every 20 s;
  headers `no-cache, no-transform`, `X-Accel-Buffering: no`; multiple subscribers get identical
  frames.
- Eviction: no subscriber and not streaming for 15 min → `dispose()` (fake-clock tested).
- Concurrency: one run per conversation; `PIUI_MAX_CONCURRENT_RUNS` semaphore (default 4) →
  `429 too_many_runs`.

## 5. Conversations (chat only)

`POST /api/conversations` (+ optional `initialMessage`), `GET /:id` (`ConversationDetail` with
the **real** composed `systemPromptPreview`, ≤ 4 KB), `GET /:id/messages`, `PATCH`, `DELETE`,
`POST /:id/messages` (idle → prompt `202`; streaming + `streamingBehavior` → steer/followUp;
streaming without → `409 conversation_busy`; the route MUST NOT await the run),
`POST /:id/abort` (clear queue → abort → wait idle ≤ 5 s, return restorable text),
`POST /:id/queue/clear`, `GET /:id/stats`.
Auto-title from the first user message only, one trivial call on the conversation's model
(decision Q8); `titleLocked` once the user sets a title.

## 6. Chat UI

New-chat dialog · model picker (`available` from credentials) · transcript with `react-markdown`
+ `remark-gfm` + `rehype-sanitize` + syntax highlighting · `useConversationStream` hook
(snapshot replaces state at any time; dedupe by `seq`; backoff reconnect capped at 10 s) ·
composer · stop button · queued-message chips · context meter · cost display.

**TUI-parity input** (`15-commands-and-input.md` §4): Enter / Alt+Enter / Esc / Alt+Up queue
semantics, prompt history, `Ctrl+G` editor modal, `Alt+*` toggles/pickers, `HotkeysDialog`.

## 7. Tests

- Unit: `event-map` over a recorded `AgentSessionEvent[]` fixture; `transcript` over a committed
  pi `.jsonl` fixture (tool call + result merged); `AuthFlow` state machine; secret hygiene.
- Integration: full chat round trip on the fake provider; SSE connect-mid-run, reconnect with
  `Last-Event-ID`, stale `since` → snapshot; `409` on concurrent prompt; abort restores queue;
  every credential route error code.
- Component: `Composer` key semantics, `useConversationStream` application + dedupe.
- Fixtures committed via `npm run fixtures:record` (human-reviewed, never regenerated in CI).

## 8. Acceptance

`14-credentials.md` §9 items 1–3, 6, 8, 10 · `07-chat-mode.md` §6 items 1, 5, 6.
(§9 items 4–5 and 9 need a multi-prompt provider or a remote host → unit tests with a stubbed
provider. Web search is M3; images may slip to M6.)
