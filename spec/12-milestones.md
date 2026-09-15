---
id: 12-milestones
title: Build order, milestones, acceptance
status: normative
read_first: true
summary: >-
  M0–M7 build sequence with per-milestone acceptance lists, the minimum test matrix, fixtures, and the V1 definition of done.
covers: [milestones, acceptance, test-matrix, definition-of-done]
depends_on: [00-overview, 19-deployment]
required_by: []
decisions: [Q1, Q2, Q3, Q4, Q7, Q10]
milestones: [M0, M1, M2, M3, M4, M5, M5b, M5c, M6, M7]
spec_version: 1
updated: 2026-02-20
---

# 12 — Build order, milestones, acceptance

Each milestone must end **runnable and demoable**. Do not start N+1 until N's acceptance list
passes. Write tests as you go, not at the end.

## M0 — Skeleton (half a day)

- Workspaces-style npm workspaces repo (`shared`, `server`, `client`), TS strict, ESM.
- Fastify boot, `/api/health`, pino logging, config parsing, graceful shutdown.
- SQLite open + migration runner + `001_init.sql` (full schema from `02-data-model.md`),
  including the `users` table with the seeded `local` admin and `owner_id` / `visibility` on
  owned tables ([18-multi-user.md](18-multi-user.md) §8).
- **Repository layer** taking the request principal, with the two scoping predicates from
  `18-multi-user.md` §4. No raw SQL in route handlers — this is the one structural rule that
  makes V2 multi-user mechanical instead of a rewrite.
- Vite React SPA with the shell (sidebar + top bar) and a placeholder page; dev proxy to `/api`.
- `npm run dev`, `npm run build`, `npm test`, lint all wired; README with setup steps.
- **Dockerfile + `docker-compose.yaml` + `.env.example` + `.dockerignore`**
  ([19-deployment.md](19-deployment.md) §§3–4). Built in M0, not M7: the container is the
  isolation model (decision Q10), so every later milestone should be exercised inside it.

**Accept:** `npm run dev` serves the SPA, `GET /api/health` returns `ok`, the db file is
created with all tables, `npm run build && node server/dist/index.js` serves the built SPA on
one port, and `cp .env.example .env && docker compose up -d` yields a healthy container serving
the same app (`19-deployment.md` §9 items 1, 2, 6, 7, 9).

## M1 — Auth (Feature 2)

- `AuthProvider` + `StaticAuthProvider`, session table, cookie, guard, CSRF checks, rate limit.
- `/login` page, `AuthGate`, user menu, 401 interceptor.
- Step-up re-auth: `POST /api/auth/step-up`, `step_up_at` column, `requireStepUp` preHandler,
  `StepUpDialog` + the 403-triggered retry in the client fetch layer
  ([14-credentials.md](14-credentials.md) §5). Built here because M2 needs it.
- Authorization: `Principal.roles` through `me`, the `requireAdmin` preHandler on the
  §5 surfaces of [18-multi-user.md](18-multi-user.md), `404`-for-invisible /
  `403`-for-not-writable semantics, and the client hiding admin-only UI.

**Accept:** `06-auth.md` §8 acceptance list, `14-credentials.md` §9 item 7, and
`18-multi-user.md` §9 (all eight items — tests inject a `role: "user"` principal; no user
management UI is needed in V1).

## M2 — pi bridge + chat mode (Feature 4)

- `pi/model-service.ts`: shared `ModelRuntime`, `GET /api/models`, `GET /api/providers`.
- `pi/credentials.ts`: `CredentialService` + `AuthFlow` state machine, the credential routes,
  `/settings/providers` page with `ProviderTable` + `CredentialDialog`, log exclusion, error
  scrubbing, `0600` enforcement ([14-credentials.md](14-credentials.md)). Do this **first** in
  M2: it is how you get a working model to test chat with.
- `pi/agent-runner.ts`: `createSession` for chat mode (empty tools, prompt override, scratch cwd).
- `SessionHub` with ring buffer, `seq`, SSE endpoint, snapshot/replay, delta coalescing.
- `event-map.ts` + `transcript.ts` projections (`UiMessage`, `UiEvent`).
- Conversation CRUD (chat only), `POST /messages`, `/abort`, `/queue/clear`.
- Chat UI: new-chat dialog, model picker, transcript, Markdown rendering, composer, streaming
  hook, stop, context meter, cost display, auto title.
- **TUI-parity input** ([15-commands-and-input.md](15-commands-and-input.md) §4): queue key
  semantics (Enter/Alt+Enter/Esc/Alt+Up), prompt history, `Ctrl+G` editor modal, the
  `Alt+*` toggle/picker bindings, `HotkeysDialog`.
- Persistence: reload page mid-stream and after server restart.

