---
id: 16-extensions
title: Extensions
status: normative
summary: >-
  Decision Q3. Global extensions installable from the UI with per-profile disable, extension-registered tools, the extension UI dialog bridge, install flows and security posture. No approval gates anywhere.
covers: [extensions, install, per-profile-disable, extension-tools, ui-bridge, no-approval-gates]
depends_on: [01-architecture, 05-skills-and-tools]
required_by: [08-agent-mode, 10-frontend]
decisions: [Q3, Q7, Q9]
milestones: [M5c]
spec_version: 1
updated: 2026-02-20
---

# 16 — Extensions

> **Decision Q3 = "global extensions, installable from the UI, per-profile disable"**
> Extensions are configured **once for all profiles** and are **enabled by default**.
> A profile may **disable** specific ones (an opt-out list, not an opt-in list).
> **No approval gates anywhere** — piui never blocks a tool call for confirmation.

## 1. Feasibility check: is per-profile disable actually easy?

**Yes — it is one array filter.** Verified against
`dist/core/resource-loader.d.ts` (`DefaultResourceLoaderOptions`):

```ts
noExtensions?: boolean;                 // suppress ALL ambient discovery
additionalExtensionPaths?: string[];    // load exactly these, additive even with noExtensions
extensionFactories?: InlineExtension[];
extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
```

Because piui already builds **one `DefaultResourceLoader` per conversation**
(`01-architecture.md` §4.3), per-profile disabling is:

```ts
new DefaultResourceLoader({
  cwd, agentDir, settingsManager,
  noExtensions: true,                                  // never discover ambiently
  additionalExtensionPaths: enabledExtensionPaths,      // global set minus profile's disabled ids
  extensionFactories: piuiInternalFactories,            // piui's own, see §6
  ...
});
```

No pi-side filtering, no `extensionsOverride` gymnastics, no per-extension enable plumbing
inside pi. The only state is one table of disabled ids per profile. **Kept in the spec.**

`LoadExtensionsResult` also gives us what the UI needs for free:

```ts
interface LoadExtensionsResult { extensions: Extension[]; errors: { path, error }[]; runtime }
interface Extension { path; resolvedPath; hidden?; sourceInfo; handlers; tools; commands; flags; shortcuts; ... }
```

So a loader reload is enough to enumerate each extension's **registered tools** and
**commands** without starting a session (§4).

## 2. Model

- Extensions are a **global** resource: `$PIUI_HOME/extensions/*.ts` plus any registered
  external paths. There is no per-profile installation.
- Every installed+globally-enabled extension is active in **every** conversation, chat mode
  included, unless the conversation's profile disables it.
- Chat mode has no profile, so it always gets the full globally-enabled set. If that turns out
  to be wrong for you, the one-line change is a piui setting `chatModeExtensions: "all" | "none"`
  — noted, not built.

### 2.1 Storage

```
$PIUI_HOME/extensions/<name>.ts          # piui-managed (installed via the UI)
```

```sql
CREATE TABLE extensions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,        -- ^[a-z0-9][a-z0-9._-]{0,63}$, from the filename
  path        TEXT NOT NULL UNIQUE,        -- absolute
  source      TEXT NOT NULL,               -- 'managed' | 'external'
  origin      TEXT,                        -- upload filename, URL, or registered path (provenance)
  enabled     INTEGER NOT NULL DEFAULT 1,  -- global kill switch
  load_error  TEXT,                        -- last load error, NULL when healthy
  tools_json  TEXT NOT NULL DEFAULT '[]',  -- cached registered tool names (§4)
  commands_json TEXT NOT NULL DEFAULT '[]',-- cached registered command names (§4)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE profile_disabled_extensions (
  profile_id   TEXT NOT NULL REFERENCES profiles(id)   ON DELETE CASCADE,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, extension_id)
);
```

Add both to `001_init.sql`. Deleting an extension cascades the disable rows — a profile's
opt-out list never dangles.

### 2.2 Ambient pi extensions

`~/.pi/agent/extensions/*.ts` are **auto-registered as `source: "external"`, `enabled: 1`** on
boot and on rescan — consistent with the Q2 decision to keep the TUI's inventory visible. They
are listed in the UI with an `external` badge, can be globally disabled and per-profile
disabled, but their files are never edited or deleted by piui.

Project extensions (`<workspace>/.pi/extensions`) are **not** loaded, trusted workspace or not.
Registering a folder must not mean executing that repo's TypeScript in the server process.
Documented in the trust dialog (`15-commands-and-input.md` §3.3).

## 3. Resolution

`ResolvedProfile` gains:

```ts
extensionPaths: string[];      // globally enabled, minus profile-disabled, minus load-failed
```

Rules:
- Order: managed before external, then alphabetical by name — deterministic, so tool-name
  collisions resolve identically every run.
