---
id: 05-skills-and-tools
title: Skills & tools management
status: normative
feature: "6 — Skills & tools management UI"
summary: >-
  Feature 6. Filesystem-backed skill CRUD and validation, the four-kind tool catalog, web search/fetch, user-defined HTTP tools, and the resolveTools contract.
covers: [skills, skill-validation, tool-catalog, web-search, http-tools, resolve-tools]
depends_on: [02-data-model]
required_by: [03-profiles, 07-chat-mode, 08-agent-mode]
decisions: [Q2, Q3]
milestones: [M3, M6]
spec_version: 1
updated: 2026-02-20
---

# 05 — Skills & tools management (Feature 6)

## Part A — Skills

### A.1 Storage & compatibility

Managed skills live in `$PIUI_HOME/skills/<dirName>/SKILL.md` and follow the
[Agent Skills standard](https://agentskills.io/specification) as implemented by pi
(see `docs/skills.md`). piui MUST NOT invent a proprietary format.

`dirName`: `^[a-z0-9][a-z0-9._-]{1,63}$`, unique, derived from the skill name by slugification
with a numeric suffix on collision.

**External skills** (`source: "external"`) are registered by absolute path — e.g. an existing
`~/.claude/skills/pdf-tools` — and are read-only in piui (no editing, no deletion of files;
only unregister). This lets me reuse skills from other harnesses.

**Decision Q2 (TUI parity)** adds *automatic* external registration: every skill pi's TUI would
discover (`~/.pi/agent/skills/`, `~/.agents/skills/`, and trusted project `.pi/skills` /
`.agents/skills`) is auto-registered into this catalog with a `location` badge. Activation stays
per profile, or wholesale via the profile's `includeDiscoveredSkills` flag. See
[15-commands-and-input.md](15-commands-and-input.md) §3.2.

### A.2 Frontmatter & validation

`SKILL.md` MUST start with YAML frontmatter:

```md
---
name: brave-search
description: Web search and content extraction via the Brave API. Use for docs, facts, any web content.
---
```

Validator (`domain/skills.ts`) produces **errors** (block save) and **warnings** (allow save):

| Severity | Condition |
|----------|-----------|
| error | missing/unparseable frontmatter |
| error | missing or empty `description` |
| error | missing `name` |
| error | `name` not matching `^[a-zA-Z0-9][a-zA-Z0-9 ._-]{1,63}$` |
| error | body empty |
| error | file > 1 MB, or skill directory > 50 MB / > 500 files |
| warning | `name` differs from `dirName` (pi allows it) |
| warning | `description` < 30 chars or > 1024 chars |
| warning | unknown frontmatter keys (list them) |
| warning | references a path that does not exist in the skill dir (best-effort regex over `./…`, `scripts/…`) |

Validation runs on save and on catalog scan; results are cached in `skills.updated_at`-keyed
memory and exposed as `SkillSummary.warnings`.

### A.3 Filesystem sync

- On boot and on `POST /api/skills/rescan`, scan `$PIUI_HOME/skills/*/SKILL.md`:
  - new directory → insert row (enabled = 1),
  - missing directory → mark row `enabled = 0` and flag `missing: true` (do not delete, so
    profile references survive a temporarily unmounted disk),
  - changed frontmatter → update `name`/`description`.
- Also rescan external paths (including the auto-discovered TUI locations), reporting
  `missing: true` when gone.
- No filesystem watcher in V1; rescan on every skills-page load (cheap) and after any write.

### A.4 Skill CRUD UI

**List page** — table: name, description (truncated), source badge, #files, size, enabled
toggle, used-by-N-profiles count, warning icon with tooltip. Search box filters by
name/description. Actions: *New skill*, *Import*, *Rescan*.

**New / Edit page** — two panes:
- left: file tree of the skill directory (`SKILL.md` pinned first) with add-file / add-folder /
  rename / delete,
- right: CodeMirror editor for the selected file; for `SKILL.md`, frontmatter is edited in
  dedicated `name` + `description` inputs above the body editor, and the server recomposes the
  file (single source of truth: the form, not raw YAML, to avoid broken frontmatter).
  A "raw mode" toggle allows editing the whole file for power users.
- footer: validation panel (errors/warnings), *Save*, *Save & test*.

**Create-from-template** — offer three starters: `basic` (instructions only),
`script` (SKILL.md + `scripts/run.sh` + setup notes), `reference`
(SKILL.md + `references/*.md` with progressive-disclosure guidance).

**Import** options:
1. upload a `.zip` (extract with path-traversal protection, reject entries containing `..`,
   absolute paths, symlinks, or a total uncompressed size > 50 MB),
2. register an existing directory by absolute path (becomes `external`),
3. paste a single `SKILL.md`.

`[LATER]` git clone / skill registry install.

**Test run** — `POST /api/skills/:id/test` creates an ephemeral chat-like agent session with
*only* this skill, `tools: ["read"]` (+ `bash` if the user ticks it), an empty scratch cwd, and
an auto prompt `/skill:<name>` (or the raw content if skill commands are disabled). Returns a
throwaway `conversationId` flagged `ephemeral: true` (not listed, deleted after 1 h). This is
how the user checks the agent actually loads the skill.

### A.5 Deletion

`DELETE /api/skills/:id`:
- `managed` → move directory to `$PIUI_HOME/trash/skills/<dirName>-<ts>/`, delete the row,
  cascade-delete `profile_skills`. Response includes `affectedProfiles: string[]`.
- `external` → delete the row only; never touch the user's files.
- The confirm dialog MUST list the profiles that will lose the skill.

---

## Part B — Tools

### B.1 The catalog

`ToolRegistry` (`domain/tools.ts`) exposes a single catalog combining three kinds:

**1. `builtin_pi`** — proxied straight to pi's built-in tool names. Exactly:

| name | label | dangerous | notes |
|------|-------|-----------|-------|
| `read` | Read file | no | required for skills |
| `ls` | List directory | no | |
| `grep` | Search contents | no | |
| `find` | Find files | no | |
| `edit` | Edit file | **yes** | |
| `write` | Write file | **yes** | |
| `bash` | Run shell command | **yes** | POSIX hosts |
| `powershell` | Run PowerShell | **yes** | offered only on Windows hosts |

The registry MUST validate these names against the installed pi version at boot (compare with
the tool names pi actually produces) and log an error if a name disappeared upstream.

**2. `builtin_piui`** — implemented by piui with `defineTool`:

| name | label | available when | dangerous |
|------|-------|----------------|-----------|
| `web_search` | Web search | search provider configured | no |
| `web_fetch` | Fetch web page | search provider configured *or* always (see B.3) | no |
| `memory_append` | Remember | profile memory enabled (implicit, not selectable) | no |

**3. `http`** — user-defined HTTP tools (rows in `http_tools`), always `dangerous: true`.

**4. `extension`** — tools registered by installed extensions via `pi.registerTool()`, cached
from a loader probe. Enumeration, the runtime/late-registration rule, and collision handling are
specified in [16-extensions.md](16-extensions.md) §4.

### B.2 Tools management UI

**List page** — grouped by kind, each row: name (monospace), label, description, kind badge,
danger badge, global enable toggle, "used by N profiles", edit/delete for `http` tools.
Built-ins can be globally disabled (hides them from all profile editors and strips them from
resolution) but not edited or deleted.

A **"Configuration"** panel at the top shows the web-search provider status
(provider name, key present yes/no, last test result) with a *Test search* button that calls
`POST /api/tools/web_search/test { query }` and shows the raw top-3 results.

**HTTP tool editor** — form fields:
- `name` (`^[a-z][a-z0-9_]{2,47}$`, unique across the whole catalog including built-ins),
- `label`, `description` (description is what the model sees — inline hint: *"write it for the
  model: what it does and when to use it"*),
- `method` (GET/POST), `urlTemplate`, `headers` (key/value rows, values may reference
  `${ENV_VAR}` resolved server-side at call time — never store raw secrets in the DB and never
  return header values to the client; return `"***"` for values containing a resolved env ref
  and mask others),
- `bodyTemplate` (JSON, POST only),
- `parameters`: a small schema builder producing a JSON-Schema object — rows of
  `{ name, type: string|number|boolean|string[], required, description }`. Advanced users get a
  raw JSON-Schema textarea. The result MUST be a valid TypeBox-compatible object schema.
- `timeoutMs` (1000–60000).
- Placeholder substitution: `{paramName}` in `urlTemplate` (URL-encoded) and in `bodyTemplate`
  (JSON-encoded). Unknown placeholders → validation error at save time.
- **Test** button: fill sample params, see status code + response body (truncated 8 KB).

**HTTP tool runtime** (`pi/tools/http-tool.ts`):
- build the request, apply timeout via `AbortSignal.timeout`,
- **SSRF guard**: resolve the hostname and reject loopback/link-local/private ranges
  (`127/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`) unless
  `PIUI_ALLOW_PRIVATE_HTTP_TOOLS=1`; reject non-http(s) schemes; do not follow redirects to a
  denied host (max 3 redirects),
- response: if JSON, pretty-print; else text; truncate to 32 KB with a truncation note,
- non-2xx → tool error with status + body snippet (models recover better with the body),
- return `{ content: [{ type: "text", text }], details: { status, url, durationMs } }`.

### B.3 Web search & fetch (used by chat mode and profiles)

`WebSearchProvider` interface, one implementation per `PIUI_SEARCH_PROVIDER`:

```ts
interface WebSearchProvider {
  readonly id: "brave" | "tavily" | "searxng";
  search(q: string, opts: { count?: number; freshness?: "day"|"week"|"month"|"year" }):
    Promise<{ title: string; url: string; snippet: string; publishedAt?: string }[]>;
}
```

`web_search` tool:
- params: `query: string` (required), `count?: number` (1–10, default 5),
  `freshness?: "day"|"week"|"month"|"year"`.
- output: numbered Markdown list `1. **title** — snippet\n   <url>`; include a trailing line
  `Use web_fetch on a URL to read the full page.`
- errors: `provider_not_configured` → tool error text
  *"Web search is not configured on this server."* (never a crash).
- caching: in-memory LRU, key = `provider|query|count|freshness`, TTL 10 min, cap 200 entries.
- rate limit: max 10 searches per conversation per run; beyond that return a tool error telling
  the model to synthesize what it has.

`web_fetch` tool:
- params: `url: string`, `maxChars?: number` (default 20000, max 100000).
- fetches with a 15 s timeout and a browser-ish UA, follows <=3 redirects, same SSRF guard as
  HTTP tools, rejects non-`text/*` / non-`application/json` / non-`application/xhtml+xml`
  content types with a clear message, converts HTML → Markdown
  (`@mozilla/readability` + `turndown`, or `html-to-text` as a simpler fallback),
  truncates and appends `…[truncated, N chars omitted]`.
- output `details`: `{ url, finalUrl, status, contentType, chars }`.

Both tools MUST report progress via pi's tool streaming if available, so the UI shows
"searching…" rather than a frozen card.

### B.4 Tool resolution (the one function that matters)

```ts
resolveTools(input: {
  mode: "chat" | "agent";
  profile?: Profile;
  webSearch: boolean;          // chat mode toggle
  memoryEnabled: boolean;
  extensionToolNames: string[];      // cached names from enabled, non-disabled extensions
}): {
  builtinToolNames: string[];        // -> createAgentSession({ tools: [...] })
  customTools: PiToolDefinition[];   // -> createAgentSession({ customTools })
  extensionToolNames: string[];      // included in the `tools` allowlist
  warnings: string[];
}
```

Rules:
- **chat mode**: `builtinToolNames = []`. `customTools = webSearch ? [web_search, web_fetch] : []`.
  No filesystem, no bash, no memory, ever. This is enforced in `resolveTools`, not at the call
  site, and covered by a unit test.
- **agent mode**: start from `profile.toolNames`, drop globally disabled and unknown names
  (warn), split into built-in names vs custom tools, then add `memory_append` iff
  `profile.memory.enabled`.
- `tools` passed to pi MUST be the **union** of built-in names, custom tool names, and the
  profile's selected extension tool names, because pi's docs state that when `tools` is provided
  it acts as an allowlist that must also include custom/extension tool names. When the profile
  has `allowDynamicExtensionTools` (default on), late-registered extension tool names are
  appended as they are observed ([16-extensions.md](16-extensions.md) §4).
- The resolved list MUST be echoed back in the conversation detail response
  (`tools: ToolDescriptor[]`) so the UI can show exactly what the model can do — no guessing.

### B.5 Acceptance criteria

1. A chat conversation with web search off exposes zero tools; the model cannot read files
   (verified by asking it to read `/etc/hostname` → it states it has no tool).
2. Turning web search on mid-conversation is **not** allowed to retroactively change history:
   changing it applies from the next prompt onward and emits a `notice`.
3. Creating an HTTP tool pointing at `http://127.0.0.1:1234` is rejected by the SSRF guard
   unless the env override is set.
4. Disabling `bash` globally removes it from every profile's resolved set, and the chat header
   tool list updates on the next conversation.
5. A skill with a missing `description` cannot be saved; the error names the problem.
6. `POST /api/skills/:id/test` yields a transcript containing a `read` of that `SKILL.md`.
