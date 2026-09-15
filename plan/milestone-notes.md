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
