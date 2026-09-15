---
id: 08-agent-mode
title: Agent mode
status: normative
feature: "5 — Agent mode"
summary: >-
  Feature 5. Model + profile + workspace: session construction, tool-card rendering, side panel, steering/queueing/abort, runaway guards, titles.
covers: [agent-mode, tool-cards, side-panel, steering, queue, abort, titles]
depends_on: [03-profiles, 04-workspaces, 05-skills-and-tools]
required_by: []
decisions: [Q2, Q3]
milestones: [M5]
spec_version: 1
updated: 2026-02-20
---

# 08 — Agent mode (Feature 5)

> "Pick a model + a profile + a workspace, then let it work."

## 1. Creation

`POST /api/conversations { mode: "agent", provider, modelId, thinkingLevel, profileId,
workspaceId, initialMessage? }`

Validation:
- `profileId` and `workspaceId` are **required** (`400 validation_error` otherwise).
- workspace must exist and be writable (`409 workspace_missing`).
- profile must exist (`404 profile_not_found`).
- model must be available (`409 model_unavailable`).
- Resolution warnings (dropped skills/tools, unconfigured web search, truncated memory) are
  returned in `warnings: string[]` and surfaced as a banner.

Session construction (`pi/agent-runner.ts`):

```ts
createAgentSession({
  cwd: workspace.path,
  agentDir: config.agentDir,
  model, thinkingLevel,
  modelRuntime,                        // shared
  tools: [...builtinToolNames, ...customTools.map(t => t.name)],
  customTools,
  resourceLoader,                      // AGENTS.md + memory + skills, no ambient discovery
  sessionManager: SessionManager.create(workspace.path),
  settingsManager: piuiSettings(),
})
```

`thinkingLevel` defaults: conversation request > profile default > `"off"`.

## 2. Transcript rendering requirements

Agent runs are tool-heavy; the transcript is the product. Requirements:

- **Tool cards** (`UiBlock.type === "tool"`) with per-tool renderers:
  - `read` — path + line range, collapsed content preview (first 20 lines), "open in workspace viewer".
  - `write` — path + byte count + full content collapsed.
  - `edit` — render `details.patch` (pi provides a unified patch) with a proper diff view
    (green/red, collapsible hunks). Fall back to `details.diff` if `patch` is absent.
  - `bash` — the command in monospace with a copy button, stdout/stderr in a terminal-styled
    block that **streams** (`tool_execution_update` → `tool_update` events), exit code badge,
    duration. Auto-scroll while running, sticky "N more lines" when collapsed.
  - `grep`/`find`/`ls` — compact result list, clickable paths.
  - `web_search`/`web_fetch` — as in chat mode.
  - `memory_append` — one-line "Remembered: …".
  - HTTP tools — method + URL + status + response body.
  - unknown tool — generic: args JSON, output text.
- States: `pending` (spinner, "starting"), `running` (live output), `ok` (green check),
  `error` (red, expanded by default).
- **Collapse policy**: successful tool cards auto-collapse once the message completes; errors
  stay open. A header switch "Expand all tool calls" persists per user in `localStorage`.
- **Thinking blocks**: collapsed, labelled "Thought for 12 s", toggled globally by a
  "Show reasoning" switch.
- Long transcripts: virtualized list (e.g. `@tanstack/react-virtual`); jump-to-bottom button;
  keyboard `j/k` to move between messages `[LATER]`.

