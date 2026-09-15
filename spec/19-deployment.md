---
id: 19-deployment
title: Deployment — Docker image and compose stack
status: normative
summary: >-
  Decision Q10=A. piui ships no per-run sandbox; instead the whole app runs in a dedicated
  environment. Defines the multi-stage Dockerfile, an off-the-shelf docker-compose.yaml,
  volume/permission/network rules, the container-specific transport settings, and upgrade,
  backup and bare-metal notes.
covers: [docker, docker-compose, deployment, volumes, permissions, upgrade, backup, container-transport]
depends_on: [01-architecture, 11-security]
required_by: [12-milestones]
decisions: [Q10]
milestones: [M0, M7]
spec_version: 1
updated: 2026-02-20
---

# 19 — Deployment: Docker image and compose stack

> **Decision Q10 = A**: piui implements **no per-run sandboxing**. Agent runs execute in-process
> as the piui process owner, and that is acceptable **because the intended deployment is a
> dedicated environment** — a container or a throwaway VM whose breakage costs nothing.
>
> The container is therefore not a security feature bolted onto a desktop app; it *is* the
> isolation model. Shipping a good image and a working `docker-compose.yaml` is consequently a
> **V1 deliverable**, not packaging polish.

## 1. What this buys, and what it does not

**It does:** confine `bash`, `write`, `edit` and extension code to a container filesystem and a
mounted workspace tree; make "the agent broke something" recoverable by `docker compose down -v`;
give a reproducible runtime (Node version, `git`, toolchain) independent of the host.

**It does not:** make piui multi-tenant-safe (all users in one container share one process and
one uid — `18-multi-user.md` §6 stands unchanged), nor protect the host if the socket, host
network or sensitive host paths are mounted in. The compose file MUST NOT mount the Docker
socket, and the README MUST say why.

Because the container is the boundary, the following earlier caveats are satisfied *by
deployment* rather than by code: dangerous tools (`bash` et al.) need no gating (Q3), API keys in
the UI are as safe as the container (Q1), and extension install is as safe as the container (Q3).

## 2. Repository artifacts (all `[V1]`)

```
Dockerfile
.dockerignore
docker-compose.yaml            # off-the-shelf: `docker compose up -d` works with no edits
docker-compose.override.yaml.example
.env.example                   # documented, copy to .env
docs/deployment.md             # narrative install/upgrade/backup guide
```

## 3. Dockerfile (normative shape)

Multi-stage, Debian-slim based (not Alpine: pi's `bash` tool and common agent workflows expect
glibc and GNU userland).

```dockerfile
# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PIUI_HOME=/data \
    PIUI_HOST=0.0.0.0 \
    PIUI_PORT=8787 \
    PIUI_CONTAINER=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git ripgrep less tini \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home --shell /bin/bash piui
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/server/dist   ./server/dist
COPY --from=build /src/client/dist   ./client/dist
COPY --from=build /src/package.json  ./
USER piui
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","server/dist/index.js"]
```

Requirements:

- **Non-root** (`uid 10001`). Document that bind-mounted workspaces must be writable by that
  uid, and offer `PUID`/`PGID` handling in `docker-compose.override.yaml.example` for hosts where
  that is inconvenient.
- **`tini` as PID 1** so `SIGTERM` reaches Node and the graceful shutdown in
  `01-architecture.md` §4.5 (abort streaming runs, dispose sessions, close the DB) actually runs.
- Installed agent tooling is deliberately minimal: `git`, `ripgrep`, `less`, `ca-certificates`.
  Anything heavier (python, compilers, cloud CLIs) belongs in a **user-built derived image**;
  `docs/deployment.md` MUST show a three-line `FROM piui:latest` example doing exactly that,
  because "the agent needs a toolchain" is the single most likely customization.
- No `npm` at runtime beyond what is installed; no build toolchain in the final layer.
- Multi-arch build (`linux/amd64`, `linux/arm64`) via buildx in CI.
- `.dockerignore` excludes `node_modules`, `.git`, `client/dist`, `server/dist`, `*.md` except
  what the image needs, and `spec/`.

## 4. docker-compose.yaml (off-the-shelf)

Must work with `cp .env.example .env && docker compose up -d` and nothing else.

