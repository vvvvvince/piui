# S10 — `defineTool`, the custom-tool execution context, and how `customTools` reach a session

- **Question:** what does a `defineTool` definition look like in 0.85.1, what is handed to
  `execute()`, and do `customTools` run when chat mode passes `noTools: "all"`?
- **Spec assumption:** `05-skills-and-tools.md` B.3/B.4 — chat mode's tools are
  `customTools = webSearch ? [web_search, web_fetch] : []`; `01-architecture.md` §4.2 +
  spike S3 — chat mode passes `noTools: "all"`.
- **Verified against:** `dist/core/extensions/types.d.ts`, `dist/core/sdk.js` (tool allowlist
  computation), `docs/sdk.md` §Custom Tools; executed in
  `plan/spikes/scratch/s10-custom-tools.mjs` against the scripted fake provider.
- **Answer:** **confirmed, with one correction that matters.**

```ts
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
  name: string; label: string; description: string;
  promptSnippet?: string; promptGuidelines?: string[];
  parameters: TParams;                       // TypeBox schema (package `typebox`, not @sinclair)
  execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
          onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
          ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>;
  renderCall?/renderResult?                  // TUI only; piui never uses them
}
export declare function defineTool<…>(tool: ToolDefinition<…>): ToolDefinition<…> & AnyToolDefinition;

// AgentToolResult: { content: (TextContent|ImageContent)[]; details: T; usage?; addedToolNames?; terminate? }
```

Observed from the spike run:

```
noTools:all + customTools     | activeTools = []            | executions = 0
tools:["web_search"] + custom | activeTools = ["web_search"] | executions = 1
                              | toolEvents = tool_execution_start,tool_execution_update,tool_execution_end
execute() ctx keys: ui, mode, hasUI, cwd, sessionManager, modelRegistry, model, scopedModels,
                    thinkingLevel, isIdle, isProjectTrusted, signal
```

- **`noTools: "all"` disables custom tools too.** `sdk.js` computes
  `allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined)`, and the
  allowlist is applied to the merged built-in + custom + extension set. A session created with
  `noTools: "all"` *and* `customTools: [webSearch]` reports `getAllTools() === []` and the model
  never sees the tool (pi answers the tool call with an error, hence the
  `tool_execution_start`/`_end` pair with zero `execute()` calls).
  → chat mode with web search **on** must pass `tools: ["web_search", "web_fetch"]` *and*
  `customTools`; with web search **off** it keeps `noTools: "all"`. This is exactly what
  `05-skills-and-tools.md` B.4 means by "the union … must also include custom tool names";
  `server/src/pi/agent-runner.ts` already switches on `config.tools.length > 0`.
- `onUpdate(partialResult)` is delivered as a `tool_execution_update` event → the UI can show
  "searching…" instead of a frozen card (B.3's progress requirement is satisfiable).
- `signal` is always passed, so the fetch timeout/abort plumbing has a real abort source.
- `ctx` is the full `ExtensionContext`; piui's web tools need none of it, so they close over
  their own injected `fetch`/provider instead — which is what keeps them unit-testable.
- The TypeBox import is the bare `typebox` package (pi's own dependency), *not*
  `@sinclair/typebox` (which the server also has, for Fastify schemas). Mixing the two in one
  definition object type-checks but is confusing; `server/src/pi/tools/**` uses `typebox`.

- **Consequence:** `resolveChatTools({ webSearch })` returns the **names**
  (`["web_search","web_fetch"]` / `[]`) and the conversation service passes the matching
  `customTools`; `agent-runner.ts` needs no change.
- **Date / author:** 2026-02-21, M3.
