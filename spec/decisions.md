---
id: decisions
title: Decision log
status: binding
read_first: true
summary: >-
  Answers to the open questions, with reasoning and the list of spec files each decision changed. Overrides anything it contradicts.
covers: [decisions]
depends_on: []
required_by: [all]
decisions: [Q1, Q2, Q3, Q4, Q5, Q6, Q7]
milestones: []
spec_version: 1
updated: 2026-02-20
---

# Decision log

Answers to `13-open-questions.md`. Each entry records the choice, the reasoning, and where the
spec was changed. An implementing agent MUST treat these as binding.

Every file in `spec/` carries YAML frontmatter (`id`, `status`, `summary`, `covers`,
`depends_on`, `required_by`, `decisions`, `milestones`). Use it to find the normative document
for a topic and to read dependencies first; the schema is documented in the README.

| # | Question | Decision | Date |
|---|----------|----------|------|
| 1 | Provider credentials in the UI | **B — API-key management in the UI** (no OAuth in V1) | 2026-02-20 |
| 2 | Skill commands / prompt templates in the composer | **TUI parity** — full `/` command surface + pi's input semantics + TUI-like discovery | 2026-02-20 |
| 3 | pi extensions per profile | **Global install (via UI) + per-profile disable; no approval gates** | 2026-02-20 |
| 4 | Memory evolution | **D — hybrid, phased: pinned + recency, then search; append-only forever** | 2026-02-20 |
| 5 | Per-workspace memory | **A — per profile only; scoped memory designed as a pure addition** | 2026-02-20 |
| 6 | Chat-mode personality | **A — no persona in chat mode; use a capability-free profile in agent mode** | 2026-02-20 |
| 7 | Multi-user | **C — real multi-user planned; ownership + roles enforced from V1, users/UI in V2** | 2026-02-20 |
| 8 | Model for titles/compaction | *open* | |
| 9 | Approval gates for dangerous commands | **Never** — answered by Q3; piui ships none | 2026-02-20 |
| 10 | Sandboxing / containerized execution | *open* | |

---

## Q1 — Provider credentials in the UI → **Option B**

**Decision.** piui manages provider **API keys** from the web UI: view status, add/replace a
key, delete a stored key, test a provider. OAuth and subscription logins remain CLI-only in V1,
but are rendered as visibly disabled options.

**Why it is not just "a text field".** Verified against the installed pi typings: persisting a
key must go through `ModelRuntime.login(providerId, "api_key", interaction)`, which drives an
interactive prompt loop (`AuthPrompt` = `secret` | `text` | `select` | `manual_code`, plus
`AuthEvent` notifications). Some providers ask for more than a key (extra ids land in
`ApiKeyCredential.env`), and providers without `auth.apiKey.login` are ambient-only (env vars,
AWS profiles, ADC) and MUST NOT offer key entry at all. So the UI implements a generic flow
driver, with a prefill fast path that collapses the common case into a single request.

**Compensating controls** (because V1 login is `test`/`test`, and accepting secrets raises the
stakes from "runs commands as me" to "exfiltrates my API keys"):

1. **Step-up re-authentication** — password re-confirmation valid for 10 minutes, required on
   every credential-write route.
2. **`PIUI_DISABLE_CREDENTIAL_WRITES=1`** kill switch for exposed deployments.
3. **`403 insecure_transport`** — refuse key entry when reachable non-locally over plaintext.
4. **Write-only secrets** — no route may read a key back; `listCredentials()` (metadata only)
   is the sole enumeration path.
5. **Route-level log exclusion** (not field redaction — a prompt answer can arrive under any
   field name) plus key-pattern scrubbing of provider error messages.
6. **`0600` / `0700`** mode enforcement on the auth file and its directory after each write.
7. Audit-log entries for login/logout/verify/step-up, never the secret.

**Storage location.** Default remains `~/.pi/agent/auth.json`, **shared with the pi CLI** — that
is what makes a fresh piui install already see your models, and a key added in piui work in the
terminal. The UI states this explicitly; `PIUI_PI_AUTH_PATH` provides isolation for users who
want it, with no migration between the two.

**Spec changes.**
- **New:** `14-credentials.md` — pi API facts, `CredentialService` + `AuthFlow` state machine,
  full HTTP contract, frontend dialog, step-up, security rules, acceptance criteria.