```yaml
services:
  piui:
    image: ghcr.io/<owner>/piui:latest
    build: .
    restart: unless-stopped
    # Loopback-only by default. Changing this to 0.0.0.0 without TLS is a documented footgun.
    ports:
      - "127.0.0.1:${PIUI_PUBLISH_PORT:-8787}:8787"
    environment:
      TZ: ${TZ:-UTC}
      PIUI_HOME: /data
      PIUI_HOST: 0.0.0.0            # inside the container only
      PIUI_CONTAINER: "1"
      PIUI_ALLOW_REMOTE: "1"        # required because we bind 0.0.0.0 inside the container
      PIUI_INSECURE_TRANSPORT_OK: "1"  # safe: the port is published to 127.0.0.1 only (see §5)
      PIUI_SESSION_SECRET: ${PIUI_SESSION_SECRET:?set this in .env}
      PIUI_USERNAME: ${PIUI_USERNAME:-test}
      PIUI_PASSWORD: ${PIUI_PASSWORD:-test}
      PIUI_PI_AUTH_PATH: /data/auth.json
      PIUI_WORKSPACE_ROOTS: /workspaces
      PIUI_SEARCH_PROVIDER: ${PIUI_SEARCH_PROVIDER:-none}
      PIUI_SEARCH_API_KEY: ${PIUI_SEARCH_API_KEY:-}
      PIUI_MAX_CONCURRENT_RUNS: ${PIUI_MAX_CONCURRENT_RUNS:-4}
      PIUI_MAX_RUN_MINUTES: ${PIUI_MAX_RUN_MINUTES:-30}
    volumes:
      - piui-data:/data              # db, profiles, skills, extensions, sessions, auth.json
      - ./workspaces:/workspaces     # the agent's working folders — bind mount, yours to inspect
    # Deliberately NOT present: /var/run/docker.sock, host network, privileged, host paths.

volumes:
  piui-data:
```

Rules:

1. **Two storage locations, on purpose.** `/data` is a named volume (piui's own state, opaque,
   backed up as a unit). `/workspaces` is a **bind mount** so the code the agent writes is
   visible, editable and git-usable from the host. Anything else is a footgun.
2. `PIUI_SESSION_SECRET` uses `${VAR:?...}` so compose **fails loudly** if `.env` is missing,
   rather than silently invalidating sessions on every restart.
3. Default credentials stay `test`/`test` (decision Q2/Q6 era behavior) but `.env.example`
   carries a comment: *change these before publishing the port anywhere.*
4. An **optional SearXNG service** ships behind a compose profile so self-hosted web search is
   one command away and off by default:

```yaml
  searxng:
    image: searxng/searxng:latest
    profiles: ["search"]
    restart: unless-stopped
    environment:
      SEARXNG_BASE_URL: http://searxng:8080/
    volumes:
      - searxng:/etc/searxng
```

with `.env.example` documenting `PIUI_SEARCH_PROVIDER=searxng` and
`PIUI_SEARXNG_URL=http://searxng:8080`, started via `docker compose --profile search up -d`.

5. `docker-compose.override.yaml.example` shows the three realistic customizations: publishing
   beyond loopback **with** a TLS-terminating reverse proxy, `PUID`/`PGID` remapping, and using a
   derived image with extra tooling.

## 5. Container transport rules (amends `11-security.md` and `14-credentials.md`)

Two spec rules were written for bare-metal and must be reconciled, or the container cannot serve
anything:

1. `01-architecture.md` refuses to bind `0.0.0.0` unless `PIUI_ALLOW_REMOTE=1`. **Inside a
   container, binding `0.0.0.0` is normal and correct** — the network namespace is the boundary,
   and publishing is controlled by Docker's port mapping. The compose file therefore sets
   `PIUI_ALLOW_REMOTE=1`, and when `PIUI_CONTAINER=1` the boot warning is downgraded from the
   red "reachable from the network" banner to an info line, because the claim would be false.
2. `14-credentials.md` §7.2 refuses credential writes when the server is remote-reachable over
   plaintext. In a container, *every* request looks remote (it arrives from the Docker bridge),
   which would break API-key entry even at `http://127.0.0.1:8787`. Resolution: add
   **`PIUI_INSECURE_TRANSPORT_OK=1`** — an explicit operator acknowledgement that plaintext is
   acceptable for this deployment — set by the shipped compose file, which publishes to
   loopback only. Without it, the existing refusal stands.

Both flags MUST be reported by `GET /api/health` (`container: true`,
`insecureTransportOk: true`) and rendered in the UI's About/Settings page, so the active posture
is never guesswork. The README must state the rule plainly: **if you publish the port beyond
loopback, put TLS in front of it and unset `PIUI_INSECURE_TRANSPORT_OK`.**

