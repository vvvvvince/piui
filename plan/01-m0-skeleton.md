---
id: plan-01
title: M0 — Skeleton + test harness
status: plan
summary: >-
  Repo bootstrap, config, SQLite + migrations + repository layer, Fastify boot, SPA shell,
  Docker artifacts, and the six test seams every later milestone depends on.
milestone: M0
est_days: "2–3"
covers: [workspaces-setup, config, sqlite, migrations, repository-layer, test-harness, fake-model, docker]
spec_refs: [00-overview, 01-architecture, 02-data-model, 18-multi-user, 19-deployment, 20-development-method, 12-milestones]
depends_on: [plan-00, plan-08]
blocks: [plan-02]
plan_version: 1
updated: 2026-02-20
---

# M0 — Skeleton + test harness

**Context to load:** `00-overview`, `01-architecture`, `02-data-model`, `19-deployment`,
`20-development-method`, `18-multi-user` §§4,8, `12-milestones` M0. (~14k tokens)

**Goal:** a walking skeleton that boots, migrates, serves the SPA, ships in a container — and a
test harness good enough that every later milestone can be driven red→green offline.

**Exception to TDD:** the walking skeleton itself. Its first job is to make `GET /api/health`
testable; after that the rule applies with no exceptions.

---

## 1. Workspace bootstrap

- Root `package.json` with npm workspaces `shared`, `server`, `client`; `"type": "module"`;
  scripts `dev`, `build`, `start`, `test`, `test:unit`, `test:int`, `test:client`, `test:e2e`,
  `lint`, `typecheck`, `fixtures:record`.
- TS project refs, `strict: true`, `noUncheckedIndexedAccess: true`, `moduleResolution: bundler`
  (client) / `nodenext` (server).
- Pick **one** formatter/linter (recommendation: biome — one tool, fast, CI-friendly) and wire it
  into `lint`.
- `shared/src/{domain.ts,events.ts,api.ts}` — paste the types from `02-data-model.md` §§3–5
  verbatim; they are the contract for both sides. Add `SessionConfig` from `01-architecture` §4.1.
- Layout exactly as `01-architecture.md` §2. Create the empty directories with `.gitkeep` so the
  structure is visible from commit 1.

## 2. Server skeleton

- `config.ts`: parse and freeze every var in `01-architecture.md` §3. Refuse `0.0.0.0` unless
  `PIUI_ALLOW_REMOTE=1`; warn when `PIUI_SESSION_SECRET` is unset; downgrade the remote-bind
  warning to info when `PIUI_CONTAINER` is set. **No `process.env` read anywhere else** —
  enforce with a grep test.
- `db/index.ts`: better-sqlite3 open, `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`,
  migration runner applying `migrations/NNN_*.sql` in a transaction, tracked in
  `schema_migrations`.
- `db/migrations/001_init.sql`: the **full** DDL from `02-data-model.md` §2, including `users`,
  `owner_id`/`visibility` on owned tables, and the seeded `local` admin
  (`18-multi-user.md` §8).
- `db/repositories/*.ts`: **the repository layer**. Every function takes a `Principal` and
  applies the two scoping predicates from `18-multi-user.md` §4 (visible = own ∪ shared;
  writable = own ∪ admin; conversations = own only, even for admins). Route handlers get no
  database handle.
- `http/server.ts`: Fastify 5 + pino (pretty in dev), one log line per request, error handler
  producing the `09-api.md` §0 error envelope, `@fastify/cookie`, `@fastify/static` for the
  built SPA in production.
- `GET /api/health` → `{ ok, version, piVersion, defaultCredentials, container, insecureTransportOk }`.
- `GET /api/meta` may land here or in M2; the health route is the M0 gate.
- Graceful shutdown: abort/dispose hooks registered (no sessions yet), close DB, exit 0.
- `Clock` / `IdGen` interfaces + real implementations, injected from `index.ts` into everything.

## 3. Client skeleton

