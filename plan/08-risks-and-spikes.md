---
id: plan-08
title: Spikes and risk register
status: plan
summary: >-
  Twelve timeboxed spikes verifying the spec's assumptions about pi 0.85.x before any adapter is
  written (S1 gates the whole TDD approach), plus the risk register and the deferred-scope list.
read_first: true
milestone: all
covers: [spikes, pi-api-verification, risks, mitigations, deferred-scope]
spec_refs: [01-architecture, 20-development-method, 13-open-questions]
depends_on: [plan-00]
blocks: [plan-01]
plan_version: 1
updated: 2026-02-20
---

# Spikes (do these first) and risk register

## 1. Why spikes come before M0 code

The specs were written against pi `0.85.x` typings and say so explicitly: *"When the spec and
pi's own docs disagree, pi's docs win."* Every adapter in `server/src/pi/**` rests on an
assumption that costs a day if wrong. Each spike is timeboxed to ~45 min, ends with a note in
`plan/spikes/NN-<topic>.md` containing: **the question, the verified answer, the exact typing
excerpt, and the consequence for the spec**.

Reference material (installed copy):
`node_modules/@earendil-works/pi-coding-agent/{dist/index.d.ts,docs/sdk.md,docs/rpc.md,docs/custom-provider.md,docs/models.md,docs/skills.md,docs/extensions.md,docs/settings.md,docs/session-format.md}`

## 2. Spike list

| # | Question | Spec assumption to confirm | Blocks |
|---|---|---|---|
| S1 | Does `ModelRuntime.registerProvider(id, config)` accept `streamSimple` + `models`, and does `pi-ai` export `createAssistantMessageEventStream()`? | `20-development-method.md` §3.1 — the **fake model provider** | M0 (critical) |
| S2 | Does `DefaultResourceLoader` accept `systemPromptOverride` / `skillsOverride` / `agentsFilesOverride` / `promptsOverride`, and does it fully suppress ambient discovery? | `01-architecture.md` §4.3 | M2, M5 |
| S3 | `createAgentSession({ cwd, agentDir, model, thinkingLevel, tools, customTools, resourceLoader, sessionManager, settingsManager })` — exact shape, and `SettingsManager.inMemory` | `01-architecture.md` §4.2 | M2 |
| S4 | `AgentSessionEvent` union: names/fields for text/thinking deltas, tool call + result, stop reasons, compaction, retry, usage | `02-data-model.md` §§4–5, `event-map.ts` | M2 |
| S5 | Session `.jsonl` format + `SessionManager.create/open`; how to project stored entries to `UiMessage[]` | `02-data-model.md` §4, `transcript.ts` | M2 |
| S6 | Credential surface: provider status, `AuthFlow` prompts, `runtime.logout()`, `auth.json` shape/permissions, `CredentialSynchronizationError` | `14-credentials.md` §1–2 | M2 |
| S7 | `steer` / `followUp` / `abort` semantics and `preflightResult` | `01-architecture.md` §5, `09-api.md` §8 | M2/M5 |
| S8 | `enableSkillCommands`, `expandPromptTemplates`, prompt template discovery + argument substitution | `15-commands-and-input.md` §§1,3 | M5b |
| S9 | `bindExtensions({ mode: "rpc", uiContext, onError })`, `additionalExtensionPaths`, `extensionFactories`, late tool registration | `16-extensions.md` §§1,3,4,5 | M5c |
| S10 | `defineTool` signature + TypeBox usage; can a tool receive an injected `fetch`? | `01-architecture.md` §1 | M3 |
| S11 | Built-in tool names exactly as pi exposes them (`read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`/…) | `05-skills-and-tools.md` part B, `resolveTools` | M3/M5 |
| S12 | Usage/cost/context accessors (`session.agent.state`, stats) | `02-data-model.md` §2 notes, `09-api.md` §8 stats | M2 |

**S1 is the gate.** If a scripted provider cannot be registered, the whole TDD approach needs a
fallback (option: a `customTools`-only stub session, or an injected `fetch` returning a canned
SSE body at the provider HTTP layer). Decide before M0 ends, and write down which mechanism was
chosen — `12-milestones.md` explicitly leaves this choice to the implementer.

## 3. Risk register

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| pi API drift between 0.85.x and later | Adapters break | high over time | Pin the exact version in `package.json`; all contact behind `server/src/pi/**`; a contract test per adapter using a real `AgentSession` + fake provider; never mock pi (policy §4 of 20) |
| Fake provider not feasible (S1) | TDD plan collapses | medium | Fallback ladder: custom provider → stub session with `customTools` only → injected `fetch` at the provider transport |
| Ambient discovery leaks into conversations (S2) | Profile is no longer the source of truth; security surprise | medium | Explicit test "no host extension/skill/prompt is loaded"; fallback = hand-written `ResourceLoader` implementing pi's interface |
| SSE snapshot/replay races | Silent transcript corruption, the hardest bug class | high | Build the SSE harness in M0; assert on frame sequences; no retries on flaky stream tests (they hide the race) |
| Delta coalescing breaks ordering | Garbled text | medium | Coalesce per content block only, flush on block end, assert reassembled text equals the script |
| Two adapters for one idea (chat vs agent) drift | Duplicate bugs | medium | One `SessionConfig` → one `ResolvedSessionConfig` → one `createSession`; chat mode is just an empty tool set + scratch cwd |
| SQLite write contention with WAL + concurrent runs | 500s under load | low | Single process, short transactions, per-profile mutex for `memory.md` |
| Scope creep from `[LATER]` items | Milestone slip | high | `[LATER]` means *API shape reserved, no implementation*: forking, tool-output fetch, users CRUD, memory Phase 1/2, OAuth |
| Secrets leaking into logs/responses | Credential exposure | medium | Dedicated hygiene test pushing a fixture key through start/respond/error paths and grepping logs, audit lines and bodies (`12-milestones.md` test matrix) |
| SSRF through `web_fetch` / HTTP tools | Host-internal access | medium | Injected `fetch` + guard tested with hostile fixtures: redirect chains, private-IP DNS, huge bodies, wrong content types |
| `spec-coverage` becomes an exemption dump | Gate loses meaning | medium | Every exemption needs a one-line reason; review the exemption list at each milestone gate |
| Playwright E2E flakiness | CI noise | medium | Only the two flows in `12-milestones.md`; fake model; fixed clock; quarantine-and-fix, never re-run |

## 4. Deliberately deferred (do not build in V1)

`POST /conversations/:id/fork` + `/tree` (shape reserved only) · `GET /tool-output/:toolCallId`
(truncate + say so) · `/api/users/*` (must return 404 while role checks exist) · memory phases
1–2 · OAuth/subscription logins · per-workspace memory · chat-mode persona · approval gates
(removed by Q3/Q9) · any sandbox beyond the container (Q10).