- `09-api.md` §2 — added `POST /api/auth/step-up`, `stepUpValidUntil` on `me`.
- `09-api.md` §3 — replaced the read-only providers route with the credential route table and
  new error codes; `GET /api/models` gains `credentialsRevision` + cache invalidation.
- `09-api.md` §9 — added the `providers_changed` global SSE event.
- `02-data-model.md` — `auth_sessions.step_up_at`.
- `01-architecture.md` — `PIUI_DISABLE_CREDENTIAL_WRITES`, `PIUI_PI_AUTH_PATH` note,
  `server/src/pi/credentials.ts`.
- `10-frontend.md` — `/settings/providers` route, `ProviderTable`/`CredentialDialog`/
  `StepUpDialog`, model-picker and empty-state links.
- `11-security.md` §3 — secrets section rewritten to point at the normative rules.
- `12-milestones.md` — step-up in M1; credentials first in M2; new unit tests.

**Follow-on hook.** Enabling OAuth later is: flip `ProviderAuthMethod.enabledInPiui` for
`oauth`, drop the `501 auth_type_not_supported`, and add a loopback callback route if a provider
needs one. The flow driver already renders `auth_url` / `device_code` / `manual_code`.

---

## Q2 — Slash commands & prompt templates → **TUI parity**

**Stated preference:** *"The default pi TUI works perfectly for me, keep a behavior close to
it."* So piui reproduces the TUI's interaction grammar rather than inventing a web-native one.

**Decision.** Three things, specified in the new [15-commands-and-input.md](15-commands-and-input.md):

1. **Full `/` command surface** — built-ins (`/model`, `/thinking`, `/compact`, `/new`,
   `/name`, `/session`, `/resume`, `/copy`, `/export`, `/settings`, `/hotkeys`,
   `/login`), `/skill:<name>` for the profile's skills, and prompt templates with pi's
   `description` / `argument-hint` dropdown rendering. Terminal-only commands (`/quit`,
   `/reload`, `/share`, `/llama`, …) are dropped with documented replacements; `/tree`,
   `/fork`, `/clone` are gated behind the `[LATER]` branch navigator. An unknown `/word` is
   refused inline and never sent as a prompt.
2. **pi's input semantics** — `Enter` sends when idle and *steers* while streaming,
   `Alt+Enter` queues a follow-up, `Esc` aborts **and restores queued text to the composer**,
   `Alt+Up` dequeues, `Shift+Enter`/`Ctrl+J` newline, `Ctrl+G` opens a full-screen editor,
   `Ctrl+V` pastes images. Browser-reserved keys are remapped with the mapping shown in
   `/hotkeys`: `Ctrl+T`→`Alt+T` (thinking), `Ctrl+O`→`Alt+O` (tool output), `Ctrl+L`→`Alt+M`
   (model), `Ctrl+P`→`Alt+P` (cycle model), `Ctrl+X`→`Alt+C` (copy answer).
3. **Argument expansion stays pi's job** — piui passes raw text with
   `expandPromptTemplates: true`; it must never reimplement `$1` / `$@` / `${1:-default}` /
   `${@:N:L}`.

**The interesting tension.** TUI parity collides with the original "a profile is the single
source of truth, suppress all ambient discovery" rule. Resolved by splitting per resource type:

| Resource | Behavior |
|----------|----------|
| Prompt templates | **Discovered like the TUI**: `$PIUI_HOME/prompts` < `~/.pi/agent/prompts` < trusted `<workspace>/.pi/prompts`, non-recursive, `location` badges showing shadowing. Templates that work in your terminal work here. |
| Skills | **Discovered into the catalog, activated per profile.** Everything the TUI would load appears in the skills UI (auto-registered as `external`), but a profile ticks what it wants — plus an `includeDiscoveredSkills` flag that reproduces exact TUI behavior in one checkbox. Reason: the TUI puts every discovered skill's description in every system prompt; piui shows the same inventory while keeping that cost visible, and the Skills/Tools panel must not lie about what the agent can load. |
| Project trust | pi's `/trust` prompt becomes `workspaces.trusted` + a dialog listing exactly which project resources were found, shown at registration. |
| Extensions, project `.pi/settings.json` | Still fully suppressed (extensions are Q3; settings are piui-owned). The trust dialog says so explicitly so trust does not overpromise. |

