# piui — Web UI for the `pi` coding agent

`piui` is a self-hosted web front end for [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
(`@earendil-works/pi-coding-agent`). pi ships no web UI; it exposes an in-process TypeScript SDK
and a JSONL RPC mode. piui wraps the SDK in an HTTP/SSE server plus a browser client, so you can
run chats and full agentic tasks from a browser instead of a terminal.

> **Status: not implemented yet.** This repository currently contains the specification
> (`spec/`) and the implementation plan (`plan/`) — no code. The sections below marked
> *(M7)* are placeholders for the product documentation that the spec requires to exist by
> then; do not delete the headings, fill them in.

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
| `shared/`, `server/`, `client/` | *(M0)* the implementation. |
| `docs/` | *(M7)* `deployment.md`, `adding-a-provider.md`. |

## Getting started

*(M0 — replace with real setup steps: prerequisites, `npm install`, `npm run dev`, `npm test`.)*

## Install with Docker *(M7 — leads with Docker per `spec/19-deployment.md`)*

*(M7 — `cp .env.example .env && docker compose up -d`, upgrade, backup, reset. Full narrative in
`docs/deployment.md`.)*

## Configuration *(M7)*

*(M7 — the full environment-variable table from `spec/01-architecture.md` §3, including
`PIUI_PI_AUTH_PATH` and how to set it to `~/.piui/auth.json` to isolate piui's credentials from
the pi CLI.)*

## Security & trust model — read before deploying

These statements are required by the spec and are covered by acceptance criteria
(`spec/18-multi-user.md` §9.8); keep them in substance when you rewrite this section.

- **Do not expose piui to an untrusted network.** It binds to `127.0.0.1` by default and refuses
  to bind elsewhere unless `PIUI_ALLOW_REMOTE=1`. Put it behind a reverse proxy with TLS if you
  publish it. (`spec/11-security.md`)
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
