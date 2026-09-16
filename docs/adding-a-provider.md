# Adding a model provider

piui does not implement providers. pi's `ModelRuntime` owns the catalogue, the credentials and
the network calls; piui only drives its login flow and lists what it reports
([`spec/14-credentials.md`](../spec/14-credentials.md)). There are therefore three different
things people mean by "add a provider".

## 1. Add credentials for a provider pi already knows (the common case)

**Settings → Providers** lists every provider pi ships. Pick one:

- **Add key** — paste an API key. piui never stores it: pi writes it into
  `PIUI_PI_AUTH_PATH` (`auth.json`, mode `0600`), the same file the `pi` CLI uses.
- **OAuth / device code** — the dialog renders whatever prompts pi's flow emits
  (`secret`, `text`, `select`, `manual_code`, plus `auth_url` / `device_code` events).
- **Verify** re-probes the provider; **Sign out** deletes the stored credential.

You must confirm your password first (step-up, valid 10 minutes), and the server refuses
credential writes over plaintext unless `PIUI_INSECURE_TRANSPORT_OK=1` is set. Models become
available without a restart — the model list is invalidated and a `providers_changed` event
reaches every open tab.

Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) also work and need no UI: pi
resolves them behind stored credentials. They show up as `source: "env"` and are not removable
from piui.

## 2. Register a provider pi does not ship — with an extension

This is the supported extension point, and it needs no piui change. An extension can call
`registerProvider` / `registerNativeProvider` on pi's runtime:

```ts
// $PIUI_HOME/extensions/my-provider.ts
export default function (pi) {
  pi.registerProvider("my-llm", {
    name: "My LLM",
    baseUrl: "https://api.my-llm.example/v1",
    api: "openai-completions",       // pi's wire protocol adapters
    apiKey: process.env.MY_LLM_KEY,  // resolved in the server process
    models: [
      {
        id: "my-llm-large",
        name: "My LLM Large",
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  });
}
```

Install it from **Extensions → Install from source** (paste, upload, URL with a mandatory source
review, or register a path). The extension is probed in a scratch directory before it is
written, so a syntax error never leaves a broken file behind. The new models appear in the model
picker for **new** conversations; existing sessions keep the provider they were built with
(`spec/16-extensions.md` §7.3).

Installing an extension is running code on this machine as the piui user. It is admin-only and
step-up gated, and every install is recorded in the audit log with the origin and the source
SHA-256.

## 3. A local OpenAI-compatible server (Ollama, vLLM, llama.cpp)

Same as §2 with `baseUrl: "http://127.0.0.1:11434/v1"` — but note that the SSRF guard protects
the **tools** (`web_fetch`, HTTP tools), not model traffic, so a loopback `baseUrl` works
without `PIUI_ALLOW_PRIVATE_HTTP_TOOLS`. Inside the shipped container, `127.0.0.1` is the
container: use `host.docker.internal` (or a compose service name) instead.

## 4. What piui deliberately does not do

- It never reads a stored credential back (`CredentialStore.read()` is not called anywhere);
  `GET /api/providers` returns status, source and label only.
- It never writes keys into its own database or logs — provider errors are scrubbed of
  key-shaped fragments before they reach a log line or the browser.
- It does not proxy or re-implement a provider API. If pi cannot talk to it, neither can piui.

## 5. Troubleshooting

| Symptom | Meaning |
|---|---|
| `Configured (stored)` but 0 available models | The key is stored and rejected by the provider — `Verify` shows the provider's message (scrubbed). |
| `403 insecure_transport` | Plaintext request without `PIUI_INSECURE_TRANSPORT_OK=1`. |
| `403 credential_writes_disabled` | `PIUI_DISABLE_CREDENTIAL_WRITES=1` on this deployment. |
| The success banner carries a warning like `(anthropic: fetch failed)` | The credential was saved, but the post-login refresh could not reach the network. |
| An extension-registered provider disappears | The extension failed to load; **Extensions** shows the load error and the conversation gets a `notice`. |