**Transcript rendering.** A `/skill:` or `/template` message renders as the **typed command**
with a "show expanded" disclosure (`UiMessage.commandEcho`), not as the expanded body —
otherwise one skill invocation buries the conversation.

**Spec changes.**
- **New:** `15-commands-and-input.md` — command surface, routing, discovery, key semantics,
  keybinding mapping, acceptance criteria.
- `01-architecture.md` — `promptsOverride` now composes three sources; `enableSkillCommands:
  true`; ambient-suppression claim amended.
- `02-data-model.md` — `profiles.include_discovered_skills`, `workspaces.trusted` +
  `trust_decided_at`, `$PIUI_HOME/prompts/`, `UiMessage.commandEcho`.
- `03-profiles.md` — `includeDiscoveredSkills` field; `ResolvedProfile.prompts`.
- `05-skills-and-tools.md` — auto-registration of TUI-discovered skills; rescan covers them.
- `08-agent-mode.md` §4 — key semantics supersede the segmented steer control.
- `09-api.md` — `GET /conversations/:id/commands`, `GET /api/prompts`,
  `POST /api/prompts/rescan`, `GET /workspaces/:id/project-resources`, `trusted` on PATCH.
- `10-frontend.md` — `Composer` semantics, `SlashMenu`, `HotkeysDialog`, keyboard section.
- `12-milestones.md` — input parity in M2; new **M5b** for commands & discovery; new tests.

---

## Q3 — pi extensions → **global, UI-installable, per-profile disable, no gates**

**Stated preference:** *"I never want approval gates. Extensions can be set up across all
profiles. Assess if per-profile disable is possible; keep it only if very easy. I don't want much
complexity here. I want to install extensions through the UI."*

**Decision.** Specified in [16-extensions.md](16-extensions.md):

1. **No approval gates, anywhere.** piui contains zero tool-call confirmation logic. The
   confirm-before-dangerous-command toggle, the `bash` denylist, and the
   `conversations.confirm_dangerous` column are **deleted** from the spec. Kept: the
   `PIUI_MAX_RUN_MINUTES` runaway-cost abort, dangerous-tool audit logging, and the `dangerous`
   UI badge. Anyone wanting gating installs an extension that does it.