## 3. Agent view layout

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ← Conversations │ title (editable) │ model chip │ profile chip │ ws chip │  ← header
│ context 34% ▓▓░░ │ $0.18 │ 12.4k tok │ git: main ●3 │ [Tools ▾] [⋯]      │
├──────────────────────────────────────┬────────────────────────────────────┤
│ transcript (virtualized)             │ side panel (tabbed, collapsible)   │
│                                      │  • Files  (workspace tree + diff)  │
│                                      │  • Tools  (resolved tool list)     │
│                                      │  • Profile (AGENTS.md, skills)     │
│                                      │  • Memory (if enabled, live)       │
│                                      │  • Usage  (per-message breakdown)  │
├──────────────────────────────────────┴────────────────────────────────────┤
│ composer: textarea │ 📎 │ [Send] / [Stop] │ queued chips │ hint line      │
└───────────────────────────────────────────────────────────────────────────┘
```

- The side panel is collapsible and remembers width + active tab per conversation.
- **Files tab**: workspace tree (`/api/workspaces/:id/tree`), refreshed after every `done`
  event and on demand; files touched during the conversation are marked with a dot; clicking a
  file opens a read-only viewer with syntax highlighting.
- **Tools tab**: exactly the resolved `ToolDescriptor[]` for this conversation, with danger
  badges. This is the user's ground truth for "what can this thing do right now".
- **Memory tab**: renders the profile memory file, live-refreshed when a `memory_append`
  notice arrives.

## 4. Steering, queueing, aborting

Map 1:1 to pi semantics (`docs/rpc.md`, `docs/sdk.md`):

| User action | API | pi call |
|-------------|-----|---------|
| Send while idle | `POST /messages { text }` | `session.prompt(text)` |
| `Enter` while streaming | `POST /messages { text, streamingBehavior: "steer" }` | `session.steer(text)` → delivered after the current turn's tool calls |
| `Alt+Enter` while streaming | `streamingBehavior: "followUp"` | `session.followUp(text)` |
| `Esc` | `POST /abort` | `clear_queue`-equivalent then `session.abort()`; queued texts returned and restored into the composer |
| `Alt+Up` | `POST /queue/clear` | dequeue into the composer without aborting |

- **Amended by decision Q2**: the primary mechanism is pi's key semantics — `Enter` steers,
  `Alt+Enter` queues a follow-up, `Esc` aborts and restores, `Alt+Up` dequeues
  ([15-commands-and-input.md](15-commands-and-input.md) §4.1). A hint line reads
  "Enter steers · Alt+Enter queues". A segmented control MAY remain for discoverability but
  MUST NOT change the default key behavior.
- Queued messages render as chips above the composer with an ✕ to remove them
  (clear-and-restore: on abort, the server returns queued texts and the client restores them in
  the composer, mirroring pi's Esc behavior).
- `queue` events keep the chips in sync across tabs.
- Abort MUST leave the partial assistant message in the transcript labelled "stopped".

## 5. Long-run resilience

- The run continues server-side even with zero SSE subscribers (a closed laptop lid must not
  kill an agent run). The ring buffer + `snapshot` replay covers reconnects.
- `[V1]` Optional browser notification on `done` when the tab is hidden (permission-gated).
- Auto-retry, compaction and summarization events from pi are surfaced as `notice`/`state`
  events: "Retrying after provider error (2/3)…", "Compacting context…". These MUST be visible;
  a silent 30 s pause is unacceptable.

## 6. Runaway guards — **no approval gates** (decision Q3)

piui contains **no tool-call confirmation logic whatsoever**: no confirm-before-dangerous-command
toggle, no `bash` denylist, no Approve/Deny state. A user who wants gating installs an extension
that implements it ([16-extensions.md](16-extensions.md) §8).

What remains:

- A per-conversation wall-clock cap (`PIUI_MAX_RUN_MINUTES`, default 30) after which the run is
  aborted with a `notice`. This is a runaway-cost guard, not a permission prompt.
- Audit logging of dangerous tool invocations — a record, not a gate.
- The `dangerous: boolean` badge on `ToolDescriptor`, purely so the Tools panel communicates
  what a profile can do.

## 7. Titles

Shared with chat mode. After the first assistant message ends and no user-set title exists:
- call the **same model** (or a configured cheap model, `PIUI_TITLE_MODEL=provider/id`) with a
  one-shot, no-tools, no-session request: *"Summarize this exchange as a title of at most 6
  words, no quotes, no trailing period."*
- On any failure, fall back to the first 48 chars of the user's first message.
- Persist to `conversations.title`, emit a `title` event. The user can rename at any time
  (`PATCH /api/conversations/:id { title }`), which sets a `titleLocked` flag so auto-titling
  never overwrites it.

## 8. Acceptance criteria

1. Create an agent conversation with the "Coding agent" profile in an empty workspace and the
   prompt *"create a hello-world Node script and run it"* → transcript shows `write` then
   `bash` cards with streaming stdout, the file exists on disk, and the Files tab lists it.
2. Mid-run steering ("also add a test") is delivered after the current tool batch and visibly
   changes behavior; the chip disappears when consumed.
3. Stop during a long `bash` command terminates it and marks the card aborted.
4. A profile with only `read`/`grep` cannot write: the model reports it lacks the tool, and the
   Tools tab lists exactly two tools.
5. Killing the browser mid-run and reopening the conversation 60 s later shows the completed
   run in full (snapshot) with no duplicated messages.
6. Restarting the server and reopening the conversation reproduces the whole transcript from
   the pi session file.
7. A workspace deleted on disk mid-conversation produces a clear error, not a 500.