- An extension whose previous load failed is still attempted (the file may have been fixed);
  the failure is reported per conversation, never fatal.
- `warnings` gains one entry per extension that failed to load, surfaced in the conversation's
  warning banner exactly like dropped skills/tools.
- Chat mode uses the global enabled set with no profile filtering.

## 4. Tools and commands registered by extensions

This is the one real integration point, and it must not be hand-waved.

**`ToolKind` gains `"extension"`** (`02-data-model.md` §3, `05-skills-and-tools.md` B.1):

| kind | source |
|------|--------|
| `builtin_pi` | pi built-ins |
| `builtin_piui` | `web_search`, `web_fetch`, `memory_append` |
| `http` | user-defined HTTP tools |
| **`extension`** | `pi.registerTool()` inside an extension |

**Enumeration (`domain/extensions.ts`).** On boot, after any install/uninstall/toggle, and on
`POST /api/extensions/rescan`:

1. Build a throwaway `DefaultResourceLoader` with `noExtensions: true` and
   `additionalExtensionPaths` = all installed+enabled paths; `await loader.reload()`.
2. Read `loader.getExtensions()`: for each `Extension`, record `path`, `[...tools.keys()]`,
   `[...commands.keys()]`; for each entry in `errors`, store `load_error`.
3. Persist to `extensions.tools_json` / `commands_json` / `load_error`; refresh the
   `ToolRegistry` catalog; emit global SSE `{ type: "extensions_changed" }`.

No session and no model call is needed — the loader alone yields this. Note that pi allows
`registerTool()` *after* startup (inside `session_start`, command handlers, etc.), so the cached
list is a **best-effort catalog for the profile editor**, not a guarantee. Therefore:

- **Extension tools are selectable per profile** like any other tool, using the cached names.
- At session construction, the `tools` allowlist passed to pi MUST be
  `[...builtinNames, ...customToolNames, ...profileSelectedExtensionToolNames]`.
- **Late-registered tools** (names not in the cache) would be excluded by that allowlist. To
  avoid silently breaking such extensions, a profile has one checkbox:
  **"Allow tools registered by extensions at runtime"**
  (`profiles.allow_dynamic_extension_tools INTEGER NOT NULL DEFAULT 1`). When on, piui appends
  every extension-registered tool name it observes to the allowlist; the conversation's Tools
  panel then shows them with a "registered at runtime" badge once seen. When off, only cached
  names are allowed. Default **on** — matching "extensions just work" and minimal fuss.
- Tool-name collision with a built-in or an HTTP tool: the extension tool is dropped with a
  warning naming both sides. Never shadow `bash`/`read`/`write`/`edit` silently.

