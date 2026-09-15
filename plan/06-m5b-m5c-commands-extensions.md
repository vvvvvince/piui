---
id: plan-06
title: M5b — Slash commands & discovery · M5c — Extensions
status: plan
summary: >-
  The slash-command surface, prompt-template composition and workspace trust; then extension
  install/probe/resolution, per-profile disable, the UI bridge, and deletion of approval gates.
milestone: [M5b, M5c]
est_days: "5–7"
covers: [slash-commands, prompt-templates, workspace-trust, extensions, ui-bridge]
spec_refs: [15-commands-and-input, 16-extensions, 09-api]
depends_on: [plan-05]
blocks: [plan-07]
plan_version: 1
updated: 2026-02-20
---

# M5b — Slash commands & discovery · M5c — Extensions

---

# M5b — Slash commands, prompt templates, workspace trust (decision Q2)

**Context:** `15-commands-and-input`, `09-api` §8 commands/prompts. (~3.5k)

## Work

- `GET /api/conversations/:id/commands` → `CommandDescriptor[]`: built-ins + the profile's skills
  (`/skill:<name>`, requires `enableSkillCommands: true`) + prompt templates from all enabled
  sources. Shape per `15-commands-and-input.md` §1.
- Prompt template composition and precedence: `$PIUI_HOME/prompts` < `~/.pi/agent/prompts` <
  trusted `<workspace>/.pi/prompts`. An **untrusted workspace contributes nothing** — unit-tested.
  `expandPromptTemplates: true` passed through to pi; **argument substitution is asserted on pi's
  output, never reimplemented**.
- `GET /api/prompts`, `POST /api/prompts/rescan` (admin-only).
- Client `SlashMenu`: filtering, `argument-hint`/`location` rendering, Tab-complete, and an
  explicit **refusal of unknown `/word`** rather than sending it as text.
- Routing table: `client` / `server` / `expand` classification + `availableWhileStreaming` gating.
- `commandEcho` on user messages with a "show expanded" disclosure.
- TUI-discovered skills auto-registered as `source: "external"` catalog entries; profile flag
  `includeDiscoveredSkills`.
- Workspace trust: `trusted` column + `trust_decided_at`,
  `GET /api/workspaces/:id/project-resources`, trust dialog in the UI.

## Acceptance

`15-commands-and-input.md` §6 — all ten items.

---

# M5c — Extensions (decision Q3: global install + per-profile disable, no approval gates)

**Context:** `16-extensions`, `09-api` §7b. (~3.6k) Spike **S9** first.

## Work

- `domain/extensions.ts`: probe-based enumeration — a loader reload reports tools, commands and
  load errors; persist into `extensions` (`tools_json`, `commands_json`, `load_error`); refresh
  the registry and emit `extensions_changed` on the global SSE channel.
- Auto-register `~/.pi/agent/extensions/*.ts` as `external`.
- Install paths: paste · upload · **fetch-URL-then-review** · register an external path. Each
  gated by a load probe, step-up, and an audit log entry; all refused when
  `PIUI_DISABLE_EXTENSION_INSTALL=1` (`extension_install_disabled`). Size cap →
  `extension_too_large`.
- Resolution (unit-tested): `additionalExtensionPaths` = global enabled set **minus** the
  profile's disabled set, deterministic ordering, failed loads excluded and warned.
- Collisions with built-in tool names are dropped with a warning; late-registered extension tools
  are allowed only when the profile's `allowDynamicExtensionTools` is on.
- `ToolKind: "extension"` in the catalog and in `resolveTools`.
- **UI bridge**: `bindExtensions({ mode: "rpc", uiContext, onError })` →
  `ui_request` / `ui_request_resolved` / `status` / `widget` SSE events +
  `POST /api/conversations/:id/ui-response`. A pending dialog must survive a snapshot and be
  resolvable from a second tab; timeouts auto-resolve.
- Extension commands appear in the `/` menu.
- **Deletions**: remove every approval-gate/denylist code path and the `confirmDangerous` field.
  Q3/Q9 say piui ships none — leaving dead gating code is a spec violation, not caution.

## Acceptance

`16-extensions.md` §10 — all ten items.
