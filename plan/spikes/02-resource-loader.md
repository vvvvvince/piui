# S2 — `DefaultResourceLoader` overrides and ambient suppression

- **Question:** do the override hooks exist, and do they fully suppress pi's ambient discovery?
- **Spec assumption:** `01-architecture.md` §4.3.
- **Verified against:** `dist/core/resource-loader.d.ts`; executed as
  `plan/spikes/scratch/s2-s5-resources-events.mjs`.
- **Answer:** **confirmed**, plus stronger switches than the spec knew about.

```ts
export interface DefaultResourceLoaderOptions {
  cwd: string; agentDir: string; settingsManager?: SettingsManager;
  additionalExtensionPaths?: string[]; additionalSkillPaths?: string[];
  additionalPromptTemplatePaths?: string[]; extensionFactories?: InlineExtension[];
  noExtensions?: boolean; noSkills?: boolean; noPromptTemplates?: boolean;
  noThemes?: boolean; noContextFiles?: boolean;
  systemPrompt?: string; appendSystemPrompt?: string[];
  extensionsOverride?; skillsOverride?; promptsOverride?; themesOverride?;
  agentsFilesOverride?; systemPromptOverride?; appendSystemPromptOverride?;
}
```

Notes:

- Override callbacks receive the **base** value and return the replacement — i.e.
  `systemPromptOverride: (base) => string | undefined`, not `() => string`. The spec's snippet
  (`systemPromptOverride: () => buildSystemPrompt(resolved)`) still type-checks.
- Getter shapes are wrapped objects: `getSkills(): { skills, diagnostics }`,
  `getPrompts(): { prompts, diagnostics }`, `getAgentsFiles(): { agentsFiles }`,
  `getSystemPrompt(): string | undefined`. Not bare arrays.
- Suppression verified: a project `AGENTS.md` and a project `.pi/settings.json` in `cwd` did
  **not** reach the session (`session.systemPrompt` contained the piui persona and not the
  ambient file), and `getExtensions().extensions.length === 0` with
  `additionalExtensionPaths: []` + `extensionFactories: []`.
- The `noExtensions` / `noSkills` / `noPromptTemplates` / `noContextFiles` flags are the cheap
  belt-and-braces for chat mode; use them in addition to the overrides.

- **Consequence:** no hand-written `ResourceLoader` is needed (the fallback in
  `01-architecture.md` §4.3 is unused). `server/src/pi/resources.ts` builds a
  `DefaultResourceLoader` per conversation with the overrides above, and an integration test
  asserts the ambient-leak check.
- **Date:** 2026-09-15
