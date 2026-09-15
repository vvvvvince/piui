---
id: 10-frontend
title: Frontend specification
status: normative
summary: >-
  Routes, components, the streaming hook's normative event application rules, UX states, accessibility, client state rules.
covers: [routes, components, streaming-hook, ux-states, a11y, client-state]
depends_on: [02-data-model, 09-api]
required_by: []
decisions: [Q1, Q2, Q3]
milestones: [M2, M5, M7]
spec_version: 1
updated: 2026-02-20
---

# 10 — Frontend specification

## 1. Routes

| Path | Screen |
|------|--------|
| `/login` | Login |
| `/` | redirect → `/conversations` |
| `/conversations` | Conversation list (+ empty state with two big CTAs: *New chat*, *New agent task*) |
| `/c/:id` | Conversation view (chat or agent layout, chosen by `mode`) |
| `/profiles` | Profile list |
| `/profiles/new`, `/profiles/:id` | Profile editor |
| `/workspaces` | Workspace list + create form |
| `/skills` | Skill list |
| `/skills/new`, `/skills/:id` | Skill editor (file tree + editor) |
| `/tools` | Tool catalog + HTTP tool editor (modal or `/tools/http/:id`) |
| `/extensions` | Extension list, install (paste/upload/URL/path), source viewer/editor ([16-extensions.md](16-extensions.md) §7.3) |
| `/settings` | Defaults, appearance, about |
| `/settings/providers` | Providers & credentials: status, add/replace/delete API keys, test ([14-credentials.md](14-credentials.md) §4) |

Global shell: left sidebar (collapsible) with nav + recent conversations; top bar with the
current screen title, a global "New" button, and the user menu.

## 2. Key components

- `AuthGate` — boot-time `me` fetch, splash, redirect with `?next=`.
- `ConversationList` — grouped by Today / Yesterday / Earlier; each row: mode icon
  (💬 chat / ⚙ agent), title, model chip, profile+workspace chips (agent), relative time,
  streaming pulse dot, cost. Row actions: rename, archive, duplicate settings, delete.
  Filters: mode, archived, search by title.
- `NewConversationDialog` — two tabs (**Chat** / **Agent**). Chat: model + thinking + web toggle.
  Agent: model + thinking + profile + workspace, with inline "create workspace" and
  "create profile" shortcuts. Remembers the last choice per mode in `localStorage`.
- `ModelPicker` — searchable combobox grouped by provider; shows context window, input
  modalities, $/Mtok; unavailable models greyed with "no credentials" and a link to
  `/settings/providers`.
- `ProviderTable` + `CredentialDialog` + `StepUpDialog` — generic driver for pi's login prompt
  flow (`secret`/`text`/`select`/`manual_code` prompts, `info`/`progress`/`auth_url`/
  `device_code` events), long-polling while `working`. Fully specified in
  [14-credentials.md](14-credentials.md) §4. Never persists a key anywhere client-side.
- `ThinkingPicker` — only rendered when `ModelInfo.reasoning`; options from
  `ModelInfo.thinkingLevels`.
- `MessageList` — virtualized; renders `UiMessage[]`; sticky date separators; "jump to latest".
- `MessageBubble` — role-styled. Assistant footer on hover: model, tokens, cost, copy, retry
  (`[LATER]`), fork (`[LATER]`).
- `MarkdownView` — `react-markdown` + `remark-gfm` + `rehype-sanitize`; code blocks with
  language label, copy button, soft wrap toggle; tables scroll horizontally; external links get
  `target="_blank" rel="noopener noreferrer nofollow"`; math via KaTeX.
- `ThinkingBlock` — collapsed summary "Thought for Xs", expandable, dimmed typography.
- `ToolCallCard` — dispatcher to per-tool renderers (`08-agent-mode.md` §2); props
  `{ block, dense }`; must render correctly for `pending|running|ok|error`.
- `DiffView` — unified-patch renderer with per-hunk collapse and a word-level intra-line diff.
- `TerminalOutput` — monospace, ANSI stripped (or rendered with `ansi-to-html`), auto-scroll
  while running, max-height with expand.
- `Composer` — autosizing textarea with **pi TUI input semantics** (normative:
  [15-commands-and-input.md](15-commands-and-input.md) §4): Enter sends when idle and *steers*
  while streaming, `Alt+Enter` queues a follow-up, `Esc` aborts and restores the queue,
  `Alt+Up` dequeues, `Shift+Enter`/`Ctrl+J` newline, `Up`/`Down` at the edges walk prompt
  history, `Ctrl+G` opens the full-screen editor modal, `Ctrl+V`/drag-drop attach images.
  Also: globe toggle (chat), Stop button, token hint, and a disabled state with an explanation
  when the conversation is blocked.
- `SlashMenu` — `/` autocomplete over built-ins + `/skill:<name>` + prompt templates, with
  `argument-hint` and `location` badges, fuzzy filter, `Tab` to complete, `Enter` to accept
  (never to send), `Esc` to close before `Esc` reaches abort. Unknown `/word` is refused inline.
- `HotkeysDialog` — lists each piui key next to the pi TUI key it maps to.
- `QueueChips` — queued steering/follow-up messages with remove buttons.
- `ContextMeter` — bar + percentage from `usage` events; click opens the Usage panel; offers
  "Compact now" above 70 %.
