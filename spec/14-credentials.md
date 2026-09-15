---
id: 14-credentials
title: Provider credentials in the UI
status: normative
summary: >-
  Decision Q1=B. pi credential APIs, the CredentialService AuthFlow state machine, HTTP contract, credential dialog, step-up re-auth, secret-handling rules.
covers: [provider-credentials, auth-flow, api-keys, step-up, secret-hygiene]
depends_on: [06-auth, 09-api]
required_by: [10-frontend]
decisions: [Q1, Q7]
milestones: [M1, M2]
spec_version: 1
updated: 2026-02-20
---

# 14 — Provider credentials in the UI

> **Decision Q1 = B**: piui manages provider **API keys** from the web UI (create, replace,
> delete), on top of pi's `ModelRuntime`. OAuth/subscription logins are **not** in V1 but the
> flow machinery below is built generically so adding them is a type-allowlist change
> (see §8).

## 1. What pi actually gives us (verified against the installed typings)

`node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.d.ts`:

```ts
class ModelRuntime implements Models {
  getProviders(): readonly Provider[];
  getProvider(id): Provider | undefined;
  getProviderAuthStatus(id): AuthStatus;      // { configured, source?, label? }  — sync, no secrets
  checkAuth(id, opts?): Promise<AuthCheck | undefined>;   // { source?, type }
  hasConfiguredAuth(id): boolean;
  isUsingOAuth(id): boolean;
  isUsingSubscription(id): boolean;
  listCredentials(opts?): Promise<readonly CredentialInfo[]>;  // { providerId, type } only
  login(providerId, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
  logout(providerId, opts?): Promise<void>;
  setRuntimeApiKey(id, apiKey, opts?): Promise<void>;     // NOT persisted
  removeRuntimeApiKey(id, opts?): Promise<void>;
  refresh(opts?): Promise<ModelsRefreshResult>;
  getAvailable(id?, opts?): Promise<readonly Model[]>;
}
```

`Provider.auth: ProviderAuth` (from `pi-ai/dist/auth/types.d.ts`):

```ts
interface ApiKeyAuth {
  name: string;                                   // "Anthropic API key"
  login?(i: ProviderAuthInteraction): Promise<ApiKeyCredential>;  // ABSENT => ambient-only
  check?(...): Promise<AuthCheck | undefined>;
  resolve(...): Promise<AuthResult | undefined>;  // merges credential.key ?? env("ANTHROPIC_API_KEY") ...
}
interface OAuthAuth { name: string; isSubscription?: boolean; loginLabel?: string; login(...); refresh(...); toAuth(...); }
type AuthType = "api_key" | "oauth";
```

`AuthInteraction` is the callback pair pi drives during `login()`:

```ts
interface AuthInteraction {
  signal?: AbortSignal;
  prompt(p: AuthPrompt): Promise<string>;   // p.type: "text" | "secret" | "select" | "manual_code"
  notify(e: AuthEvent): void;               // "info" | "auth_url" | "device_code" | "progress"
}
```

Consequences that the implementation MUST respect:

1. **Persisting a key goes through `login(id, "api_key", interaction)`** — not
   `setRuntimeApiKey` (runtime-only, lost on restart) and not by writing `auth.json` by hand.
   The provider's own `login()` decides what to ask for; some providers need more than a key
   (e.g. account/gateway ids land in `ApiKeyCredential.env`). piui must therefore implement the
   **whole prompt loop**, not a single "paste key" field.
2. **A provider whose `auth.apiKey.login` is absent is ambient-only** (env vars, AWS profiles,
   ADC files). The UI MUST NOT offer key entry for it; it shows *"configured via environment"*
   plus the expected variable name from `AuthStatus.label`, and the only fix is env/config.
3. **`AuthStatus.source`** tells us where a working credential came from:
   `"stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command"`.
   Delete/"Sign out" is offered **only** for `source === "stored"`; for `"environment"` the UI
   explains that piui cannot remove it.
4. **Secrets are never readable back.** `listCredentials()` returns `{ providerId, type }` only,
   and `CredentialStore.read()` (which does return the key) MUST NOT be called by any route.
