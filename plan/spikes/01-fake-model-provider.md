# S1 — scripted fake model provider `[gate]`

- **Question:** can piui register a scripted provider on `ModelRuntime` that drives a real
  `AgentSession` offline, including real tool execution and multi-turn loops?
- **Spec assumption:** `20-development-method.md` §3.1.
- **Verified against:** `@earendil-works/pi-coding-agent@0.85.1` —
  `dist/core/model-runtime.d.ts`, `dist/core/provider-composer.d.ts`,
  `@earendil-works/pi-ai@0.85.1` `dist/utils/event-stream.d.ts`; executed as
  `plan/spikes/scratch/s1-fake-provider.mjs`.
- **Answer:** **confirmed**, with three corrections.

```ts
// ModelRuntime
registerProvider(providerId: string, config: ProviderConfigInput): void;

// ProviderConfigInput (dist/core/provider-composer.d.ts)
streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions)
  => AssistantMessageEventStream;
models?: Array<{ id; name; api?; baseUrl?; reasoning; input; cost; contextWindow; maxTokens; ... }>;
```

Corrections to the spec's assumption:

1. `createAssistantMessageEventStream()` is **not** exported from the `@earendil-works/pi-ai`
   root. It lives at the subpath `@earendil-works/pi-ai/utils/event-stream`, so piui must
   declare a direct dependency on `@earendil-works/pi-ai@0.85.1` (added to `server`), not rely
   on it transitively.
2. A registered provider with `streamSimple` still goes through pi's **auth preflight**:
   without credentials `AgentSession.prompt()` throws `No API key found for <provider>`.
   The fake provider therefore sets a literal `apiKey: "piui-fake-key"` in its config
   (`getProviderAuthStatus()` → `{configured: true, source: "fallback"}`). No network is used.
3. `pi-ai` also ships a ready-made faux provider
   (`@earendil-works/pi-ai/providers/faux`: `fauxProvider()`, `fauxAssistantMessage()`,
   `fauxToolCall()`, `setResponses()`, `tokensPerSecond`). It is usable via
   `ModelRuntime.registerNativeProvider(faux.provider)`. piui keeps its **own** scripted
   provider because the spec's script items (`stall`, `error`, per-turn queueing, fixed usage)
   map 1:1 onto `streamSimple`, but `faux` is the documented fallback if the composer layer
   changes.

Verified behaviors in one run (`tools: ["write"]`, two scripted turns):

- thinking deltas, text deltas in 5-char chunks, one tool call;
- pi executed the **real** `write` tool (file present on disk with the scripted content);
- the second scripted turn produced the final assistant text;
- `session.getSessionStats()` reported deterministic tokens (60) and cost (0.006).

- **Consequence:** the TDD plan stands; the `PIUI_FAKE_MODEL=1` seam is
  `server/test/support/fake-model.ts` implementing `streamSimple`, and the fallback ladder in
  `plan/08` is not needed. `20-development-method.md` §3.1's claim that `pi-ai` exports
  `createAssistantMessageEventStream()` from its root is superseded by the subpath import.
- **Date:** 2026-09-15
