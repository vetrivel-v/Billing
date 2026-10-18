# ADR-0014: Authentication, sessions, lockout and permission-based authorization

- Status: Accepted
- Date: 2026-10-18
- Task: Phase 1 Task 1.3 (requirement P1-AUTH-01, foundation scope)
- Builds on: ADR-0010 (launch secret), ADR-0011 (Argon2id library), ADR-0012 (permission catalogue), ADR-0013

## Context

The Electron launch secret (ADR-0010/0013) only proves that a request comes from the application shell.
It says nothing about which person is using it. Spec section 11 requires per-user authentication, lockout,
session timeout, role-based and granular authorization enforced on the server.

## Decision

1. **Two independent controls.** The launch secret is checked first, for every route except `/health`.
   User authentication is checked second, by the route's `preHandler`. A valid session without the launch
   secret gets 401; the launch secret is never used as, or accepted as, a user session token.
2. **Package.** Logic lives in `packages/auth` (`@commercebill/auth`): `PasswordHasher`, password policy,
   token helpers, configuration, and `createAuthService` (users, login, sessions, lockout, audit). The API only
   adapts it to HTTP (`auth-routes.ts`, `auth-guard.ts`).
3. **Passwords.** Argon2id through `@node-rs/argon2` (ADR-0011), random salt per hash, NFKC-normalised input,
   PHC string in `users.password_hash`. Cost chosen by `npm run bench:password-hash` on the development
   machine (median of 9 runs): 19 MiB/t=2 19 ms; 32 MiB/t=3 46 ms; 48 MiB/t=3 62 ms; 64 MiB/t=3 84 ms;
   **64 MiB/t=4 110 ms (chosen)**; 96 MiB/t=3 131 ms; 128 MiB/t=3 180 ms. Chosen: `m=65536 KiB, t=4, p=1`,
   inside the 100-250 ms target; configuration refuses anything below the OWASP floor (19 MiB, t=2) outside tests.
   `needsRehash` compares the stored parameters with the current ones and the hash is upgraded transparently at
   the next successful login (audited without hash material). Policy: length 12-128 code points, not containing
   the username, not a built-in common password or "common word + digits/symbols", not a single repeated
   character, not containing the product name; no composition rules (NIST SP 800-63B). The list is a floor, not a
   breach corpus.
4. **No account enumeration.** Every failure (unknown user, wrong password, disabled, locked, malformed username)
   returns the identical `401 AUTH_0001 "Sign-in failed. Check your username and password."`. Exactly one
   Argon2 verification runs on every path (unknown users are verified against a startup-computed dummy hash),
   asserted by a test that counts verifications. Remaining timing differences are database work of a few
   milliseconds against a roughly 110 ms hash; they are not claimed to be zero.
5. **Sessions.** Token = 32 CSPRNG bytes, base64url, sent only in `Authorization: Bearer`. Never in URLs,
   bodies, cookies or logs. The database stores only the SHA-256 hex (`sessions.token_hash`, enforced by a CHECK
   so a raw token cannot be stored). Absolute lifetime 12 h, inactivity timeout 30 min, `last_seen_at` written at
   most every 30 s. A session is valid only if: shape is valid, hash found, not revoked, not past expiry, not
   idle, user active. Revocation: logout, `revokeAllSessions`, and `disableUser` (which revokes everything in the
   same transaction); a disabled user's still-unrevoked session is also rejected at use time. All values are
   configurable and validated. Sessions are not bound to IP (all clients are loopback).
6. **Lockout.** Per account: 5 consecutive failures lock the account for 15 minutes. Attempts during the lock do
   not extend it and do not count; an expired lock restarts the count; success resets it. The row is locked
   (`SELECT ... FOR UPDATE`) so concurrent guesses cannot bypass the counter (tested with 12 parallel attempts).
   There is also a coarse per-route limiter on `POST /auth/login` (default 10/min, 429 `AUTH_0003`); because
   every local client shares the loopback address it is a flood brake, not the brute-force control.
7. **Authorization.** `requirePermission('stable.key')` runs `requireAuthenticatedUser` then checks the key
   against permissions resolved from the database on every request (user -> roles in the user's own
   organization -> role_permissions -> permission keys), so revocations and role changes apply immediately.
   401 `AUTH_0001` = no valid identity; 403 `AUTH_0002` = valid identity lacking the permission (the response does
   not name the required key; the denial is logged). **There is no administrator bypass**: Administrator simply
   holds every catalogue permission; an unknown key is denied to everyone. Keys come from the reference catalogue,
   never from role names or labels. Registration rejects malformed keys.
8. **Users are never deleted.** A DB trigger rejects `DELETE FROM users`; accounts are disabled
   (`is_active = false`). Usernames are stored lower-case/trimmed (CHECK) and looked up case-insensitively.
9. **Audit.** `auth.login.success`, `auth.login.failure` (with an internal reason), `auth.logout`,
   `auth.sessions.revoked`, `auth.password.rehash`, `user.create`, `user.disable`, `user.enable` in category
   `security`, with correlation ID. Never password, hash or token. Unknown-user failures store only a 12-hex
   one-way fingerprint of the attempted name (people sometimes type passwords into the username field).
10. **Migration** `20261018000000_task_1_3_auth_constraints` adds only constraints and a trigger (no table or
    column change): canonical usernames, token-hash shape, expiry order, and the user-delete block. It folds
    existing usernames first and aborts atomically on a collision rather than guessing (tested).

## Consequences

- There is no password reset/change flow, no user-management routes and no UI yet; a forgotten password or a
  locked account has no in-app recovery beyond the lock expiring (risk R-047). `must_change_password` is stored
  and returned but not yet enforced (R-048).
- Authorization costs one extra query per authenticated request; performance is unmeasured (R-050).
- Audit rows are written for every failed login; volume is bounded only by lockout and rate limits (R-049).
- The setup wizard (a later task) must create the first administrator through `createUser`, run the reference
  seed and write its own audit event (R-041).