- Vite + React 18 + react-router + Tailwind + TanStack Query provider.
- App shell: sidebar (Conversations / Profiles / Workspaces / Skills / Tools / Settings) + top
  bar + one placeholder page.
- Typed fetch wrapper in `api/` that always sends `X-Requested-With: piui` and centralizes the
  error envelope (401 / 403-step-up interceptors arrive in M1).
- Dev proxy `/api` → `:8787`.

## 4. Test harness (the real deliverable) — `20-development-method.md` §3

Build these test-first, in this order:

1. **`withTempHome(fn)`** — fresh `PIUI_HOME` under `os.tmpdir()`, real SQLite file (not
   `:memory:`), removed in teardown. Every test runs migrations → free migration testing.
2. **Temp-root access guard** — global setup fails any test that reads/writes outside the temp
   root (`~/.piui`, `~/.pi` must be untouched). `[20-development-method#9.3]`
3. **`withWorkspace()`** — temp dir seeded with a small file tree.
4. **Injectable `Clock`/`IdGen`** — fake clock advanced explicitly; **no `setTimeout` sleeping
   in tests**.
5. **Principal minting** — insert an `auth_sessions` row directly, return a cookie; supports
   `role: "user"`, a second user, an inactive user.
6. **SSE harness** — connect, collect frames with their `id:`, reconnect with `Last-Event-ID`.
7. **Injectable `fetch`** — threaded through config into `web_search`/`web_fetch`/HTTP tools and
   pi's `ProviderRequestOptions`. No test performs real network I/O.
8. **Scripted fake model provider** (`PIUI_FAKE_MODEL=1`) — see spike **S1** in
   `08-risks-and-spikes.md`; script items `{text}|{thinking}|{toolCall}|{error}|{stall}`, small
   delta chunks, fixed usage/cost, per-turn queuing, real tool execution.
   `[20-development-method#9.2]`
9. **`test/spec-coverage.test.ts` + `test/spec-exemptions.ts`** — parse acceptance sections of
   `spec/*.md`, collect `<id>#<section>.<item>`, fail on any item lacking a tagged test or an
   exempt entry with a reason. `[20-development-method#9.4]`
10. **Structural grep tests** — no pi import outside `server/src/pi/**`; no raw SQL against owned
    tables outside repositories `[18-multi-user#9.7]`; no `process.env` outside `config.ts`.

Vitest config: three projects (`unit`, `integration`, `client`) with the speed budgets from
`20-development-method.md` §5; parallel-safe because each test owns its temp home.

## 5. Deployment artifacts (V1, built now — decision Q10)

- `Dockerfile` — multi-stage, Debian-slim (not Alpine), non-root user, `git` + GNU userland
  present, healthcheck hitting `/api/health`.
- `docker-compose.yaml` — works unedited: named volume for `PIUI_HOME`, publish to **loopback
  only**, `PIUI_CONTAINER=1`, `PIUI_INSECURE_TRANSPORT_OK=1`, **no Docker socket mount**
  (and the README must say why).
- `.dockerignore`, `.env.example` (documented), `docker-compose.override.yaml.example`.

## 6. Acceptance (`12-milestones.md` M0, `19-deployment.md` §9 items 1,2,6,7,9)

1. `npm run dev` serves the SPA and proxies `/api`.
2. `GET /api/health` → `ok`.
3. DB file created with every table; `users` holds exactly one active admin
   `[18-multi-user#9.1]`.
4. `npm run build && node server/dist/index.js` serves the built SPA on one port.
5. `cp .env.example .env && docker compose up -d` → healthy container serving the same app.
6. `npm test` green, offline, no credentials, < 2 min `[20-development-method#9.1]`.
7. The harness items 2, 8, 9 above have their own tagged tests.

## 7. Exit checks before starting M1

- [ ] Spikes S1–S5 written up in `plan/spikes/`.
- [ ] A deliberately broken scoping predicate makes a **named** test fail (mutation spot-check,
      `20-development-method#9.6`) — record in the milestone notes.
- [ ] `spec-exemptions.ts` contains only reasoned entries.
