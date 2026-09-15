# S5 / S12 — session `.jsonl`, `SessionManager`, usage & context stats

- **Question:** where does pi write sessions, what is in the file, and how does piui read
  usage/cost/context?
- **Spec assumption:** `02-data-model.md` §4 (transcript projection) and §2 notes (stats).
- **Verified against:** `dist/core/session-manager.d.ts`, `dist/core/agent-session.d.ts`;
  executed in `s2-s5-resources-events.mjs`.
- **Answer:** confirmed, with one **isolation hazard**.

```ts
static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
static inMemory(cwd?: string, options?: NewSessionOptions, entries?: FileEntry[]): SessionManager;
static forkFrom(sourcePath, targetCwd, sessionDir?, options?): SessionManager;   // [LATER]
static list(cwd, sessionDir?, onProgress?): Promise<SessionInfo[]>;
static listAll(sessionDir?, onProgress?): Promise<SessionInfo[]>;
```

> **Hazard:** `SessionManager.create(cwd)` without `sessionDir` writes to the **host**
> `~/.pi/agent/sessions/<slug>/…` — it does *not* follow `createAgentSession({ agentDir })`.
> The first spike run polluted the developer's real `~/.pi`. piui MUST always pass
> `sessionDir = join(config.agentDir, "sessions")`, and the M0 temp-root access guard
> (`20-development-method.md` §9.3) is what catches regressions here.

File shape (7 entries for a one-prompt, one-tool run):

```
{type:"session",       version,id,timestamp,cwd}
{type:"model_change",  id,parentId,timestamp,provider,modelId}
{type:"thinking_level_change", id,parentId,timestamp,thinkingLevel}
{type:"message",       id,parentId,timestamp,message}   // user / assistant / toolResult
```

`parentId` chains entries (the branching/fork substrate — `[LATER]`). `transcript.ts` projects
`type:"message"` entries and ignores the rest except `compaction`/`branch_summary`.

Stats (S12): `session.getSessionStats()` returns

```ts
{ sessionFile, sessionId, userMessages, assistantMessages, toolCalls, toolResults,
  totalMessages, tokens: { input, output, cacheRead, cacheWrite, total }, cost,
  contextUsage?: { tokens, contextWindow, percent } }
```

- **Consequence:** `conversations.tokens_total` / `cost_total` are written from
  `getSessionStats()` at run end; `UiEvent.usage.contextPercent` is
  `contextUsage.percent * 100` (pi reports a fraction: `0.03` for 3 %) — clamp and round in
  `event-map.ts`. `conversations.session_path` is `session.sessionFile`.
- **Date:** 2026-09-15
