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
- [x] S6 credentials / `AuthFlow` surface (`plan/spikes/06-credentials-and-auth-flow.md`)
- [x] S7 steer / followUp / abort / preflight (typings verified; behavior re-checked in M2)
- [x] S8 skill commands + prompt templates (`plan/spikes/10`)
- [x] S9 `bindExtensions` + `additionalExtensionPaths` (`plan/spikes/11`)
- [x] S10 `defineTool` + injectable fetch · S11 built-in tool names · S12 usage/cost accessors
- [x] S9 built-in tools for real: names, params, `tool_execution_*` payloads (`plan/spikes/09`)

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
- [x] `AuthProvider` + `StaticAuthProvider`, cookie sessions, guard
- [x] CSRF, login rate limit + delay, logout invalidation
- [x] step-up (`step_up_at`, `requireStepUp`, 10 min, fake clock)
- [x] `requireAdmin` on §5 surfaces; 404-invisible / 403-not-writable
- [x] `/login`, `AuthGate`, user menu, 401 interceptor, `StepUpDialog` + 403 retry
- [x] **Gate:** `06-auth#8`, `14-credentials#9.7`, `18-multi-user#9.1–9.8`

## M2 — credentials, bridge, streaming, chat
- [x] `CredentialService` + `AuthFlow`; credential routes; secret-hygiene test; `0600`
- [x] `/settings/providers` UI
- [x] `ModelService` + `GET /api/models` (cache + revision + `?refresh=1`)
- [x] `pi/resources.ts` + ambient-suppression test
- [x] `pi/agent-runner.ts` `createSession` (chat: empty tools, scratch cwd, prompt override)
- [x] `SessionHub` + ring buffer + seq + eviction + run semaphore
- [x] `event-map.ts` (coalescing) + `transcript.ts` (merged tool blocks) + fixtures
- [x] SSE route: snapshot / `Last-Event-ID` replay / stale→snapshot / 20 s ping
- [x] conversation routes incl. abort-with-restore, queue clear, stats, auto-title
- [x] chat UI + `useConversationStream` + markdown sanitization + context/cost
- [x] TUI-parity input + `HotkeysDialog`
- [x] **Gate:** `14-credentials#9.{1,2,3,6,8,10}`, `07-chat-mode#6.{1,5,6}` — plus 9.4/9.5/9.9
      and `19-deployment#9.3`, which the stub-provider seam made testable early

## M3 — web search & tool runtime
- [x] `WebSearchProvider` (brave + tavily + searxng + `none`) with the 10 min / 200 entry cache
- [x] `web_search` / `web_fetch` with injectable fetch, progress updates, per-run rate limit
- [x] shared SSRF guard + hostile-response tests (literal + DNS, redirect hops, caps)
- [x] `GET /api/tools`, `PATCH /api/tools/:name` (admin), `POST /api/tools/web_search/test`
- [x] `ToolRegistry` catalog (+ boot validation against the installed pi) and `resolveChat`
- [x] chat globe toggle, web tool cards, Sources footer, `/tools` configuration panel
- [x] **Gate:** `07-chat-mode#6.{2,3}`, `05-skills-and-tools#B.5.{1,2}`

## M4 — workspaces
- [x] path validation (symlink resolution, denylist, roots, traversal) + error codes
- [x] create + `git init`, status probing, `validate`, tree/file/git, `fs/browse`
- [x] UI list/create/edit/delete, picker, file viewer, Missing state blocking prompts
- [x] **Gate:** `04-workspaces#7.1–7.6`

## M5 — profiles + agent mode
- [x] skills read path (scan + list)
- [x] profile CRUD + AGENTS.md side effects + trash-on-delete + warnings
- [x] resolution pipeline + `resolveTools` permutations (chat ⇒ zero fs tools)
- [x] memory Phase 0: skeleton, `parseMemory`, injection + notices, `memory_append`, mutex, panel
- [x] agent conversations, immutability rules, missing-workspace error
- [x] tool cards (read/write/edit-diff/bash-stream/grep/find/ls), side panel, Files refetch
- [x] steering/follow-up/abort-with-restore; retry + compaction notices
- [x] runaway guards (wall clock + tool-call cap), no approval gates
- [x] **Gate:** `03-profiles#8`, `17-memory#7`, `08-agent-mode#8`

## M5b — commands
- [x] `/commands`, `/api/prompts` (+ rescan), template composition & precedence
- [x] `enableSkillCommands`, `/skill:<name>`, `SlashMenu`, unknown-command refusal
- [x] routing table, `commandEcho` + show-expanded
- [x] discovered skills as `external`, `includeDiscoveredSkills`
- [x] workspace trust column + project-resources route + dialog
- [x] Alt+T / Alt+O collapse toggles + `/hotkeys` parity; `/settings` prompt sources + Rescan
- [x] **Gate:** `15-commands-and-input#6.1–6.10`

## M5c — extensions
- [x] probe enumeration, registry refresh, `extensions_changed`
- [x] auto-register `~/.pi/agent/extensions/*.ts`
- [x] install paths (paste/URL-then-review/register) + probe gate + step-up + audit + kill switch
- [x] resolution unit tests (global − disabled, ordering, failures excluded)
- [x] collision drop, `allowDynamicExtensionTools`
- [x] UI bridge events + `ui-response` route + snapshot-surviving dialogs
- [x] extension commands in `/`; **no approval-gate code, no `confirmDangerous` (grep-tested)**
- [x] **Gate:** `16-extensions#10.1–10.10`

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
