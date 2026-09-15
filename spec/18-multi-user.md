---
id: 18-multi-user
title: Multi-user authorization model
status: normative
summary: >-
  Decision Q7=C. The ownership and role model piui is built against: enforced from V1 with a
  single seeded admin, expanded to real multi-user in V2. Defines owned vs global resources,
  admin-only surfaces, the repository-layer scoping rule, and the honest limits of isolation.
covers: [multi-user, authorization, ownership, roles, admin, isolation-limits, v2-path]
depends_on: [02-data-model, 06-auth]
required_by: [09-api, 14-credentials, 16-extensions]
decisions: [Q7]
milestones: [M1, M7]
spec_version: 1
updated: 2026-02-20
---

# 18 — Multi-user authorization model

> **Decision Q7 = C**: piui is designed as a multi-user application. V1 runs with exactly one
> seeded user, but **ownership and role checks are enforced from day one** at the repository
> layer, so V2 is "add users + an auth provider", not a rewrite.

## 1. What V1 must build (normative, ~a day of work)

This is the part that is expensive to retrofit and cheap to do up front:

1. A `users` table with **one seeded row** (`id = 'local'`, `role = 'admin'`) created by the
   first migration.
2. `owner_id TEXT NOT NULL` on every **owned** resource (§3), populated from the request
   principal.
3. **All data access goes through a repository layer that takes the principal**, and every
   query on an owned table filters by `owner_id` (or explicitly by visibility, §4). There is no
   ad-hoc SQL in route handlers. This is the rule that makes V2 mechanical.
4. **Role checks on admin-only routes** (§5), returning `403 forbidden`.
5. `Principal.roles` already exists (`06-auth.md` §1) and is surfaced by `GET /api/auth/me`;
   the client hides admin-only UI for non-admins (defense in depth only — the server decides).

With one user, none of this changes observable behavior. That is the point: it is dormant
enforcement, not simulated multi-tenancy.

**What V1 does NOT build:** additional auth providers, a user-management UI, sharing controls,
per-user credentials, or quotas. Those are §7.

## 2. Users and roles

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,            -- 'local' for the V1 seed
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL,               -- 'admin' | 'user'
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

`auth_sessions` gains `user_id TEXT NOT NULL REFERENCES users(id)` (replacing the loose
`username` column as the authoritative link; keep `username` only if useful for logs).

**Two roles, deliberately.** A third role is a product decision, not a technical one.

| Role | May |
|------|-----|
| `admin` | everything `user` may, plus every admin-only surface in §5 |
| `user` | own conversations, profiles, workspaces, skills, HTTP tools; read shared resources; use any configured model |

`StaticAuthProvider` (V1) resolves to the seeded `local` admin. `AuthProvider.verify()` already
returns a `Principal`; V2 implementations map their own identities onto `users` rows, creating
one on first successful login when the provider is trusted to do so
(`PIUI_AUTH_AUTOPROVISION=1`, default off).

## 3. Resource classification

This table is the decision. Everything else follows from it.

| Resource | Class | Rationale |
|----------|-------|-----------|
| conversations (+ pi session files, uploads, scratch) | **owned, private** | transcripts are personal; never listable by another user, not even by an admin, in V2.0 |
| profiles | **owned, shareable** | a persona is personal but worth publishing to a team |
| workspaces | **owned, shareable** | a folder registration is per-user config, but the same repo is often shared |
| skills | **owned, shareable** | same |
| HTTP tools | **owned, shareable** | headers may reference env secrets; sharing exposes *use*, never values (`05-skills-and-tools.md` B.2) |
| prompt templates (`$PIUI_HOME/prompts`) | **global, admin-writable** | they are files on disk, not DB rows; per-user template dirs are §7 |
| provider credentials | **global, admin-only** | `ModelRuntime` is process-wide in V1/V2.0 (§6) |
| extensions | **global, admin-only** | arbitrary in-process code; there is no per-user variant that means anything (§6) |
| global tool enable/disable, workspace roots, server settings | **global, admin-only** | server configuration |
| audit log | **global, admin-only read** | |

**Discovered** resources (TUI-discovered skills/extensions/prompts from `~/.pi/agent/…`, per
decisions Q2/Q3) are **global**, owned by no one, and admin-managed. They come from the
machine's pi installation, not from a piui user.

## 4. Visibility and the scoping rule

Owned tables get one more column, in V1, unused until V2:

```sql
visibility TEXT NOT NULL DEFAULT 'private'   -- 'private' | 'shared'
```

- `private`: visible only to `owner_id`.
- `shared`: **readable and usable** by every active user; writable only by the owner or an
  admin. Deleting a shared resource that other users' conversations reference follows the
  existing "keeps working, warns, counts affected" pattern (`03-profiles.md` §7).
- conversations ignore this column (always private in V2.0). Sharing a transcript is an export
  (`GET /api/conversations/:id/export`), not an ACL.

**The scoping rule (normative):** every read of an owned table resolves as
`owner_id = :principal OR visibility = 'shared'`; every write resolves as
`owner_id = :principal OR :principal.role = 'admin'`. A resource the principal cannot see
returns `404 not_found`, **not** `403` — do not leak existence. A resource visible but not
writable returns `403 forbidden`.

Implement this once, in the repository layer, as two helper predicates. A unit test MUST assert
that every owned-table query goes through them (a simple grep-based test over
`server/src/domain/**` for raw `db.prepare` outside the repository is acceptable and effective).

