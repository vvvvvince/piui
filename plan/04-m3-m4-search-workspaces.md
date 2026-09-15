---
id: plan-04
title: M3 — Web search & tool runtime · M4 — Workspaces
status: plan
summary: >-
  Web search providers, web_search/web_fetch with the shared SSRF guard and the tool catalog
  routes; then workspace path validation, tree/file/git endpoints and the workspace UI.
milestone: [M3, M4]
est_days: "3–4"
covers: [web-search, web-fetch, ssrf, tool-catalog, workspaces, path-validation, file-browser]
spec_refs: [05-skills-and-tools, 11-security, 07-chat-mode, 04-workspaces, 09-api]
depends_on: [plan-03]
blocks: [plan-05]
plan_version: 1
updated: 2026-02-20
---

# M3 — Web search & tool runtime · M4 — Workspaces

---

# M3 — Web search & tool runtime

**Context:** `05-skills-and-tools` part B, `11-security` §2, `07-chat-mode` §§1,3. (~4k)

## Work

- `WebSearchProvider` interface + `brave` (default) and at least one alternative
  (`tavily`/`searxng`), plus an explicit `none` stub. Selected by `PIUI_SEARCH_PROVIDER`;
  key from `PIUI_SEARCH_API_KEY`; `PIUI_SEARXNG_URL` for searxng.
- `pi/tools/web-search.ts`: `defineTool` `web_search` and `web_fetch` (spike **S10**), both
  taking an **injectable `fetch`** (this is why the seam exists).
- **SSRF guard** shared by `web_fetch` and HTTP tools: block private/loopback/link-local ranges
  after DNS resolution, cap redirects and re-check each hop, cap body size, enforce content
  type, enforce timeout. Tested with hostile fixtures supplied directly through the injected
  fetch — never real network.
- Response caching + per-run rate limiting.
- `GET /api/tools` (all kinds + `usedByProfiles` + `webSearch: { provider, configured }`),
  `PATCH /api/tools/:name` (global enable/disable, admin-only),
  `POST /api/tools/web_search/test` (`503 provider_not_configured` when unset).
- UI: web-search toggle in chat, `web_search`/`web_fetch` tool cards, **Sources footer**,
  provider config panel in Settings.

## Acceptance

`07-chat-mode.md` §6 items 2–3 (off → answer admits staleness and mentions the toggle, no tool
call; on → search card + sources footer + referenced answer) · `05-skills-and-tools.md` B.5
items 1–2.

---

# M4 — Workspaces

**Context:** `04-workspaces`, `09-api` §5. (~2k)

## Work

- `domain/workspaces.ts`: normalize to an absolute path without trailing slash; **resolve
  symlinks before checking** `PIUI_WORKSPACE_ROOTS`; system denylist (`/etc`, `/`, `/usr`,
  `/bin`, `$HOME` root, …); error codes `path_not_absolute`, `path_not_found`,
  `path_not_directory`, `path_not_writable`, `path_not_allowed`, `path_denylisted`,
  `path_already_registered`, `path_escape`.
- Create-folder + `git init` options; status probing (`exists`, `writable`, `isGitRepo`,
  `entryCount`) computed on read, never cached into staleness.
- Routes: list/create/get/patch/delete, `POST /api/workspaces/validate` (live form feedback),
  `GET /:id/tree?path=&depth=`, `GET /:id/file?path=` (`415 binary_file`, 512 KB cap),
  `GET /:id/git`, `GET /api/fs/browse?path=` (admin-only, dirs only, denylist honoured).
  `path` patch only before any conversation started → else `409 immutable_after_start`.
  Delete removes the record only — **files are never deleted**.
- UI: list/create/edit/delete with the "files are not deleted" confirmation, directory picker,
  read-only file tree + viewer, git status badge, **Missing** state that blocks new prompts with
  a clear message (not a 500).

## Tests

Path validation unit table (absolute/relative, symlink escape, denylist, roots, traversal);
integration for each error code; the Files-tab refetch after the `done` event.

## Acceptance

`04-workspaces.md` §7 items 1–6 (denylist, symlink escape, create+git init, agent-written file
appears without reload, renamed folder → Missing + blocked prompts, delete leaves files).
