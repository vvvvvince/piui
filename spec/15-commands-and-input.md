---
id: 15-commands-and-input
title: Slash commands, prompt templates, TUI-parity input
status: normative
summary: >-
  Decision Q2. The / command surface (built-ins, skills, templates, extension commands), execution routing, resource discovery, workspace trust, pi's queue key semantics and keybinding mapping.
covers: [slash-commands, prompt-templates, skill-commands, resource-discovery, workspace-trust, keybindings, message-queue]
depends_on: [05-skills-and-tools, 08-agent-mode]
required_by: [10-frontend]
decisions: [Q2]
milestones: [M2, M5b]
spec_version: 1
updated: 2026-02-20
---

# 15 — Slash commands, prompt templates, and TUI-parity input

> **Decision Q2 = "TUI parity"**: the composer behaves like pi's interactive editor. `/`
> autocomplete over extension-less commands + skills + prompt templates, pi's message-queue
> semantics (Enter / Alt+Enter / Esc / Alt+Up), and pi's toggles. Where a pi binding is
> impossible in a browser, a documented equivalent is provided.

## 1. Command surface

pi's TUI opens command completion on `/` and mixes three sources (`docs/usage.md`,
`docs/prompt-templates.md`, `docs/skills.md`). piui does the same. pi's RPC `get_commands`
already defines the shape piui mirrors: `{ name, description?, source, location?, path? }` with
`source ∈ { extension, prompt, skill }`.

### 1.1 `GET /api/conversations/:id/commands`

```ts
200 {
  items: {
    name: string;              // "skill:brave-search", "review", "model"
    display: string;           // "/skill:brave-search"
    description: string;
    argumentHint?: string;     // from prompt-template frontmatter, e.g. "<PR-URL>"
    source: "builtin" | "prompt" | "skill" | "extension";
    location?: "piui" | "user" | "project";
    kind: "client" | "server" | "expand";   // how the client executes it (§2)
    availableWhileStreaming: boolean;
  }[]
}
```

Computed per conversation, because skills come from the conversation's **profile**, prompt
templates depend on the **workspace** (project-level templates), and extension commands depend
on which extensions the profile leaves enabled ([16-extensions.md](16-extensions.md) §4). Cached in the `LiveSession`,
invalidated by `skills_changed` / profile edits / `POST /api/prompts/rescan`.

### 1.2 Built-in commands (`source: "builtin"`)

Mapped to piui equivalents of the pi TUI commands. `[V1]` unless marked.

| Command | pi TUI meaning | piui behavior | kind |
|---------|----------------|---------------|------|
| `/model` | model selector | opens `ModelPicker` | client |
| `/thinking` | thinking level | opens `ThinkingPicker` | client |
| `/compact [prompt]` | manual compaction | `POST /conversations/:id/compact` with the argument as `customInstructions` | server |
| `/new` | new session | opens `NewConversationDialog` prefilled with the current mode/model/profile/workspace | client |
| `/name <name>` | session display name | `PATCH /conversations/:id { title }` (sets `titleLocked`) | server |
| `/session` | session file, id, tokens, cost | opens the Usage panel; renders `GET /conversations/:id/stats` as a system notice | client |
| `/resume` | pick a previous session | opens the conversation list filtered to the current workspace | client |
| `/copy` | copy last assistant message | clipboard copy, toast | client |
| `/export [file]` | export session | `GET /conversations/:id/export?format=md` download; `/export html` and `/export json` accepted | server |
| `/settings` | preferences | navigates to `/settings` | client |
| `/hotkeys` | shortcut list | opens the shortcut dialog (§4.3) | client |
| `/login`, `/logout` | credential management | navigates to `/settings/providers` (Q1 = B) | client |
| `/tree` | jump to any point in the session | `[LATER]` — hidden until the branch navigator exists (`09-api.md` §8 fork block) | client |
| `/fork`, `/clone` | branch the session | `[LATER]` — same gate | server |
| `/quit`, `/trust`, `/reload`, `/share`, `/import`, `/llama`, `/scoped-models`, `/changelog` | — | **not implemented**. `/trust` is replaced by the workspace trust toggle (§3.3); `/reload` by `POST /api/skills/rescan` + `/api/prompts/rescan`; the rest are terminal-specific. | — |