**Accept:** `14-credentials.md` §9 items 1–3, 6, 8, 10 and `07-chat-mode.md` §6 items 1, 5, 6
(web search comes in M3; images may slip to M6). Items 4–5 and 9 of §9 need a multi-prompt
provider / a remote host and may be verified by unit tests with a stubbed provider.

## M3 — Web search & tool runtime (part of Feature 6)

- `WebSearchProvider` (brave + at least one alternative or a clearly-stubbed `none`),
  `web_search`, `web_fetch` with SSRF guard, caching, per-run rate limit.
- Web-search toggle in chat, specialized tool cards, Sources footer.
- `GET /api/tools`, global enable/disable, `POST /api/tools/web_search/test`, config panel.

**Accept:** `07-chat-mode.md` §6 items 2–3; `05-skills-and-tools.md` B.5 items 1–2.

## M4 — Workspaces (Feature 3)

- Path validation + denylist + roots, create/`git init`, status probing, `validate`, `fs/browse`.
- Workspace list/create/edit/delete UI with the "files are not deleted" confirm.
- Read-only tree + file viewer endpoints and components; git status endpoint.

**Accept:** `04-workspaces.md` §7.

## M5 — Profiles + agent mode (Features 1 & 5)

- Skills catalog **read path** only (enough to select in a profile): scan + list.
- Profile CRUD with AGENTS.md file side-effects, tool/skill selection, validation rules.
- Memory (Phase 0 of decision Q4): toggle, skeleton file format, `parseMemory()`, injection with
  truncation, `memory_append` tool, notice events, memory endpoints + UI panel with the
  "injecting X of Y" readout ([17-memory.md](17-memory.md)).
- `ResolvedProfile` pipeline, ambient-discovery suppression test, `resolveTools` unit tests.
- Agent-mode conversation creation, agent layout, tool cards (`read`/`write`/`edit` diff/`bash`
  streaming/`grep`/`find`/`ls`), side panel (Files, Tools, Profile, Memory, Usage).
- Steering/follow-up segmented control, queue chips, abort-with-restore.
- Retry/compaction notices surfaced.

**Accept:** `03-profiles.md` §8, `17-memory.md` §7, and `08-agent-mode.md` §8.

## M5b — Slash commands & resource discovery (decision Q2)

Slotted after M5 because skills must exist first, but the template half can land in M2 if
convenient.

- `GET /api/conversations/:id/commands`, `GET /api/prompts`, `POST /api/prompts/rescan`.
- Prompt template composition from `$PIUI_HOME/prompts`, `~/.pi/agent/prompts`, and trusted
  project `.pi/prompts`; `expandPromptTemplates: true` passed through to pi.
- `enableSkillCommands: true`; `/skill:<name>` in the menu for the profile's skills.
- `SlashMenu` with `argument-hint`/`location` rendering, Tab-complete, unknown-command refusal.
- Built-in command routing table (`client` / `server` / `expand`).
- `commandEcho` on user messages + "show expanded" disclosure.
- Auto-registration of TUI-discovered skills as `external` catalog entries; profile
  `includeDiscoveredSkills`.
- Workspace trust: `trusted` column, `GET /api/workspaces/:id/project-resources`, trust dialog.

**Accept:** `15-commands-and-input.md` §6 (all ten items).

## M5c — Extensions (decision Q3)

- `domain/extensions.ts`: probe-based enumeration (loader reload → tools/commands/load errors),
  registry refresh, `extensions_changed` SSE.
- Auto-registration of `~/.pi/agent/extensions/*.ts` as `external`.
- Install paths: paste, upload, URL fetch-then-review, register external path; load probe
  gating; step-up; audit log; `PIUI_DISABLE_EXTENSION_INSTALL`.
- `/extensions` page + profile Extensions section (per-profile **disable** switches,
  `allowDynamicExtensionTools`).
- `ToolKind: "extension"` in the catalog and in `resolveTools`.
- `bindExtensions({ mode: "rpc", uiContext, onError })` + the extension UI bridge
  (`ui_request`/`ui_request_resolved`/`status`/`widget` events,
  `POST /conversations/:id/ui-response`, snapshot-restored pending dialogs).
- Extension commands in the `/` menu.
- **Deletions:** remove any approval-gate/denylist code paths and the `confirmDangerous` field.

**Accept:** `16-extensions.md` §10 (all ten items).

## M6 — Skills & tools management UI (Feature 6, remainder)

- Skill create/edit/delete with file tree, frontmatter form, validation panel, templates,
  zip/path/paste import, rescan, trash-on-delete, `usedByProfiles` counts.
- Skill test-run endpoint + ephemeral conversation.
- HTTP tool CRUD + parameter schema builder + test + runtime with SSRF guard.
- Image uploads end-to-end (chat + agent) if not already done.

