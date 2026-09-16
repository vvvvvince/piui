# S10 — prompt templates, argument substitution, `/skill:` expansion (M5b)

- **Question:** what does `promptsOverride` have to return, how does pi expand `$1`/`$@`, and
  does `enableSkillCommands: true` really turn `/skill:<name>` into an expansion?
- **Spec assumption:** `15-commands-and-input.md` §§1.3, 1.4, 3.1.
- **Verified against:** `dist/core/prompt-templates.{d.ts,js}`, `dist/core/agent-session.js`,
  `dist/core/resource-loader.js`; executed as
  `plan/spikes/scratch/s10-prompts-and-skill-commands.mjs`.
- **Answer:** confirmed, with four facts that shape the implementation.

## 1. `PromptTemplate` is the contract

```ts
interface PromptTemplate {
  name: string; description: string; argumentHint?: string;
  content: string; sourceInfo: SourceInfo; filePath: string;
}
```

`promptsOverride: () => ({ prompts, diagnostics })` is enough: `AgentSession.promptTemplates`
is literally `resourceLoader.getPrompts().prompts`. The loader rewrites `sourceInfo` from the
file path, so piui may pass a synthetic one — piui computes its own `location` badge anyway and
never reads `sourceInfo` back.

Frontmatter is parsed by pi's YAML frontmatter helper: `description` and `argument-hint`
(hyphen, not camelCase). With no `description`, pi falls back to the **first non-empty body
line, truncated at 60 chars + `...`** — replicated verbatim in `server/src/pi/prompts.ts`.

`loadPromptTemplates()` is **not exported** from the package root and the `exports` map blocks a
deep import, so piui scans the three directories itself (same rules: non-recursive, `*.md`,
basename = command name). That is *discovery*, not substitution.

## 2. Expansion happens inside pi, on every entry point

`prompt()` defaults `expandPromptTemplates: true`; `steer()` and `followUp()` always expand.
Order inside pi: extension command → `_expandSkillCommand` → `expandPromptTemplate`. So piui
passes the typed text through unchanged and never touches `$1`/`$@`.

Observed output (fake provider, real `AgentSession`):

| typed | user message pi produced |
|---|---|
| `/component Button "click handler"` (`Create component $1 that handles $@.`) | `Create component Button that handles Button click handler.` |
| `/review https://example.com/pr/1` (`Review $1 carefully.`) | `Review https://example.com/pr/1 carefully.` |
| `/skill:pdf-tools extract` | `<skill name="pdf-tools" location="…/SKILL.md">\nReferences are relative to …\n\nUse pdftotext.\n</skill>\n\nextract` |
| `/compcat typo` (unknown) | `/compcat typo` — **passed through verbatim as a prompt** |

Note `$@` is *all* args including `$1` (bash semantics), so the second row really is
"Button click handler". Quoted arguments are parsed by pi (`parseCommandArgs`).

The last row is why acceptance 6.5 has to be enforced **client-side**: pi happily sends an
unknown `/word` to the model.

## 3. Precedence is "first match wins"

`expandPromptTemplate` does `templates.find(t => t.name === name)`. Duplicates are not an error.
So the composed array must be ordered **highest precedence first**: project → user → piui.
Verified: with `shadowed.md` in both the project and the user dir, `/shadowed` expanded to the
project body.

## 4. `enableSkillCommands` does **not** gate expansion

`_expandSkillCommand` is unconditional on `settingsManager`; the setting only drives the TUI's
autocomplete provider. Consequence for piui: `/skill:<name>` expands in **chat mode too** if a
skill were ever handed to a chat session — chat mode passes `skills: []`, so the expansion is a
no-op and the command is simply absent from the `/` menu (acceptance 6.10 holds by
construction, not by a flag).

- **Consequence:** `server/src/pi/prompts.ts` (discovery + composition) and
  `promptsOverride` in `createResourceLoader`; the argument grammar is never reimplemented and
  every substitution test asserts on `session.messages`.
- **Date:** 2026-02-21
