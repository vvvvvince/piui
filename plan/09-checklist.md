---
id: plan-09
title: Flat work order checklist
status: plan
summary: >-
  Every task from the milestone files as one tickable list, in execution order, with the
  acceptance gate closing each milestone. Progress tracker, not a specification.
milestone: all
covers: [checklist, work-order, progress]
spec_refs: [12-milestones]
depends_on: [plan-00, plan-01, plan-02, plan-03, plan-04, plan-05, plan-06, plan-07, plan-08]
blocks: []
plan_version: 1
updated: 2026-02-20
---

# Flat work order (tick as you go)

Rule for every line below: **failing test first**, then code, then refactor, commit at green.

## Spikes
- [x] S1 fake model provider feasible (`ModelRuntime.registerProvider` + `createAssistantMessageEventStream`) — **blocks everything**
- [x] S2 `DefaultResourceLoader` overrides + ambient suppression
- [x] S3 `createAgentSession` shape + `SettingsManager.inMemory`
- [x] S4 `AgentSessionEvent` union
- [x] S5 session `.jsonl` + `SessionManager`
- [ ] S6 credentials / `AuthFlow` surface (M2)
- [x] S7 steer / followUp / abort / preflight (typings verified; behavior re-checked in M2)
- [ ] S8 skill commands + prompt templates (M5b)
- [ ] S9 `bindExtensions` + `additionalExtensionPaths` (M5c)
- [x] S10 `defineTool` + injectable fetch · S11 built-in tool names · S12 usage/cost accessors

## M0 — skeleton + harness
- [x] npm workspaces, TS strict, ESM, lint/format, scripts
- [x] `shared/src/{domain,events,api}.ts` from `02-data-model` §§3–5
- [x] `config.ts` frozen, no `process.env` elsewhere (grep test)
- [x] SQLite open + migration runner + `001_init.sql` (full DDL + seeded `local` admin)
- [x] repository layer with the two scoping predicates; no raw SQL in routes (grep test)
- [x] Fastify boot, pino, error envelope, `GET /api/health`, graceful shutdown
- [x] Vite SPA shell + dev proxy
- [x] `withTempHome` / `withWorkspace` / temp-root access guard
- [x] injectable `Clock` / `IdGen` / `fetch`
- [x] principal-minting helper
- [x] SSE harness
- [x] scripted fake model provider (`PIUI_FAKE_MODEL=1`)
- [x] `spec-coverage.test.ts` + `spec-exemptions.ts`
- [x] Dockerfile, compose, `.dockerignore`, `.env.example`, override example
- [x] **Gate:** M0 acceptance + mutation spot-check

## M1 — auth
- [ ] `AuthProvider` + `StaticAuthProvider`, cookie sessions, guard
- [ ] CSRF, login rate limit + delay, logout invalidation
- [ ] step-up (`step_up_at`, `requireStepUp`, 10 min, fake clock)
- [ ] `requireAdmin` on §5 surfaces; 404-invisible / 403-not-writable
- [ ] `/login`, `AuthGate`, user menu, 401 interceptor, `StepUpDialog` + 403 retry
- [ ] **Gate:** `06-auth#8`, `14-credentials#9.7`, `18-multi-user#9.1–9.8`

## M2 — credentials, bridge, streaming, chat
- [ ] `CredentialService` + `AuthFlow`; credential routes; secret-hygiene test; `0600`
- [ ] `/settings/providers` UI
- [ ] `ModelService` + `GET /api/models` (cache + revision + `?refresh=1`)
- [ ] `pi/resources.ts` + ambient-suppression test
- [ ] `pi/agent-runner.ts` `createSession` (chat: empty tools, scratch cwd, prompt override)
- [ ] `SessionHub` + ring buffer + seq + eviction + run semaphore
- [ ] `event-map.ts` (coalescing) + `transcript.ts` (merged tool blocks) + fixtures
- [ ] SSE route: snapshot / `Last-Event-ID` replay / stale→snapshot / 20 s ping
- [ ] conversation routes incl. abort-with-restore, queue clear, stats, auto-title
- [ ] chat UI + `useConversationStream` + markdown sanitization + context/cost
- [ ] TUI-parity input + `HotkeysDialog`
- [ ] **Gate:** `14-credentials#9.{1,2,3,6,8,10}`, `07-chat-mode#6.{1,5,6}`

