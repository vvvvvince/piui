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
