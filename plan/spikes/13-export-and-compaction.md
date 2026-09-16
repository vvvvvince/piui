# S14 — export and compaction in pi 0.85.1 (M7)

- **Question:** does pi expose an HTML/Markdown exporter piui can delegate to (spec `09-api.md`
  §8 says `?format=html` should "delegate to pi's HTML export when the live session exists"), and
  what exactly is the compaction entry point — `isCompacting`, the trigger, the events, and what
  `compact()` does to `session.messages` and therefore to the projected transcript?
- **Spec assumption:** `09-api.md` §8 (`GET …/export`, `POST …/compact`), `10-frontend.md` §2
  (`ContextMeter` offers "Compact now" above 70 %).
- **Verified against:** `dist/index.d.ts`, `dist/config.d.ts`, `dist/core/export-html/index.d.ts`,
  `dist/core/agent-session.{d.ts,js}`, `dist/core/compaction/compaction.d.ts`; executed against a
  real `AgentSession` + the fake provider, offline:
  `plan/spikes/scratch/s14-export-and-compact.mjs`.
- **Answer:** export **cannot** be delegated (the exporter exists but is unreachable);
  compaction **can** — `session.compact()` is a real, awaitable entry point.

## 1. pi has an HTML exporter, and it is not reachable from piui

`dist/core/export-html/index.js` ships `exportSessionToHtml(sessionManager, state?, options?)`
and `exportFromFile(inputPath, options?)` (plus `template.html`, `template.css`, an ANSI→HTML
converter and a tool renderer). Neither is re-exported from the package root:

```
package-root exports matching /export|html|render|markdown/i: getMarkdownTheme, renderDiff
exportSessionToHtml on root? undefined
exportFromFile on root?    undefined
```

and the package's `exports` map has exactly three subpaths (`.`, `./rpc-entry`, `./client`,
`./experimental/plugin`), so a deep import fails hard:

```
ERR_PACKAGE_PATH_NOT_EXPORTED  Package subpath './dist/core/export-html/index.js'
is not defined by "exports" in .../pi-coding-agent/package.json
```

The only public transcript serializer is `serializeConversation(messages)` → a **plain-text**
`[User]: …\n\n[Assistant]: …` string. Not Markdown (no fences, no tool-call structure), not HTML.

**Consequence:** the `09-api.md` §8 "delegate to pi's HTML export" clause is not implementable
against 0.85.1 through a supported API. piui renders all three formats itself, from the same
`UiMessage[]` the transcript renders — which is also the only representation that carries piui's
own additions (tool cards with `details`, image attachments, the `/command` echo). Recorded as an
M7 deviation; if pi ever exports `exportFromFile`, swapping the `html` branch is one module.

## 2. Compaction: `session.compact(customInstructions?)`

```ts
compact(customInstructions?: string): Promise<CompactionResult>
CompactionResult = { summary, firstKeptEntryId, tokensBefore,
                     estimatedTokensAfter?, usage?, details? }
```

Observed against the fake provider (`keepRecentTokens: 200` so a small session compacts):

```
Q4b: compact() -> { summary: "summary of the conversation so far\n\n---\n\n**Turn Context
     (split turn):** …", firstKeptEntryId: "3fc6a4d9", tokensBefore: 30,
     estimatedTokensAfter: 673, usage: [input, output, cacheRead, cacheWrite, totalTokens, cost] }
Q4c: events emitted during compact: compaction_start, compaction_end
     compaction_start {"reason":"manual"}
     compaction_end   {"reason":"manual","aborted":false,"willRetry":false,"hasResult":true}
```

Facts that matter for M7:

1. **It is one model call.** The summary comes from the session's own model (the fake provider's
   next scripted turn), so a piui test must script a turn for it.
2. **It aborts the current run first** (`await this.abort()` is the first line) and never resumes
   the interrupted turn. So the route may be synchronous: `await session.compact()` resolves when
   the summary is written.
3. **Events**: `compaction_start { reason: "manual" }` then `compaction_end { reason, result,
   aborted, willRetry, errorMessage? }`. Auto-compaction uses the same two events with
   `reason: "threshold" | "overflow"`, so projecting the pair covers both paths for free.
   `isCompacting` is true between them; `isIdle` is false.
4. **Failure is an exception *and* a `compaction_end` with `errorMessage`.** Two refusals are
   plain `Error`s, not typed: `"Nothing to compact (session too small)"` and `"Already
   compacted"`. A session under `keepRecentTokens` (default 20 000) can never be compacted —
   which is why a piui test has to lower the setting or the run has to be genuinely long.
5. **`session.messages` is replaced, not appended to.** After a successful compaction:

   ```
   messages BEFORE: user,assistant,user,assistant,user,assistant   (6)
   messages AFTER:  compactionSummary,assistant                    (2)
   raw[0] = { role: "compactionSummary", summary: "…", tokensBefore: 30, timestamp: … }
   ```

   The kept tail follows it. A further `prompt()` appends normally
   (`compactionSummary,assistant,user,assistant`). **`projectTranscript` must learn the
   `compactionSummary` role**, or the divider silently disappears from the transcript and the
   history looks truncated for no visible reason.
6. `getSessionStats()` still reports the *cumulative* token/cost totals (they are not reset by
   compaction), and `sessionManager.getEntries()` gains a `compaction` entry
   (`getLatestCompactionEntry(entries)` returns it) — so the compaction survives a reload and a
   session revival, unlike anything piui would have to remember itself.
7. `settingsManager.getCompactionSettings()` → `{ enabled, reserveTokens: 16384,
   keepRecentTokens: 20000 }`; `SettingsManager.inMemory({ compaction: {...} })` overrides it,
   which is how the piui integration test makes a short scripted conversation compactable.

## 3. What piui does with this (M7 decisions)

- `GET /api/conversations/:id/export?format=md|json|html` renders **in piui**, from
  `UiMessage[]` (`server/src/conversations/export.ts`): `json` is `{ conversation, messages }`,
  `md` renders tool calls as fenced blocks and attachments as image links, `html` is the same
  content in one self-contained, escaped document with no external assets (CSP-safe).
- `POST /api/conversations/:id/compact` is **synchronous**: it awaits `session.compact()` and
  answers `{ summary, tokensBefore, estimatedTokensAfter, cost }`. The pair of pi events is
  projected onto the conversation channel (a `state` frame and a `notice`), and the transcript
  keeps a `compactionSummary` system message from fact 5.