## M3 — web search & tool runtime
- [ ] `WebSearchProvider` (brave + one alternative + `none`)
- [ ] `web_search` / `web_fetch` with injectable fetch, cache, per-run rate limit
- [ ] shared SSRF guard + hostile-response tests
- [ ] `GET /api/tools`, `PATCH /api/tools/:name`, `POST /api/tools/web_search/test`
- [ ] chat toggle, tool cards, Sources footer, settings panel
- [ ] **Gate:** `07-chat-mode#6.{2,3}`, `05-skills-and-tools#B.5.{1,2}`

## M4 — workspaces
- [ ] path validation (symlink resolution, denylist, roots, traversal) + error codes
- [ ] create + `git init`, status probing, `validate`, tree/file/git, `fs/browse`
- [ ] UI list/create/edit/delete, picker, file viewer, Missing state blocking prompts
- [ ] **Gate:** `04-workspaces#7.1–7.6`

## M5 — profiles + agent mode
- [ ] skills read path (scan + list)
- [ ] profile CRUD + AGENTS.md side effects + trash-on-delete + warnings
- [ ] resolution pipeline + `resolveTools` permutations (chat ⇒ zero fs tools)
- [ ] memory Phase 0: skeleton, `parseMemory`, injection + notices, `memory_append`, mutex, panel
- [ ] agent conversations, immutability rules, missing-workspace error
- [ ] tool cards (read/write/edit-diff/bash-stream/grep/find/ls), side panel, Files refetch
- [ ] steering/follow-up/abort-with-restore; retry + compaction notices
- [ ] **Gate:** `03-profiles#8`, `17-memory#7`, `08-agent-mode#8`

## M5b — commands
- [ ] `/commands`, `/api/prompts` (+ rescan), template composition & precedence
- [ ] `enableSkillCommands`, `/skill:<name>`, `SlashMenu`, unknown-command refusal
- [ ] routing table, `commandEcho` + show-expanded
- [ ] discovered skills as `external`, `includeDiscoveredSkills`
- [ ] workspace trust column + project-resources route + dialog
- [ ] **Gate:** `15-commands-and-input#6.1–6.10`

## M5c — extensions
- [ ] probe enumeration, registry refresh, `extensions_changed`
- [ ] auto-register `~/.pi/agent/extensions/*.ts`
- [ ] install paths (paste/upload/URL/register) + probe gate + step-up + audit + kill switch
- [ ] resolution unit tests (global − disabled, ordering, failures excluded)
- [ ] collision drop, `allowDynamicExtensionTools`
- [ ] UI bridge events + `ui-response` route + snapshot-surviving dialogs
- [ ] extension commands in `/`; **delete all approval-gate code + `confirmDangerous`**
- [ ] **Gate:** `16-extensions#10.1–10.10`

## M6 — skills & tools UI
- [ ] skill CRUD + files + import + rescan + validate + trash + counts
- [ ] skill test-run ephemeral conversation
- [ ] HTTP tool CRUD + schema builder + test + runtime with SSRF guard
- [ ] image uploads end to end (magic bytes, caps, inline serving)
- [ ] **Gate:** `05-skills-and-tools` A/B lists

## M7 — hardening
- [ ] headers/CSP, audit log, redaction, run caps, subscriber caps
- [ ] global `/api/events` + live sidebar badges
- [ ] export md/json/html, compact endpoint + button
- [ ] UX states, command palette, a11y, light theme
- [ ] README + `docs/deployment.md` + `docs/adding-a-provider.md`
- [ ] multi-arch CI, SearXNG profile, Settings → About posture
- [ ] **Gate:** `11-security` testable items, `10-frontend#4` manual pass, `19-deployment#9`

## V1 close
- [ ] definition of done (`plan/00-plan.md` §4) verified inside the container
- [ ] `spec-exemptions.ts` reviewed — every entry still justified
