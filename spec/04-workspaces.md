---
id: 04-workspaces
title: Workspaces
status: normative
feature: "3 — Workspaces"
summary: >-
  Feature 3. A named folder used as the agent cwd: path validation, denylist, status probing, file tree, git status, deletion semantics.
covers: [workspaces, path-validation, denylist, file-tree, git-status]
depends_on: [02-data-model]
required_by: [08-agent-mode]
decisions: [Q2]
milestones: [M4]
spec_version: 1
updated: 2026-02-20
---

# 04 — Workspaces (Feature 3)

> A **workspace** is just a named folder the agent works in. It becomes the pi session `cwd`.

## 1. Definition

| Field | Rules |
|-------|-------|
| `name` | 1–60 chars, unique. |
| `path` | Absolute, normalized (`path.resolve`), no trailing separator, no `~` (expand it server-side), no symlink escape (see §3), unique across workspaces. |
| `description` | <= 280 chars. |

Creation modes in the UI:
1. **Pick existing folder** — type/paste a path; a server-side browse endpoint assists.
2. **Create new folder** — give a parent + folder name; server `mkdir`s it (recursive, `0o755`).
   Optionally `git init` (checkbox, default off).

## 2. Path validation (server, `domain/workspaces.ts`)

A path is accepted only if **all** hold:

1. `path.isAbsolute(p)` after `~` expansion.
2. `fs.realpath` resolves (folder exists) **or** creation was requested and the *parent* exists.
3. It is a directory, readable and writable by the server process.
4. If `PIUI_WORKSPACE_ROOTS` is set: `realpath(p)` is inside one of the roots
   (compare with a trailing-separator-aware prefix check on the **realpath**, to defeat
   symlink escapes).
5. It is **not** in the denylist: `/`, `/etc`, `/dev`, `/proc`, `/sys`, `/boot`, `/usr`,
   `/bin`, `/sbin`, `/lib*`, `/var/lib`, the user's home root itself (`$HOME` exactly),
   `$PIUI_HOME` and any of its subdirectories, `~/.pi`, `~/.ssh`, `~/.gnupg`, `~/.aws`,
   `~/.config`, and the piui install directory. Subdirectories of `$HOME` are fine.
6. Windows equivalent denylist if the implementation targets Windows (`C:\Windows`, etc.).

Rejections return `400` with a machine code: `path_not_absolute`, `path_not_found`,
`path_not_directory`, `path_not_writable`, `path_not_allowed`, `path_denylisted`,
`path_already_registered`.

## 3. Status probing

`GET /api/workspaces` includes a cheap `status` per workspace, computed with a 250 ms budget:

```ts
status: { exists: boolean; writable: boolean; isGitRepo: boolean; entryCount?: number }
```

- `isGitRepo`: `<path>/.git` exists.
- `entryCount`: number of direct children, capped at 500 (`readdir` then `slice`), omitted if
  the probe times out.
- A workspace whose folder disappeared is shown as **Missing** with a "Relocate" action; it MUST
  NOT be auto-deleted, and starting a conversation with it returns `409 workspace_missing`.

`GET /api/workspaces/:id/tree?path=&depth=1` `[V1, read-only]` returns direct children for a
lightweight file browser in the agent view:

```ts
{ path: string; entries: { name: string; kind: "file" | "dir" | "symlink"; size?: number; modifiedAt: string }[] }
```

Rules: `path` is relative to the workspace root; `..` and absolute paths are rejected
(`400 path_escape`); resolve via `realpath` and re-check containment; hidden files included but
flagged; `node_modules`, `.git` listed but never recursed automatically; hard cap 1000 entries.

`GET /api/workspaces/:id/file?path=` `[V1]` returns a text file's content (UTF-8, max 512 KB,
`415` for binary) so the UI can preview what the agent touched.

## 4. Relationship to conversations

- An agent-mode conversation stores `workspace_id` and passes `workspace.path` as pi `cwd`.
- The pi session file for that conversation is created by
  `SessionManager.create(workspacePath)`, so pi's own session directory naming groups
  conversations by workspace — desirable, keep it.
- Changing a conversation's workspace after creation is **forbidden** in V1
  (`409 immutable_after_start` once `session_path` is set). Before the first prompt it is
  allowed. Rationale: the transcript would reference paths that no longer exist.
- Multiple conversations may share a workspace concurrently. piui does not lock the folder;
  the UI MUST display a subtle "2 active conversations in this workspace" indicator on the
  workspace card to warn about interference.

## 5. Git awareness `[V1, minimal]`

If `isGitRepo`, the agent view header shows branch + dirty-file count, refreshed on demand
(button) and at the end of every agent run:

`GET /api/workspaces/:id/git` → `{ branch, ahead, behind, dirtyCount, staged: number, lastCommit: { hash, subject, at } }`

Implemented by shelling out to `git` with `cwd` set to the workspace (`--no-optional-locks`,
5 s timeout). If `git` is absent, return `{ available: false }`. No commit/push from piui in
V1 — the agent can do that with `bash` if the profile allows it.

## 6. Deletion

- `DELETE /api/workspaces/:id` removes the **record only**. It MUST NOT delete files on disk.
  The confirm dialog must say so explicitly: *"This removes the workspace from piui. The folder
  and its files are left untouched."*
- Conversations referencing it keep their transcript; `workspace_id` becomes NULL and new
  prompts return `409 workspace_missing`.

## 7. Acceptance criteria

1. Registering `/etc` fails with `path_denylisted`; registering `~/projects/demo` succeeds.
2. Registering a symlink pointing outside `PIUI_WORKSPACE_ROOTS` fails with `path_not_allowed`.
3. Creating a workspace with "create folder + git init" produces the directory and a `.git`.
4. An agent conversation in that workspace writes a file, and the workspace file browser shows
   it without a page reload (refetch after `done` event).
5. Renaming the folder on disk marks the workspace **Missing** and blocks new prompts with a
   clear message.
6. Deleting the workspace record leaves the folder intact.
