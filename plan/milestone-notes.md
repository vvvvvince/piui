# Milestone notes

Running log of what was actually built, decisions taken, deviations from the spec, and the
mutation spot-checks required by `spec/20-development-method.md` §9.6. One section per
milestone; the next session should read this plus the milestone's plan file.

---

## S — Spikes (pi 0.85.1 verification)

Written up in `plan/spikes/01…07`. Headlines:

- **S1 green**: `ModelRuntime.registerProvider(id, { streamSimple, models, apiKey })` drives a
  real `AgentSession` offline. Two corrections: `createAssistantMessageEventStream` lives at
  `@earendil-works/pi-ai/utils/event-stream` (direct dependency added), and pi's auth preflight
  needs a literal `apiKey` on the fake provider.
- **S2 green**: `DefaultResourceLoader` overrides suppress ambient discovery; `noExtensions`,
  `noSkills`, `noPromptTemplates`, `noContextFiles` exist as extra belt-and-braces.
- **S3**: `tools: []` does *not* mean "no tools" — chat mode must pass `noTools: "all"`.
- **S4**: deltas are wrapped in `message_update.assistantMessageEvent`; there is no top-level
  `text_delta`. `agent_end` carries `willRetry`.
- **S5 hazard**: `SessionManager.create(cwd)` without a `sessionDir` writes to the real
  `~/.pi/agent/sessions`. Always pass `join(config.agentDir, "sessions")`.
- **S12**: `session.getSessionStats()` is the usage/cost/context accessor;
  `contextUsage.percent` is a fraction (0.03 = 3 %).

---

## M0 — Skeleton + test harness ✅

**Shipped**

- npm workspaces `shared`/`server`/`client`, TS strict + `noUncheckedIndexedAccess`, biome,
  vitest with three projects (`unit`, `integration`, `client`).
- `server/src/config.ts` — the only `process.env` reader; frozen config; refuses `0.0.0.0`
  without `PIUI_ALLOW_REMOTE`; downgrades the remote-bind warning to info under
  `PIUI_CONTAINER`; warns on missing session secret and on `test`/`test`.
- SQLite (WAL + foreign keys), migration runner, `001_init.sql` with the full schema and the
  seeded `local` admin; repository layer with the two scoping predicates.
- Fastify 5 boot, one log line per request, `09-api.md` §0 error envelope, `/api/health`,
  `/api/meta`, SPA static serving in production, graceful shutdown hooks.
- React 18 + Vite + router + TanStack Query + Tailwind shell with the six sections and a typed
  fetch wrapper that always sends `X-Requested-With: piui`.
- Harness: `withTempHome`, `withWorkspace`, `FakeClock`/`SeqIdGen`, principal minting, SSE
  collector, scripted fake provider (`server/src/pi/fake-model.ts`), temp-root guard,
  `spec-coverage` + `spec-exemptions`, three structural grep tests.
- `Dockerfile`, `docker-compose.yaml` (+ `.env.example`, `.dockerignore`, override example).

**Verified by hand (M0 acceptance)**

1. `npm run dev` → SPA at :5173 with `/api` proxied; screenshotted in a browser. ✅
2. `GET /api/health` → `ok`. ✅
3. DB file has all 12 tables, exactly one active admin. ✅ (tests)
4. `npm run build && node server/dist/index.js` serves the built SPA on :8787. ✅
5. `docker compose up -d` → container `healthy`, `/api/health` reports
   `container: true, insecureTransportOk: true`, SPA 200, `id` = uid 10001, no toolchain. ✅
6. `npm test` → 58 tests green, offline, no credentials, 1.4 s. ✅

**Deviations / decisions**

- *Temp-root guard*: monkeypatching `node:fs` is impossible under ESM (frozen namespace, direct
  named imports bypass a patched CJS object — verified). Implemented instead as (1) `HOME`
  redirected to a sandbox for the whole test process, (2) a before/after fingerprint of the real
  `~/.pi` and `~/.piui` in `globalSetup` teardown, (3) `assertInTempRoot()` in every helper that
  hands a path to production code. Same guarantee, different mechanism.
- `test/spec-exemptions.ts` has two lists: permanent `exemptions` (with a reason) and `pending`
  (criterion → milestone that will cover it). `COMPLETED_MILESTONES` drives the gate, and a test
  fails if a pending entry belongs to a completed milestone, so the list cannot rot.
- No TS project references / `composite`: they made `tsc` fail with TS6305 across the workspace
  boundary. `shared` is built first by `npm run build`; the test/vite configs alias
  `@piui/shared` to the source.
- Dockerfile declares `ARG HTTP_PROXY/HTTPS_PROXY/NO_PROXY` (needed on proxied networks) and the
  build stage installs **no** compiler: `better-sqlite3` resolves to a prebuilt binary.
- `disableRequestLogging: true` is deprecated in Fastify 5.7 but its `logController` replacement
  does not accept a subclass in the shipped typings; revisit at Fastify 6.

**Mutation spot-check (§9.6)** — flipped the read predicate in
`db/repositories/base.ts` (`visibleWhere`: `owner_id = ?` → `owner_id != ?`) and ran the suite:
`repositories.test.ts > [18-multi-user#9.4] hides another user's private rows behind 404, not 403`
and `repository scoping > keeps workspaces scoped the same way` failed by name (2 failed,
18 passed). Reverted. ✅

**Open for M1**

- `auth_sessions` is written only by the test helper so far; the real login/cookie/CSRF/step-up
  flow is M1, and the cookie format (`<sid>.<hmac>`) is already fixed by
  `server/test/support/principal.ts`.
- `/api/meta` exists but the workspace-root and search-provider behaviors behind it land in
  M3/M4.

---

## M1 — Authentication & authorization ✅

**Shipped**

- `server/src/http/auth.ts` — `AuthProvider` + `StaticAuthProvider` (constant-time compare over
  SHA-256 digests), session creation (`randomBytes(32).hex`, 30 d), `piui_sid` cookie
  `<sid>.<hmacSHA256(sid, PIUI_SESSION_SECRET)>` with `HttpOnly; SameSite=Lax; Path=/;
  Max-Age=2592000` (+ `Secure` over HTTPS or `PIUI_FORCE_SECURE_COOKIE=1`), sliding expiry after
  24 h, lazy deletion of expired rows, and a 1 h sweep interval wired in `index.ts`.
- One `onRequest` guard for the whole `/api/*` surface: CSRF → authentication → `requireAdmin`
  → `requireStepUp`. Public: `POST /api/auth/login`, `GET /api/health`.
- CSRF per `06-auth` §5: `X-Requested-With: piui` **or** a JSON content-type, plus an
  `Origin`/`Referer` host match when the header is present.
- Brute force: per-IP sliding window (10 failures / 5 min → `429` + `Retry-After`) shared by login
  and step-up, and a 250 ms delay on every failed verification.
- Routes `POST /api/auth/{login,logout,step-up}` and `GET /api/auth/me`
  (`{ user, stepUpValidUntil }`). A fresh login counts as a step-up.
- `server/src/http/authz.ts` — the `18-multi-user` §5 admin surface and the `14-credentials` §5
  step-up surface as (method, path) matchers.
- Client: `/login` page (with the default-credentials hint driven by `/api/health`), `AuthGate`
  (splash → redirect to `/login?next=…` on 401), `UserMenu` (display name, role, sign out),
  admin-only nav hidden from non-admins, and a fetch layer with the 401 interceptor and the
  `403 step_up_required` → `StepUpDialog` → **single** retry of the original request.

**Verified by hand (M1 acceptance)**

1. Browser (Firefox via MCP): `/workspaces` → `/login?next=%2Fworkspaces`, sign in with
   test/test → lands back on `/workspaces`, user menu shows `Local user` + role `admin`,
   "Sign out" → back to `/login`. ✅
2. `npm run build && node server/dist/index.js` → SPA + login + `me` all 200 on one port,
   unauthenticated `/api/meta` → 401. ✅
3. Suite: 96 tests green, offline, ~2 s. ✅

**Deviations / decisions**

- *Credentials come from `config`, not `process.env`*: `06-auth` §1 shows `StaticAuthProvider`
  reading `process.env` directly, which would break the "only `config.ts` reads env" invariant
  (`01-architecture` §3, grep-tested). The provider takes username/password as constructor
  arguments; `createContext` is the single wiring line.
- *Guards are path matchers, not per-route preHandlers*: the admin-only and step-up surfaces land
  across M2–M6, so matching on (method, path) in the global guard means a route added later is
  guarded the moment it exists — and it made both criteria testable in M1 against routes that do
  not exist yet (a guarded-but-missing route answers `403` for a non-admin, `404` for an admin).
  `requireAdmin` / `requireStepUp` are still exported for routes that need an explicit check.
- *`onRequest`, not `preHandler`*: the CSRF check must happen before Fastify parses the body,
  otherwise a `multipart/form-data` probe fails with `415` instead of `403 csrf_check_failed`.
- *`ctx.sleep` is injectable*: the 250 ms failed-login delay would otherwise cost the suite
  ~3 s; `withTempHome` records the requested delays in `sleeps` and a test asserts `[250]`.
- *Vite dev proxy `changeOrigin: false`*: found with the browser, not the suite. With
  `changeOrigin: true` the proxy rewrites `Host` to the target, so `Origin` (`localhost:5173`)
  never matched and every dev login returned `403 csrf_check_failed`. The server additionally
  accepts `req.host` (i.e. `X-Forwarded-Host` under `trustProxy`) for real reverse proxies.
- *401 vs. refused password*: the client's 401 interceptor ignores `invalid_credentials`, so a
  wrong password in the step-up dialog does not look like a lost session and log the user out.
- *Client tests render with `MemoryRouter` + `useRoutes`*, not `createMemoryRouter`: the data
  router builds a `Request` on navigation and jsdom's `AbortSignal` is rejected by undici.
- `/api/users/*` stays absent in V1 (`404` for admins, `403` for non-admins via the role guard),
  as `09-api` §7a requires.

**Mutation spot-check (§9.6)** — two mutants, both caught by name:

1. `verifySessionCookie` → `return sessionId` (HMAC never checked) ⇒
   `[06-auth#8.5] rejects a cookie whose HMAC has been tampered with` failed (1 failed, 44 passed).
2. removed `if (isAdminOnly(…)) requireAdmin(req)` ⇒
   `[18-multi-user#9.3] answers 403 to a role:"user" principal on every admin-only route` failed
   (1 failed, 44 passed). Both reverted. ✅

**Open for M2**

- The step-up matcher currently covers *every* `/api/providers/*` route except
  `GET /api/providers`; when the long-poll `GET /api/providers/auth-flows/:id` lands, decide
  whether it should stay gated (it is a read of a flow the step-up already authorized).