## 6. Provider credentials in a container

`PIUI_PI_AUTH_PATH=/data/auth.json` — inside the volume, **not** the host's `~/.pi/agent/auth.json`.
Consequences to document:

- A fresh container starts with **no** credentials; the Q1 in-UI key entry is how you bootstrap,
  which is exactly why Q1 = B matters for this deployment.
- Alternatively, mount the host file read-only
  (`~/.pi/agent/auth.json:/data/auth.json:ro`) to reuse CLI credentials — but then in-UI writes
  fail; `docs/deployment.md` must spell out the trade-off rather than leaving a confusing
  permission error.
- Provider env vars (`ANTHROPIC_API_KEY`, …) still work and are the cleanest option for
  unattended setups, since pi's `ModelRuntime` resolves them ahead of nothing and behind stored
  credentials.

## 7. Operations

**Upgrade.** `docker compose pull && docker compose up -d`. SQLite migrations run at boot inside
a transaction (`01-architecture.md`); `docs/deployment.md` MUST tell the user to back up first
and MUST state that downgrades are unsupported.

**Backup.** One command per artifact, documented verbatim:

```bash
docker compose stop piui
docker run --rm -v piui_piui-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/piui-data-$(date +%F).tar.gz -C /data .
docker compose start piui
```

Plus: `./workspaces` is a plain directory — back it up however you already back up code.
Restoring is the inverse; note that `piui.db` is WAL-mode, hence the stop.

**Logs.** stdout/stderr only (pino JSON in production); `docker compose logs -f piui`. No log
files inside the image except the audit log, which lives in `/data/logs/audit.jsonl`
(`11-security.md` §7) precisely so it survives container replacement.

**Resource limits.** `docker-compose.override.yaml.example` shows `mem_limit`/`cpus` with a note
that a runaway agent process is bounded by `PIUI_MAX_CONCURRENT_RUNS` and
`PIUI_MAX_RUN_MINUTES`, not by the container.

**Reset.** `docker compose down -v` destroys piui state but **not** `./workspaces` — call this
out, since it is the difference between "start clean" and "lose my code".

## 8. Bare-metal support (still supported, not the default)

`npm run build && node server/dist/index.js` with `PIUI_HOME` set remains supported for
development and for users who want it. In that mode the bare-metal defaults apply unchanged:
bind `127.0.0.1`, no `PIUI_ALLOW_REMOTE`, no `PIUI_INSECURE_TRANSPORT_OK`, and
`PIUI_PI_AUTH_PATH` defaulting to the host's `~/.pi/agent/auth.json` so the CLI's credentials are
reused. `docs/deployment.md` documents both paths, and the README leads with Docker.

## 9. Acceptance criteria

1. `cp .env.example .env` (filling `PIUI_SESSION_SECRET`) then `docker compose up -d` yields a
   healthy container and a working login at `http://127.0.0.1:8787` with no further edits.
2. `docker compose up -d` **fails with a clear message** when `PIUI_SESSION_SECRET` is unset.
3. With no credentials configured, the UI's provider page allows adding an API key
   (`PIUI_INSECURE_TRANSPORT_OK=1` path) and the chosen model becomes available without a restart.
4. Unsetting `PIUI_INSECURE_TRANSPORT_OK` makes credential-write routes return
   `403 insecure_transport`, and the UI explains why.
5. An agent conversation in a workspace under `./workspaces` writes a file that appears on the
   **host** with uid 10001 ownership; registering a path outside `/workspaces` is refused by
   `PIUI_WORKSPACE_ROOTS`.
6. `docker compose restart` preserves conversations, profiles, skills, extensions and
   credentials; `docker compose down -v` clears them while leaving `./workspaces` intact.
7. `docker stop` triggers graceful shutdown (streaming runs aborted, sessions disposed, DB
   closed) within the default 10 s grace period — verified in logs, and proving `tini` wiring.
8. `GET /api/health` reports `container: true` and `insecureTransportOk: true`, and the
   Settings/About page shows the posture.
9. The image contains no build toolchain, runs as uid 10001, and does not mount or reference the
   Docker socket anywhere in the shipped files.
10. `docker compose --profile search up -d` plus the two documented env vars makes `web_search`
    work end-to-end against the bundled SearXNG.
11. A derived image built from the documented three-line example adds a tool (e.g. `python3`)
    that the agent can then invoke via `bash`.
12. Multi-arch images build in CI for `linux/amd64` and `linux/arm64`.
