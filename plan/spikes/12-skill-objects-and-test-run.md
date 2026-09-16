# S13 — multi-file skills, the `<available_skills>` block and the test run (M6)

- **Question:** what does pi's `Skill` object need for a multi-file skill; does `baseDir` make
  `references/*.md` and `scripts/*.sh` reachable and does the model only see them through `read`;
  what does the prompt block look like for one skill in a session with `tools: ["read"]`; what
  does `/skill:<name>` expand to with an empty vs. a long body; and can an ephemeral session with
  an empty scratch `cwd` load a skill whose directory is outside that `cwd`?
- **Spec assumption:** `05-skills-and-tools.md` §§A.1, A.4 and acceptance B.5.6.
- **Verified against:** `dist/core/skills.{d.ts,js}`, `dist/core/agent-session.js`
  (`_expandSkillCommand`); executed against a real `AgentSession` + the fake provider, offline:
  `plan/spikes/scratch/s13-skill-objects.mjs`.
- **Answer:** confirmed on all five points.

## 1. The `Skill` object — four fields matter, `baseDir` is not indexed

```ts
interface Skill { name; description; filePath; baseDir; sourceInfo; disableModelInvocation }
```

`skillsOverride` accepts the four piui already passes (`name`, `description`, `filePath`,
`baseDir`); `sourceInfo` is unused on this path and `disableModelInvocation` is read as falsy, so
the skill stays visible. **pi never enumerates the skill directory.** `baseDir` appears in exactly
two places: `_expandSkillCommand`'s "References are relative to `<baseDir>`." line, and nothing
else. `references/api.md` does **not** appear in the system prompt. A multi-file skill is
therefore reachable only through a tool: the model resolves the relative link against `baseDir`
and calls `read` (or `bash`) with the absolute path. Consequence for M6: files besides `SKILL.md`
need no registration anywhere — writing them into the directory is the whole feature.

## 2. The prompt block for `tools: ["read"]`

pi appends (verbatim, `formatSkillsForPrompt(skills, "read")`):

```
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>pdf-tools</name>
    <description>Extract text and tables from PDFs. Use when working with PDF documents.</description>
    <location>/tmp/…/skills/pdf-tools/SKILL.md</location>
  </skill>
</available_skills>
```

Only `name`, `description` and `filePath` are in context — the progressive-disclosure contract.
The wording switches to "Use bash to load…" when `read` is absent, which is why the test run
always grants `read`.

## 3. `/skill:<name>` inlines the **whole** body, never truncated

`_expandSkillCommand` reads `filePath`, strips frontmatter and emits
`<skill name="…" location="…">\nReferences are relative to <baseDir>.\n\n<body>\n</skill>`,
with ` \n\n<args>` appended when arguments follow.

| body | expansion |
|---|---|
| empty | the block with an empty body — `…\n\n\n</skill>`, no error, no diagnostic |
| ~30 KB | the full 29 868-char block; **no truncation, no size guard** |

So a long skill costs its full size in context on every `/skill:` call, and the expansion alone
never produces a `read`.

## 4. A skill outside `cwd` loads fine; `read` reaches it

`DefaultResourceLoader` with `noSkills: true` + `skillsOverride` loaded all three skills from
`$HOME/skills/*` while `cwd` was an unrelated empty scratch dir — no diagnostics. pi's `read`
tool then executed `read { path: "<skillDir>/references/api.md" }` with `isError: false`: **the
built-in read tool is not confined to `cwd`**, it takes any absolute path.

## 5. Consequence for acceptance B.5.6

`POST /api/skills/:id/test` can be asserted offline: the ephemeral session gets an empty scratch
`cwd`, `tools: ["read"]` and the one skill; the fake provider is scripted with
`{ toolCall: { name: "read", args: { path: "<skillDir>/SKILL.md" } } }` and the transcript then
contains a real `read` of that SKILL.md with a real tool result. No real model is needed.
Since the `/skill:<name>` auto prompt *inlines* the body (§3), the read the acceptance asks for
is the model's choice, not a mechanical consequence — piui therefore scripts it in the test and
relies on pi's own prompt wording ("Use the read tool to load a skill's file") in production.

- **Date / author:** 2026-02-21, M6.