## 5. Admin-only surfaces

Enforced from V1 (with the single user being an admin, so it is invisible until V2):

- everything under `/api/providers/*` and `POST /api/auth/step-up`-gated credential writes
  ([14-credentials.md](14-credentials.md))
- everything under `/api/extensions/*` ([16-extensions.md](16-extensions.md))
- `PATCH /api/tools/:name` (global enable/disable)
- `POST /api/skills/rescan`, `POST /api/prompts/rescan`, `POST /api/extensions/rescan`
- `/api/users/*` (§7, V2)
- server settings and audit-log reads
- `GET /api/fs/browse` — it enumerates the filesystem; non-admins get it restricted to
  `PIUI_WORKSPACE_ROOTS` (and denied entirely when that is unset)

Non-admin attempts return `403 forbidden` with a message naming the required role. The client
hides these surfaces based on `me.roles`, but the server is authoritative.

## 6. Honest limits of isolation (read this before promising anything)

Multi-user piui, as designed, is **not a security boundary between users** unless the execution
model changes (Q10, containerization). State this in the README and in the user-management UI:

1. **One OS user.** Every agent run executes as the piui process owner. A `user` with a profile
   containing `bash` can read and write anything that OS user can — including other users'
   `$PIUI_HOME` data, the SQLite file, and `auth.json`. `owner_id` scoping governs the **API**,
   not the filesystem.
2. **Shared provider credentials.** All users spend the same API keys. Per-user keys are
   technically possible (one `ModelRuntime` per user with its own `authPath`) and are recorded
   in §7, but they do not fix (1).
3. **Global extensions.** Extension code runs in the shared server process for everyone. There
   is no per-user extension.
4. Therefore V2 multi-user is for **mutually trusting users** — a small team, a household, or
   one person with several logins. Roles prevent *accidents and config tampering*, not a
   determined insider.
5. The only real fix is per-user execution isolation: a container or separate OS user per run
   (Q10). Until then, the README must say: *"give piui accounts only to people you would give a
   shell account to."*

This is the reason the resource table in §3 keeps credentials and extensions **admin-only**:
if every user could install extensions and add keys, the role distinction would be cosmetic.

## 7. V2 scope (designed, not built)

| Item | Shape |
|------|-------|
| User management | `GET/POST/PATCH/DELETE /api/users` (admin): create, set role, deactivate, reset password. Deactivating invalidates that user's `auth_sessions` immediately. |
| Real auth providers | `HtpasswdAuthProvider` (bcrypt file) and `OidcAuthProvider` (auth-code + PKCE), both satisfying the existing `AuthProvider` interface. `PIUI_AUTH_PROVIDER` selects one. `StaticAuthProvider` remains for single-user installs. |
| Password changes | `POST /api/auth/password { current, next }` for providers that own credentials; step-up applies. |
| Sharing UI | A private/shared toggle on profiles, workspaces, skills, HTTP tools, plus an owner badge and a "shared by X" filter in each list. |
| Per-user prompt templates | `$PIUI_HOME/users/<id>/prompts/` prepended to the composition order in `15-commands-and-input.md` §3.1. |
| Per-user credentials | One `ModelRuntime` per user, `authPath = $PIUI_HOME/users/<id>/auth.json`, with a shared fallback runtime for globally configured providers. Requires reworking the single shared runtime in `01-architecture.md` §4.2 — the only genuinely invasive V2 item. |
| Quotas | Per-user monthly cost cap read from `users`, enforced at prompt preflight using existing per-conversation cost accounting. |
| Admin dashboard | Active runs per user, cost per user, audit-log viewer. |

Nothing above requires changing the V1 schema beyond adding columns/tables.

## 8. Migration & seeding

- `001_init.sql` creates `users` with the `local` admin, and `owner_id NOT NULL` +
  `visibility NOT NULL DEFAULT 'private'` on the five owned tables.
- Seed profiles (`03-profiles.md` §1) are owned by `local` and created `visibility = 'shared'`,
  so they behave sensibly the moment a second user exists.
- If `PIUI_USERNAME` is set, the seeded row uses it as `username`; the id stays `local` so
  foreign keys are stable across renames.
- A later migration adding a second user never needs to touch existing rows.

## 9. Acceptance criteria

1. `001_init.sql` produces a `users` table containing exactly one active admin, and every owned
   table has `owner_id NOT NULL` and `visibility NOT NULL DEFAULT 'private'`.
2. Every row created through the API has `owner_id` equal to the request principal's id —
   asserted by an integration test that creates one of each resource and inspects the DB.
3. A test principal with `role: "user"` (injected in tests, no UI needed in V1) receives `403`
   from every admin-only route in §5 and `200` from the rest.
4. A second test user cannot read, patch, or delete the first user's `private` resources:
   reads return `404` (not `403`), writes return `404` for invisible and `403` for
   visible-but-not-owned.
5. A `shared` profile is usable by another user for a new conversation but not editable by them;
   an admin can edit it.
6. Conversations are never visible across users, including to an admin, and
   `GET /api/conversations` of user B omits user A's rows entirely.
7. A grep-based test finds no direct SQL against owned tables outside the repository layer.
8. The README and the (V2) user-management UI both carry the §6 isolation warning verbatim in
   substance: piui accounts imply shell-equivalent trust.
