# S3 — `createAgentSession` options and `SettingsManager.inMemory`

- **Question:** exact option shape for session construction; does `SettingsManager.inMemory`
  exist?
- **Spec assumption:** `01-architecture.md` §4.2.
- **Verified against:** `dist/core/sdk.d.ts`, `dist/core/settings-manager.d.ts`,
  `dist/core/agent-session.d.ts`; executed in `s2-s5-resources-events.mjs`.
- **Answer:** **confirmed with renames.**

```ts
export interface CreateAgentSessionOptions {
  cwd?: string; agentDir?: string;
  modelRuntime?: ModelRuntime;          // spec said "modelRuntime" — correct
  model?: Model<any>; thinkingLevel?: ThinkingLevel;
  scopedModels?: Array<{ model; thinkingLevel? }>;
  noTools?: "all" | "builtin";          // NEW: chat mode should use noTools: "all"
  tools?: string[];                      // allowlist
  excludeTools?: string[];
  customTools?: ToolDefinition[];
  resourceLoader?: ResourceLoader;
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
  sessionStartEvent?: SessionStartEvent;
}
// returns { session, extensionsResult, modelFallbackMessage? }
```

- `SettingsManager.inMemory(overrides)` exists and accepts `enableSkillCommands`,
  `steeringMode`, `followUpMode`.
- **`tools: []` does not mean "no tools".** pi treats an empty/omitted allowlist as "use the
  defaults". Chat mode MUST pass `noTools: "all"` and rely on `customTools` for
  `web_search`/`web_fetch`. (Amends `01-architecture.md` §4.2, row `tools`.)
- Useful accessors on `AgentSession`: `getActiveToolNames()`, `getAllTools(): ToolInfo[]`,
  `getToolDefinition(name)`, `setActiveToolsByName(names)`, `systemPrompt`, `messages`,
  `state`, `isStreaming`, `isIdle`, `sessionFile`, `sessionId`, `dispose()`.

- **Consequence:** `server/src/pi/agent-runner.ts` maps `ResolvedSessionConfig` onto exactly
  these fields; the tool allowlist is `tools` + `noTools: "all"` when the resolved set is empty.
- **Date:** 2026-09-15
