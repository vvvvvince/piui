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