5. `login()`/`logout()` may reject with `CredentialSynchronizationError` — the credential *was*
   written but the local snapshot did not converge. Handle it specifically: report success with
   a warning and trigger a `refresh()`, do not retry the write.

## 2. Server component: `CredentialService`

Lives in `server/src/pi/credentials.ts` (inside the pi boundary). Public surface:

```ts
interface ProviderAuthMethod {
  type: "api_key" | "oauth";
  name: string;                // provider-supplied display name
  interactive: boolean;        // api_key: login !== undefined ; oauth: always true
  isSubscription?: boolean;
  loginLabel?: string;
  enabledInPiui: boolean;      // V1: true only for api_key (Q1 = B); oauth => false
}

interface ProviderStatus {
  id: string; name: string;
  configured: boolean;
  source?: AuthStatus["source"];
  label?: string;              // e.g. "ANTHROPIC_API_KEY"
  credentialType?: "api_key" | "oauth";
  removable: boolean;          // source === "stored"
  methods: ProviderAuthMethod[];
  modelCount: number;
  availableModelCount: number;
}

interface CredentialService {
  listProviders(): Promise<ProviderStatus[]>;
  startLogin(providerId: string, type: AuthType, prefill?: Record<string, string>): Promise<AuthFlowView>;
  respond(flowId: string, value: string): Promise<AuthFlowView>;
  poll(flowId: string, waitMs: number): Promise<AuthFlowView>;
  cancel(flowId: string): Promise<void>;
  logout(providerId: string): Promise<ProviderStatus>;
  verify(providerId: string): Promise<{ configured: boolean; models: number; error?: string }>;
}
```

### 2.1 AuthFlow state machine

One in-memory `Map<flowId, AuthFlow>`; `flowId = randomBytes(16).hex`.

```ts
type AuthFlowView =
  | { flowId: string; providerId: string; state: "prompting"; prompt: UiAuthPrompt; events: UiAuthEvent[] }
  | { flowId: string; providerId: string; state: "working";  events: UiAuthEvent[] }
  | { flowId: string; providerId: string; state: "done";     status: ProviderStatus; warning?: string }
  | { flowId: string; providerId: string; state: "error";    message: string }
  | { flowId: string; providerId: string; state: "cancelled" };

// UiAuthPrompt mirrors pi's AuthPrompt minus the AbortSignal:
type UiAuthPrompt =
  | { id: string; type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { id: string; type: "select"; message: string; options: { id: string; label: string; description?: string }[] };
```

Implementation:

```ts
const flow = { events: [], pending: undefined, abort: new AbortController() };
const promise = runtime.login(providerId, type, {
  signal: flow.abort.signal,
  prompt: (p) => new Promise<string>((resolve, reject) => {
    const id = randomUUID();
    flow.pending = { id, prompt: toUiPrompt(id, p), resolve, reject };
    flow.state = "prompting";
    p.signal?.addEventListener("abort", () => { /* drop this prompt, back to "working" */ });
  }),
  notify: (e) => { flow.events.push(toUiEvent(e)); },
});
```

Rules:
- **`prefill` auto-answer**: `startLogin` accepts `prefill: { apiKey?, [envName]? }`. When a
  `secret` prompt arrives and `prefill.apiKey` is unused, answer it immediately without a
  round trip. This gives the common case ("paste key → done") a **single request** while still
  supporting multi-prompt providers. Prefilled values are consumed once and zeroed.
- One pending prompt at a time. `respond()` on a flow that is `working` → `409 flow_not_prompting`.
- `respond()` with a `flowId` that is unknown/expired → `404 flow_not_found`.
- TTL **5 minutes** of inactivity, then abort + drop. A completed/errored flow is retained 60 s
  so the client can read the terminal view, then dropped.
- Max 3 concurrent flows per provider, 10 overall → `429`.
- `cancel()` calls `abort.abort()` and rejects the pending prompt; `login()` is expected to
  reject, which is caught and mapped to `state: "cancelled"`.