- `14-credentials#9.{1–6,8–10}` are parked in `pending` → M2; only §9.7 is due at M1.
- Rate-limit state is per-process in memory, as specified; credential-mutation limits
  (20/hour/session, `14-credentials` §5) are still to do with the credential routes.

---

## M2 — Credentials, pi bridge, streaming, chat mode ✅

**Shipped**

- *Spike S6* (`plan/spikes/06-credentials-and-auth-flow.md`) before the adapter: pi writes
  `auth.json` itself at `0600`, `getProviderAuthStatus()` is an async-refreshed **snapshot**
  (so the shared runtime is created with `refreshOnCreate: true, allowModelNetwork: false`),
  `logout()` on an env-sourced provider silently succeeds, no built-in provider in 0.85.1 is
  ambient-only or multi-prompt, and `refresh().errors` is a `Map`, not an object.
- `server/src/pi/runtime.ts` — the one process-wide `ModelRuntime` (`authPath: config.piAuthPath`),
  registering the scripted fake provider only under `PIUI_FAKE_MODEL=1`.
- `server/src/pi/credentials.ts` — `CredentialService` + the `AuthFlow` machine: prefill
  auto-answer for the first `secret` prompt (one request for the paste-a-key case), one pending
  prompt at a time, `promptId` match, 5 min idle TTL, 60 s terminal retention, 3 flows/provider
  and 10 overall, cancel → `cancelled`, `CredentialSynchronizationError` → success-with-warning,
  post-login `checkAuth` → `refresh` (15 s) → `getAvailable` → cache invalidation +
  `providers_changed` + `provider_login` audit line, and a message sanitizer
  (`/\b(sk|pat|ghp|xoxb|gsk|api)[-_]…/` → `***`, plus the answers we were handed).
- `server/src/pi/model-service.ts` + `GET /api/models` — 60 s cache, `credentialsRevision`
  bumped by every mutation, `?refresh=1` with a 15 s deadline and per-provider errors.
- Credential routes per `14-credentials` §3 with the write guard: `credential_writes_disabled`,
  `insecure_transport` (honouring `X-Forwarded-Proto` and `PIUI_INSECURE_TRANSPORT_OK`) and a
  20/hour/session mutation limiter.
- `server/src/pi/resources.ts` — the fixed chat system prompt (§2 of `07-chat-mode`) and a
  `DefaultResourceLoader` with every ambient source suppressed;
  `server/src/pi/agent-runner.ts` — `createSession({ config, sessionManager })` exactly as
  `01-architecture` §4.1, `noTools: "all"` for chat, `SessionManager` always given
  `config.sessionsDir`.
- `server/src/session/` — `transcript.ts` (pi messages → `UiMessage[]`, tool call + result
  merged, 16 KB output cap, `stopReason:"error"` → `role:"error"`), `event-map.ts`
  (`assistantMessageEvent` unwrapping, delta coalescing at 50 ms / 1 KB, immutable frames),
  `hub.ts` (`LiveSession` with a 2000-event / 8 MB ring, strictly increasing `seq`, 15 min idle
  eviction, one run per conversation + `PIUI_MAX_CONCURRENT_RUNS`), `bus.ts` (global channel).
- Conversation surface: create (chat only, profile/workspace refused), detail with the **real**
  composed `systemPromptPreview`, messages, patch (model change → `notice` + fresh session,
  `409` while streaming), delete (row + session file + scratch + uploads), prompt
  (`202`/`409 conversation_busy`, never awaits the run), abort (clear queue → abort → wait idle
  ≤ 5 s), queue clear, stats, auto-title from the first user message (one `completeSimple` call,
  `title_locked` once the user renames), scratch dirs `0700` + boot sweep.
- SSE: `GET /api/conversations/:id/events` (snapshot, `Last-Event-ID`/`?since=` replay,
  stale → snapshot, 20 s ping, `no-cache, no-transform`, `X-Accel-Buffering: no`, identical
  frames for multiple subscribers) and `GET /api/events` for `providers_changed` /
  `conversation_*`.
- Client: `/conversations` (list, empty-state CTAs, skeletons), `NewConversationDialog` +
  `ModelPicker` (grouped, unavailable greyed with a link to `/settings/providers`), `/c/:id`
  (transcript with `react-markdown` + `remark-gfm` + `rehype-sanitize`, thinking/tool cards,
  context meter, cost, reconnect banner, queue chips, notices), `useConversationStream` with the
  normative application rules, `Composer` with the full TUI-parity key table, `HotkeysDialog`,
  `/settings/providers` with `ProviderTable` + generic `CredentialDialog` (prompt loop,
  long-poll while `working`, events incl. `auth_url`/`device_code`) + in-app sign-out confirm.
- Fixtures: `npm run fixtures:record` writes `server/test/fixtures/{agent-events,messages}.json`
  + `session.jsonl` from the fake provider; committed and human-reviewed, never regenerated in CI.

**Verified by hand (M2 acceptance)**

1. Browser (Firefox via MCP), dev server on `PIUI_HOME=/tmp/piui-m2-home` + `PIUI_FAKE_MODEL=1`:
   login → `/conversations` empty state → **New chat** → model picker (the fake provider is the
   only available model, everything else greyed "no credentials") → chat streams tokens, header
   shows `ctx 3%` and the running cost, footer shows tokens/cost per message. ✅
2. `/settings/providers`: 41 providers listed *Not configured*, `authPath` rendered, OAuth
   buttons disabled with the provider's `loginLabel`. **Add key** on Anthropic → dialog → pasted
   a fixture key → `Configured (stored)`, `14 models (14 available)`, "Sign out" appeared, and
   the success state carried the honest warning `(anthropic: fetch failed)` because the host has
   no network. `auth.json` on disk: mode `0600`, `{"anthropic":{"type":"api_key",…}}`. ✅
3. Production build: `npm run build && NODE_ENV=production node server/dist/index.js` → SPA 200,
   login 200, chat created, prompt `202`, transcript + SSE snapshot over one port. ✅
4. Suite: 146 tests green, offline, ~11 s. ✅

**Deviations / decisions**

- *The long-poll `GET /api/providers/auth-flows/:flowId` stays step-up gated* (the open M1
  question). It is a read, but it is a read of a credential flow: the same session started that
  flow less than 5 minutes ago, so the step-up window (10 min) is always still open, and leaving
  the whole `/api/providers/*` prefix uniformly gated keeps one rule instead of an exception.
- *`removable` is "a stored credential exists"*, not literally `source === "stored"`: pi reports
  a stored-but-rejected key as `configured: true, source: "stored"` **and** a stored key whose
  `resolve()` fails as `configured: true` with 0 available models. Keying off
  `listCredentials()` is what makes "paste a bad key, then delete it" possible (§2.2 requires it).
- *`checkAuth()` is the success oracle after `login()`*, not `status.configured`: the snapshot
  calls a stored credential configured even when the provider refuses it, which would have made
  acceptance 9.3 report a lie.
- *`getPendingMessages()` does not exist* (spike S7 read it from the spec): pi 0.85.1 exposes
  `getSteeringMessages()` / `getFollowUpMessages()` / `pendingMessageCount`, and `waitForIdle()`
  is what the abort route awaits.
- *`event-map.ts` / `transcript.ts` use structural pi types*, not `import type` from pi: the
  `01-architecture` §2.1 grep forbids any `from "@earendil-works/…"` outside `server/src/pi/**`,
  and the projection layer is exactly where a future RPC backend would be cut.
- *Delta coalescing uses the real clock*, not `ctx.clock`: with a frozen `FakeClock` the 50 ms
  rule can never fire, so the flush cadence takes an injectable `now()` defaulting to
  `Date.now`, and the projection test drives it with a frozen stub to prove the size rule.
- *A message id is pinned to the pi message object* (`MessageIds`, a `WeakMap`), and
  `message_end` reuses the id handed out at `message_start`: pi passes a **different** object for
  the final message, which made every answer render twice. Found in the browser, then covered by
  an assertion in `chat.test.ts`.
- *`window.confirm` is banned in piui*: the sign-out confirmation used it, and a native modal
  froze the whole tab — including the browser-automation bridge. Replaced by an in-app dialog.
- *`UiMessage` gained `stopped?: true`* so an aborted partial answer can be marked "stopped"
  (`07-chat-mode` §6.6 asks for it but `02-data-model` §4 has no field for it).
- *`CredentialService.settleBudgetMs` is public*: pi serializes credential operations per
  provider, so a second concurrent flow genuinely sits in `working` until the first finishes; the
  concurrency test lowers the budget instead of waiting out 10 s twice.
