---
id: 11-security
title: Security, privacy, operations
status: normative
summary: >-
  Threat model, input handling, secrets, HTTP hardening, DoS self-protection, privacy, audit log, error discipline.
covers: [threat-model, ssrf, path-traversal, headers, csp, rate-limits, audit-log]
depends_on: [09-api]
required_by: []
decisions: [Q1, Q3, Q7]
milestones: [M7]
spec_version: 1
updated: 2026-02-20
---

# 11 — Security, privacy, operational notes

## 1. Threat model (be honest about it)

piui runs an agent that can execute arbitrary shell commands and write files **as the user
running the server**. There is no sandbox in V1. Therefore:

- piui MUST bind `127.0.0.1` by default and refuse `0.0.0.0` unless `PIUI_ALLOW_REMOTE=1` is
  set, and in that case it MUST log a red warning at boot and display a persistent banner in
  the UI: *"piui is reachable from the network with placeholder authentication."*
- The docs (`README`) MUST state: do not expose piui to an untrusted network; put it behind a
  reverse proxy with real auth and TLS if you must. It MUST also state plainly that anyone who
  can log in can run arbitrary code on the machine — through the agent's shell tool **and**
  through extension install ([16-extensions.md](16-extensions.md) §7.4).
- piui deliberately ships **no approval gates** (decision Q3): no tool call is ever paused for
  confirmation. Gating, if wanted, is a user-installed extension's job.
- **Multi-user is not a security boundary** (decision Q7). All runs execute as the piui process
  owner, credentials are shared, and extensions are global, so `owner_id` scoping governs the
  API only — not the filesystem. Roles prevent accidents and config tampering, not a determined
  insider. The README MUST say: *give piui accounts only to people you would give a shell
  account to.* Normative detail: [18-multi-user.md](18-multi-user.md) §6.
- `[LATER]` containerized execution (see pi's `containerization.md`) as the real fix.

## 2. Input handling

| Surface | Rule |
|---------|------|
| All request bodies | validated against a schema; unknown properties rejected (`additionalProperties: false`). |
| Path parameters that are filesystem paths | normalized, `realpath`-resolved, containment-checked **after** resolution; `..`, NUL bytes, and absolute paths rejected where relative is expected. |
| Skill zip import | reject entries with `..`, absolute paths, symlinks, >50 MB uncompressed, >500 files; extract into a temp dir then move. |
| Uploads | magic-byte sniffing, size cap, stored outside any served static root except the dedicated upload route. |
| Model output | never executed by the server, never interpolated into shell commands by piui itself, always sanitized before rendering. |
| HTTP tool / web_fetch URLs | scheme allowlist (`http`, `https`), DNS-resolution SSRF guard against loopback/private/link-local ranges, max 3 redirects each re-checked, hard timeouts. |
| Env-var references in HTTP tool headers | resolved server-side at call time; the raw value is never returned to the client or written to logs. |

## 3. Secrets

- piui **accepts** provider API keys from the UI (decision Q1 = B) but never stores them
  itself: they are written by pi's `ModelRuntime.login()` into
  `authPath = PIUI_PI_AUTH_PATH` (default `~/.pi/agent/auth.json`, shared with the pi CLI).
  The full rule set — step-up re-auth, `PIUI_DISABLE_CREDENTIAL_WRITES`, `insecure_transport`
  refusal, route-level log exclusion, key-pattern scrubbing of provider errors, `0600` file
  mode enforcement — is in [14-credentials.md](14-credentials.md) §§5–7 and is **normative**.
- Keys are write-only from the API's point of view: no route may call `CredentialStore.read()`,
  and `listCredentials()` (metadata only) is the sole enumeration path.
- `GET /api/providers` returns only status/source/label, never key material.
- Logs MUST redact: `authorization`, `cookie`, `set-cookie`, `x-api-key`, anything matching
  `sk-[A-Za-z0-9]{8,}`, and HTTP tool header values.
- `PIUI_SESSION_SECRET` should be set in production-ish setups; otherwise sessions are
  invalidated on restart (acceptable, must be logged).

## 4. HTTP hardening

- Helmet-equivalent headers: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Permissions-Policy: geolocation=(), microphone=(), camera=()`.
- CSP for the SPA: `default-src 'self'; img-src 'self' data: blob: https:;
  style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self';
  frame-ancestors 'none'; base-uri 'none'; object-src 'none'`.
  (`img-src https:` is needed for favicons in the Sources footer; if that is dropped, tighten
  it to `'self' data: blob:`.)
- Body size limit 1 MB for JSON routes; multipart handled separately.
- No CORS headers at all in V1 (same-origin only).
- Rate limits: login (see `06-auth.md`), `POST /messages` 60/min, `web_search` tool 10 per run,
  `/api/fs/browse` 120/min.

## 5. Denial-of-service self-protection

- `PIUI_MAX_CONCURRENT_RUNS` semaphore (default 4) → `429 too_many_runs`.
- `PIUI_MAX_RUN_MINUTES` (default 30) wall-clock abort per run.
- Ring buffer caps per conversation (2000 events / 8 MB) — oldest dropped, which forces a
  `snapshot` for laggards rather than unbounded memory growth.
- SSE subscriber cap per conversation (8) → `429`.
- Tool output truncation everywhere (16 KB in snapshots, 32 KB for HTTP/web tools).
- SQLite: WAL, `busy_timeout = 5000`, all multi-statement writes in transactions.

## 6. Privacy

- Conversation content is stored unencrypted in pi `.jsonl` files under `$PIUI_HOME/agent/sessions`.
  Document this; deleting a conversation moves the file to `$PIUI_HOME/trash/` (and a
  `POST /api/maintenance/empty-trash` endpoint `[LATER]` or a documented `rm`).
- Disable pi's install telemetry in piui's own settings
  (`enableInstallTelemetry: false` in the piui-owned pi settings) since piui is not the CLI and
  should not ping on the user's behalf.
- No analytics, no outbound calls except: model providers, the configured search provider, and
  URLs the model explicitly fetches.

## 7. Auditability

- Append a JSONL audit log `$PIUI_HOME/logs/audit.jsonl`, one line per:
  login success/failure, step-up success/failure, profile/workspace/skill/tool
  create-update-delete, provider credential login/logout/verify, extension
  install/update/uninstall/toggle (with origin + source SHA-256) and load errors, conversation
  create/delete, dangerous tool invocation (`bash`, `write`, `edit`, HTTP tools, extension
  tools) with the conversation id and a truncated argument summary.
- Never log full file contents or full model outputs to the audit log.

## 8. Error handling discipline

- No stack traces in HTTP responses. `internal_error` + a correlation id that appears in the
  server log (`{ error: { code, message, correlationId } }`).
- Every `catch` either handles or rethrows with context; no silent `catch {}`.
- Unhandled rejections / uncaught exceptions: log, attempt to abort live runs, exit non-zero
  (let a supervisor restart).
