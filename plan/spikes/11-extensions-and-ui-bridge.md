# S9 — extension loading, the probe reload, and `bindExtensions({ mode: "rpc" })` (M5c)

- **Question:** what do `additionalExtensionPaths` + `extensionFactories` actually load, what does
  a reload report for a broken extension, what shape is `LoadExtensionsResult`, what does
  `session.extensionRunner` expose, and what exactly does `bindExtensions({ mode: "rpc", uiContext,
  onError })` demand of the host — including whether an unresolved UI request blocks the run?
- **Spec assumption:** `16-extensions.md` §§1, 4, 5.
- **Verified against:** `dist/core/resource-loader.d.ts`, `dist/core/extensions/{types,runner}.d.ts`,
  `dist/core/agent-session.d.ts`; executed as `plan/spikes/scratch/s9-extensions.mjs` and
  `plan/spikes/scratch/s9b-extensions-late.mjs` against a real `AgentSession` + the fake provider,
  offline.
- **Answer:** confirmed, with five facts that shape the implementation.

## 1. The probe: a loader reload, no session, no model

`new DefaultResourceLoader({ noExtensions: true, additionalExtensionPaths: [...] })` +
`await loader.reload()` **never throws**, whatever the extension does. Everything lands in
`getExtensions(): LoadExtensionsResult`:

```
extensions: [{ path, resolvedPath, sourceInfo, tools: Map, commands: Map, handlers: Map, flags, shortcuts }]
errors:     [{ path, error }]
runtime:    { sendMessage, appendEntry, getActiveTools, setActiveTools, refreshTools, … }
```

Observed error strings (all non-fatal, per path):

| candidate | `errors[].error` |
|---|---|
| syntax error | `Failed to load extension: ParseError: Unexpected keyword 'this'. …:1:28` |
| factory throws at load | `Failed to load extension: top-level boom` |
| missing file | `Extension path does not exist: …/nope.ts` |
| **a directory** | `Extension path does not exist: …` — a *directory* is **not** expanded |

So "register a path that is a directory of `*.ts`" (`16-extensions.md` §7.1) has to be expanded to
individual files by piui; pi only accepts files. `extensionFactories` load as
`path: "<inline:piui-notices>"` and never appear in `errors`.

`tools`/`commands` are `Map<string, …>` keyed by name — `[...e.tools.keys()]` is the cached catalog.
`pi.registerCommand(name, options)` takes the name as the **first argument** (not a field).

## 2. `session.extensionRunner`

`getCommand(name) → ResolvedCommand | undefined` (`{ name, invocationName, description, handler,
sourceInfo }`), `getRegisteredCommands()`, `getAllRegisteredTools()`, `getActiveTools()`,
`getExtensionPaths()`, `hasHandlers(eventType)`, `onError(listener)`, `emitError(error)` (returns
`void`, fans out to the listeners registered via `bindExtensions({ onError })`).

## 3. `bindExtensions({ mode: "rpc", uiContext, onError })`

`uiContext` must be a **complete** `ExtensionUIContext` — pi calls the member the extension calls
and nothing more, but TypeScript demands all of them: `select/confirm/input/editor`, `notify`,
`setStatus`, `setWidget`, `setTitle`, `setFooter/setHeader/custom/setEditorComponent/
getEditorComponent`, `pasteToEditor/setEditorText/getEditorText`, `onTerminalInput`,
`addAutocompleteProvider`, `setWorking*`, `setHiddenThinkingLabel`, theme getters/setters,
`get/setToolsExpanded`. Observed payloads from a tool that prompts:

```
["confirm","Deploy?","Deploy to prod?", opts|null]   // opts = { signal?, timeout? }
["notify","deploying prod","info"]
["setStatus","deploy","deploying"]
["setWidget","deploy",["deploying prod"], opts|null] // opts = { placement? }
```

**An unresolved request blocks the run.** The tool's `await ctx.ui.confirm(...)` does not return
until the promise the host returned settles: the run sat streaming for the full 1.5 s the spike
waited, and finished only after the host resolved. Consequences for piui: the pending request must
survive a snapshot/reconnect (it is the only way to unblock), and the existing wall-clock runaway
cap (`PIUI_MAX_RUN_MINUTES`) is the backstop for a request nobody answers.

`onError` receives `{ extensionPath, event, error, stack? }`. A handler that throws on **every**
`message_end` produced four `onError` calls and the run still completed normally — a broken
extension cannot take a conversation down.

## 4. Extension commands are dispatched inside `prompt()`

`await session.prompt("/deploy now")` ran the command handler (its `ctx.ui.notify` fired) and added
**zero** messages to the transcript — pi dispatched it and never reached the model. Confirms
`16-extensions.md` §4: extension commands are `kind: "expand"`-like from the client's point of view
(type and send), `availableWhileStreaming: true`, and piui must not try to execute them itself.

## 5. Late-registered tools need the allowlist up front

A tool registered inside a `session_start` handler is visible in `getActiveTools()` **immediately
after** `createAgentSession` — but only if the construction allowlist admits it:

| construction | active tools |
|---|---|
| no `tools` option | `read, bash, edit, write, late_tool` |
| `tools: ["late_tool"]` | `late_tool` |
| `tools: ["read"]` | `read` — and the model gets `Tool late_tool not found` |

`session.setActiveToolsByName(["read","late_tool"])` **cannot** re-add it: pi intersects with the
`allowedToolNames` computed at construction (same rule as spike S8's `noTools: "all"`).

→ piui's `allowDynamicExtensionTools` is therefore implemented as *observe, persist, allow next
time*: after `bindExtensions`, piui reads `extensionRunner.getAllRegisteredTools()`, stores any
name that was not in the probe cache into `extensions.tools_json`, and the next session built for
that profile admits it. That is exactly the spec's "shows them … once seen"
(`16-extensions.md` §4); a *first* run after installing an extension that registers lazily does not
see the tool, which is honest and costs no second session.

- **Consequence:** `server/src/pi/extensions.ts` (probe + `bindExtensions` + the structural
  `PiuiExtensionUi` port), `server/src/extensions/service.ts` (enumeration, persistence,
  resolution), and the UI bridge in `LiveSession`.
- **Date / author:** 2026-02-21, M5c.
