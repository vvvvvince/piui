# S7 / S10 / S11 — steering, `defineTool`, built-in tool names (partial: typings only)

Timeboxed static verification; the behavioral half of S7 is re-run in M2/M5 with the fake
provider (`stall` script item).

- **Verified against:** `dist/core/agent-session.d.ts`, `dist/core/extensions/types.d.ts`,
  `dist/core/tools/index.d.ts`, `dist/core/sdk.d.ts`.

## S7 — steering / follow-up / abort

```ts
prompt(text: string, options?: PromptOptions): Promise<void>;
interface PromptOptions {
  expandPromptTemplates?: boolean;      // default true — S8 confirms the expansion surface
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";   // REQUIRED while streaming
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
steer(text, images?): Promise<void>;
followUp(text, images?): Promise<void>;
abort(): Promise<void>;
getPendingMessages(): { steering: string[]; followUp: string[] };
get steeringMode(): "all" | "one-at-a-time";
```

Confirms `09-api.md` §8: a `prompt` while `isStreaming` maps to `prompt(text, {streamingBehavior})`;
absent the field piui returns `409 conversation_busy` **before** calling pi.
`preflightResult` is the hook that tells piui whether pi accepted the prompt (e.g. rejected by
an extension `input` handler) — surface a `notice` UiEvent when `false`.

## S10 — `defineTool`

```ts
export declare function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
```

TypeBox `TSchema` for parameters, as the spec assumed. There is **no** injected `fetch` in the
tool execution context: piui's own tools are built by factories that close over the injected
`fetch` from config (`web-search.ts`, `web-fetch.ts`, `http-tool.ts`), which is what
`20-development-method.md` §3.6 requires anyway.

## S11 — built-in tool names

`createCodingTools({ cwd })` → **`read`, `bash`, `edit`, `write`** (the default active set).
Additional factories exported individually: `createGrepTool`, `createFindTool`, `createLsTool`,
`createPowerShellTool`, `createReadOnlyTools`. `session.getAllTools()` returns the registry
(`ToolInfo[]`) and `getActiveToolNames()` the enabled subset — the catalog in
`05-skills-and-tools.md` part B is built from `getAllTools()`, not from a hardcoded list.

- **Date:** 2026-09-15