**Extension commands** join the `/` menu from `15-commands-and-input.md` §1 with
`source: "extension"`, `kind: "expand"` (pi executes them inside `prompt()` even while
streaming, per pi's docs), and `availableWhileStreaming: true`.

## 5. Extension UI bridge

piui binds extensions with pi's `AgentSession.bindExtensions(...)`
(`dist/core/agent-session.d.ts`):

```ts
await session.bindExtensions({
  mode: "rpc",                 // closest match to piui: dialogs work, TUI-only APIs degrade
  uiContext: piuiExtensionUiContext(conversationId),
  onError: (e) => hub.notice(conversationId, "error", `${e.extensionPath}: ${e.error}`),
});
```

`mode: "rpc"` is chosen deliberately: pi's RPC mode documents exactly which
`ExtensionUIContext` members work and which degrade, so piui inherits a specified contract
rather than inventing one. Implement `uiContext` as:

| Method | piui behavior |
|--------|---------------|
| `select`, `confirm`, `input`, `editor` | Emit a `ui_request` UI event → modal in the conversation view → response resolves the promise. Honor pi's `timeout` (auto-resolve `undefined`/`false`). |
| `notify` | `notice` event (info/warning/error) inline in the transcript |
| `setStatus` | a small badge in the conversation header, keyed |
| `setWidget` | a text block above/below the composer, keyed; string arrays only |
| `setTitle` | ignored (browser tab title is piui's) |
| `setEditorText`, `pasteToEditor` | set the composer content |
| `custom`, `setFooter`, `setHeader`, `setEditorComponent`, `setWorkingMessage`, `setWorkingIndicator`, `setToolsExpanded`, theme getters/setters | no-op / documented degraded return values, mirroring pi's RPC table |

New `UiEvent` variants (`02-data-model.md` §5):

```ts
| { type: "ui_request"; seq: number; requestId: string;
    method: "select" | "confirm" | "input" | "editor";
    title?: string; message?: string; options?: string[]; placeholder?: string;
    prefill?: string; timeoutMs?: number }
| { type: "ui_request_resolved"; seq: number; requestId: string }   // another tab answered
| { type: "status"; seq: number; key: string; text: string | null }
| { type: "widget"; seq: number; key: string; lines: string[] | null;
    placement: "aboveEditor" | "belowEditor" }
```

Answering: `POST /api/conversations/:id/ui-response { requestId, value?, confirmed?, cancelled? }`
→ `200`. Pending requests are included in `snapshot` so a reload re-renders the modal; a
request answered in one tab emits `ui_request_resolved` so other tabs close theirs. If the
conversation is disposed with a request pending, resolve it as cancelled.

**This is a dialog bridge, not an approval gate.** piui contains no tool-call confirmation logic
of its own (`08-agent-mode.md` §6 is deleted, see §8). If a *user-installed* extension chooses
to prompt, its dialog appears — that is the extension's business.

## 6. piui's own inline extensions

`extensionFactories` carries piui's internal `InlineExtension`s. V1 ships **one**:

- `piui-notices` — surfaces `extension_error` and a few lifecycle hints as `notice` events.

`memory_append` stays a plain `customTools` entry (not an extension). No approval-gate
extension is built. Keep this list near-empty on purpose; inline factories are the escape hatch
for future piui behavior, not a dumping ground.

## 7. Installing extensions from the UI

### 7.1 Sources

| Source | Flow |
|--------|------|
| **Upload / paste** | Upload a `.ts` file or paste source into a CodeMirror editor → validated (§7.2) → written to `$PIUI_HOME/extensions/<name>.ts` |
| **From URL** | `POST /api/extensions/fetch { url }` fetches the raw text (https only, SSRF guard from `11-security.md`, 1 MB cap) and returns it **without installing**. The UI shows the full source in a read-only editor with a mandatory *"I have reviewed this code"* checkbox before Install is enabled. |
| **Register a path** | Point at an existing absolute path (file or directory of `*.ts`) → `source: "external"`, files never modified |

`[LATER]`: npm packages (pi supports `pi.extensions` in `package.json`) and git clone. Both need
dependency installation, which is a bigger story.

### 7.2 Validation on install

Cheap, honest checks — **not** a security boundary (see §7.4):

1. Extension `name` from the filename, matching `^[a-z0-9][a-z0-9._-]{0,63}$`, unique.
2. Size ≤ 1 MB, valid UTF-8, non-empty.
3. **Load probe**: run the enumeration loader (§4) with the candidate included. If it lands in
   `LoadExtensionsResult.errors`, the install is **rejected** with the error text — a syntax
   error or bad import never reaches a conversation.
4. The probe result (registered tools/commands) is shown in the install confirmation:
   *"This extension registers 1 tool (`deploy`) and 1 command (`/deploy`)."* So the user sees
   what they are adding before it goes live.
5. Installs require **step-up re-auth** (`14-credentials.md` §5) and are audit-logged with the
   origin and a SHA-256 of the source.

### 7.3 Management UI — `/extensions`

**List**: name, source badge (`managed`/`external`), origin, health (✓ / ⚠ with the load error),
registered tools + commands as chips, global enable toggle, "disabled in N profiles" count,
actions (view source, edit, uninstall, rescan).

- **View/edit source**: CodeMirror (TypeScript). Managed only; external is read-only. Saving
  re-runs the load probe and refuses to save a broken file (with a "save anyway, disabled"
  escape so you can't get stuck).
- **Uninstall**: managed → move file to `$PIUI_HOME/trash/extensions/`; external → unregister
  only. Confirm dialog lists the tools/commands that will disappear and the profiles affected.
- **Broken extension banner**: if any enabled extension has a `load_error`, show a persistent
  warning on the extensions page and in any conversation's warning banner.
- **Reload**: `POST /api/extensions/rescan` re-probes everything. Note: already-live
  `LiveSession`s keep their loaded extensions; the UI must say *"Changes apply to new
  conversations"* (matching pi, where `/reload` is explicit).

**Profile editor** gains an **Extensions** section: the global list with a per-profile
*Disable* switch (default: enabled), plus the "Allow tools registered by extensions at runtime"
checkbox from §4. The copy states plainly: *"Extensions are installed globally. Here you can
switch some off for this profile."*

### 7.4 Security posture — stated plainly

An extension is **arbitrary TypeScript executed in the piui server process**, with the same
privileges as the agent's `bash` tool (which agent mode already grants). Installing one is
therefore *not* a meaningful escalation over normal use of piui — but installing one from a URL
you did not read **is**. Requirements:

1. Step-up re-auth on every install/edit/uninstall/enable-toggle.
2. URL installs: fetch-then-review-then-install, never fetch-and-run; mandatory review
   checkbox; the source is stored so it can be re-read later.
3. `PIUI_DISABLE_EXTENSION_INSTALL=1` disables all extension mutation routes (`403`), for
   locked-down deployments. Status and per-profile disabling still work.
4. `403 insecure_transport` on mutation routes under the same conditions as credential writes
   (`14-credentials.md` §7.2).
5. Audit log: `extension_install` (origin, sha256), `extension_update`, `extension_uninstall`,
   `extension_toggle`, `extension_load_error`.
6. The README security section names this explicitly: *"anyone who can log into piui can run
   arbitrary code on this machine — through the agent's shell tool, and through extensions."*
7. No sandbox. `[LATER]` and honestly gated behind the containerization question (Q10).

## 8. Consequence: approval gates are removed from the spec

Per the decision, **`08-agent-mode.md` §6 "Safety rails" is deleted** except the wall-clock cap:

- ❌ confirm-before-dangerous-command toggle — removed entirely
- ❌ the `bash` denylist regex — removed entirely
- ❌ `conversations.confirm_dangerous` column and the `confirmDangerous` PATCH field — removed
- ✅ `PIUI_MAX_RUN_MINUTES` wall-clock abort — **kept** (it is a runaway-cost guard, not a
  permission prompt)
- ✅ dangerous-tool **audit logging** — kept (a record, not a gate)
- ✅ the `dangerous: boolean` flag on `ToolDescriptor` — kept, purely as a UI badge so the
  Tools panel communicates what a profile can do

A user who *wants* gating installs an extension that does it. piui ships none.

## 9. API

All mutation routes require auth + step-up + **`role: "admin"`** (extension code runs in the
shared server process, so there is no meaningful per-user variant —
[18-multi-user.md](18-multi-user.md) §§3, 6); all are refused when
`PIUI_DISABLE_EXTENSION_INSTALL=1`.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/extensions` | `{ items: ExtensionSummary[], installEnabled: boolean }` |
| GET | `/api/extensions/:id` | summary + `source` text (managed only) + probe details |
| POST | `/api/extensions` | `{ name, source }` (paste) or multipart upload, or `{ path }` to register external → `201` after a successful load probe |
| POST | `/api/extensions/fetch` | `{ url }` → `200 { name, source, sha256, bytes }` — **does not install** |
| PATCH | `/api/extensions/:id` | `{ enabled?, source? }` — source edit re-probes |
| DELETE | `/api/extensions/:id` | `200 { affectedProfiles: string[], removedTools: string[], removedCommands: string[] }` |
| POST | `/api/extensions/rescan` | `200 { added, updated, removed, errors }` |
| POST | `/api/conversations/:id/ui-response` | `{ requestId, value?, confirmed?, cancelled? }` |

`ExtensionSummary`:

```ts
{ id, name, source: "managed" | "external", origin: string | null, path: string,
  enabled: boolean, loadError: string | null,
  tools: string[], commands: string[],
  disabledInProfiles: number, editable: boolean }
```

Profile endpoints gain `disabledExtensionIds: string[]` and
`allowDynamicExtensionTools: boolean`.

New error codes: `extension_name_taken`, `extension_load_failed`, `extension_not_editable`,
`extension_install_disabled`, `extension_too_large`.

## 10. Acceptance criteria

1. Pasting a valid extension that registers a tool and a command installs it; the install
   confirmation names both; the tool appears in the tool catalog as kind `extension` and is
   selectable in a profile; `/command` appears in the `/` menu of a **new** conversation.
2. Pasting an extension with a syntax error is rejected with the load error and nothing is
   written to `$PIUI_HOME/extensions/`.
3. An extension in `~/.pi/agent/extensions/` is auto-registered as `external`, enabled, and
   active in a new conversation without any UI action.
4. Disabling an extension **for one profile** leaves it active in conversations using another
   profile, verified by the presence/absence of its tool in each conversation's Tools panel.
   Implementation is an array filter on `additionalExtensionPaths` — no pi-side filtering.
5. Globally disabling an extension removes its tools/commands everywhere for new conversations
   and leaves running conversations untouched, with the "applies to new conversations" notice.
6. An extension calling `ctx.ui.confirm()` renders a modal in the conversation; answering it
   resolves the extension's promise; reloading the page mid-dialog re-renders it from the
   snapshot; answering in a second tab closes the first tab's modal.
7. An extension that throws produces a visible `notice`/warning naming the extension path, and
   the conversation continues working.
8. Uninstalling an extension lists affected profiles and disappearing tools before confirming,
   and moves the file to trash rather than deleting it.
9. URL install shows the full fetched source and cannot be installed without ticking the review
   checkbox; `PIUI_DISABLE_EXTENSION_INSTALL=1` makes every mutation route `403`.
10. No tool call is ever blocked pending user confirmation anywhere in piui (grep the codebase:
    no approval/denylist logic exists).