2. **Extensions are global**, enabled by default everywhere, installed explicitly. Ambient
   `~/.pi/agent/extensions/*.ts` are auto-registered as `external` and enabled (consistent with
   Q2's "the TUI inventory is visible"). Project `.pi/extensions` are never loaded, trust or no
   trust — registering a folder must not mean executing that repo's code.
3. **Per-profile disable: assessed EASY, kept.** `DefaultResourceLoaderOptions` exposes
   `noExtensions` + `additionalExtensionPaths`, and piui already builds one loader per
   conversation. So the entire feature is: `additionalExtensionPaths = globalEnabled minus
   profileDisabled`. One array filter, one join table (`profile_disabled_extensions`), no
   pi-side plumbing. It is an opt-**out** list so the default stays "extensions just work".
4. **Install from the UI**: paste source, upload a `.ts`, register an existing path, or fetch
   from a URL — where fetch **never** auto-installs: the source is shown in a read-only editor
   behind a mandatory "I have reviewed this code" checkbox. Every install runs a **load probe**
   (a throwaway loader reload) so a broken extension is rejected at install time, and the probe
   reports which tools/commands it registers so the user sees what they are adding.
   Step-up re-auth + audit log with origin and source SHA-256.
   `PIUI_DISABLE_EXTENSION_INSTALL=1` turns all of it off.

**The two non-obvious integration points** (where complexity actually lives — unavoidable, but
contained):

- **Extension-registered tools.** `ToolKind` gains `"extension"`. Names are enumerated from a
  loader probe (`LoadExtensionsResult.extensions[].tools`) and cached, so they are selectable in
  the profile editor. Because pi allows `registerTool()` *after* startup, the cache can be
  incomplete — handled by one profile checkbox, `allowDynamicExtensionTools` (default **on**),
  which appends runtime-registered names to pi's `tools` allowlist. Without this, a late-
  registering extension would be silently crippled by the allowlist.
- **Extension dialogs.** Extensions may call `ctx.ui.confirm()/select()/input()/editor()`. piui
  binds with `bindExtensions({ mode: "rpc", ... })` — pi's RPC mode documents exactly which UI
  methods work and which degrade, so piui inherits a specified contract. New `ui_request` /
  `ui_request_resolved` / `status` / `widget` UI events plus
  `POST /conversations/:id/ui-response`, with pending dialogs restored from `snapshot` after a
  reload. **This is a dialog bridge, not an approval gate** — piui prompts for nothing on its
  own.

**Security posture, stated rather than mitigated.** An extension is arbitrary TypeScript in the
server process — the same privilege the agent's `bash` tool already has, so installing one is
not a real escalation over normal piui use. Installing one *from an unread URL* is, hence the
review gate. No sandbox; that is Q10.

**Spec changes.**
- **New:** `16-extensions.md` — feasibility proof, model, storage, resolution, tool/command
  enumeration, UI bridge, install flows, security, API, acceptance criteria.
- `01-architecture.md` — loader now `noExtensions: true` + filtered paths; `bindExtensions`;
  `PIUI_DISABLE_EXTENSION_INSTALL`; `domain/extensions.ts`.
- `02-data-model.md` — `extensions` + `profile_disabled_extensions` tables,
  `profiles.allow_dynamic_extension_tools`, `$PIUI_HOME/extensions/`, `ToolKind` +
  `"extension"`, four new `UiEvent` variants.
- `03-profiles.md` — `disabledExtensionIds`, `allowDynamicExtensionTools`,
  `ResolvedProfile.extensionPaths`.
- `05-skills-and-tools.md` — fourth tool kind; `resolveTools` signature and allowlist rule.
- `08-agent-mode.md` §6 — approval gates **removed**, section retitled "Runaway guards".
- `09-api.md` — new §7b extension routes, `ui-response`, `extensions_changed` event,
  `confirmDangerous` removed from PATCH.
- `10-frontend.md` — `/extensions` route, install/editor components, `ExtensionUiModal`.
- `11-security.md` — arbitrary-code statement, no-gates statement, audit additions.
- `15-commands-and-input.md` — `source: "extension"` commands; project-extension note.
- `12-milestones.md` — new **M5c**; new tests.

---

## Q4 — Memory evolution → **Option D (hybrid, phased)**

**Decision.** `memory_append` remains the **only** agent write path, permanently. Structure
arrives as convention, not mechanism. Phasing, specified in [17-memory.md](17-memory.md):

| Phase | Content | Trigger |
|-------|---------|---------|
| **0 — V1** | Exactly what `03-profiles.md` §5 already specifies: append-only notes, last 32 KB injected | ships now |
| **1 — `[LATER]`** | `## Pinned` injected **in full, always** + the N most recent notes within a 24 KB budget + an omitted-count line; human-only pin/unpin | when a memory file passes ~16 KB, or sooner if pinning is wanted for correctness |
| **2 — `[LATER]`** | `memory_search` over an SQLite **FTS5** index rebuilt from the file, plus a table-of-contents line in the injected block so the model knows to search | when a file passes ~100 KB |
| 3 | Embeddings — a hypothesis, not a plan. Only if keyword search measurably fails | — |

**Reasoning.** Two constraints: (a) a note is useful only if it is *in context* or *reliably
retrieved*, and retrieval-by-tool-call is precisely the mechanism pi's own docs warn about for
skills (*"models don't always do this"*) — so must-never-forget notes cannot depend on the model
choosing to search; (b) anything the agent can rewrite, it can quietly destroy, and you cannot
audit information that silently disappears. Hence pinning for determinism, recency for
relevance, search for scale, append-only for auditability. Option B (agent rewrites its own
memory) is explicitly rejected as the next step for exactly this reason.

**The one thing this decision changes in V1** — and the reason it was worth answering now: the
**file format is fixed today** so no phase ever needs a migration. V1 must

1. create `memory.md` with the skeleton (`# Memory — <name>`, `## Pinned`, `## Notes`),
2. append notes under `## Notes` in the existing dated-bullet format,
3. implement and unit-test `parseMemory()` → `{ pinned, sections[], raw }` even though Phase 0
   only consumes `raw`,
4. derive note identity as `sha256(normalized text)[0..12]` — no ids in the file, which is why
   dedupe already works and why later phases can address notes without a format change,
5. parse tolerantly: hand-written non-conforming content is preserved verbatim, because a human
   editing the file badly must never break the agent,
6. say so in the UI — the Memory panel states that pinned notes become always-injected in a
   future version, rather than shipping a heading that silently does nothing.

**Invariants every phase preserves:** append-only for the agent; the file is the source of truth
and any index is disposable; memory is per profile and invisible to chat mode; every injection is
inspectable ("injecting 18 KB of 64 KB") and every agent write emits a transcript `notice`;
human curation (view/edit/download/clear) is always available.

**Deliberately not granted to the agent:** `memory_append({ pin: true })`. Letting the model
decide what sits in *every* prompt is how context budgets die. Revisit only with evidence.

**Spec changes.**
- **New:** `17-memory.md` — rationale, normative file format, per-phase injection budgets,
  Phase 1 pinning/prompt wording/API, Phase 2 FTS5 design, cross-phase invariants, V1
  acceptance additions.
- `03-profiles.md` §5 — marked Phase 0; skeleton + `parseMemory()` required in V1; Memory panel
  gains the injection readout and the pinning-is-coming note.
- `12-milestones.md` — M5 memory item points at Phase 0; new parser unit tests; M5 acceptance
  includes `17-memory.md` §7.

---

## Q5 — Per-workspace memory → **Option A (per profile only)**

**Decision.** Memory stays keyed by **profile** alone, shared across every conversation using
that profile. No project/workspace dimension in V1.

**Reasoning.** Which notes are genuinely project-scoped versus globally true is an empirical
question, and getting it wrong means the agent appends to the wrong file — a failure mode that
cannot occur with a single file. The known downside (a repo-specific fact like *"the build uses
pnpm"* following the profile into unrelated repos) is already partially mitigated by the injected
instruction from `03-profiles.md` §5.2: *prefer current evidence over stale notes, and record a
correction*. That is a mitigation rather than a fix, and it is accepted for V1.

**Designed expansion (not built):** option C — two memory files, both injected:
`<profileDir>/memory.md` for stable preferences and `<profileDir>/memory/<workspace-slug>.md`
for project facts. Q4's format decision makes this a **pure addition**: more files, not a
different format. The landing path is

1. `memory_append` gains optional `scope: "profile" | "project"`, defaulting to `"profile"`
   (so existing behavior is untouched),
2. `ResolvedProfile.agentsFiles` gains a second memory block,
3. the Memory panel gains a tab per scope,
4. no schema migration — the path is derived from the profile id and workspace slug.

Revisit when a real `memory.md` shows observable cross-project pollution. Tracked in
`13-open-questions.md` §B and `17-memory.md` §6 item 3.

**Spec changes.** `17-memory.md` §6 item 3 already states the invariant ("memory is per profile;
a future workspace dimension means more files, not a different format"); `13-open-questions.md`
Q5 marked answered with the option-C hook recorded in the `[LATER]` table. No other file changes
— which is the point of choosing A.

---

## Q6 — Chat-mode personality → **Option A (keep chat clean)**

**Decision.** Chat mode gets no persona mechanism: no per-conversation instructions field, no
chat presets, and profiles do not apply to it. The chat system prompt stays fixed apart from the
web-search block.

**Supported alternative when a framing is wanted:** agent mode with a **capability-free
profile** — `toolNames: []`, no skills, memory off. `03-profiles.md` §4 already allows an empty
tool selection, so "a persona with no capabilities" is an existing, tested configuration. The
only friction is that agent mode requires a workspace selection.

**Reasoning.** Chat mode exists to be cheap and predictable — a unit test already asserts its
system prompt contains none of pi's coding prompt and that it resolves zero tools. Adding a
persona surface erodes exactly that property, and option D (applying a profile's `AGENTS.md`
with tools stripped) is actively harmful: instructions written for an agent (*"use `read` before
editing"*) would produce a chat assistant that offers to edit files it cannot see. Option B (a
free-text box) was cheap but would have been a second, non-reusable instruction surface; if
retyping the same framing ever becomes a habit, that is the evidence to promote it — and a
`conversations.instructions` column plus the existing prompt composer is all it would take.

**Spec changes.** `07-chat-mode.md` gains §1.1 recording the decision, the workaround, and the
rationale (so it is not silently re-opened); `13-open-questions.md` Q6 marked answered with the
hook in the `[LATER]` table. No schema, API, or frontend change — again the point of choosing A.

---

## Q7 — Multi-user → **Option C (plan it; enforce the model from V1)**

**Decision.** piui is a multi-user application by design. V1 still runs with exactly one user,
but the **authorization model is enforced from day one**; V2 adds users, auth providers and
sharing UI on top without a rewrite. Normative in [18-multi-user.md](18-multi-user.md).

**What V1 builds** (the expensive-to-retrofit part, roughly a day):

1. `users` table with one seeded row (`id = 'local'`, `role = 'admin'`).
2. `owner_id TEXT NOT NULL` + `visibility TEXT NOT NULL DEFAULT 'private'` on profiles,
   workspaces, skills and HTTP tools; `owner_id` on conversations (always private).
3. A **repository layer that takes the request principal** — no raw SQL in route handlers —
   with two predicates: read = `owner_id = :me OR visibility = 'shared'`,
   write = `owner_id = :me OR :me.role = 'admin'`.
4. `403 forbidden` role checks on the admin-only surfaces: all of `/api/providers/*` and
   `/api/extensions/*`, `PATCH /api/tools/:name`, every `*/rescan`, settings, audit reads, and
   `GET /api/fs/browse` for non-admins.
5. `404`-for-invisible vs `403`-for-not-writable, so existence never leaks.

With one admin user none of this is observable — it is dormant enforcement, not simulated
multi-tenancy. Tests inject a `role: "user"` principal to exercise it; no user-management UI
exists in V1.

**Resource classification** (the actual decision; everything else follows):
conversations are owned and **always private, even from admins** — sharing a transcript is an
export, not an ACL. Profiles, workspaces, skills and HTTP tools are owned and *shareable*.
Provider credentials, extensions, global tool toggles, prompt-template files and server settings
are **global and admin-only** — because `ModelRuntime` is process-wide and extension code runs
in the shared server process, so a per-user variant of either would be fiction. Keeping those
two admin-only is what stops the role distinction from being cosmetic, and it revises the
Q1/Q3 surfaces accordingly.

**The honest caveat, documented rather than papered over** (`18-multi-user.md` §6 and
`11-security.md`): multi-user piui is **not a security boundary between users**. Every run
executes as the piui process owner, so a `user` with `bash` in their profile can read other
users' data, the SQLite file and `auth.json` directly. `owner_id` governs the API, not the
filesystem. Roles prevent accidents and config tampering; they do not contain a determined
insider. V2 multi-user therefore targets **mutually trusting users**, and the README must say:
*give piui accounts only to people you would give a shell account to.* The only real fix is
per-run execution isolation — which is Q10.

**V2 scope, designed not built:** user CRUD (admin), `HtpasswdAuthProvider` /
`OidcAuthProvider` behind the existing `AuthProvider` interface, password changes, the
private/shared toggle UI, per-user prompt-template dirs, per-user `ModelRuntime` with per-user
`authPath` (the one genuinely invasive item, since V1 shares a single runtime), per-user cost
quotas, and an admin dashboard. None of it requires changing the V1 schema beyond adding
columns and tables.

**Spec changes.**
- **New:** `18-multi-user.md` — V1 obligations, users/roles, resource classification, the
  scoping rule, admin-only surfaces, isolation limits, V2 scope, seeding, acceptance criteria.
- `02-data-model.md` — `users` table, `owner_id`/`visibility` on owned tables,
  `auth_sessions.user_id`, `Owned` interface, owner-scoped conversation index, repository rule.
- `06-auth.md` §7 — rewritten from "readiness" to enforced model, pointing at spec 18.
- `09-api.md` — authorization paragraph in §0, `roles` on `me`, scoping notes on profile routes,
  new §7a users routes (`[V2]`, `404` in V1).
- `14-credentials.md`, `16-extensions.md` — write routes marked admin-only with the reason.
- `11-security.md` — the not-a-security-boundary statement.
- `12-milestones.md` — repository layer + seeded admin in M0, authorization in M1, a new
  authorization test group, and the no-raw-SQL rule in the definition of done.
