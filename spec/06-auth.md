---
id: 06-auth
title: Authentication
status: normative
feature: "2 — Authentication"
summary: >-
  Feature 2. Pluggable AuthProvider with a hardcoded test/test implementation, server-side sessions, CSRF, brute-force protection, step-up re-auth.
covers: [auth, sessions, cookies, csrf, rate-limit, step-up]
depends_on: [02-data-model]
required_by: [09-api, 14-credentials, 18-multi-user]
decisions: [Q1, Q7]
milestones: [M1]
spec_version: 1
updated: 2026-02-20
---

# 06 — Authentication (Feature 2)

> V1: **hardcoded `test` / `test`**. The point of this spec is that replacing it later is a
> one-file change.

## 1. Pluggable interface

```ts
// server/src/http/auth.ts
export interface AuthProvider {
  readonly id: string;
  /** Returns the authenticated principal, or null on bad credentials. */
  verify(credentials: { username: string; password: string }): Promise<Principal | null>;
}

export interface Principal {
  id: string;         // stable user id; "local" for the static provider
  username: string;
  displayName: string;
  roles: string[];    // V1: ["admin"]
}
```

V1 implementation:

```ts
export class StaticAuthProvider implements AuthProvider {
  id = "static";
  async verify({ username, password }) {
    const okUser = timingSafeEqualStr(username, process.env.PIUI_USERNAME ?? "test");
    const okPass = timingSafeEqualStr(password, process.env.PIUI_PASSWORD ?? "test");
    return okUser && okPass
      ? { id: "local", username, displayName: "Local user", roles: ["admin"] }
      : null;
  }
}
```

Requirements:
- Comparison MUST be constant-time (`crypto.timingSafeEqual` on equal-length buffers; hash both
  sides with SHA-256 first to normalize length).
- Credentials MUST be overridable by `PIUI_USERNAME` / `PIUI_PASSWORD` env vars while keeping
  `test`/`test` as the default, and the server MUST log a prominent warning at boot when the
  defaults are in use: `!! piui is using the default test/test credentials !!`.
- `[LATER]` planned providers: `htpasswd` file, OIDC (auth-code + PKCE), reverse-proxy header
  trust. The route layer MUST depend only on `AuthProvider` + the session store, never on
  `StaticAuthProvider`.

## 2. Session mechanics

Server-side sessions in the `auth_sessions` table (not stateless JWTs — logout must be real).

- `POST /api/auth/login { username, password }`
  - success → create row: `id = randomBytes(32).toString("hex")`, `expires_at = now + 30d`;
    set cookie and return `{ user: Principal }`.
  - failure → `401 invalid_credentials`. Generic message, no user enumeration.
- Cookie: name `piui_sid`, value `<sessionId>.<hmacSHA256(sessionId, PIUI_SESSION_SECRET)>`,
  attributes `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` and `Secure` when the request
  arrived over HTTPS or `PIUI_FORCE_SECURE_COOKIE=1`.
- `POST /api/auth/logout` → delete the row, clear the cookie, `204`.
- `GET /api/auth/me` → `{ user }` or `401`.
- Sliding expiry: if a request arrives with more than 24 h elapsed since `created_at`/last
  refresh, extend `expires_at` and re-set the cookie.
- Expired rows are deleted lazily on access plus by a 1 h interval sweep.

## 3. Route protection

- A Fastify `preHandler` hook applied to **every** `/api/*` route except
  `POST /api/auth/login`, `GET /api/health`.
- Rejection: `401 { error: { code: "unauthenticated" } }`. Never redirect an API call.
- SSE endpoints are protected identically; the cookie travels with `EventSource` because it is
  same-origin (V1 does not support cross-origin SSE, hence no token-in-query-string hack).
- Static SPA assets are served unauthenticated (the shell is public; all data is not).

## 4. Brute-force protection

- Per-IP sliding window limiter on `/api/auth/login`: 10 attempts / 5 min, then `429` with
  `Retry-After`. In-memory map, cleaned on an interval.
- 250 ms artificial delay on failed login.
- `[LATER]` account lockout, 2FA.

## 5. CSRF

Because auth is cookie-based with `SameSite=Lax`:
- All state-changing endpoints MUST be `POST`/`PATCH`/`DELETE` (never `GET`), and
- MUST require header `X-Requested-With: piui` (the client always sends it) **or** a
  `Content-Type: application/json` body — reject `application/x-www-form-urlencoded` and
  `multipart/form-data` without the header. Return `403 csrf_check_failed`.
- `Origin`/`Referer`, when present, MUST match the server's own origin, else `403`.

## 6. Frontend

- `/login` route: centered card, username + password, error text, "Sign in" button, and a
  visible hint in V1: *"Default credentials: test / test"* (rendered only when
  `GET /api/health` reports `defaultCredentials: true`).
- An `AuthGate` wrapper: calls `GET /api/auth/me` once at boot; while pending shows a splash;
  on `401` redirects to `/login` preserving `?next=<path>`.
- A global fetch interceptor: any `401` clears the cached user and redirects to `/login`;
  any in-flight `EventSource` is closed.
- User menu in the top bar: display name, "Sign out".

## 7. Multi-user (decision Q7 = C — enforced from V1)

piui is designed as a multi-user application. V1 runs with one seeded admin, but **ownership and
role checks are enforced from day one**, not deferred: a `users` table, `owner_id NOT NULL` +
`visibility` on owned tables, a repository layer that takes the principal, and `403 forbidden`
on admin-only routes.

`Principal.roles` is authoritative; `GET /api/auth/me` surfaces it so the client can hide
admin-only UI (defense in depth only — the server decides). `auth_sessions.user_id` links a
session to its user, and deactivating a user invalidates their sessions.

The full model — resource classification, the scoping rule, the admin-only surface list, the V2
scope, and the **honest limits of isolation** (one OS user, shared credentials, global
extensions ⇒ mutually trusting users only) — is normative in
[18-multi-user.md](18-multi-user.md).

## 8. Acceptance criteria

1. Any `/api/*` call without a cookie returns `401` with `{"error":{"code":"unauthenticated"}}`.
2. `test`/`test` logs in; `test`/`wrong` returns `401` after ~250 ms; 11 rapid failures give `429`.
3. Logout invalidates the session server-side: replaying the old cookie returns `401`.
4. A `POST /api/profiles` without `X-Requested-With` and with form content-type returns `403`.
5. Tampering with the cookie's HMAC yields `401`.
6. Swapping `StaticAuthProvider` for a stub in a test changes nothing outside `auth.ts` wiring.
