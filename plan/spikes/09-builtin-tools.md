# S9 — pi's built-in tools for real: names, parameters, and the `tool_execution_*` payloads

- **Question:** M5 is the first milestone that runs pi's *built-in* tools. What are their exact
  names and parameter shapes, what does a tool card get to render (diff? exit code? streaming
  stdout?), and does agent mode keep pi's default system prompt while AGENTS.md/memory/skills
  are injected?
- **Spec assumption:** `05-skills-and-tools.md` §B.1 (the eight names), `08-agent-mode.md` §2
  (tool cards: `read` line range, `write` byte count, `edit` `details.patch`, `bash` streaming
  stdout + exit code + duration), `03-profiles.md` §2 ("**not** `systemPromptOverride`; the pi
  default system prompt MUST be preserved in agent mode").
- **Verified against:** `dist/core/tools/{index,read,write,edit,bash,grep,find,ls}.d.ts`;
  executed in `plan/spikes/scratch/s09-builtin-tools.mjs` and `s09b-agent-prompt.mjs` against
  the scripted fake provider.
- **Answer:** confirmed, with four practical corrections.

```ts
export type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";
read   { path, offset?, limit? }                 details?: { truncation }
write  { path, content }                         details: undefined
edit   { path, edits: { oldText, newText }[] }   details: { diff, patch, firstChangedLine }
bash   { command, timeout? }                     details?: { truncation, fullOutputPath }
grep   { pattern, path?, glob?, ignoreCase?, literal?, context?, limit? }
find   { pattern, path?, limit? }
ls     { path?, limit? }
```

Observed event stream (`tools: ["read","write","edit","bash","grep","find","ls"]`,
`session.getAllTools()` returns exactly those seven):

```
tool_execution_start  keys: type,toolCallId,toolName,args
tool_execution_update keys: type,toolCallId,toolName,args,partialResult   (bash only)
tool_execution_end    keys: type,toolCallId,toolName,result,isError
edit  end result.details = { diff: " 1 alpha\n-2 beta\n+2 BETA", patch: "--- seed.txt\n+++ …", firstChangedLine: 2 }
bash  updates carry the **cumulative** stdout so far ("one\n" → "one\ntwo\n" → …), not deltas
bash  failure → isError: true, text "(no output)\n\nCommand exited with code 3"
read  missing file → isError: true, text "ENOENT: … access '/tmp/…/nope.txt'"
```

1. **`edit` gives a real unified patch** (`details.patch`) *and* a display diff
   (`details.diff`) — the spec's diff card is directly renderable, and piui's existing
   `safeDetails` (8 KB cap) already ships them to the client.
2. **`bash` has no exit-code field.** The exit code only appears as the trailing text
   `Command exited with code N` on failure; `isError` is the reliable signal. The card shows
   *failed* / *ok* from the block state and surfaces the text; no fake exit-code badge.
   `tool_execution_update.partialResult` is cumulative, so the streaming card *replaces* the
   output rather than appending — which is exactly what `EventProjector.onToolProgress`
   already does.
3. **`grep`/`find` shell out to bundled `rg`/`fd` binaries resolved under the *real*
   `~/.pi/agent/bin`**, not under our `agentDir`. On a host without them (or without exec
   permission — this sandbox) they return a tool error rather than crashing. Consequence: the
   suite never asserts a successful `grep`/`find`; agent integration tests drive
   `write`/`edit`/`bash`/`read`/`ls`, which are pure Node and always work offline.
4. **Agent mode must not pass `systemPromptOverride`** (S9b). Without it the composed prompt is
   pi's default: persona + `Available tools:` list built from the resolved allowlist + per-tool
   guidelines, then `<project_context><project_instructions path="…/AGENTS.md">…` from
   `agentsFilesOverride` (the memory block rides the same mechanism as a second entry), then
   `<available_skills>` with **name + description + location only** — the skill body is *not*
   in the prompt, which is what makes `03-profiles#8.4` ("the transcript shows a `read` of that
   SKILL.md") the correct assertion. Chat mode keeps its override (`07-chat-mode.md` §2).

- **Consequence:** `createResourceLoader` takes `systemPrompt?: string` (omitted ⇒ pi's
  default) and `skills`; `agent-runner.ts` is otherwise unchanged. Tool cards render
  `edit.details.patch`, `bash` streaming text, `read`/`write`/`ls` args + output; no exit-code
  badge is invented.
- **Date / author:** 2026-02-22, M5.
