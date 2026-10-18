# ADR-0017: User administration and password management

- Status: Accepted and implemented in Phase 1 Task 1.6
- Date: 2026-10-18
- Builds on: ADR-0014 (authentication, sessions, authorization), ADR-0015 (bootstrap exception)

## Context

Task 1.3 provided login, sessions and permission guards but no way to create users, change passwords or manage roles.
These are the first ordinary business-administration routes and the place where privilege escalation is most likely.

## Decisions (approved before implementation)

1. **Admin password reset and forced change.** `POST /users/:id/reset-password` exists; the administrator supplies the
   temporary password (`security.user.reset_password`); the server never generates, stores in clear or returns one. The
   target is flagged `must_change_password`, loses all sessions and any lockout. Forced change is enforced by a new
   stable code `AUTH_0004` (403) on every authenticated route except `/auth/me`, `/auth/change-password`, `/auth/logout`.
2. **Own password change has no catalogue key.** `POST /auth/change-password` needs a valid session only. A wrong
   current password is **400 `VAL_0001` / `current_password_incorrect`** (not 401, which means "no valid session"), counts
   toward lockout, is audited (`user.password.change_failed`) and is rate limited (default 5/min).
3. **Role-assignment safeguards.** (a) Privilege ceiling: every role granted OR revoked must have all its permissions
   within the caller's own permissions. (b) A caller cannot change their own roles. (c) `POST /users` with non-empty
   `roleIds` needs `security.role.manage` in addition to `security.user.manage`.

## Addition beyond the approved plan (flagged for review)

The ceiling also applies to **reset-password**: the target's effective permissions must be within the caller's.
Without it a holder of `security.user.reset_password` alone could reset an Administrator's password and sign in as them.
A user with fewer permissions can still be reset. Disable/enable have no ceiling (R-064).

## Other design points

- Organization comes only from the session; targets in other organizations are 404, and roles of other organizations
  give the same 400 `unknown_role` as non-existent ones (no existence oracle).
- Each service operation re-checks that the acting user is active and still holds the permission **inside its own
  transaction**, takes the organization advisory lock, applies the change, and writes its audit event in the same
  transaction. Audit rows hold names and counts only, never passwords, hashes or tokens.
- Session handling: change-password revokes the caller's other sessions; reset and disable revoke all of the target's
  sessions; a role change needs no revocation because permissions are read from the database on every request.
- **Last usable administrator** is a database invariant (migration `20261021000000`), not only a check: deferred
  constraint triggers and an advisory lock keyed `hashtextextended('secadmin:' || organizationId, 0)`, used by both the
  triggers and the service. The service reports 409 `BIZ_0001`; direct SQL is refused as well. Exempt: organizations
  with no completed setup (R-060).
- The brief named the key `security.role_manage`; the catalogue key is `security.role.manage`.

## Consequences

- Through HTTP, the role-removal path to "last administrator" is unreachable by design (a caller who passes the ceiling
  is itself an administrator and the self-change rule stops the last one), so that path is proven at database level.
- A sole administrator who forgets their password still has no in-app recovery (R-055).