- *Migration `002`* adds `conversations.title_locked` and `conversations.timezone`
  (decision Q8 + `07-chat-mode` §2's `{{TZ}}`).
- *`waitUntil` lives in `server/test/support/async.ts`*: a real `AgentSession` streams on real
  timers, and the suite-hygiene grep (rightly) forbids `setTimeout` sleeps inside test files.
- Scope honestly deferred: web tools/`Sources` footer (M3), image attachments (M6), `/` command
  menu and prompt templates (M5b), compaction endpoint, export, `Alt+T`/`Alt+O`/`Alt+M`/`Alt+P`
  global toggles and `Ctrl+G` editor modal (the `HotkeysDialog` lists them; M5b/M7).

**Mutation spot-check (§9.6)** — two mutants, both caught by name:

1. dropped `if (since > this.seq) return undefined` from `LiveSession.replay` (a cursor from a
   previous process would silently get nothing instead of a snapshot) ⇒
   `[01-architecture#4.4] stamps strictly increasing seq numbers and replays from the ring` and
   `[09-api#9.1] replays from Last-Event-ID and falls back to a snapshot when it is stale`
   failed (2 failed, 118 passed).
2. `removable: true` for every provider in `CredentialService.statusOf` ⇒
   `[14-credentials#9.1] lists every provider as not configured when there are no credentials`
   and `[14-credentials#9.5] refuses key entry and deletion for credentials piui does not own`
   failed (2 failed, 68 passed). Both reverted. ✅

**Open for M3**

- `resolveChatTools()` returns `[]` for both toggle states; M3 fills in `web_search`/`web_fetch`
  as `customTools` (the prompt block and the `webSearch` column already switch correctly).
- The sign-out confirmation dialog was rewritten *after* the browser session wedged on the old
  `window.confirm`, so it is covered by the integration test but not yet re-clicked by hand —
  do that first thing in M3 (it is two clicks).
- `GET /api/models` ships 1355 models in ~390 KB; the picker renders it, but first paint of the
  dialog is visibly slow. M3/M7 should paginate or filter server-side (`?available=1`).
- `POST /api/conversations/:id/compact`, `GET …/export`, uploads and the global sidebar badge
  wiring are still absent; `/api/events` exists and is used only for `providers_changed`.
- Auto-title consumes one turn of the fake provider's script, so tests that care about script
  ordering must either pass an explicit `title` or script the extra turn.

---

## M3 — Web search & tool runtime ✅

**Shipped**

- *Spike S10* (`plan/spikes/08-custom-tools.md`) first: `defineTool` shape, the `execute()`
  contract, and the fact that **`noTools: "all"` disables custom tools too** — pi computes
  `allowedToolNames = options.tools ?? (noTools === "all" ? [] : undefined)` and applies it to
  the merged built-in + custom set. Chat with web search on therefore passes
  `tools: ["web_search","web_fetch"]` *and* `customTools`; with it off it keeps `noTools: "all"`.
- `server/src/search/providers.ts` — `WebSearchProvider` with `brave` (key in the
  `X-Subscription-Token` header, `freshness` → `pd|pw|pm|py`), `tavily` (key in the POST body,
  never in a URL), `searxng` (`/search?format=json`, no key) and a `none` stub; count clamped to
  1–10 (default 5); LRU cache keyed `provider|query|count|freshness`, TTL 10 min, cap 200;
  provider errors are scrubbed of key-shaped fragments before they reach a model or a log.
- `server/src/net/ssrf.ts` — the shared guard: scheme allowlist, literal-address short circuit
  (no DNS lookup for `127.0.0.1`), DNS resolution with **every** answer checked (one private
  answer refuses the whole name, which is what makes rebinding useless), v4 + v6 + v4-mapped-v6
  ranges (loopback, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, CGNAT, `fc00::/7`,
  `fe80::/10`, multicast), `redirect: "manual"` with each hop re-checked and capped at 3, body
  cap streamed (never buffer a hostile gigabyte), content-type allowlist, hard timeout,
  `PIUI_ALLOW_PRIVATE_HTTP_TOOLS=1` as the documented escape hatch.
- `server/src/net/html-to-markdown.ts` — dependency-free HTML → Markdown for `web_fetch`.
- `server/src/pi/tools/web-search.ts` — `web_search` (numbered Markdown list + the
  "Use web_fetch on a URL to read the full page." line, `details` carrying the results, a
  progress update so the card says *searching…*, 10 searches per run then an error telling the
  model to synthesize) and `web_fetch` (15 s, browser-ish UA, ≤3 redirects, Markdown conversion,
  `…[truncated, N chars omitted]`, `details: { url, finalUrl, status, contentType, chars }`).
- `server/src/tools/registry.ts` + migration `003_tool_settings.sql` + `ToolSettingsRepository` —
  the catalog (`builtin_pi` × 8 with the spec's danger flags, `powershell` only on Windows;
  `builtin_piui` × 3 with `memory_append` marked implicit), `usedByProfiles` from `profile_tools`,
  global enable/disable, boot validation of the built-in names against the installed pi
  (`server/src/pi/builtin-tools.ts`), and `resolveChat()` — the one function that decides a chat
  conversation's tools.
- Routes `GET /api/tools`, `PATCH /api/tools/:name` (admin-only through the existing matcher),
  `POST /api/tools/web_search/test` (10/min/session, `503 provider_not_configured`).
- Chat wiring: `resolveChatTools({ webSearch, available })`, `customTools` per pi session with a
  per-run search budget reset on `agent_start`, the resolved set echoed back in
  `ConversationDetail.tools`, and `PATCH` notices that now distinguish
  *Web search enabled* / *Web search disabled*.
- Client: web-search-specific tool cards (query + result links; final URL, status, char count),
  the **Sources** footer (numbered favicon+domain chips built from the tool `details`, so it
  works even when the model forgets to cite), the composer globe toggle (disabled with a reason
  when no provider is configured or while streaming), the resolved-tool chip next to it, and a
  real `/tools` page: provider status, *Test search* with the top-3 results, and the global
  enable/disable toggles.

**Verified by hand (M3 acceptance + the two open M2 items)**

1. **The M2 sign-out dialog, re-clicked** (open item 1): `/settings/providers` → *Add key* on
   Anthropic → `Configured (stored)` → *Sign out* → in-app confirmation → *Sign out* →
   `auth.json` back to `{}` and the row back to *Not configured*. No native modal, no wedged
   tab. One nit seen and fixed: the row kept the old status for the duration of the background
   refetch, so the DELETE response now patches the cache directly. ✅
2. Browser, dev server with a **stub SearXNG on 127.0.0.1:9999** and `PIUI_FAKE_SCRIPT` driving
   the fake provider: `/tools` shows `searxng · key present yes`, *Test search* returns the
   three stub results. ✅
3. New chat with **web search on** → the model calls `web_search` → card with the query and the
   three result links, **Sources footer** with numbered chips, the answer citing the page
   (`07-chat-mode#6.3`); a second prompt drives `web_fetch` → card with final URL, `200`,
   `58 chars`. ✅
4. Globe toggle → `Web search disabled` divider **on the already-open SSE stream**, tools chip
   gone, history untouched (`05-skills-and-tools#B.5.2`). ✅
5. Suite: 220 tests green, offline, ~13 s; lint + strict typecheck clean; production build
   (`npm run build && NODE_ENV=production node server/dist/index.js`) serves the SPA, the tool
   catalog and a chat on one port. ✅

**Deviations / decisions**

- *No `@mozilla/readability` + `turndown`* (spec §B.3 suggests them): `web_fetch` output is read
  by a model, not rendered, and readability needs a DOM. piui ships a ~100-line converter
  (`net/html-to-markdown.ts`) that drops script/style/comments and keeps headings, lists, links
  and code. If extraction quality ever matters, swapping it is a one-module change.
- *`tool_settings` is a new table* (migration 003). `02-data-model.md` has no home for "built-in
  `bash` is globally disabled" — built-ins have no row anywhere — so the flag lives in a
  `(name, enabled)` table where **absence means enabled**; the table only ever holds deviations.
- *`provider_not_configured` now maps to 503*, not 400, because `09-api.md` §7 specifies
  `503 provider_not_configured` for the search test route and nothing else used the code.
- *Two layers refuse tools in chat mode.* `ToolRegistry.resolveChat` (policy: toggle, provider
  configured, globally disabled) and `resolveChatTools` (shape: never a built-in) both have to
  say yes. The mutation check below shows this is deliberate defense in depth: mutating either
  alone cannot arm a tool.
- **`ConversationChannel` (an M2 bug found by an M3 test).** SSE subscribers used to live on the
  `LiveSession`, which `PATCH /api/conversations/:id` disposes — so the `notice` went nowhere
  and an attached stream went deaf until the client reconnected, and `seq` restarted at 0. The
  ring, the sequence and the subscribers now live in a per-conversation channel owned by the hub
  that outlives session swaps; `hub.drop()` replaces the session, `hub.forget()` (used by delete)
  drops the channel too.
- *Tool `details` now reach the client* (`safeDetails`, 8 KB cap, dropped rather than truncated
  into invalid JSON) and `tool_execution_update` is projected, which is what makes the Sources
  footer and the live "searching…" card possible.
- *`PIUI_FAKE_SCRIPT`* (dev only, honoured only under `PIUI_FAKE_MODEL=1`): a JSON file of
  scripted turns, so a browser session can drive tool calls offline. Remember the auto-title
  consumes the first turn.
- *`GET /api/models` stays unfiltered* (open item 2). Server-side `?available=1` would contradict
  `07-chat-mode` §3, which wants unavailable models listed and greyed with "no credentials"; the
  visible cost was rendering ~1355 rows, so the picker now renders a bounded slice
  (`MODEL_RENDER_LIMIT = 60`, available first, "N more — refine your search") while searching the
  whole catalog. Paginating the endpoint itself is parked for M7.
- *Favicons in the Sources footer* come from `icons.duckduckgo.com` and hide themselves on error
  (offline hosts show no broken-image box). `11-security.md` §4's CSP already allows
  `img-src https:` for exactly this.

**Mutation spot-check (§9.6)** — three mutants, all caught by name:

1. removed the `169.254/16` arm of `isPrivateAddress` ⇒
   `[11-security#2] classifies loopback, private, link-local and unique-local addresses`,
   `[11-security#2] blocks a hostname that resolves to a private address` and
   `[11-security#2] re-checks every redirect hop…` failed (3 failed, 174 passed).
2. removed `if (!input.webSearch) return { toolNames: [], warnings: [] }` from
   `ToolRegistry.resolveChat` ⇒ `[05-skills-and-tools#B.4] chat mode resolves zero built-ins,
   whatever the toggle` failed (1 failed, 177 passed).
3. removed `if (!input.webSearch) return []` from `resolveChatTools` ⇒
   `[07-chat-mode#4.1] swaps the web-search block with the toggle and resolves zero tools`
   failed (1 failed, 177 passed). All reverted. ✅

**Open for M4**

- The dev browser tab wedged twice after long HMR sessions (every request pending while the
  server answered in 1 ms) — most likely the 6-connection HTTP/1.1 budget with SSE streams held
  open across hot reloads. A fresh tab always recovered. Worth a proper look in M7 (one shared
  `EventSource` per tab, or `/api/events` multiplexing) before anyone opens many chat tabs.
- `web_fetch`'s converter has no `<table>` support and ignores `<article>`-style main-content
  extraction; fine for M3, revisit if agent mode leans on it.
- `POST /api/tools/http*` (HTTP tools), the profile-facing half of the catalog
  (`05-skills-and-tools#B.5.{3,4,5,6}`) and the skills surface stay parked for M6;
  `19-deployment#9.10` (end-to-end against the bundled SearXNG image) moved to M7 — the compose
  wiring is asserted offline, running the image is not.
- `memory_append` is listed in the catalog but not implemented (M5); it is flagged
  `selectableInProfile: false`, so nothing can select it yet.

---

## M4 — Workspaces ✅

**Shipped**

- `server/src/workspaces/paths.ts` — the whole of `04-workspaces` §2 in one pure-ish module:
  `~` expansion, NUL/relative/empty refusal, `realpath` **before** every containment check,
  denylist (`/`, `/etc`, `/dev`, `/proc`, `/sys`, `/boot`, `/usr`, `/bin`, `/sbin`, `/lib*`,
  `/var/lib`, `$HOME` exactly, `$PIUI_HOME` + subtree, `~/.pi`, `~/.ssh`, `~/.gnupg`, `~/.aws`,
  `~/.config`, the install dir, plus the Windows equivalents) and `PIUI_WORKSPACE_ROOTS` with a
  separator-aware prefix test (`isInside`, exported and reused by the tree/browse guards).
- `server/src/workspaces/service.ts` — CRUD, `probe()` (exists/writable/isGitRepo/entryCount,
  capped at 500, recomputed on every read), `mkdir -p 0o755` + `git init`, one-level `tree`
  (hidden flagged, 1000-entry cap, `path_escape` on `..`/absolute/symlink escape), `file`
  (512 KB cap, NUL sniff → `415 binary_file`, language guess), `gitStatus` (one
  `status --porcelain=v1 --branch` + one `log -1`, `--no-optional-locks`, 5 s, `available:false`
  when git is absent or the folder is not a repo), `browse` (dirs only, denylist honoured, roots
  honoured including their ancestors so the picker can walk down to them) and `requireUsable`.
- Routes `server/src/http/routes/workspaces.ts` (`09-api` §5) incl. `POST /validate` registered
  before `/:id`, and `GET /api/fs/browse` — already admin-only via the `http/authz.ts` matcher.
- Repository additions: `workspaces.getById/findByName` + `path` in the update statement;
  `conversations.countInWorkspace` (the "2 active conversations" badge),
  `countStartedInWorkspace` (the `immutable_after_start` test) and `detachWorkspace`
  (delete → `workspace_id = NULL`, returns `affectedConversations`).
- `workspace_missing` re-mapped to **409** (`09-api` §5 wants a 409, `errors.ts` had 400) and a
  new `binary_file` → 415.
- Client: `/workspaces` (list with Missing / git / read-only / entry-count badges, active
  conversation warning, create dialog with live `validate` on blur, server-side directory
  picker, edit/relocate, in-app removal dialog quoting §6 verbatim) and `WorkspaceFiles`
  (breadcrumb tree, read-only preview, git badge, refetch on `conversation_done`).

**Verified by hand (04-workspaces §7, Firefox via MCP, dev server on `/tmp/piui-m4-roots`)**

1. `/etc` → *"/etc is a system or piui-owned folder."* in the dialog, nothing registered;
   `/tmp/piui-m4-roots/alpha` registered fine. ✅ (§7.1)
2. `/tmp/piui-m4-roots/escape` → symlink to `/tmp/piui-m4-outside` → *"This server only allows
   workspaces under: /tmp/piui-m4-roots."* ✅ (§7.2)
3. Picker walked `roots → alpha`, "use this folder" filled the form, create + `git init`
   produced `.git`; the card shows `git`, and the panel shows `master · 1 dirty`. ✅ (§7.3)
4. Wrote a file into the workspace by hand, then drove a real fake-model chat run: the `done`
   event on `/api/events` refetched the tree and `agent-wrote-this.md` appeared **without a
   reload**. ✅ (§7.4)
5. `mv alpha alpha-moved` → the card flipped to **Missing** with "new prompts are blocked until
   you relocate it. Nothing was deleted", Files hidden, Relocate → PATCH path → healthy again.
   The 409 itself is asserted server-side (agent mode is M5). ✅ (§7.5)
6. Remove → in-app dialog with the spec sentence → record gone, `ls` still shows `.git`,
   `README.md`, `agent-wrote-this.md`, `dirty.txt`, `src`. ✅ (§7.6)
7. Production build: `npm run build && NODE_ENV=production node server/dist/index.js` →
   login, validate, create, list, tree, file and the denylist all answer on one port; SPA 200.
8. Suite: 249 tests green, offline, ~14 s; lint + strict typecheck clean.

**Deviations / decisions**

- *Denylist is checked before permissions and before the roots.* `/etc` is unwritable for the
  server user, so a naive order answered `path_not_writable` where §7.1 demands
  `path_denylisted`; and with roots configured it would have answered `path_not_allowed`. The
  denylist also runs on the **normalized** path before `realpath`, so a non-existent
  `$PIUI_HOME/x` is refused as denylisted rather than "not found".
- *The Missing check is a domain guard, not a route precondition* (open item 2).
  `WorkspaceService.requireUsable(workspaceId)` throws `409 workspace_missing`; today it is
  called from `ConversationService.prompt` for any conversation carrying a `workspace_id`. M5's
  agent mode calls the same function in its session factory — the guard, not the route, is the
  seam, so every future entry point inherits it. Mutation-checked below.
- *`workspace_missing` is 409, not 400.* `09-api` §5 and `04-workspaces` §3 both say 409; the
  code table in `errors.ts` (written in M0 from §0's list) had it at 400.
- *`depth` is accepted and ignored* on `GET /:id/tree`: §3 pins V1 to `depth=1` (direct
  children only). The parameter stays in the contract so M5's side panel can deepen it without
  a client change.
- *`activeConversations` counts non-archived conversations of the calling principal*, not live
  runs: transcripts are private per user (`18-multi-user` §4), so a count that crossed owners
  would leak. The UI wording ("active conversations … they can interfere") matches §4.
- *Tests for §7.4 run offline in two halves* (open item 3): the server test proves the tree is
  read from disk on every request (no cache to invalidate), and the client test drives a fake
  `EventSource` with a `conversation_done` frame and asserts the new entry appears. The browser
  check above closes the loop with a real run, without an agent.
- *The wedged-tab item stays M7* (open item 1). M4 adds at most one more `EventSource` per tab
  (the Files panel is single-open by construction, and it unsubscribes when closed), so it does
  not move the needle on the 6-connection HTTP/1.1 budget; the fix worth doing is the one
  already parked — one shared `EventSource` per tab multiplexing `/api/events`. No wedge was
  observed during this milestone's browser session.
- *`19-deployment#9.5` re-parked to M7* with the reason in `test/spec-exemptions.ts`: M4 covers
  its `PIUI_WORKSPACE_ROOTS` half offline; the "agent-written file appears on the host as uid
  10001" half needs agent mode (M5) **and** a running container.
- `trusted` is stored and returned but no UI toggles it: the trust dialog is `15-commands` §3.3,
  i.e. M5b. `GET /:id/project-resources` is deliberately absent until then.

**Mutation spot-check (§9.6)** — three mutants, all caught by name:

1. `isInside` → plain `startsWith` (no separator boundary) ⇒
   `[04-workspaces#7.2] refuses a path outside PIUI_WORKSPACE_ROOTS, and a symlink that escapes
   them` failed (1 failed, 200 passed).
2. removed the `requireUsable` call from `ConversationService.prompt` ⇒
   `[04-workspaces#7.5] marks a renamed folder Missing and blocks new prompts with 409` failed
   (1 failed, 99 passed).
3. `delete()` returning a hard-coded `affectedConversations: 0` (conversations never detached) ⇒
   `[04-workspaces#7.6] deletes the record, detaches conversations and leaves every file on
   disk` failed (1 failed, 13 passed). All reverted. ✅

**Open for M5**

- Agent mode must call `WorkspaceService.requireUsable` when it builds the session (cwd) as
  well as on prompt, and pass `workspace.path` to `SessionManager.create` (spec §4).
- `POST /api/conversations` still refuses `workspaceId` outright (chat-only, `07-chat-mode` §1);
  M5 replaces that branch with profile/workspace resolution and the
  `immutable_after_start` rule for `PATCH /api/conversations/:id`.
- The file browser is one level deep and has no watch: M5's side panel may want `depth>1` and a
  refetch on `tool_execution_end` for write/edit tools, not just on `done`.
- `GET /api/workspaces/:id/project-resources` + the trust dialog are M5b.
- `git` shells out synchronously (`execFileSync`, 5 s): fine for a button and a run end, but if
  M5 refreshes it per tool call it should move off the event loop.

---

## M5 — Profiles, memory Phase 0, agent mode ✅

**Shipped**

- *Spike S9* (`plan/spikes/09-builtin-tools.md`) before any tool card: pi's built-in tool names,
  parameter shapes and `tool_execution_*` payloads run for real against the fake provider. Four
  facts drove the code: `edit` returns `details.{diff,patch,firstChangedLine}`; `bash` streams a
  **cumulative** `partialResult` and has **no exit-code field** (only `isError` + a trailing
  "Command exited with code N"); `grep`/`find` shell out to `rg`/`fd` under the *real*
  `~/.pi/agent/bin` (so the suite never asserts a successful one); and agent mode must **not**
  pass `systemPromptOverride` — pi's default prompt carries the tool list and the
  `<available_skills>` block, AGENTS.md and memory ride in as `agentsFiles`.
- `server/src/skills/catalog.ts` + `SkillRepository` — the M5 read path: scan
  `$PIUI_HOME/skills/*/SKILL.md`, tolerant frontmatter parse, mirror into `skills`, a vanished
  directory is `enabled = 0, missing: true` (never deleted, so profile references survive),
  `GET /api/skills` with `usedByProfiles`, and `resolve(skillIds)` → pi `Skill` objects with a
  **warning** (not a 500) for anything missing.
- `server/src/profiles/service.ts` — CRUD with file side effects (`AGENTS.md` written on save,
  the **file wins** on an external edit because it is the only store — the schema has no column),
  delete moves the directory to `$PIUI_HOME/trash/<id>-<ts>/`, duplicate, the seven validation
  rules of §7 (incl. the new `agents_md_too_large` code), the three seed profiles on first boot,
  and `resolve(profileId)` → `ResolvedProfile { agentsFiles, skills, builtin/custom tool names,
  memory, warnings }` — the one input to agent session construction.
- `server/src/profiles/memory.ts` — the normative file format: `memorySkeleton`, `parseMemory`
  (tolerant: continuation lines join their note, non-conforming bullets and stray paragraphs are
  preserved as `section.other`), `noteId` = `sha256(normalized)[0..12]`, `buildMemoryBlock`
  (whole file, or the last 32 KB cut on a paragraph boundary with `…(earlier notes omitted)…`),
  `appendToFile` and `MemoryStore` with the per-profile async mutex.
- `server/src/pi/tools/memory.ts` — `memory_append`: dated line format, case-insensitive dedupe
  ("already remembered"), 2000-char note cap, 1 MB file cap, and a `notice` in the transcript on
  every successful append. `selectableInProfile: false` stays — it follows `memory.enabled`.
- `ToolRegistry.resolveTools({ mode, webSearch, profile })` — the correctness centre. Chat mode
  returns `builtinToolNames: []` whatever the profile says; agent mode splits the profile's
  selection into pi built-ins vs. piui custom tools, drops unknown/globally-disabled/unconfigured
  names with a warning, and appends `memory_append` iff memory is on.
- Agent conversations: `POST /api/conversations { mode: "agent" }` requires `profileId` +
  `workspaceId`, calls `WorkspaceService.requireUsable` (the M4 seam) **and** builds the pi
  session eagerly so `systemPromptPreview` is the real composed prompt; `cwd` = workspace path;
  `thinkingLevel` = request > profile default > `off`; resolution warnings are returned.
  `PATCH` refuses a profile/workspace move with `409 immutable_after_start`.
- Runaway guards in `LiveSession` (§6, **no** approval gates): a wall-clock timer
  (`PIUI_MAX_RUN_MINUTES`, default 30) and a per-run tool-call cap (`PIUI_MAX_TOOL_CALLS`,
  default 200). Either one emits a `notice` ("Stopped after … Send another message to continue.")
  and aborts. A grep test asserts the repository contains no Approve/Deny/denylist machinery.
- Client: `/profiles` (list, editor with Instructions/Tools/Skills/Memory tabs, danger badges,
  implicit `memory_append` row, warning banners, in-app delete dialog quoting the conversation
  count, duplicate) and the Memory panel ("injecting X of Y", "memory truncated", the
  pinned-notes-not-yet-special sentence, edit/download/clear).
- Client: agent transcript renderers (`edit` → coloured diff from `details.patch`/`diff`, `bash`
  → command + copy + streaming terminal block, `write` → byte count + content, `read` → line
  range, `grep`/`find`/`ls` → compact list, `memory_append` → one line), the
  Files·Tools·Profile·Memory·Usage side panel, and the agent tab in the new-conversation dialog.

**Verified by hand (Firefox via MCP, dev server on `/tmp/piui-m5-home` + `/tmp/piui-m5-roots`)**

1. `/profiles` shows the three seeds; created "Browser demo", edited AGENTS.md, ticked tools,
   turned memory on. Resolution warnings render as banners
   (*Tool "web_search" is not configured on this server and was dropped.*). ✅
2. New conversation → **agent** tab → profile + workspace pickers → agent view with the header
   chips (`piui-fake/fake-1 · Browser demo · alpha`), the side panel and the resolved tool list
   under the composer. ✅
3. One prompt drove `write` → `bash` → `edit` → `memory_append`: the write card showed
   "36 B written", the bash card streamed and ended "exited 0", and **`edit` failed with
   "Tool edit not found"** because the profile does not grant it — `03-profiles#8.1` visible in
   the browser. `hello.js` appeared in the **Files** tab with the touched dot *during* the run,
   not at `done`. `memory.md` on disk had exactly one dated line under `## Notes`. ✅
4. Steering while streaming, a **reload mid-run** (snapshot rebuilt the transcript, no duplicate
   bubbles, still streaming), and **abort-with-restore** (Stop → the queued follow-up came back
   into the composer). ✅
5. Suite: 302 tests green, offline, ~8 s; lint + strict typecheck clean; production build serves
   profile CRUD, agent creation and a streamed run on one port.

**Deviations / decisions**

- *No `systemPromptOverride` in agent mode* (spike S9b). `03-profiles` §2 requires pi's default
  prompt to survive; the chat-mode override stays. `createResourceLoader`'s `systemPrompt` is now
  optional, which is the whole difference between the two modes at the pi boundary.
- *`profile_not_found` is 404, not 400.* `08-agent-mode` §1 spells it out; `errors.ts` (written in
  M0 from §0's unordered code list) had it at 400.
- *A user-initiated stop is not an error.* pi ends the turn after `abort()` with
  `stopReason: "error"`, `errorMessage: "This operation was aborted"`, which painted a red error
  bubble. `isAbortedMessage`/`roleOfAssistant` in `transcript.ts` now classify it once, and both
  projection paths plus `lastRunReason` route through them — root cause, not per-caller patch.
- *Agent mode builds its session eagerly at creation* (and `GET /api/conversations/:id` ensures
  one, swallowing failures). That is what makes `systemPromptPreview` "the real composed prompt,
  not a guess" (`09-api` §8) and it also means `session_path` exists immediately, so
  `immutable_after_start` has a crisp meaning. A conversation whose workspace vanished still
  loads (the prompt route is where it 409s) — `08-agent-mode#8.7`.
- *AGENTS.md is edited in a `<textarea>` with a counter and the 16 KB warning*, not CodeMirror.
  Adding an editor dependency for one field is exactly the bloat the spec's UI section invites;
  M6 needs a real file editor for skills and can bring CodeMirror in once, for both.
- *`memory.md` is the only store for memory and `AGENTS.md` the only store for instructions* —
  no DB mirror, so "the file wins on an external edit" is true by construction rather than by a
  sync rule.
- *Open item 1 — Files panel refresh*: the agent Files tab keys its tree query on the number of
  **completed `write`/`edit` tool blocks** as well as on `doneCount`, so a file appears mid-run
  (seen in the browser) and again after `done`; touched paths get a dot. `tree` stays one level
  deep: the panel navigates by clicking, a recursive walk on every write would be the expensive
  option, and `?depth` remains accepted-and-ignored for M6. Offline story: the server test proves
  the tree is read from disk per request; the client test rerenders with an extra completed
  `write` block and asserts a new `/tree` request.
- *Open item 2 — immutability lives in `ConversationService.patch`*, not the route, mirroring M4's
  `requireUsable` decision; the route schema merely accepts `profileId`/`workspaceId` so the 409
  is reachable. Mutation-checked below.
- *Open item 3 — `git status` stays synchronous.* Agent runs never call it: the agent Files tab
  does not render the git badge, and the workspaces page still refreshes it only on
  `conversation_done`. Re-parked; if M6 puts a git panel next to a running agent, it moves off
  the event loop then.
- *Open item 4 — concrete caps*: wall clock `PIUI_MAX_RUN_MINUTES` (30) and tool calls
  `PIUI_MAX_TOOL_CALLS` (200) per run, both surfaced as a `notice` naming the env var and
  telling the user to send another message. **Output bytes get no new cap**: tool output is
  already truncated at 16 KB per call before it reaches the model or the ring, and the ring is
  capped at 8 MB / 2000 events — a third counter would duplicate those with no new guarantee.
- *`memory_append` errors are thrown, not returned* — pi 0.85.1's `AgentToolResult` has no
  `isError` field; pi converts a thrown error into the error result (spike S9).
- Scope honestly deferred: `includeDiscoveredSkills` / `disabledExtensionIds` /
  `allowDynamicExtensionTools` are stored but not resolved (M5b/M5c), the profile editor has no
  template-insert menu or model defaults picker, and skills CRUD/import/test-run stays M6.

**Mutation spot-check (§9.6)** — three mutants, all caught by name:

1. `resolveTools`'s `if (input.mode === "chat")` → `if (false)` (chat falls through to the
   profile's selection) ⇒ `[05-skills-and-tools#B.4] chat mode yields zero filesystem tools,
   whatever the profile says` failed (1 failed, 5 passed).
2. removed the `session_path || live` condition from the immutability guard ⇒
   `agent mode > requires a profile and a workspace, and freezes both once the session exists`
   failed (1 failed, 11 passed).
3. dropped the duplicate short-circuit in `appendToFile` ⇒
   `memory_append > deduplicates case-insensitively without writing again` failed
   (1 failed, 3 passed). All reverted. ✅

**Open for M5b**

- `GET /api/conversations/:id/commands`, prompt templates, `/` menu and the workspace trust
  dialog are the next milestone; `enableSkillCommands` is already `true` in the settings manager,
  so `/skill:<name>` will work the moment the command surface exists.
- The profile editor writes one field per request (`PATCH` per checkbox). Fine for a handful of
  tools; if the editor grows a form-wide Save, batch it then.
- `Researcher` (a seed profile) selects `web_search`/`web_fetch`, so on a server without a search
  provider every agent conversation with it starts with two dropped-tool warnings. Correct, but
  M6's tools UI should let the user see that from the profile list.
- The `UserMenu` popover does not close on an outside click and can overlap the profile-editor
  action buttons (seen in the browser, pre-existing since M1). One-line fix whenever M6 touches
  the shell.

---

## M5b — Slash commands, prompt templates, discovery, workspace trust ✅

**Shipped**

- *Spike S10* (`plan/spikes/10-prompt-templates-and-skill-commands.md`) before the command
  surface. Four facts drove the design: `promptsOverride` only needs pi's `PromptTemplate`
  shape; `expandPromptTemplate` takes the **first** name match, so the composed array must be
  ordered highest-precedence-first; `prompt()`/`steer()`/`followUp()` expand by default, so piui
  passes the typed text through untouched; and `enableSkillCommands` does **not** gate
  `_expandSkillCommand` — it only drives pi's TUI autocomplete.
- `server/src/pi/prompts.ts` — discovery + composition of `$PIUI_HOME/prompts` <
  `~/.pi/agent/prompts` < trusted `<workspace>/.pi/prompts`: non-recursive `*.md`, frontmatter
  `description` / `argument-hint`, pi's first-line fallback truncated at 60 chars, shadowing
  recorded per template. Pure and unit-tested; it contains **no** substitution grammar.
- `server/src/commands/service.ts` — the eleven built-ins that have a target in this build,
  `/skill:<name>` from the conversation's resolved profile, templates with their `location`
  badge, `GET /api/prompts`, `POST /api/prompts/rescan` (admin-only through the existing
  `*/rescan` matcher) and `GET /api/workspaces/:id/project-resources`.
- `GET /api/conversations/:id/commands`, and the composed set handed to pi through
  `createResourceLoader({ prompts })` — the M5 `promptsOverride: () => ({ prompts: [] })` now
  delivers the real set.
- Skill discovery (`skills/catalog.ts`): `~/.pi/agent/skills`, `~/.agents/skills` and, for
  trusted workspaces, `<ws>/.pi/skills` + `<ws>/.agents/skills` are registered as
  `source: "external"` with a `location` badge, never auto-enabled. `profiles.resolve()` honours
  `includeDiscoveredSkills` and reports `discoveredSkillCount`.
- `commandEcho`: `SessionHub.prompt` records the typed `/…` text, `LiveSession` pairs it with the
  user message **pi produced** and decorates both the live events and the snapshot. The client
  renders the typed command with a `show expanded (N chars)` disclosure.
- Client: `SlashMenu` inside the composer (filter, `Tab`/`Enter` complete, `Esc` closes before
  `Esc` aborts, `argument-hint` + `location` rendering), the routing table
  (`client`/`server`/`expand` + `availableWhileStreaming`), the inline refusal of an unknown
  `/word`, `Alt+T`/`Alt+O` collapse-all toggles (with buttons next to them), the workspace trust
  dialog (in-app, never `window.confirm`) + the "project resources available — review" badge,
  the profile editor's *Include all discovered skills* checkbox with a live count and token
  estimate, and a real `/settings` page listing the prompt sources with counts and *Rescan*.

**Verified by hand (Firefox via MCP, dev server on `/tmp/piui-m5b-home` + `/tmp/piui-m5b-roots`)**

1. Registering `/tmp/piui-m5b-roots/demo` raised the trust dialog listing exactly what was found
   (`component`, `proj-helper`); *Decide later* left the card showing
   *project resources available — review*. ✅ (§6.8, first half)
2. `/` in the agent conversation listed the built-ins, `/skill:pdf-tools` (via *Include all
   discovered skills*, count "1 discovered skill … ~17 tokens") and the templates with `user` /
   `piui` badges and argument hints — **no** `component`, because the workspace was untrusted. ✅
   (§§6.1, 6.9)
3. `/review https://example.com/pr/1` → the transcript shows the typed command; *show expanded
   (61 chars)* reveals `Review https://example.com/pr/1 carefully and list the risks.` ✅ (§6.2)
4. `/skill:pdf-tools extract` → `show expanded (253 chars)` with the `<skill …>` block and the
   argument. ✅ (§6.4)
5. `/compcat` → *Unknown command `/compcat`…* inline, text still in the composer, nothing sent. ✅
   (§6.5)
6. Trusting the workspace from the card made `/component <Name> <behaviour> … project` appear in
   the **same** conversation, and `/component Button "click handler"` expanded to
   `Create component Button that handles Button click handler.` ✅ (§§6.3, 6.8)
7. `/hotkeys` (a `client` command) opened the dialog listing Alt+T/Ctrl+T and Alt+O/Ctrl+O;
   `Alt+T` flipped the transcript toggle. ✅ (§6.7)
8. A chat conversation showed built-ins + `user`/`piui` templates and **no** skill commands and
   no project templates; `/piui-note buy milk` expanded. ✅ (§6.10)
9. `/settings` listed both source paths with counts; dropping `standup.md` into the user folder
   and pressing **Rescan** reported `1 added · 0 updated · 0 removed`, and `/standup shipped M5b`
   expanded in an **already-open** chat session. ✅
10. Production build (`npm run build && NODE_ENV=production node server/dist/index.js`, port
    8799): SPA, `/api/prompts`, `project-resources`, `GET …/commands` on an agent conversation and
    an expanded `/component` run all answer on one port. ✅
11. Suite: 330 tests green, offline, ~7 s; lint + strict typecheck clean.

**Deviations / decisions**

- *Open item 1 — the composed template set is **not** cached.* The spec suggests caching it on
  the `LiveSession`; composing it is three `readdirSync` calls, and the invalidation rules (a
  session outlives a profile edit, a `ConversationChannel` outlives the session) were the entire
  cost. `GET …/commands` composes per request. The one place the set really is held is pi's
  `ResourceLoader` inside the session, so the two events that change it drop sessions instead:
  a trust flip drops every session in that workspace (`WorkspaceService.onTrustChanged` →
  `hub.drop`), and `POST /api/prompts/rescan` calls `hub.dropAll()`. Both also emit
  `skills_changed` on the global channel. Mutation-checked below; §6.8's test asserts a *run*
  after trusting, not just the route.
- *Open item 2 — the "user" source is `config.userAgentDir`* (`PIUI_USER_AGENT_DIR`, default
  `~/.pi/agent`), and `createTempHome` points it at `<temp home>/user-pi/agent` for **every**
  test, so no test can touch the real `~/.pi`. `~/.agents/skills` is derived from it
  (`dirname(dirname(userAgentDir))/.agents/skills`) rather than from `homedir()`, so it is
  redirected by the same switch. Discovery runs **on every read of the catalog** (`scan()`
  already did), not on boot or rescan only: the filesystem stays the source of truth and there
  is no ordering to get wrong.
- *Open item 3 — trust is asked at registration*, exactly as acceptance 6.8 says: the create
  mutation probes `project-resources` and raises the dialog when `hasPiDir`. *Decide later*
  leaves `trust_decided_at` null and the card carries the review affordance, so the question is
  never lost. An untrusted workspace contributes nothing (unit-tested in
  `prompt-templates.test.ts` and end-to-end in `commands.test.ts`).
- *Open item 4 — the profile editor stays one PATCH per toggle.* `includeDiscoveredSkills` is
  one more checkbox on the same path; a batched save would be a new form-state machine for zero
  user-visible gain. Revisit when the editor grows fields that must change together.
- *Built-ins are only listed when their target exists.* `/compact`, `/export`, `/tree` and
  `/fork` have no endpoint in this build (M6/M7 + the `[LATER]` fork block), and a menu entry
  that 404s is worse than its absence. `/model` and `/thinking` currently answer with a notice
  pointing at the picker; the in-conversation pickers are M7's job.
- *`commandEcho` is live-session state.* pi's session file stores only the **expanded** text, so
  the typed command is remembered per `LiveSession` (`Map<expandedText, echo>`) and decorates
  both the SSE frames and the snapshot. After an eviction and revival the bubble shows the
  expanded text — honest, since that is all pi kept. Recording it in the session file would mean
  writing piui metadata into pi's format.
- *`skills_changed` is the one "command surface changed" signal.* Rather than adding a
  `prompts_changed` event, the existing (previously unused) `GlobalEvent` carries both; the
  client's commands query is also refetched on focus, which is what makes a trust decision taken
  on another page show up in an open conversation.
- *Discovered skill rows key on their absolute path* (`dir_name = <abs dir>`, `ext_path` set),
  because two roots may hold the same directory name; `SkillSummary.dirName` is the basename.
  `markMissing` now covers external rows too, so a workspace that loses its trust disables its
  project skills instead of leaving them enabled.
- **Browser-only bug (the M5b one): a background tab froze the transcript.**
  `useConversationStream` batched frames with `requestAnimationFrame`, which a hidden or
  background tab never fires — the SSE connection stayed "connected" while the batch piled up
  unapplied, so a run looked like it never happened until the tab regained focus. Found while
  driving Firefox headless; fixed with a 250 ms `setTimeout` fallback next to the rAF, and
  covered by `[10-frontend#3.1] applies frames in a background tab…`. Pre-existing since M2.
- *`window.confirm` stays banned*: the trust dialog is an in-app dialog, like the delete dialogs.

**Mutation spot-check (§9.6)** — three mutants, all caught by name:

1. reversed the precedence order in `composePromptTemplates` (piui first) ⇒
   `[15-commands-and-input#6.1] orders project over user over piui, and records the shadowing`
   and `[15-commands-and-input#6.1] GET /api/prompts lists the global sources with counts`
   failed (2 failed, 255 passed).
2. dropped the `trusted === 1` condition in `CommandService.prompts` (project templates always
   loaded) ⇒ `[15-commands-and-input#6.8] hides project templates until the workspace is
   trusted, without a restart` failed (1 failed, 135 passed).
3. made `LiveSession.withEcho` return the message unchanged ⇒
   `[15-commands-and-input#6.3] lets pi substitute $1 and $@, and echoes the typed command` and
   `[15-commands-and-input#6.2] expands a ~/.pi/agent/prompts template exactly as the terminal
   does` failed (2 failed, 134 passed). All reverted. ✅

**Open for M5c**

- Extension commands (`source: "extension"`) are absent from the `/` menu by construction: the
  command service has no extension input yet. M5c adds them next to the skill section, and the
  same `kind` routing already covers them.
- `/compact`, `/export`, `/fork`, `/tree` and the in-conversation `ModelPicker`/`ThinkingPicker`
  are the remaining built-ins; they land with their endpoints (M6/M7). `Alt+M`/`Alt+P`/`Alt+C`
  and `Ctrl+G` are still listed in `HotkeysDialog` without an implementation.
- `POST /api/prompts/rescan` drops **every** live session, which is correct but blunt; if a
  deployment ever runs many concurrent conversations, drop only the sessions whose composed set
  actually changed.
- `[LATER]` piui-managed template CRUD (`$PIUI_HOME/prompts` is read-only in the UI) and
  `@file` completion, both explicitly out of V1 scope in `15-commands-and-input.md` §§4.2, 5.
- The `/settings` page is now a real page with one panel; M7 owns the rest of it
  (`steeringMode`/`followUpMode`, About, audit).

---

## M5c — Extensions ✅

**Shipped**

- *Spike S9* (`plan/spikes/11-extensions-and-ui-bridge.md`) before any code. Five facts drove the
  design: a loader `reload()` **never throws** — a broken extension lands in
  `LoadExtensionsResult.errors` with a per-path message, so enumeration needs no session and no
  model; a **directory** path is not expanded by pi (`Extension path does not exist`), so piui
  expands `*.ts` itself; `registerCommand(name, options)` takes the name as the first argument;
  an unresolved `ctx.ui.confirm()` **blocks the run** until the host answers; and a tool
  registered in `session_start` is admitted only if the construction allowlist already names it —
  `setActiveToolsByName` cannot re-add it.
- `server/src/pi/extensions.ts` — the pi boundary: `probeExtensions({ paths, cwd, agentDir })`
  (loader-only, returns `{ loaded: [{ path, tools, commands }], errors }`) and `bindExtensionUi`,
  the complete `ExtensionUIContext` for `mode: "rpc"` (dialogs + `notify`/`setStatus`/`setWidget`
  live, TUI-only members degraded per pi's RPC table), returning the tool names observed after
  `session_start`.
- `server/src/extensions/resolve.ts` — the pure resolution of §3 (global enabled set − profile
  opt-outs − load-failed, managed before external then alphabetical, built-in collisions dropped
  with a warning naming both sides). Unit-tested on its own.
- `server/src/extensions/service.ts` + `ExtensionRepository` — `sync()` registers
  `$PIUI_HOME/extensions/*.ts` (managed) and `<userAgentDir>/extensions/*.ts` (external, spec
  §2.2) and re-probes on every read; install by paste (name rules, 1 MB cap, probe-before-write),
  `POST /fetch` (https + the M3 SSRF guard, returns source + sha256, installs nothing), register
  an external path, `PATCH` (enable toggle / source edit with a re-probe), `DELETE` (managed →
  `$PIUI_HOME/trash/extensions/`, external → forget only) and `rescan`.
- Routes `GET/POST/PATCH/DELETE /api/extensions`, `/fetch`, `/rescan` — admin-only through the
  existing prefix matcher, **step-up on every mutation** (`requiresStepUp` extended), an audit
  line per mutation (`extension_install` carries origin + sha256) and
  `PIUI_DISABLE_EXTENSION_INSTALL=1` → `403 extension_install_disabled` on all of them while
  reads and per-profile switches keep working.
- `ToolKind: "extension"` in the catalog (kind, `selectableInProfile: false`, collisions dropped)
  and in `resolveTools`, which now takes `extensionToolNames`; `ResolvedProfile` gained
  `extensionPaths` / `extensionToolNames` / `allowDynamicExtensionTools`, and
  `createResourceLoader` finally passes a non-empty `additionalExtensionPaths`.
- The UI bridge: `ConversationChannel` owns the pending-request registry (`ask` / `resolveUi` /
  `cancelPendingUi`), `snapshot` carries `pendingUiRequests`, and
  `POST /api/conversations/:id/ui-response` resolves from any tab, emitting `ui_request_resolved`
  to close the other tabs' modals. `notify` → `notice`, `setStatus` → header badge,
  `setWidget` → a block above the composer.
- Extension commands in the `/` menu (`source: "extension"`, `availableWhileStreaming: true`) —
  pi dispatches them inside `prompt()`, piui only sends the text.
- Client: `/extensions` (list with source badge, health, tool/command chips, "disabled in N
  profiles", global toggle, in-app uninstall dialog naming what disappears, paste install,
  fetch-then-review with the mandatory checkbox, Rescan, broken-extension banner, kill-switch
  notice), the profile editor's **Extensions** tab (per-profile switches + "Allow tools
  registered by extensions at runtime"), and `ExtensionDialog` + status/widget rendering in the
  conversation.

**Verified by hand (Firefox via MCP, dev server on `/tmp/piui-m5c-home` + `/tmp/piui-m5c-roots`)**

1. `/extensions` listed the two planted ambient files: `ambient` (external, ✓ healthy, tools
   `ask_deploy`, command `/ambient-hello`) and `brokenone` with its `ParseError` and the
   "1 enabled extension failed to load" banner. ✅ (§§10.2, 10.3)
2. Paste install (`pasted`) landed in `$PIUI_HOME/extensions/pasted.ts` with its command listed;
   URL install from a local https stub showed the full source read-only, kept **Install disabled**
   until the review box was ticked, and then installed `remote` with `remote_tool`. ✅ (§§10.1, 10.9)
3. Profile editor → **Extensions** tab → unticked `ambient` for the `NoExt` profile. The new
   conversation on `WithExt` resolved `ls, read, remote_tool, ask_deploy` and offered
   `/ambient-hello`; the one on `NoExt` resolved `ls, read, remote_tool` and had no such command.
   Both carried the `brokenone` load warning. ✅ (§§10.4, 10.5, 10.7-adjacent)
4. A run calling `ask_deploy` raised the modal ("Deploy? / Deploy to prod?") with the
   `asking…` status badge; **reloading the page re-rendered it from the snapshot**, a second tab
   showed the same dialog, answering in the second tab closed the first tab's modal, the tool
   returned `confirmed=true`, and the widget (`target: prod / confirmed: true`) plus the
   `deploy answered: true` notice appeared. ✅ (§10.6)
5. `PIUI_DISABLE_EXTENSION_INSTALL=1`: the page showed the notice and disabled every control, and
   POST/PATCH/DELETE/fetch/rescan all answered `403 extension_install_disabled`. ✅ (§10.9)
6. Production build (`npm run build && NODE_ENV=production node server/dist/index.js`, port 8799):
   `GET /api/extensions` (incl. the broken one), a paste install, an agent conversation resolving
   `ask_deploy`, a `ui_request` over SSE and the `ui-response` round trip all answer on one port. ✅
7. Suite: 357 tests green, offline, ~25 s; lint + strict typecheck clean.

**Deviations / decisions**

- *Open item 1 — the probe is loader-only, per read.* `ExtensionService.sync()` builds one
  throwaway `DefaultResourceLoader`, reloads it and persists `tools_json`/`commands_json`/
  `load_error`; it runs on every `GET /api/extensions` (like M5b's skill scan) rather than on boot
  and rescan only, so a hand-edited file is never stale. A failing extension cannot take a
  conversation down: `reload()` does not throw, the failure is a per-path error, and resolution
  excludes it with a warning that surfaces in the conversation's banner.
- *Open item 2 — the resolved set is computed per session build and live sessions are **not**
  dropped.* This is the deliberate opposite of M5b's `hub.drop` answer: spec §7.3 says changes
  apply to new conversations, and dropping a session would cancel its in-flight `ui_request`s.
  `extensions_changed` on the global channel is the only invalidation; the UI says so in words.
- *Open item 3 — pending dialogs live on the `ConversationChannel`, not the `LiveSession`*, because
  the channel outlives a session swap. That is what makes "survives a reload", "answerable from a
  second tab" and "`ui_request_resolved` closes the others" fall out for free. The timer is
  pi's: `opts.timeout` becomes `timeoutMs` and auto-resolves as **cancelled** (→ `confirm` false,
  `select`/`input`/`editor` undefined); with no timeout there is no piui timer — the wall-clock
  runaway cap (`PIUI_MAX_RUN_MINUTES`) is the backstop, and `LiveSession.dispose()` resolves
  everything still pending as cancelled.
- *Open item 4 — the fetched source is written **after** the probe, never before.* The probe runs
  on a copy in `$PIUI_HOME/scratch/ext-probe-<id>/`, so a syntax error leaves `extensions/`
  untouched (acceptance 10.2, mutation-checked). The probe directory is per-call because pi (like
  any ESM host) caches a module by path — re-probing a fixed file at the same path would return
  the previous version. The review step shows the full source, byte count and sha256 with a
  mandatory checkbox; the 1 MB cap is `extension_too_large` (the route raises its `bodyLimit` so
  the domain, not the transport, reports it).
- *Open item 5 — `disabledExtensionIds` keeps M5b's one-PATCH-per-toggle editor.* Same reasoning:
  a batched save would be a new form-state machine for no user-visible gain.
- *Extension tools are not per-profile selectable.* Spec §4 suggests selecting them like any other
  tool, but acceptance 10.3 requires an ambient extension to be "active in a new conversation
  without any UI action" and 10.4 makes the per-profile lever the **disable switch**. So extension
  tools are added to the allowlist for every profile that does not disable the extension, and the
  catalog marks them `selectableInProfile: false`. One concat instead of a selection join.
- *`allowDynamicExtensionTools` is "observe, persist, allow next time".* pi fixes the allowlist at
  construction (spike §5), so a tool first registered inside `session_start` is recorded into
  `tools_json` after `bindExtensions` and admitted from the next session — the spec's "shows them
  … once seen". Recorded only when exactly one extension is loaded, because with several the owner
  of a new name is ambiguous.
- *Nothing had to be deleted for §8.* `confirmDangerous` / `confirm_dangerous` / denylist code
  never existed in this build (M5 already shipped guards-only); `runaway.test.ts`'s grep is now
  tagged `[16-extensions#10.10]` and extended to those two field names so a future reintroduction
  fails the suite.
- *Chat mode gets the whole globally enabled set* (spec §2), including its extension tool names in
  the `tools` allowlist — `noTools: "all"` would otherwise strip them (spike S8). Chat mode still
  resolves **zero** filesystem built-ins, which the M5 test still proves.
- *Browser-only finding:* `DELETE /api/extensions/:id` sent with `Content-Type: application/json`
  and an empty body answers `400 internal_error` (fastify's `FST_ERR_CTP_EMPTY_JSON_BODY` is not
  mapped into the envelope). The client never does that — a plain DELETE returns
  `403 extension_install_disabled` as specified — but the generic mapping of fastify transport
  errors is worth tidying in M7's hardening pass.

**Mutation spot-check (§9.6)** — three mutants, all caught by name:

1. dropped `disabled.has(extension.id)` from `resolveExtensions` (a per-profile opt-out stops
   working) ⇒ `[16-extensions#10.4] drops only the profile's disabled ids…` and
   `[16-extensions#10.4] disables an extension for one profile only` failed (2 failed, 355 passed).
2. moved `writeFileSync` **before** the load probe in `install()` ⇒
   `[16-extensions#10.2] rejects a syntax error with the load error and writes nothing` failed
   (1 failed, 8 passed).
3. removed `pendingUiRequests` from `LiveSession.snapshot()` ⇒
   `[16-extensions#10.6] renders a dialog, resolves the extension promise, and survives a
   reconnect` failed (1 failed, 4 passed). All reverted. ✅

**Open for M6**

- Extension **source editing** exists on the server (`PATCH { source }`, re-probed, refuses a
  broken save) but the page has no editor yet — M6 brings CodeMirror in for skills and should
  reuse it here, together with the spec's "save anyway, disabled" escape.
- Upload-a-`.ts`-file and "register a path" are server-side only (`POST { path }`); the page
  offers paste and URL. The multipart upload lands with M6's upload surface.
- `extension_load_error` is logged as a conversation `notice` and an extension row field, but not
  yet an audit line of its own (§7.4.5 lists five events; four are wired).
- The probe re-reads and re-imports every enabled extension on each `GET /api/extensions`; fine
  for a handful, but if an installation ever grows dozens, cache on mtime.
- `piui-notices` (§6's single inline `InlineExtension`) is still not built: `onError` →
  `notice` covers what it was for, and `extensionFactories` stays `[]`.

---

## M6 — Skills & tools management UI ✅

**Shipped**

- *Spike S13* (`plan/spikes/12-skill-objects-and-test-run.md`) before any code. Five facts drove
  the design: pi's `Skill` needs only `name`/`description`/`filePath`/`baseDir`, and **pi never
  enumerates the skill directory** — `baseDir` appears only in `/skill:`'s "References are
  relative to …" line, so a multi-file skill is reachable *only* through a tool call; the
  `<available_skills>` block carries name + description + location and nothing else;
  `_expandSkillCommand` inlines the **whole** body with no truncation (a 30 KB skill costs 30 KB
  of context, and an empty body yields an empty block, no error); a skill outside the session
  `cwd` loads fine and pi's `read` reaches any absolute path; therefore B.5.6 is assertable
  offline by scripting the fake provider's `read`.
- `server/src/skills/validate.ts` — the whole §A.2 table as a pure function (`validateSkill`,
  `composeSkillMd`, `splitSkillMd`, `skillDirName`, `referencedPaths`), unit-tested row by row.
  `parseFrontmatter` moved here and is re-exported by the catalog, so there is one parser.
- `server/src/skills/service.ts` — the write path around M5b's read-only catalog: create from
  `basic|script|reference`, `PATCH` (form **or** raw, always validated *before* the write),
  per-file `GET/PUT/DELETE …/files/*` with a `resolve`+`relative` traversal guard and the 512 KB
  cap, delete → `$PIUI_HOME/trash/skills/<dir>-<ts>/` + `affectedProfiles`, external skills
  read-only (`skill_not_editable`, unregister only), rescan, and the three imports.
- `server/src/skills/zip.ts` — a ~150-line zip reader on `zlib.inflateRawSync`, **no
  dependency**. It parses the central directory, refuses `..`/absolute/drive-letter/NUL names
  and symlinks (unix mode `0120000` in the external attributes), refuses >500 entries, >1 MB per
  entry and >50 MB total **by the declared sizes before inflating**, then re-checks the actual
  inflated bytes (`maxOutputLength`) because a central directory can lie. Nothing is written
  until every entry passed.
- `POST /api/skills/:id/test` + `server/src/skills/test-run.ts` — an ephemeral conversation
  (`ephemeral = 1`, `skill_id`, `ephemeral_tools` in migration `004`): only that skill,
  `tools: ["read"]` (+`bash` on request), an empty scratch cwd, auto prompt `/skill:<name>`,
  never listed, swept after 1 h next to M2's scratch sweep.
- `server/src/tools/http-tools.ts` (pure: name rule, schema builder, `{param}` renderers,
  placeholder/JSON/timeout validation), `HttpToolRepository`, `HttpToolService` (CRUD, masking,
  the Test call) and `server/src/pi/tools/http-tool.ts` (the pi custom tool: `{param}`
  URL-encoded in the URL and JSON-encoded in the body, `${ENV_VAR}` resolved at call time, the
  **shared** `safeFetch` SSRF guard, 32 KB truncation, `details: { status, url, durationMs }`,
  non-2xx thrown with the body snippet).
- `ToolKind: "http"` in the catalog (always `dangerous`, selectable in profiles) and in
  `resolveTools` — an HTTP tool lands in `customToolNames`, and `createPiSession` builds its
  runtime through `httpTools.toolsFor(toolNames)`.
- Uploads (`server/src/uploads/service.ts` + routes): magic-byte sniffing (PNG/JPEG/GIF/WebP),
  `PIUI_MAX_UPLOAD_MB`, storage under `$PIUI_HOME/uploads/<conversationId>/`, inline serving with
  `Content-Security-Policy: sandbox` + `nosniff`, and `attachments` on `POST …/messages` (upload
  id **or** inline base64), projected into `UiMessage.attachments` in both the snapshot and the
  live SSE frame.
- Client: `/skills` (list with source/location badges, file count, usage, warning icon, search,
  New/Import/Rescan, in-app delete dialog naming the affected profiles) with the editor (file
  tree + add/delete, frontmatter form, **CodeMirror 6** body/raw/file editor, validation panel,
  Save, Save & test → the ephemeral conversation); the `HttpToolEditor` on `/tools` (schema
  builder, header rows, Test with the response echoed, in-app delete dialog); and the composer's
  attach button + paste/drop + thumbnail tray, with images rendered in the user bubble.

**Verified by hand (Firefox via MCP, dev server on `/tmp/piui-m6-home` + `/tmp/piui-m6-roots`)**

1. **New skill** from the `script` template → `SKILL.md` + `scripts/run.sh` on disk, editor open
   with the frontmatter form, CodeMirror body and the "name differs from directory" warning. ✅
2. Clearing the description and pressing **Save** → `400 skill_invalid`, *"Not saved: Frontmatter
   is missing `description`…"* under the validation panel, **file unchanged on disk**. Restoring
   it saved. ✅ (B.5.5)
3. Adding `references/api.md` in the tree, then **Save & test** → the ephemeral conversation
   *Test: demo skill* with the typed `/skill:demo skill`, a real `read` of
   `/tmp/piui-m6-home/skills/demo-skill/SKILL.md`, `tools: read` under the composer, and it does
   **not** appear in the conversation list. ✅ (B.5.6)
4. Importing a zip whose entry is `zipped-skill/../../escape.md` → *"… escapes the skill
   directory with `..`"*, nothing written; the clean archive imported as `zipped-skill` with its
   `references/api.md`; registering `/tmp/piui-m6-external/pdf-tools` added it as
   `external · user`. ✅
5. Deleting a skill a profile selects → in-app dialog: *"These profiles lose the skill: Read-only
   reviewer."* plus the trash sentence and the file count. ✅ (A.5)
6. HTTP tool `weather` created against a local stub with `authorization: Bearer ${DEMO_TOKEN}`:
   re-opening it shows `***`, `GET /api/tools/http` and `/api/tools` never contain the stored
   value, and **Test** against `http://127.0.0.1:9911` was refused — *"refusing to fetch a private
   address: 127.0.0.1"*. ✅ (B.5.3)
7. With `PIUI_ALLOW_PRIVATE_HTTP_TOOLS=1` + `DEMO_TOKEN=s3cret-from-env`: **Test** returned
   `200 · 14 ms` with the stub's JSON, and the stub logged `Bearer s3cret-from-env` — the env ref
   is resolved at call time, server-side only. An agent conversation on a profile selecting
   `weather` then called it live (`weather · ok` card, answer from the stub). ✅
8. Attaching a PNG in a chat: thumbnail tray, the image in the user bubble **while streaming**
   (see the deviation below), and the file served `200 · image/png · inline · CSP sandbox`. ✅
   (`07-chat-mode#6.4`, `09-api#10`)
9. Production build (`npm run build && NODE_ENV=production node server/dist/index.js`, port
   8799): skill create + validate + test-run transcript, an HTTP tool created, tested and
   **called inside an agent conversation**, and an upload round trip with the sandbox CSP — all
   on one port. ✅
10. Suite: 424 tests green, offline, ~16 s; lint + strict typecheck clean.

**Deviations / decisions**

- *Open item 1 — the editor writes per Save, never stages.* `PATCH /api/skills/:id` recomposes
  `SKILL.md` from the form (or takes `raw`) and **validates before writing**, so the UI cannot
  leave a skill unparseable; other files are written by their own `PUT`. A profile whose skill
  becomes invalid *outside* piui keeps M5's behaviour: resolution warns and drops, the list shows
  the warning icon, and the row is never deleted.
- *Open item 2 — validation is computed per request, not cached.* The spec suggests an
  `updated_at`-keyed cache; it is one file read plus a `readdir`, and the case the panel exists
  for is precisely a hand edit that a cache would miss. Same reasoning as M5b's per-request
  prompt composition.
- *Open item 3 — the test run is a flagged conversation, not a table.* `ephemeral = 1` keeps the
  whole transcript/SSE/abort/stats machinery; `list()` filters it out, the model is the request's
  → the most recent conversation's → the first available one, and it *does* appear on the global
  SSE channel (the hub cannot tell it apart, and the sidebar only renders the list route).
  Sweeping runs on boot and before every new test run.
- *Open item 4 — header storage.* The value is stored verbatim (ideally a `${ENV_VAR}` ref),
  resolved at call time by `config.readEnv` (config.ts stays the only module touching
  `process.env`), and **every** read answers `"***"`. A PATCH that echoes `"***"` back keeps the
  stored value; `""` deletes the row. The test endpoint returns `{ status, durationMs, body,
  truncated }` — the response only, never the request headers.
- *Open item 5 — HTTP-tool CRUD is admin-only*, reads included. `18-multi-user.md` §5 lists only
  `PATCH /api/tools/:name`, but an HTTP tool makes outbound calls from this host with server-side
  secrets — the blast radius of an extension, which §5 does list; reads expose the URLs and header
  names. Recorded in `http/authz.ts` and covered by a test over all six routes.
- *Open item 6 — uploads.* Both paths are supported and both store the file: the client uses
  `POST /api/uploads` (it already has the `File`), inline base64 stays available per §10. The
  upload id is `sha256(bytes)[0..32].<ext>`, which is what lets the transcript rebuild the URL
  with **no mapping table** (and dedupes re-uploads). Deleting a conversation still removes the
  directory (M2).
- *CodeMirror 6 landed here* (`@uiw/react-codemirror` + `@codemirror/lang-markdown`, one
  `CodeEditor` component) for the skill body, raw mode and per-file editing. The extension source
  editor and the AGENTS.md textarea do **not** use it yet — re-parked to M7 with the rest of the
  UX pass (`10-frontend#4`), since both already have a working plain editor.
- *The zip reader is homegrown* (see above): node's `zlib` plus ~150 lines beats a dependency
  whose own extraction logic would have to be audited for exactly the traversal rules §A.4 names.
- *`ctx.lookup` is now injectable* next to `ctx.fetch`; the test harness's default **throws**, so
  no test can resolve a real hostname. The HTTP-tool runtime and `web_fetch` share the guard.
- *The fake model is now vision-capable* (`input: ["text", "image"]`) so the attach path is
  exercisable offline; it is registered only under `PIUI_FAKE_MODEL=1`.
- **Browser-only bug (the M6 one): the live SSE frame dropped image attachments.**
  `projectTranscript` carried them, so the picture appeared only after a reload;
  `EventProjector.onMessageStart/onMessageEnd` now project them through the same
  `imageAttachmentsOf`. Covered by `[07-chat-mode#6.4] carries the attachment on the live SSE
  frame…`, which fails when the line is removed.
- *Second browser finding:* a refused Save rendered only in the page-level banner, above the fold
  once the editor is open. The editor now shows `Not saved: …` next to the Save button
  (`skill-save-error`), tested in `SkillsPage.test.tsx`.
- *Third (component-test) finding:* the HTTP-tool parameter/header rows were keyed by their
  value, so every keystroke remounted the input and stole focus. Keys are positional now, with
  the reason in a `biome-ignore`.

**Mutation spot-check (§9.6)** — three mutants, all caught by name:

1. disabled the `..` arm of `assertSafePath` in `skills/zip.ts` ⇒ `[11-security#3] refuses an
   entry escaping with ..` and `[11-security#3] refuses a zip whose entry escapes the skill
   directory and writes nothing` failed (2 failed, 313 passed).
2. returned the raw `headers` map instead of the masked one from `HttpToolService.view` ⇒
   `[05-skills-and-tools#B.2] never returns a stored header value through any route` failed
   (1 failed, 314 passed).
3. made `UploadService.store` accept anything by defaulting the sniff to PNG ⇒
   `[11-security#3] refuses a file whose magic bytes are not an image, whatever it claims`
   failed (1 failed, 314 passed). All reverted. ✅

**Open for M7**

- `ExtensionSourceEditor` and the AGENTS.md editor still use plain textareas; `CodeEditor` is
  there to be dropped in during the UX pass.
- The HTTP-tool card in a transcript uses the generic renderer (`weather · ok`); a dedicated
  renderer showing status/duration would read better.
- `GET /api/skills` re-validates every skill on every read (one file read + `readdir` each).
  Fine for dozens; if a deployment ever holds hundreds, cache on `mtime` like the extension probe.
- Skill *files* have no rename and no folder creation beyond "write a path"; `[LATER]` per §A.4's
  git-clone/registry install.
- `09-api.md` §6 documents the zip import on `POST /api/skills/import`; piui serves multipart on
  `POST /api/skills/import-zip` because fastify routes one path to one content-type parser. Worth
  a spec erratum in M7.
- The ephemeral test run is visible on the global SSE channel; if M7's sidebar badges count
  conversations from that channel, they must filter `ephemeral`.
