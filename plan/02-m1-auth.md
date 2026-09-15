---
id: plan-02
title: M1 — Authentication & authorization
status: plan
summary: >-
  AuthProvider + static test/test implementation, cookie sessions, CSRF, brute-force protection,
  step-up re-auth, and the full ownership/role matrix enforced with one real user.
milestone: M1
est_days: "1–1.5"
covers: [auth, sessions, csrf, rate-limit, step-up, authorization]
spec_refs: [06-auth, 18-multi-user, 09-api, 14-credentials]
depends_on: [plan-01]
blocks: [plan-03]
plan_version: 1
updated: 2026-02-20
---

# M1 — Authentication & authorization

**Context to load:** `06-auth`, `18-multi-user`, `09-api` §§0–2, `14-credentials` §5. (~7k)

**Goal:** a guarded API with server-side sessions, CSRF, brute-force protection, step-up
re-auth, and the full role/ownership matrix enforced — with exactly one real user.

---

## 1. Server

- `http/auth.ts`:
  - `AuthProvider` interface + `StaticAuthProvider` (`test`/`test`, principal
    `{ id: "local", username, displayName, roles: ["admin"] }`). Swapping it must touch nothing
    but the wiring line `[06-auth#8.6]`.
  - Session creation → `auth_sessions` row (random 32-byte hex id), HMAC-signed cookie keyed by
    `PIUI_SESSION_SECRET`; tampering → `401` `[06-auth#8.5]`.
  - `preHandler` guard on every `/api/*` except `POST /api/auth/login` and `GET /api/health`;
    unauthenticated → `401 unauthenticated` `[06-auth#8.1]`.
  - CSRF: mutating requests require `X-Requested-With: piui`; form content-types without it →
    `403 csrf_check_failed` `[06-auth#8.4]`.
  - Rate limit + constant-ish delay on failed logins (~250 ms); 11 rapid failures → `429`
    `[06-auth#8.2]`.
  - Logout invalidates server-side; replaying the cookie → `401` `[06-auth#8.3]`.
- **Step-up** (`14-credentials.md` §5): `POST /api/auth/step-up { password }` → `204`, writes
  `auth_sessions.step_up_at`; `requireStepUp` preHandler rejects with `403 step_up_required`
  outside a 10-minute window `[14-credentials#9.7]`.
- Routes: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
  (`{ user, stepUpValidUntil }`, `user.roles` drives admin-only UI), `POST /api/auth/step-up`.
- **Authorization**: `requireAdmin` preHandler on the `18-multi-user.md` §5 surfaces
  (`/api/providers/*`, `/api/extensions/*`, `PATCH /api/tools/:name`, all `*/rescan`,
  `/api/users/*`, settings, audit reads, `GET /api/fs/browse` for non-admins). Semantics:
  invisible → `404 not_found` (never leak existence), visible-but-not-writable → `403 forbidden`
  naming the required role.
- `/api/users/*` MUST 404 in V1 while the role checks it depends on exist.

## 2. Client

- `/login` page, `AuthGate` route wrapper, user menu with logout.
- Fetch layer: 401 interceptor → redirect to login; `403 step_up_required` → open
  `StepUpDialog`, then **retry the original request once**.
- Hide admin-only UI based on `me.user.roles`.

## 3. Tests (write red first)

- Route-guard matrix via `fastify.inject()` for all six `06-auth` §8 criteria.
- Authorization matrix with injected principals (`18-multi-user` §9, all eight):
  seeded admin `[#9.1]`, `owner_id` on every created row `[#9.2]`, `role:"user"` 403/200 split
  `[#9.3]`, cross-user 404-vs-403 `[#9.4]`, shared profile usable-not-editable + admin-editable
  `[#9.5]`, conversations never cross users `[#9.6]`, grep test `[#9.7]`, README warning
  `[#9.8]`.
- Step-up: expiry via the **fake clock**, not sleeping.
- Client component tests: `StepUpDialog` flow and the 403-retry path.

## 4. Acceptance

`06-auth.md` §8 (1–6) · `14-credentials.md` §9 item 7 · `18-multi-user.md` §9 (1–8).