- `SidePanel` — tabbed Files / Tools / Profile / Memory / Usage (agent mode); Sources / Usage
  (chat mode).
- `FileTree` + `FileViewer` — lazy-loaded per directory, highlighted touched files.
- `ToolList` — the resolved tool descriptors with danger badges.
- `ProfileEditor` — form + Markdown editor + skill multi-select + tool checkbox groups +
  memory panel; unsaved-changes guard; validation panel.
- `SkillEditor` — file tree + CodeMirror + frontmatter form + validation panel + test run.
- `HttpToolEditor` — as in `05-skills-and-tools.md` B.2, with a parameter schema builder.
- `ExtensionList` + `ExtensionInstallDialog` + `ExtensionSourceEditor` — install from paste,
  upload, URL (fetch → mandatory source review → install) or path registration; health badges
  with load errors; registered tool/command chips; global toggle.
- `ExtensionUiModal` — renders `ui_request` events (`select`/`confirm`/`input`/`editor`) as
  modals, honors `timeoutMs`, closes on `ui_request_resolved` from another tab, re-renders from
  `snapshot` after a reload. `status`/`widget` events render as a header badge and a composer-
  adjacent text block.
- `Toasts` + `NoticeInline` — transient errors as toasts; conversation `notice` events as
  inline dividers in the transcript (they are part of history, not toasts).

## 3. Streaming hook (normative behavior)

```ts
useConversationStream(conversationId): {
  messages: UiMessage[];
  state: ConversationRuntimeState;
  connected: boolean;
}
```

- Opens `EventSource("/api/conversations/:id/events")`.
- Maintains a `Map<messageId, UiMessage>` plus an ordered id array.
- Applies events:
  - `snapshot` → replace everything (idempotent, safe at any time),
  - `message_start` → append,
  - `block_start` → push block,
  - `block_delta` → **append** `textDelta` to the block's text / `argsDelta` to `argsText`,
  - `block_end`, `tool_update` → replace that block by id,
  - `message_end` → replace the message, clear `streaming`,
  - `usage`, `state`, `queue`, `title`, `notice`, `done` → update ancillary state.
- Tracks `lastSeq`; on reconnect passes `?since=<lastSeq>`; discards any event with
  `seq <= lastSeq` (dedupe on replay).
- Deltas are applied inside a single `requestAnimationFrame` batch (or a 30 ms flush) to avoid
  a React render per token.
- Auto-scroll: stick to bottom only when the user is already within 80 px of the bottom.
- On `done`, invalidate the TanStack queries for messages, stats, workspace tree and memory.

## 4. UX states that MUST be designed (not afterthoughts)

1. **Empty**: no conversations / no profiles / no workspaces / no skills / no models available
   (with an actionable setup card: "No model credentials found" → **Add a provider key**
   linking to `/settings/providers`, plus the `pi` CLI alternative).
2. **Loading**: skeletons for lists and transcript, never a bare spinner on a full page.
3. **Streaming**: pulsing caret at the end of the streaming text block; Stop enabled; composer
   in steering mode.
4. **Waiting on tool**: tool card in `running` with live output; the header shows a subtle
   "working…" indicator so a long silent tool never looks frozen.
5. **Error**: assistant error message with the provider message, a Retry button, and a
   "copy details" affordance.
6. **Disconnected**: an amber bar "Reconnecting…" while the SSE is down; it must not clear the
   transcript.
7. **Blocked**: missing workspace/profile/model → red banner explaining exactly what to fix,
   composer disabled.
8. **Warnings**: profile-resolution warnings as a dismissible banner listing each dropped item.

## 5. Accessibility & polish

- Keyboard: the pi-parity table in [15-commands-and-input.md](15-commands-and-input.md) §4.3 is
  normative (`Alt+T` thinking, `Alt+O` tool output, `Alt+M` model, `Alt+P` cycle model,
  `Shift+Tab` thinking level, `Alt+C` copy last answer, `Esc` interrupt). Additionally
  `Cmd/Ctrl+K` opens the command palette (jump to conversation, new chat, new agent task).
  Every rebound key MUST also be reachable from the UI.
- All interactive elements reachable by Tab, visible focus rings, `aria-live="polite"` on the
  streaming region (but throttled — do not announce every token; announce on message end).
- Dark mode by default, light mode toggle, respects `prefers-color-scheme`; persisted.
- Reduced-motion respected (no pulse animations).
- Any text that could come from the model is rendered as sanitized Markdown — never
  `dangerouslySetInnerHTML` with raw model output.
- Long single-line tool output must not break the layout (`overflow-x: auto`, `word-break`).

## 6. Client-side state rules

- Server data: TanStack Query only (no duplicating into a store). Query keys:
  `["conversations", filters]`, `["conversation", id]`, `["messages", id]`, `["profiles"]`,
  `["profile", id]`, `["workspaces"]`, `["skills"]`, `["skill", id]`, `["tools"]`, `["models"]`.
- Local UI state (expanded tool cards, panel width, reasoning visibility, last model choice):
  `localStorage` under the `piui.` prefix, versioned (`piui.v1.*`).
- Optimistic updates only for: title rename, archive toggle, tool enable toggle. Everything
  else refetches.
- The user's own message MUST appear instantly (optimistic append) with a "sending" state,
  reconciled by `message_start`/`snapshot`.