**Accept:** `05-skills-and-tools.md` A/B acceptance lists (all items).

## M7 — Hardening & polish

- Security headers, CSP, audit log, redaction, run caps, subscriber caps.
- Global `/api/events` channel; live sidebar badges.
- Export (`md`/`json`/`html`), compaction endpoint + "Compact now".
- Empty/loading/error/disconnected states everywhere; command palette; a11y pass; light theme.
- Docs: README (Docker-first install, env table, security/trust-model warning, screenshots),
  `docs/deployment.md` (upgrade, backup, reset, derived images, bare metal),
  `docs/adding-a-provider.md`.
- Deployment polish: multi-arch CI build, SearXNG compose profile,
  `docker-compose.override.yaml.example`, health/posture surfacing in Settings → About
  ([19-deployment.md](19-deployment.md) §9 items 3–5, 8, 10–12).

**Accept:** `11-security.md` items verifiable by test (headers, SSRF, traversal, rate limits),
plus a manual pass over `10-frontend.md` §4.

---

## Test matrix (minimum)

**Unit**
- `resolveTools` for all mode/profile/memory permutations — especially "chat mode yields zero
  filesystem tools".
- `AuthFlow`: prefill auto-answer, multi-prompt sequencing, `promptId` mismatch, TTL expiry,
  cancel-aborts-login, `CredentialSynchronizationError` → success-with-warning.
- Secret hygiene: a fixture key pushed through start/respond/error paths must not appear in
  captured logs, audit lines, or any HTTP response body.
- Path validation: absolute/relative, symlink escape, denylist, roots, traversal.
- Frontmatter parse/compose round-trip; validator error/warning classification.
- Memory append: dedupe, size caps, format, concurrent appends (mutex).
- `parseMemory()` round-trip over the skeleton + conforming, multi-line, non-conforming and
  stray content; stable note ids ([17-memory.md](17-memory.md) §7).
- HTTP tool template substitution + SSRF guard decisions.
- `event-map` projection: a recorded `AgentSessionEvent[]` fixture → expected `UiEvent[]`.
- Command routing: unknown `/word` refused; `client`/`server`/`expand` classification;
  `availableWhileStreaming` gating. Template argument substitution is asserted on **pi's**
  output, never reimplemented.
- Prompt/skill source composition and precedence (piui < user < trusted project), and that an
  untrusted workspace contributes nothing.
- Extension resolution: global set minus profile-disabled equals the exact
  `additionalExtensionPaths` array; deterministic ordering; failed loads excluded and warned.
- Extension tool collisions with built-ins are dropped with a warning; late-registered tools
  are allowed only when `allowDynamicExtensionTools` is on.
- Extension UI bridge: request → response resolution, timeout auto-resolve, pending request
  survives a snapshot, second-tab resolution.
- `transcript` projection: a real pi `.jsonl` fixture → expected `UiMessage[]` (tool call and
  result merged into one block).

**Authorization (integration, with injected principals)**
- Every created row carries the principal's `owner_id`.
- A `role: "user"` principal is `403` on every admin-only surface and `200` elsewhere.
- Cross-user access: `404` for invisible, `403` for visible-but-not-owned, conversations never
  cross users (not even for an admin).
- A `shared` profile is usable but not editable by a non-owner; editable by an admin.
- Grep test: no direct SQL against owned tables outside the repository layer.

**Integration (fastify.inject + a stub model)**
- Full chat round trip with a fake provider returning canned deltas.
- SSE: connect mid-run, reconnect with `Last-Event-ID`, stale `since` → snapshot.
- 409 on concurrent prompt; steer/followUp acceptance; abort restores queue.
- Profile/workspace/skill/tool CRUD happy paths + each documented error code.
- Auth: guard, CSRF, rate limit, logout invalidation.

**E2E (Playwright, thin)**
- login → new chat → send → streamed answer → reload → history intact.
- new workspace → new profile → agent task writing a file → file appears in the Files tab.

**Fixtures**
- Commit a small recorded pi session `.jsonl` and a recorded event stream so projections can be
  tested without a provider.
- Provide a `PIUI_FAKE_MODEL=1` mode that registers a scripted fake model through pi's custom
  provider mechanism (or a `customTools`-only stub session) so the whole stack is testable
  offline. Decide the mechanism by reading pi's `docs/custom-provider.md` and `docs/models.md`.

## Definition of done (V1)

- All six features implemented per their spec files with their acceptance lists passing.
- No pi import outside `server/src/pi/**`; no raw SQL against owned tables outside the
  repository layer.
- `npm run build` produces a single-command production start; documented in the README.
- Zero TypeScript errors with `strict: true`; lint clean; tests green in CI.
- A first-run experience that works with nothing configured but pi credentials: seeded
  profiles, a clear prompt to create a workspace, and a working chat.
