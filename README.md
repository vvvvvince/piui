# piui — Web UI for the `pi` coding agent

`piui` is a self-hosted web front end for [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
(`@earendil-works/pi-coding-agent`). pi ships no web UI; it exposes an in-process TypeScript SDK
and a JSONL RPC mode. piui wraps the SDK in an HTTP/SSE server plus a browser client, so you can
run chats and full agentic tasks from a browser instead of a terminal.

> **Status: M2 complete (credentials + chat mode).** You can add a provider API key from
> Settings → Providers, start a chat, watch tokens stream, steer/queue/stop a run, and survive a
> reload and a server restart. Web search lands in M3, agent mode in M5. The
> sections below marked *(M7)* are placeholders for the product documentation that the spec
> requires to exist by then; do not delete the headings, fill them in.

## Features

| # | Feature | Spec |
|---|---------|------|
| 1 | **Profiles** — AGENTS.md + skills + tools + opt-in persistent memory | [spec/03-profiles.md](spec/03-profiles.md) |
| 2 | **Authentication** — hardcoded `test`/`test`, pluggable later | [spec/06-auth.md](spec/06-auth.md) |
| 3 | **Workspaces** — a folder the agent works in | [spec/04-workspaces.md](spec/04-workspaces.md) |
| 4 | **Chat mode** — model only, web search, no memory/profile/persona | [spec/07-chat-mode.md](spec/07-chat-mode.md) |
| 5 | **Agent mode** — model + profile + workspace, full agentic loop | [spec/08-agent-mode.md](spec/08-agent-mode.md) |
| 6 | **Skills & tools management UI** | [spec/05-skills-and-tools.md](spec/05-skills-and-tools.md) |

## Repository layout

| Path | Contents |
|------|----------|
| [`spec/`](spec/README.md) | The specification corpus. **Authoritative.** Start at [`spec/README.md`](spec/README.md) for reading order and the per-task context budget. |
| [`plan/`](plan/README.md) | The implementation plan derived from the spec: milestones, spikes, risks, checklist. |
| `shared/`, `server/`, `client/` | The implementation: shared DTOs, Fastify server, React SPA. |
| `docs/` | *(M7)* `deployment.md`, `adding-a-provider.md`. |

## Getting started

Prerequisites: **Node ≥ 22** and npm 9+ (Docker optional, see below).

```bash
npm install
npm run dev        # server on :8787, Vite on :5173 (proxies /api)
npm test           # unit + integration + component suites, offline, ~2 s
npm run typecheck  # strict tsc across shared/server/client
npm run lint       # biome (use `npm run lint:fix` to apply)
npm run build      # shared/dist, client/dist, server/dist
node server/dist/index.js   # production: one port, serves the built SPA
```

State lives in `$PIUI_HOME` (default `~/.piui`): `piui.db`, `agent/` (pi sessions),
`profiles/`, `skills/`, `prompts/`, `extensions/`, `uploads/`, `scratch/`, `logs/`.

Development is **test-first** — see [`spec/20-development-method.md`](spec/20-development-method.md).
The M0 harness gives you: `withTempHome()`, `withWorkspace()`, a fake `Clock`/`IdGen`,
principal minting, an SSE collector, and a scripted fake model provider that drives a real
`AgentSession` with no network and no credentials.

## Install with Docker

```bash
cp .env.example .env     # then set PIUI_SESSION_SECRET (openssl rand -hex 32)
docker compose up -d     # http://127.0.0.1:8787
```

The container runs as uid 10001, carries `git`/`ripgrep`/`less` and nothing heavier, and keeps
its state in the `piui-data` volume; `./workspaces` is bind-mounted so the files the agent
writes stay visible on the host. Behind a corporate proxy, build with
`docker build --network=host --build-arg HTTP_PROXY=$http_proxy --build-arg HTTPS_PROXY=$https_proxy -t piui:latest .`

*(M7 — upgrade, backup and reset narrative moves to `docs/deployment.md`.)*

## Configuration *(M7)*

*(M7 — the full environment-variable table from `spec/01-architecture.md` §3, including
`PIUI_PI_AUTH_PATH` and how to set it to `~/.piui/auth.json` to isolate piui's credentials from
the pi CLI.)*

### Web search (M3)

Chat mode gets `web_search` and `web_fetch` when the composer's globe toggle is on **and** a
provider is configured:

| Variable | Meaning |
|---|---|
| `PIUI_SEARCH_PROVIDER` | `brave` (default), `tavily`, `searxng`, or `none` |
| `PIUI_SEARCH_API_KEY` | key for `brave` / `tavily` |
| `PIUI_SEARXNG_URL` | base URL for `searxng` (e.g. the bundled `http://searxng:8080`) |
| `PIUI_ALLOW_PRIVATE_HTTP_TOOLS` | `1` disarms the SSRF guard so `web_fetch` may reach loopback/private addresses. Off by default. |

`web_fetch` resolves the hostname and refuses loopback, private, link-local, CGNAT and
unique-local addresses, allows only `http(s)`, re-checks every redirect (max 3), caps the body,
enforces a 15 s timeout, and reads only text-ish content types. Search results are cached for
10 minutes and a single run may search at most 10 times.

Status and a *Test search* button live on the **Tools** page, which is also where a built-in
tool can be disabled globally (admin only).

## Security & trust model — read before deploying

These statements are required by the spec and are covered by acceptance criteria
(`spec/18-multi-user.md` §9.8); keep them in substance when you rewrite this section.

- **Do not expose piui to an untrusted network.** It binds to `127.0.0.1` by default and refuses
  to bind elsewhere unless `PIUI_ALLOW_REMOTE=1`. Put it behind a reverse proxy with TLS if you
  publish it. (`spec/11-security.md`)
- **piui is not a security boundary between users.** Roles and ownership stop accidents and
  config tampering, not a determined insider; every run shares one OS user, one set of provider
  credentials, and one set of extensions. (`spec/18-multi-user.md` §6)
- **A piui account is shell-equivalent trust.** Give piui accounts only to people you would give
  a shell account on the same machine: the agent's `bash`, `write` and `edit` tools, extensions,
  and installed API keys all run as the piui process owner, and all users share one process and
  one uid. (`spec/18-multi-user.md` §6)
- **Anyone who can log into piui can run arbitrary code** through extension install and the
  dangerous built-in tools. This is deliberate — piui ships no approval gates (decisions Q3/Q9).
- **The container is the isolation model**, not a hardening extra (decision Q10). The shipped
  `docker-compose.yaml` deliberately does **not** mount the Docker socket, the host network, or
  sensitive host paths: those mounts convert the container from a boundary into a formality.

## License

*(TBD)*
