---
id: plan-05
title: M5 — Profiles, memory, agent mode
status: plan
summary: >-
  Skills read path, profile CRUD with file side-effects, the resolution pipeline (resolveTools
  is the correctness centre), memory Phase 0, and the agent-mode transcript and controls.
milestone: M5
est_days: "4–6"
covers: [profiles, resolve-tools, system-prompt, memory, agent-mode, tool-cards, steering]
spec_refs: [03-profiles, 05-skills-and-tools, 08-agent-mode, 17-memory, 09-api]
depends_on: [plan-04]
blocks: [plan-06, plan-07]
risk: high
plan_version: 1
updated: 2026-02-20
---

# M5 — Profiles, memory, agent mode

**Context:** `03-profiles`, `05-skills-and-tools` (part A read path + part B), `08-agent-mode`,
`17-memory`, `09-api` §§4,6,8. (~10k)

**Goal:** the product's reason to exist — pick a profile + workspace, give a task, watch the
agent work with exactly the tools the profile grants.

---

## 1. Skills — read path only

Scan `$PIUI_HOME/skills/*/SKILL.md`, parse frontmatter (`name`, `description`), mirror into the
`skills` table, expose `GET /api/skills` (+ `usedByProfiles`, `missing?`). Full CRUD is M6.
Files on disk stay the source of truth; never store skill bodies only in SQLite.

## 2. Profiles

- `domain/profiles.ts`: CRUD with file side-effects — `$PIUI_HOME/profiles/<id>/AGENTS.md`
  written on save, file wins on external edit, delete moves the directory to
  `$PIUI_HOME/trash/<id>-<ts>/` (never `rm -rf`).
- Routes `09-api.md` §4: list (without `agentsMd`, plus `agentsMdSize`, `usedByConversations`),
  create, get (full + `resolvedTools` + `warnings`), patch, delete
  (`{ affectedConversations }`), duplicate, and the four memory routes.
- Validation: unique name (`profile_name_taken`), tool names must exist in the catalog, skill ids
  must resolve; a deleted skill still referenced yields a **warning**, not a 500
  `[03-profiles#8.5]`.
- UI: profile list + editor (CodeMirror for AGENTS.md, skill selector, tool selector with
  `dangerous` markers, memory toggle, defaults).

## 3. Resolution pipeline

`SessionConfig` → `ResolvedSessionConfig`:
`resolveProfile` → `resolveSkills` → `resolveTools` → `buildSystemPrompt` → `buildAgentsFiles`.

- `resolveTools` is the correctness centre: mode × profile selection × memory × globally
  disabled tools. **Chat mode must yield zero filesystem tools** — the flagship unit test.
- Ambient-discovery suppression test (again, at this layer): a profile's set is the exact set.

## 4. Memory — Phase 0 only (decision Q4 = D)

- Skeleton file on first use: profile-name title + `## Pinned` + `## Notes`
  `[17-memory#7.1]`.
- `parseMemory()` written and unit-tested now even though Phase 0 does not use it: round-trips
  skeleton + two conforming notes + a multi-line note + a non-conforming bullet + a stray
  paragraph, classifying correctly `[17-memory#7.2]`, with **stable note ids** unaffected by
  surrounding edits `[17-memory#7.3]`.
- Injection: tail of the file within the Phase 0 budget, with truncation notice events.
- `memory_append` tool (`pi/tools/memory.ts`): dedupe, size caps, dated line format, per-profile
  **async mutex** for concurrent appends.
- Memory panel shows "injecting X of Y" and states plainly that pinned notes are not yet special
  `[17-memory#7.4]` — no silent half-implementation.

## 5. Agent mode

- Conversation creation requires `profileId` + `workspaceId`; `cwd` = workspace path; tools from
  the profile; AGENTS.md injected when non-empty.
- Immutability: `profileId`/`workspaceId` not patchable once `session_path` is set
  (`409 immutable_after_start`). Missing workspace → clear error, never a 500
  `[08-agent-mode#8.7]`.
- Transcript: tool cards for `read` / `write` / `edit` (diff) / `bash` (streaming stdout) /
  `grep` / `find` / `ls`.
- Agent layout side panel: Files · Tools · Profile · Memory · Usage. Files refetches on `done`.
- Steering / follow-up segmented control, queue chips consumed visibly, abort-with-restore.
- Long-run resilience: retry and compaction notices surfaced as `notice` events; runaway guards
  from `08-agent-mode.md` §6 — **no approval gates** (Q3/Q9).

## 6. Tests

Unit: `resolveTools` permutations · memory append dedupe/caps/mutex · `parseMemory` round-trip ·
system prompt composition.
Integration (fake provider, real `write`/`bash` in a temp workspace): multi-turn tool loop;
steering delivered once; abort during a stalled tool; reload mid-run with no duplicates;
transcript rebuilt from the session file after a server restart.
E2E: workspace → profile → agent writes a file → Files tab shows it.

## 7. Acceptance

`03-profiles.md` §8 (1–5) · `17-memory.md` §7 (1–4) · `08-agent-mode.md` §8 (1–7).
