# S6 — credential surface: `login()` prompt loop, statuses, logout `[gate for M2 §1]`

- **Question:** what exactly does `ModelRuntime`'s credential surface do at runtime — prompt
  shapes, where the key lands, file mode, status/source semantics, logout, error types —
  and can piui build the generic `AuthFlow` state machine of `14-credentials.md` §2 on it?
- **Spec assumption:** `14-credentials.md` §§1–2.
- **Verified against:** `@earendil-works/pi-coding-agent@0.85.1`
  (`dist/core/model-runtime.d.ts`, `dist/core/provider-composer.d.ts`) and
  `@earendil-works/pi-ai@0.85.1` (`dist/auth/types.d.ts`, `dist/models.d.ts`); executed as
  `plan/spikes/scratch/s6-credentials.mjs` and `s6b-native-provider.mjs`.
- **Answer:** **confirmed**, with five facts the spec did not know.

## Observed

```
provider count: 40                       # built-in catalog, offline, no network
anthropic: auth.apiKey { name: "Anthropic API key", login: present }
           auth.oauth  { name: "Anthropic (Claude Pro/Max)", isSubscription: true }
ambient-only providers (apiKey without login): []      # none in this build
login("anthropic","api_key",…) prompts: [{ type: "secret",
                                           message: "Enter Anthropic API key" }]   # no signal
credential: { type: "api_key", key: "sk-…" }
auth.json written, mode 0600, content { "anthropic": { "type": "api_key", "key": "…" } }
getProviderAuthStatus  -> { configured: true, source: "stored" }
checkAuth              -> { source: "stored credential", type: "api_key" }
listCredentials        -> [{ providerId: "anthropic", type: "api_key" }]
getAvailable("anthropic").length -> 14
refresh({providers:["anthropic"]}) -> { aborted: false, errors: {} }
logout -> auth.json becomes {}; a second logout resolves (idempotent)
env ANTHROPIC_API_KEY set -> status { configured: true, source: "environment",
                                      label: "ANTHROPIC_API_KEY" }; logout() does NOT throw
```

Prompt rejection / abort:

```
prompt() throwing            -> login() rejects with that Error
interaction.signal aborted   -> login() rejects with DOMException AbortError
unknown provider             -> ModelsError "Unknown provider: …"
login("anthropic","oauth")   -> attempts a real OAuth exchange (network) — must stay 501 in V1
```

## Facts that change the implementation

1. **pi already writes `auth.json` with mode `0600`** (parent dir created `0700`). §6's chmod
   requirement is therefore a *post-condition check*, not a fix-up piui must always perform;
   piui still asserts/repairs it after every write (cheap, POSIX-only).
2. **`getProviderAuthStatus()` is a snapshot, not a live probe.** A runtime created with
   `refreshOnCreate: false` reports `configured: false` for a stored credential until an
   availability refresh has run (it becomes correct ~one tick later). piui creates the shared
   runtime with `refreshOnCreate: true, allowModelNetwork: false` — accurate statuses, still
   strictly offline. Credential mutations queue that refresh themselves, so the status after
   `login()`/`logout()` is already correct.
3. **The snapshot only knows about ambient credentials that the provider declares.** A
   hand-written provider whose `resolve()` reads an env var reports `configured: false` in
   `getProviderAuthStatus()` while `checkAuth()` reports `{ source: "STUB_AMBIENT_KEY" }`.
   `ProviderStatus.configured` is therefore built as `status.configured || checkAuth() != null`
   for the provider being inspected (`verify`), and from the snapshot for the list view
   (40 `checkAuth()` calls per list request would be a command-execution hazard —
   `ApiKeyAuth.resolve()` may run a configured shell command).
4. **No built-in provider in 0.85.1 is ambient-only** (`auth.apiKey.login` is always present),
   and every provider that offers `oauth` also offers `api_key`. Acceptance `14-credentials#9.4`
   (two prompts) and `#9.5` (ambient-only) can therefore only be exercised against a stub, which
   `ModelRuntime.registerNativeProvider(provider)` accepts: a plain object with
   `{ id, name, auth: { apiKey: { name, login?, resolve } }, getModels, stream, streamSimple }`
   registers, prompts, and persists `{ key, env }` exactly as a built-in does (verified).
5. **`logout()` on an env-sourced provider resolves without throwing** — pi deletes a stored
   credential that is not there. The `409 credential_not_removable` of §3 is therefore a piui
   precondition (`source !== "stored"`), checked *before* calling pi.

Secondary notes: `AuthPrompt.signal` is absent for api-key logins (it exists for OAuth flows
racing a callback server); `notify()` was never called by a built-in api-key login, so the
`UiAuthEvent` list is exercised through the stub; `refresh()` returns
`{ aborted: boolean, errors: Record<providerId, string> }` — `errors` is an object, not the
array `14-credentials.md` §2.2 implies, so the mapping to `warning` flattens it.

- **Consequence:** `server/src/pi/credentials.ts` implements §2 as specified: one
  `Map<flowId, AuthFlow>`, `login()` driven through the `AuthInteraction` callback pair, prefill
  auto-answer for the first `secret` prompt, TTL/retention, and `CredentialSynchronizationError`
  → success-with-warning. No spec change needed beyond the five notes above.
- **Date:** 2026-09-16