- On success: `state: "done"`, then **post-login sequence** (§3).
- Flow objects MUST NOT be logged and MUST NOT be serialized into the audit log or error
  responses. `prefill`/prompt answers are held in a plain string, overwritten with `""` after
  use (best-effort; Node strings are immutable — the point is to drop the reference, not to
  scrub memory).

### 2.2 Post-login sequence

After `login()` resolves, in order:

1. `await runtime.checkAuth(providerId)` → establishes `{ type, source }`.
2. `await runtime.refresh({ providers: [providerId], signal: AbortSignal.timeout(15_000) })` so
   dynamic catalogs (OpenRouter-style) populate. Ignore `aborted`/`errors` for success purposes
   but include them as `warning`.
3. `await runtime.getAvailable(providerId)` → count for the response.
4. Invalidate the 60 s `/api/models` cache and emit a global SSE event
   `{ type: "providers_changed" }` (see `09-api.md` §9, `GET /api/events`).
5. Audit-log `provider_login` with `{ providerId, type, source, modelCount }` — **never the key**.

If step 1 reports `configured: false`, return `state: "error"` with
*"The credential was saved but the provider still reports no working auth — check the key."*
and keep the stored credential (the user can retry or delete).

## 3. HTTP API (replaces `09-api.md` §3 "Providers")

All routes require authentication **and step-up** (§5) except `GET /api/providers`.
All write routes are additionally **admin-only** (`403 forbidden` for `role: "user"`), because
`ModelRuntime` and therefore provider credentials are process-global — see
[18-multi-user.md](18-multi-user.md) §§3, 5, 6. Per-user credentials are a V2 item (§7 there).

### `GET /api/providers`
`200 { items: ProviderStatus[], credentialWritesEnabled: boolean, authPath: string }`
- `authPath` is shown in the UI so the user knows *where* keys land (§6). It is a path, not a
  secret, but it MUST be `~`-abbreviated in the response.

### `POST /api/providers/:id/auth/start`
```ts
{ type?: "api_key";                 // default "api_key"; "oauth" => 501 not_implemented in V1
  apiKey?: string;                  // optional prefill for the first `secret` prompt
  env?: Record<string, string> }    // optional prefills keyed by prompt message match (best effort)
```
→ `200 AuthFlowView` (usually `state: "done"` immediately when `apiKey` was prefilled and the
provider only asks for a key).
Errors: `404 provider_not_found`, `409 provider_ambient_only` (no `auth.apiKey.login`),
`501 auth_type_not_supported`, `429 too_many_flows`, `403 credential_writes_disabled`.

### `POST /api/providers/:id/auth/respond`
`{ flowId, promptId, value }` → `200 AuthFlowView`.
`promptId` MUST match the pending prompt (guards against a stale double-submit) else
`409 flow_prompt_mismatch`.

### `GET /api/providers/auth-flows/:flowId?wait=25000`
Long-poll: returns immediately if the view changed since the client's last
`?since=<viewVersion>`, otherwise waits up to `wait` ms (max 30 s) then returns the current
view. Used for multi-prompt and (later) OAuth/device-code flows. No SSE channel for this — a
flow is short-lived and client-driven.

### `POST /api/providers/:id/auth/cancel`
`{ flowId }` → `200 AuthFlowView` (`state: "cancelled"`).

### `DELETE /api/providers/:id/auth`
`runtime.logout(id)` → `200 ProviderStatus`.
- `409 credential_not_removable` when `source !== "stored"` (e.g. env var), with a message
  naming `AuthStatus.label` so the user knows what to unset.
- Audit-log `provider_logout`.
- Conversations currently streaming on that provider are **not** aborted; they keep the auth
  they resolved at request time. The UI warns: *"Running tasks may fail on their next request."*

### `POST /api/providers/:id/verify`
Re-checks without writing: `checkAuth` + `getAvailable` →
`200 { configured, models, source?, label?, error? }`. This is the "Test" button.

### `GET /api/models` (amended)
Unchanged shape, but the cache MUST be invalidated by any credential mutation, and the response
gains `credentialsRevision: number` (bumped on every mutation) so the client can cheaply detect
staleness.

