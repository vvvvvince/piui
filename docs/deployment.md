# Deploying piui

piui runs an agent that executes shell commands and writes files **as the user running the
server**. There is no per-run sandbox and there never will be
([`spec/11-security.md`](../spec/11-security.md) §1, decision Q10). The intended deployment is a
dedicated environment whose breakage costs nothing: the shipped container **is** the isolation
model. Read the trust-model section of the [README](../README.md) before you expose anything.

## 1. Docker (the default)

```bash
cp .env.example .env
# set PIUI_SESSION_SECRET (openssl rand -hex 32) and change PIUI_USERNAME/PIUI_PASSWORD
mkdir -p workspaces && sudo chown 10001:10001 workspaces   # the container runs as uid 10001
docker compose up -d          # http://127.0.0.1:8787
docker compose logs -f piui
```

The `chown` is the one host-side step: `./workspaces` is a bind mount, so its ownership comes
from the host. Without it, registering `/workspaces` fails with `path_not_writable`
(`chmod 777 workspaces` is the sudo-less alternative; `user: "1000:1000"` in the override file
is the third option).

Two storage locations, on purpose:

| Path | Kind | Contents |
|------|------|----------|
| `/data` | named volume `piui-data` | `piui.db`, `agent/sessions/`, `profiles/`, `skills/`, `extensions/`, `uploads/`, `logs/audit.jsonl`, `auth.json` |
| `/workspaces` | bind mount `./workspaces` | the folders the agent works in — visible, editable and git-usable from the host |

The container binds `0.0.0.0` *inside its network namespace* and is published to `127.0.0.1`
only. That is why the compose file sets `PIUI_ALLOW_REMOTE=1` and
`PIUI_INSECURE_TRANSPORT_OK=1` — both are reported by `GET /api/health` and rendered under
**Settings → About**, so the active posture is never guesswork.

**If you publish the port beyond loopback, put TLS in front of it and unset
`PIUI_INSECURE_TRANSPORT_OK`.** Without that flag, credential-write routes answer
`403 insecure_transport` — which is the correct behaviour for a plaintext remote deployment.

### Self-hosted web search

```bash
docker compose --profile search up -d
# in .env:
PIUI_SEARCH_PROVIDER=searxng
PIUI_SEARXNG_URL=http://searxng:8080
```

The bundled SearXNG needs JSON output enabled — the stock image answers `format=json` with a
403 HTML page — so piui ships `searxng/settings.yml` and mounts it read-only. Nothing to edit;
verify from the UI: **Tools → Test search**.

### Provider credentials in a container

`PIUI_PI_AUTH_PATH=/data/auth.json` — inside the volume, **not** the host's
`~/.pi/agent/auth.json`. Three ways to get credentials in:

1. **Add a key in the UI** (Settings → Providers). The recommended path; it is exactly why
   in-UI key entry exists (decision Q1).
2. **Mount the host file read-only**: `~/.pi/agent/auth.json:/data/auth.json:ro`. Reuses the CLI's
   credentials, but in-UI writes then fail with a permission error — the trade-off is yours.
3. **Provider env vars** (`ANTHROPIC_API_KEY`, …) in `.env`. Cleanest for unattended setups; pi
   resolves them behind stored credentials.

## 2. Upgrade

```bash
# back up first (below), then:
docker compose pull && docker compose up -d
```

Migrations run at boot inside a transaction. **Downgrades are unsupported** — a newer schema is
not readable by an older binary, so restore from a backup instead.

## 3. Backup and restore

```bash
docker compose stop piui        # piui.db is WAL-mode; stop it first
docker run --rm -v piui_piui-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/piui-data-$(date +%F).tar.gz -C /data .
docker compose start piui
```

`./workspaces` is a plain directory — back it up the way you back up code. Restore is the
inverse (`tar xzf … -C /data` into a stopped container's volume).

## 4. Reset

```bash
docker compose down -v          # destroys piui state; LEAVES ./workspaces intact
```

That is the difference between "start clean" and "lose my code". A softer reset: delete
`/data/piui.db` only, keeping sessions and skills.

## 5. Derived images (extra tooling)

"The agent needs a toolchain" is the most likely customization, and it belongs in your own
image, not in piui's:

```dockerfile
# Dockerfile.custom
FROM piui:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
USER piui
```

```bash
docker build -f Dockerfile.custom -t piui-python:latest .
PIUI_IMAGE=piui-python:latest docker compose up -d
```

`docker-compose.override.yaml.example` shows this, plus publishing behind a reverse proxy and
`PUID`/`PGID` remapping. Copy it to `docker-compose.override.yaml` and keep only what you need.

## 6. Resource limits

`PIUI_MAX_CONCURRENT_RUNS` (default 4) and `PIUI_MAX_RUN_MINUTES` (default 30) bound the agent,
not the container. Add `mem_limit` / `cpus` in the override file if a runaway `bash` tool must be
bounded by the kernel too.

## 7. Logs and audit

Application logs go to stdout (pino JSON in production): `docker compose logs -f piui`.
The audit log is the one file piui writes: `/data/logs/audit.jsonl`, one JSON line per mutation
with `ts`, `actor`, `action`, `target`, `outcome` — plus dangerous tool invocations with the
conversation id and a truncated, redacted argument summary. It is append-only and never
rotated by piui; use `logrotate` (or `truncate -s 0`) if it grows.

## 8. Bare metal

Still supported, not the default:

```bash
npm ci && npm run build
PIUI_HOME=~/.piui PIUI_SESSION_SECRET=$(openssl rand -hex 32) node server/dist/index.js
```

In that mode the bare-metal defaults apply: bind `127.0.0.1`, no `PIUI_ALLOW_REMOTE`, no
`PIUI_INSECURE_TRANSPORT_OK`, and `PIUI_PI_AUTH_PATH` defaults to `~/.pi/agent/auth.json`, so the
pi CLI's credentials are reused. Node ≥ 22, plus `git` and `ripgrep` on `PATH` for the agent's
tools.

## 9. Troubleshooting

| Symptom | Cause |
|---|---|
| compose exits with `PIUI_SESSION_SECRET` in the message | `.env` is missing or the variable is empty — this refusal is deliberate. |
| `403 insecure_transport` when adding a key | `PIUI_INSECURE_TRANSPORT_OK` is unset and the request did not arrive over HTTPS. |
| Files in `./workspaces` are owned by `10001` | The container's uid. `chown -R 10001:10001 ./workspaces`, or use the `user:` override. |
| `path_not_allowed` when registering a workspace | The path is outside `PIUI_WORKSPACE_ROOTS` (`/workspaces` in the image). |
| Web search returns `provider_not_configured` | `PIUI_SEARCH_PROVIDER` / key / `PIUI_SEARXNG_URL` mismatch; check Settings → About. |
| The UI loads but stays blank after an upgrade | A stale service-worker-less cache is not the cause — check the browser console for CSP violations and report them; the CSP is asserted by tests but a new asset origin would break silently. |
