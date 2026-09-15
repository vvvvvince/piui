---
id: plan-07
title: M6 — Skills & tools management UI · M7 — Hardening & polish
status: plan
summary: >-
  Skill write path, HTTP tools and uploads; then security headers, audit, global SSE, export,
  UX states, product documentation, deployment polish and the CI gates.
milestone: [M6, M7]
est_days: "6–8"
covers: [skills-crud, http-tools, uploads, security-headers, audit, global-sse, export, ux-states, docs, ci]
spec_refs: [05-skills-and-tools, 10-frontend, 11-security, 19-deployment, 09-api]
depends_on: [plan-06]
blocks: []
plan_version: 1
updated: 2026-02-20
---

# M6 — Skills & tools management UI · M7 — Hardening & polish

---

# M6 — Skills & tools management (Feature 6 remainder)

**Context:** `05-skills-and-tools`, `10-frontend`, `09-api` §§6,7,10. (~5k)

## Work

- **Skills write path**: create/edit/delete with a file tree, frontmatter form + body editor
  (CodeMirror), validation panel (errors vs warnings), templates `basic|script|reference`,
  per-file routes (`GET/PUT/DELETE /api/skills/:id/files/*`, traversal rejected, 512 KB cap),
  import via zip / external path / pasted `SKILL.md`, `POST /api/skills/rescan` (admin-only),
  `POST /api/skills/:id/validate`, delete → trash + `{ affectedProfiles }`, `usedByProfiles`
  counts in the list.
- **Skill test-run**: `POST /api/skills/:id/test` → `201 { conversationId, ephemeral: true }`
  (`05-skills-and-tools.md` A.4).
- **HTTP tools**: CRUD + parameter JSON-Schema builder + header masking on read + test endpoint;
  runtime factory `pi/tools/http-tool.ts` with `{param}` substitution in URL/body,
  `${ENV_VAR}` header expansion, timeout, and the **same SSRF guard** as `web_fetch`.
  Name rule `^[a-z][a-z0-9_]{2,47}$`, `tool_name_taken`.
- **Image uploads end to end** (if not already done in M2): `POST /api/uploads` multipart,
  magic-byte validation (not the declared type), `PIUI_MAX_UPLOAD_MB`, storage under
  `$PIUI_HOME/uploads/<conversationId>/`, served with `Content-Disposition: inline` and
  `Content-Security-Policy: sandbox`; base64-in-message supported for small images.

## Acceptance

`05-skills-and-tools.md` parts A and B acceptance lists — all items · `07-chat-mode.md` §6 item 4
if images slipped from M2.

---

# M7 — Hardening, polish, docs

**Context:** `11-security`, `19-deployment`, `10-frontend` §4. (~6k)

## Work

- **Security**: security headers + CSP, audit log, log redaction, run caps
  (`PIUI_MAX_RUN_MINUTES`), SSE subscriber caps, rate limits, error-handling discipline
  (`11-security.md` §8: no stack traces or provider errors leaked to the client).
- **Global SSE** `GET /api/events`: `conversation_state`, `conversation_title`,
  `conversation_done`, `skills_changed`, `providers_changed`, `extensions_changed`, `ping` →
  live sidebar badges without polling.
- **Export** `GET /api/conversations/:id/export?format=md|json|html` (html delegates to pi's
  export when a live session exists) and `POST /:id/compact` + a "Compact now" button.
- **UX states** (`10-frontend.md` §4, each designed, not improvised): empty, loading, error,
  disconnected/reconnecting, missing workspace, no credentials, streaming, aborted. Plus command
  palette, a11y pass (focus order, labels, keyboard reachability), light theme.
- **Docs**: README (Docker-first install, env table, the trust-model warning verbatim in
  substance — *piui accounts imply shell-equivalent trust* `[18-multi-user#9.8]`, screenshots),
  `docs/deployment.md` (upgrade, backup, reset, derived images, bare metal),
  `docs/adding-a-provider.md`.
- **Deployment polish**: multi-arch CI build, SearXNG compose profile,
  `docker-compose.override.yaml.example`, health/posture surfaced in Settings → About
  (`container`, `insecureTransportOk` from `/api/health`).
- **CI gates** wired exactly as `20-development-method.md` §8: lint, `tsc --noEmit`, unit +
  integration + component, `spec-coverage`, E2E, Docker build.

## Acceptance

`11-security.md` items verifiable by test (headers, SSRF, traversal, rate limits) + a manual pass
over `10-frontend.md` §4 (list it in `spec-exemptions.ts` with its reason) ·
`19-deployment.md` §9 items 3–5, 8, 10–12.

## Final V1 gate

Run `plan/00-plan.md` §4 (definition of done) end to end, in the container.
