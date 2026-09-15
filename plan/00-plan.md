---
id: plan-00
title: Implementation plan — overview
status: plan
summary: >-
  Strategy, ground rules, milestone sequencing with estimates, and the V1 definition of done.
  Entry point for the plan; read before any milestone file.
read_first: true
milestone: all
covers: [strategy, ground-rules, sequencing, estimates, definition-of-done]
spec_refs: [decisions, 00-overview, 01-architecture, 12-milestones, 20-development-method]
depends_on: []
blocks: [plan-01, plan-02, plan-03, plan-04, plan-05, plan-06, plan-07]
plan_version: 1
updated: 2026-02-20
---

# piui — Implementation Plan (overview)

Derived from `spec/` (v1, 2026-02-20) and verified against the installed
`@earendil-works/pi-coding-agent@0.85.1` (Node v22.22.1 available).

This folder is *plan*, not spec. On conflict: `spec/decisions.md` (binding) >
`spec/*.md` (normative) > this plan > pi docs… except where the README rule applies
(**pi's own docs win over the spec when they disagree about pi's API**).

| File | Content |
|---|---|
| `00-plan.md` | this overview: strategy, ground rules, sequencing, risks |
| `01-m0-skeleton.md` | M0 — repo, DB, config, Docker, **test harness** |
| `02-m1-auth.md` | M1 — auth, sessions, CSRF, step-up, authorization |
| `03-m2-chat.md` | M2 — credentials, pi bridge, SessionHub/SSE, chat UI |
| `04-m3-m4-search-workspaces.md` | M3 web search/tool runtime, M4 workspaces |
| `05-m5-profiles-agent.md` | M5 profiles + agent mode + memory |
| `06-m5b-m5c-commands-extensions.md` | M5b slash commands, M5c extensions |
| `07-m6-m7-management-hardening.md` | M6 skills/tools UI, M7 hardening & docs |
| `08-risks-and-spikes.md` | pi-API spikes to run first, risks, mitigations |
| `09-checklist.md` | flat, tickable work order |

---

## 1. Strategy in one page

1. **TDD is mandatory** (`spec/20-development-method.md`, requirement R1). Every milestone's
   acceptance list is its test backlog; tests carry tags `[<spec id>#<section>.<item>]`;
   `test/spec-coverage.test.ts` fails the build on untagged criteria.
2. **Build the seams before the features.** M0 ships the fake model provider, temp `PIUI_HOME`,
   injectable `Clock`/`IdGen`/`fetch`, principal minting, and the SSE harness. Nothing after M0
   is testable without them, so M0 is the single highest-leverage milestone — do not compress it.
3. **Two structural invariants, enforced by grep tests from day one:**
   - no import of `@earendil-works/pi-coding-agent` outside `server/src/pi/**`;
   - no raw SQL against owned tables outside `server/src/db/repositories/**`.
   These are what make a future RPC backend and V2 multi-user mechanical instead of a rewrite.
4. **Spike pi's real API before writing adapters** (see `08-risks-and-spikes.md`). The specs were
   written against 0.85.x typings; verify each assumption against
   `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` + `docs/` and record the answer
   in `plan/spikes/NN-*.md`. Spec deviations found this way are legitimate; document them.
5. **Ship runnable at every milestone.** Each milestone ends with: suite green, `docker compose up`
   healthy, and a demoable path through the UI.
6. **Container-first.** The image and compose file land in M0 (decision Q10); later milestones are
   exercised inside the container, not only on the host.

## 2. Ground rules (repeat of the normative bits that bite)

- Node ≥ 22, ESM, TS `strict`, npm workspaces `shared` / `server` / `client`.
- Fastify 5, better-sqlite3 (WAL + `foreign_keys=ON`), TypeBox + ajv (no zod), pino.
- React 18 + Vite + react-router 6 + TanStack Query + Tailwind + radix + CodeMirror 6.
- Markdown output is untrusted → `rehype-sanitize` always.
- Config parsed once into a frozen object; **no `process.env` reads outside `config.ts`**.
- All DTOs live in `shared/src/{api,domain,events}.ts` and are the single source of truth.
- Route handlers never touch pi, the filesystem, or SQL directly: they call domain modules.
- `09-api.md` is authoritative for the HTTP contract; `14-credentials.md` §3 overrides its §3.

## 3. Sequencing and estimates

| # | Milestone | Focus | Est. | Gate |
|---|---|---|---|---|
| S | Spikes | pi API verification (§08) | 0.5–1 d | spike notes committed |
| M0 | Skeleton + harness | workspaces, config, DB+migrations, repos, Fastify, SPA shell, Docker, **all test seams** | 2–3 d | `12-milestones.md` M0 accept |
| M1 | Auth | AuthProvider, cookie sessions, CSRF, rate limit, step-up, role guards | 1–1.5 d | `06-auth#8`, `14-credentials#9.7`, `18-multi-user#9` |
| M2 | Credentials + chat | CredentialService/AuthFlow, ModelService, agent-runner, SessionHub, SSE, chat UI, TUI input | 5–7 d | `14-credentials#9.{1,2,3,6,8,10}`, `07-chat-mode#6.{1,5,6}` |
| M3 | Web search / tool runtime | providers, `web_search`/`web_fetch`, SSRF guard, tool catalog routes | 1.5–2 d | `07-chat-mode#6.{2,3}`, `05-skills-and-tools#B.5.{1,2}` |
| M4 | Workspaces | path validation, tree/file/git, browse, UI | 1.5–2 d | `04-workspaces#7` |
| M5 | Profiles + agent mode | resolution pipeline, memory Phase 0, agent UI, steering/abort | 4–6 d | `03-profiles#8`, `17-memory#7`, `08-agent-mode#8` |
| M5b | Commands & discovery | `/` menu, prompt templates, skill commands, workspace trust | 2–3 d | `15-commands-and-input#6` |
| M5c | Extensions | install/probe/registry, per-profile disable, UI bridge | 3–4 d | `16-extensions#10` |
| M6 | Skills & tools UI | skill CRUD/import/validate/test-run, HTTP tools, uploads | 3–4 d | `05-skills-and-tools` A/B |
| M7 | Hardening & docs | CSP/headers, audit, caps, global SSE, export, a11y, docs, CI | 3–4 d | `11-security` testable items + `10-frontend#4` pass |

Total ≈ 27–38 focused days. M2 and M5 carry the risk; everything else is mostly mechanical
once the seams exist.

Parallelization (if more than one implementer): client work for a milestone can trail the
server work by one milestone, against the DTOs in `shared/`. Do **not** parallelize M0.

## 4. Definition of done (V1) — copied forward as the closing gate

- All six features per spec, all acceptance lists green.
- No pi import outside `server/src/pi/**`; no raw SQL outside the repository layer.
- `npm run build` → single-command production start; documented in README.
- `tsc --noEmit` strict clean, lint clean, unit+integration+component+`spec-coverage`+E2E green,
  Docker image builds.
- Every acceptance criterion tagged or exempted with a reason in `test/spec-exemptions.ts`.
- First-run works with only pi credentials present: seeded profiles, workspace prompt, working chat.

## 5. How to use this plan with a coding agent

Per task, load only:

- this file's §2 (ground rules) — always,
- the milestone plan file,
- the spec files listed in that file's **Context** block (mirrors the `spec/README.md` context
  budget).

Never load all of `spec/` (~55k tokens). Skip `Rationale:` / `Reasoning:` / `Why:` blocks while
implementing.