Commands absent from the menu MUST NOT be silently sent to the model. If the user submits an
unknown `/word`, the client shows an inline error *"Unknown command `/word`. Type `/` to see
available commands."* and keeps the text in the composer — never sends it as a prompt
(pi's TUI behaves this way; a typo'd `/compcat` must not become a message).

### 1.3 Skills — `/skill:<name> [args]`

- Listed for every skill selected by the conversation's profile (chat mode: none — chat has no
  profile, so the skill section is simply absent).
- Execution: sent verbatim as the prompt text; **pi expands it** (`docs/rpc.md`: skill commands
  and prompt templates are expanded before sending/queueing). `kind: "expand"`.
- Requires `enableSkillCommands: true` in the piui-owned `SettingsManager` — this **overrides**
  the earlier note in `05-skills-and-tools.md` that suggested disabling it.
- Arguments after the command are appended by pi as `User: <args>`.
- The transcript MUST render the user message as the **typed command** (`/skill:pdf-tools
  extract`), not the expanded body, with a "show expanded" disclosure. Rationale: an expanded
  skill body is hundreds of lines and would bury the conversation. The expansion is recoverable
  from the session file, so the client renders `UiMessage.blocks[0].text` but the server
  additionally provides `commandEcho?: { typed: string; expandedChars: number }` on the user
  `UiMessage` when it detects a command expansion.

### 1.4 Prompt templates — `/<name> [args]`

Full pi semantics, no subset:

- Frontmatter `description` (falls back to the first non-empty line) and `argument-hint`
  rendered in the dropdown exactly as pi does: `→ pr  <PR-URL>  — Review PRs …`.
- Argument substitution is **pi's job**, not piui's: `$1`, `$2`, `$@`/`$ARGUMENTS`,
  `${1:-default}`, `${@:-default}`, `${@:N}`, `${@:N:L}`. piui passes the raw text to
  `session.prompt()` / `steer()` / `followUp()` with `expandPromptTemplates: true` (pi's
  `PromptOptions`). **Do not reimplement the substitution grammar.**
- Quoted arguments work because pi parses them (`/component Button "click handler"`).
- Same transcript rendering rule as skills (`commandEcho`).

## 2. Execution routing (client)

On submit, the client inspects the leading token:

1. No leading `/` → normal prompt.
2. `/` + a name whose command has `kind: "client"` → execute locally, **do not** call the
   messages API, clear the composer.
3. `kind: "server"` → call the mapped endpoint; render the result as an inline system notice.
4. `kind: "expand"` (skills, templates) → `POST /conversations/:id/messages { text }` unchanged;
   the server passes it to pi with expansion enabled.
5. Unknown → the inline error from §1.2.

`availableWhileStreaming`: `/compact`, `/new`, `/fork` are false (they need an idle session and
return `409 conversation_busy`); pickers, `/copy`, `/session`, `/hotkeys`, `/export` are true.
Skills and templates are true — they queue as steering/follow-up like any prompt.

## 3. Resource discovery — how TUI-like is it?

pi's TUI discovers prompts and skills from `~/.pi/agent/…`, the project, packages, and settings.
The original piui spec suppressed **all** ambient discovery so that a profile is the single
source of truth. "Behave like the TUI" collides with that, so the resolution is split by
resource type:

### 3.1 Prompt templates — discovered like the TUI `[changed]`

Loaded from, in increasing precedence:
1. `$PIUI_HOME/prompts/*.md` — piui-managed (CRUD in the UI, `[LATER]` editor; V1 = the folder
   exists and is read),
2. `~/.pi/agent/prompts/*.md` — the user's existing pi templates (**this is the point of the
   decision**: templates that work in the terminal work here),
3. `<workspace>/.pi/prompts/*.md` — project templates, **only when the workspace is trusted**
   (§3.3).

Non-recursive, matching pi. Name collisions: later source wins, and the menu shows the
`location` badge (`piui` / `user` / `project`) so the shadowing is visible. Implemented via
`DefaultResourceLoader`'s `promptsOverride` composing the three sets, or by letting the loader
discover and then merging in the piui set — whichever the installed API makes clean.
Chat mode gets sources 1 and 2 (no workspace, so no project templates).

### 3.2 Skills — discovered *into the catalog*, activated *per profile* `[unchanged behavior, new discovery]`

Skills stay profile-controlled (that is feature #1's contract, and the Tools/Skills panel must
tell the truth about what the agent can load). But discovery becomes TUI-like:

- On boot and on rescan, piui auto-registers as `source: "external"` catalog entries every skill
  found in `~/.pi/agent/skills/`, `~/.agents/skills/`, and — for trusted workspaces —
  `<workspace>/.pi/skills/` and `.agents/skills/` (pi's ancestor walk).
- They appear in the skills UI with a `location` badge and are read-only there.
- They are **not** auto-enabled in any profile. The user ticks them like any other skill.
- Rationale: pi's TUI loads every discovered skill's description into every request's system
  prompt. With a few dozen skills that is real context cost the user cannot see. piui shows the
  same inventory but makes activation explicit, which is strictly more controllable and still
  "no surprises relative to the terminal" — everything you had is there, one checkbox away.
- A profile-level convenience: **"Include all discovered skills"** checkbox (stored as
  `profiles.include_discovered_skills INTEGER NOT NULL DEFAULT 0`). Ticking it reproduces exact
  TUI behavior for users who want it, and the profile page then shows the resulting count and an
  estimated system-prompt cost.

### 3.3 Workspace trust — replaces pi's `/trust` prompt `[new]`

pi asks before trusting a project folder and records the decision in `trust.json`
(`docs/settings.md`). piui does the equivalent:

- New column `workspaces.trusted INTEGER NOT NULL DEFAULT 0` and
  `workspaces.trust_decided_at TEXT`.
- When a workspace is registered and contains `.pi/` (settings, prompts, skills, extensions) or
  `.agents/skills`, the create/edit form shows: *"This folder contains project-level pi
  resources. Trust it to load its prompt templates and skills?"* with Trust / Don't trust, and
  a list of exactly what was found.
- Untrusted → project prompts/skills are not loaded and the workspace card shows a "project
  resources available — review" affordance.
- Project `.pi/settings.json` is **never** loaded (piui owns settings) and project
  `.pi/extensions` is **never** loaded regardless of trust (decision Q3 — extensions are global
  and installed explicitly, see [16-extensions.md](16-extensions.md) §2.2). The trust
  dialog must say so, so trust does not overpromise.
- Toggleable later from the workspace detail page; changing it invalidates command caches and
  applies to the next prompt.

### 3.4 Not discovered, deliberately

Packages (`pi.prompts` / `pi.skills` in `package.json`), pi `settings.json` `prompts`/`skills`
arrays, and pi extensions. Add `[LATER]` if the need appears; the settings-array case is the
most likely next step and maps onto §3.1/§3.2 as a fourth source.

## 4. Input behavior — pi's editor semantics in a browser

### 4.1 Message queue (normative, matches `docs/usage.md` "Message Queue")

| Situation | Key | Behavior |
|-----------|-----|----------|
| Idle | `Enter` | send prompt |
| Idle | `Shift+Enter` / `Ctrl+J` | newline |
| **Streaming** | `Enter` | queue as **steering** (`streamingBehavior: "steer"`) |
| **Streaming** | `Alt+Enter` | queue as **follow-up** (`streamingBehavior: "followUp"`) |
| Streaming or idle | `Esc` | **abort and restore queued messages to the composer** — `POST /abort`, take `restored.steering`/`restored.followUp` and place them in the composer (joined with `\n\n` when multiple), preserving anything already typed by appending below it |
| Streaming | `Alt+Up` | dequeue: `POST /queue/clear` and move the returned texts into the composer without aborting |

This **supersedes** the segmented "Steer now / After it finishes" control in
`08-agent-mode.md` §4 as the *primary* mechanism: keep a small, non-modal indicator showing
"Enter steers · Alt+Enter queues" while streaming, plus the queue chips. A visible dropdown may
remain for discoverability but must not change the default key semantics.

`steeringMode` / `followUpMode` (pi's `all` vs `one-at-a-time`) are exposed in `/settings` with
pi's defaults (`all` for steering, `one-at-a-time` for follow-up) and passed through to the
session.

### 4.2 Editor behaviors worth copying

- **Prompt history**: `Up`/`Down` at the first/last line cycle previously sent prompts for this
  conversation (persisted per conversation in `localStorage`, capped at 100). pi has dedicated
  history actions; browser `Up`/`Down` at the boundary is the closest natural equivalent.
- **`Ctrl+G` external editor** → opens a full-screen composer modal (CodeMirror, markdown,
  soft-wrapped) whose content replaces the composer on save. Same intent: write a long prompt
  comfortably.
- **`Ctrl+V` image paste** and drag-and-drop, matching `app.clipboard.pasteImage`.
- **Autocomplete interaction**: `/` at the start of an empty composer opens the menu; typing
  filters fuzzily; `Tab` completes the highlighted name and leaves the cursor after a space;
  `Up`/`Down` navigate; `Enter` accepts the highlighted item (does **not** send); `Esc` closes
  the menu (and only then does `Esc` abort). Exactly pi's precedence: a dropdown swallows the
  key first.
- **`@file` completion** `[LATER]`: pi accepts `@files` on the CLI. In agent mode a `@` trigger
  offering workspace-relative paths (from `GET /workspaces/:id/tree`) inserting a plain relative
  path is a natural addition; out of V1 scope but do not use `@` for anything else.

### 4.3 Toggles and pickers

| pi action | pi key | piui key | Note |
|-----------|--------|----------|------|
| Collapse/expand thinking | `Ctrl+T` | `Alt+T` | `Ctrl+T` opens a browser tab and cannot be intercepted |
| Collapse/expand tool output | `Ctrl+O` | `Alt+O` | |
| Model selector | `Ctrl+L` | `Alt+M` | `Ctrl+L` focuses the address bar in most browsers |
| Cycle model | `Ctrl+P` | `Alt+P` | `Ctrl+P` is print; `preventDefault` is unreliable |
| Cycle thinking level | `Shift+Tab` | `Shift+Tab` | works; must not break focus traversal — only bind while the composer is focused |
| Copy last assistant message | `Ctrl+X` | `Alt+C` | `Ctrl+X` is cut |
| Interrupt | `Esc` | `Esc` | identical |
| Queue follow-up | `Alt+Enter` | `Alt+Enter` | identical |
| Dequeue | `Alt+Up` | `Alt+Up` | identical |

Rules: every rebound key MUST also be reachable from the UI (menu item or button); the
`/hotkeys` dialog lists **both** the piui key and the pi TUI key it corresponds to, so muscle
memory transfers with a visible explanation. Keys fire only when the composer or transcript has
focus, never inside dialogs or CodeMirror.

`[LATER]` user-configurable keybindings (pi has a whole keybindings file); V1 ships the table
above as fixed.

## 5. Prompt template management `[V1 minimal]`

- `GET /api/prompts` → `{ items: { name, description, argumentHint?, location, path, content? }[] }`
- `POST /api/prompts/rescan` → `{ added, updated, removed }`
- `[LATER]` create/edit/delete piui-managed templates in the UI (`$PIUI_HOME/prompts/`). V1
  reads the folder; the user can drop files in, and the `/settings` page shows the three source
  paths with counts and a "Rescan" button.

Rationale for the minimal scope: the decision is *parity with the TUI*, and in the TUI templates
are files the user authors in an editor. Reading `~/.pi/agent/prompts` already delivers the
value; a piui editor is polish.

## 6. Acceptance criteria

1. Typing `/` in an agent conversation lists: built-ins, the profile's skills as
   `/skill:<name>`, and templates from all three sources with `location` badges and
   `argument-hint` rendering identical in content to pi's dropdown.
2. `/review` with a `~/.pi/agent/prompts/review.md` present expands and runs exactly as in the
   terminal; the transcript shows `/review` with a "show expanded" disclosure.
3. `/component Button "click handler"` substitutes `$1` and `$@` correctly — verified by
   asserting the expanded text pi produced, not by piui parsing the arguments.
4. `/skill:<name> extract` loads the skill (a `read` of its `SKILL.md` appears) and the
   arguments reach the model.
5. `/compcat` is refused inline, stays in the composer, and no message is sent.
6. While streaming: `Enter` produces a steering chip, `Alt+Enter` a follow-up chip, `Alt+Up`
   returns both to the composer, `Esc` aborts and restores them.
7. `Alt+T` / `Alt+O` toggle thinking and tool-output collapse; `/hotkeys` shows both piui and pi
   TUI keys.
8. A workspace containing `.pi/prompts` prompts for trust on registration; untrusted, its
   templates are absent from `/`; after trusting, they appear without a restart.
9. A skill present in `~/.pi/agent/skills` appears in the piui skills catalog as `external`,
   is not active until a profile selects it, and ticking "Include all discovered skills" makes
   every discovered skill active with a visible count.
10. Chat mode shows built-ins and templates but **no** skill commands, and enabling none of it
    reintroduces filesystem tools.