## 4. Frontend — Settings → Models & providers

New page at `/settings/providers` (and the picker's "no credentials" state links to it).

**Provider table** — one row per provider:
`name` · status pill (`Configured (stored)` green / `Configured (env: ANTHROPIC_API_KEY)` blue /
`Not configured` grey) · `N models (M available)` · actions.

Actions per row:
- **Add key** / **Replace key** — opens the credential dialog (below). Hidden when the provider
  is ambient-only; instead a tooltip: *"This provider reads credentials from the environment
  (`AWS_PROFILE`, …). Set them where piui runs."*
- **Test** — `POST /verify`, shows a spinner then a green/red inline result.
- **Sign out** — only when `removable`; confirm dialog naming the provider; explains running
  tasks may fail on their next request.
- **OAuth / subscription login** — rendered **disabled** with the provider's `loginLabel` and a
  tooltip *"Not available in this version — use the `pi` CLI"* (keeps Q1=B honest while showing
  the path exists).

**Credential dialog** (drives the flow machinery generically — do not hardcode "one key field"):
1. On open: `POST /auth/start` with `apiKey` **only if** the user already typed it in the
   inline fast-path field; otherwise start with no prefill and render whatever prompt comes back.
2. Render `UiAuthPrompt` by type: `secret` → password input with a reveal toggle;
   `text` → text input; `select` → radio list; `manual_code` → text input + the
   `auth_url`/`device_code` event contents shown above it.
3. Render accumulated `UiAuthEvent`s: `info` (with links), `progress` (spinner + message),
   `auth_url` (clickable + copy button), `device_code` (big monospace code + verification URI).
4. Submit → `POST /auth/respond`; if the next view is `prompting`, render the next prompt
   (loop). If `working`, long-poll `GET /auth-flows/:flowId?wait=25000`.
5. `done` → success state showing "N models available", close, invalidate `["providers"]`,
   `["models"]`, and any model picker.
6. `error` → show the message, offer Retry (new flow) and Cancel.
7. Closing the dialog or navigating away calls `POST /auth/cancel`.

**Step-up prompt**: the first credential-mutating action in a session opens a small
"Confirm your password" dialog (§5). On success the dialog retries the original request. The
UI MUST NOT store the password.

**Hygiene**: `autocomplete="off"`, `spellcheck={false}`, `type="password"` for secrets; never
put a key in a query string, a `localStorage` entry, a TanStack Query cache key, or a toast.
The key field is cleared on unmount.

**First-run integration**: when `GET /api/models` reports zero available models, the app shows a
setup card: *"No model credentials found"* → **Add a provider key** (opens this page) or
*"or run `pi` in a terminal and log in"*.

## 5. Step-up re-authentication (required for credential writes)

Because V1 auth is `test`/`test`, credential *writes* get one extra gate so a drive-by request
(CSRF slip, XSS, a curious housemate on an unlocked laptop) cannot silently plant or steal
provider auth:

- New column: `auth_sessions.step_up_at TEXT` (add to `001_init.sql`).
- `POST /api/auth/step-up { password }` → verified via the same `AuthProvider.verify()`;
  on success sets `step_up_at = now`, returns `204`. On failure `401` + the same 250 ms delay
  and the login rate limiter.
- A `requireStepUp` preHandler on every route in §3 except `GET /api/providers`:
  `step_up_at` must be within **10 minutes**, else `403 step_up_required`.
- A fresh login counts as a step-up (`step_up_at = created_at`).
- Rate limit credential mutations: 20 per hour per session → `429`.

## 6. Where keys are stored, and the isolation choice

- Default `PIUI_PI_AUTH_PATH = ~/.pi/agent/auth.json` — piui **shares** the pi CLI's credential
  file. This is deliberate: it is why a fresh piui install already sees your models, and a key
  added in piui immediately works in the terminal.
- The provider page MUST state this plainly: *"Keys are stored in `~/.pi/agent/auth.json`,
  shared with the pi CLI."*
- Users who want isolation set `PIUI_PI_AUTH_PATH=~/.piui/auth.json`; document it in the README
  next to the security warning. piui MUST NOT copy or migrate keys between the two files.
- File permissions: after any credential write, piui MUST `chmod 0600` the auth file and its
  parent directory `0700` if they are more permissive (best-effort, POSIX only, log on failure).

## 7. Security requirements specific to this feature

Additions to `11-security.md` §3:

1. Credential routes MUST be rejected outright when `PIUI_DISABLE_CREDENTIAL_WRITES=1`
   (`403 credential_writes_disabled`). Recommend this flag for any exposed deployment.
2. If the server is reachable non-locally (`PIUI_ALLOW_REMOTE=1`) **and** the request did not
   arrive over HTTPS (no TLS, no `X-Forwarded-Proto: https`), credential-write routes MUST
   return `403 insecure_transport` — never accept a pasted API key over plaintext off-host.
   The UI surfaces this as a disabled "Add key" button with an explanation.
3. Request bodies for these routes MUST be excluded from request logging entirely (route-level
   opt-out, not field redaction — a `secret` prompt answer can arrive under any field name).
4. Error messages from `login()` MUST be passed through a sanitizer that strips anything
   resembling a key (`/\b(sk|pat|ghp|xoxb)[-_][A-Za-z0-9]{8,}/g` → `***`) before reaching the
   client or the log.
5. Audit log entries: `provider_login`, `provider_logout`, `provider_verify`,
   `step_up_success`, `step_up_failure` — with `providerId`, `type`, `source`, outcome. Never
   the secret, never the prompt text answers.
6. CSP already forbids third-party `connect-src`; keep it — the key never leaves the origin.

## 8. What is deliberately still out (and how it lands later)

| Deferred | Landing path |
|----------|--------------|
| OAuth / subscription logins (`type: "oauth"`) | The flow machinery already handles `auth_url`, `device_code`, `manual_code` prompts and long-polling. Flip `enabledInPiui` for the `oauth` method, drop the `501`, and add a callback route if a given provider needs a loopback redirect. Track as `[LATER-oauth]`. |
| `models.json` custom providers/endpoints editing | `ModelRuntime` reads `modelsPath`; a future `/api/settings/models-json` editor. |
| Per-conversation key override | `setRuntimeApiKey` exists but is process-global — needs a per-session `ModelRuntime`, explicitly out of scope. |
| Key rotation reminders / expiry display | `CredentialInfo` carries no expiry for api keys. |

## 9. Acceptance criteria

1. With no credentials at all, `/settings/providers` lists every provider as *Not configured*,
   and the model picker links to it.
2. Pasting a valid Anthropic key in the fast-path field results in **one** `auth/start` request,
   `state: "done"`, `~/.pi/agent/auth.json` containing an `api_key` credential, the file mode
   `0600`, and the model picker showing Anthropic models as available without a page reload.
3. Pasting an invalid key yields `state: "error"` with a message that contains **no** fragment
   of the key, and the provider still shows a clear status (configured-but-failing or not
   configured) rather than a lie.
4. A provider that needs two prompts (key + account id) walks through both dialog steps and
   succeeds; the second prompt's value ends up in the stored credential's `env`.
5. An ambient-only provider (env-var based) shows *"configured via environment: X"*, offers no
   key entry, and `DELETE /api/providers/:id/auth` returns `409 credential_not_removable`
   naming `X`.
6. `DELETE /api/providers/:id/auth` on a stored credential makes its models unavailable in the
   next `GET /api/models`, and the global SSE `providers_changed` event updates an open
   settings tab in another window.
7. Credential routes without a step-up return `403 step_up_required`; after
   `POST /api/auth/step-up` with `test` they succeed; 11 minutes later they require step-up again.
8. `PIUI_DISABLE_CREDENTIAL_WRITES=1` makes every write route `403` and the UI hides/disables
   the actions, while status and `verify` still work.
9. With `PIUI_ALLOW_REMOTE=1` over plain HTTP from another host, key entry is refused with
   `403 insecure_transport`.
10. No request log line, audit line, or error response in any of the above contains the key
    (verified by a test that greps the captured log output for the fixture key).
