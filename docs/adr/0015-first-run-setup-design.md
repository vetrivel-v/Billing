# ADR-0015: First-run setup - atomic completion, saved draft, explicit login

- Status: Accepted and IMPLEMENTED in Phase 1 Task 1.4
- Date: 2026-10-18
- Applies to: Phase 1 Task 1.4 (first-run setup service and API, backend only; spec section 10)
- Resolves: the conflict in the earlier Task 1.4 outline between "one transaction / no partial organization"
  and "resumable via `organizations.setup_step`" (a single transaction leaves nothing partial to resume)

## Context

Spec section 10 asks for a guided setup that "can be resumed after interruption", and the project rules require
that a failed setup leaves no partial organization, that the first Administrator cannot be created twice, and
that there is exactly one place where session tokens are issued. At first run there is no user, so the setup
routes cannot use user authentication or permission guards.

## Decision

1. **Atomic completion.** `POST /setup/complete` performs everything in **one database transaction**: the
   organization, its primary business location and warehouse, the first financial year, the first Administrator
   (through the Task 1.3 `createUser`, so the password policy and Argon2id apply), the Task 1.1 reference seed for
   that organization, the `setup.completed` security audit event, deletion of the saved draft, and finally
   `setup_completed_at`. Any failure rolls back all of it. Nothing exists half-created.
2. **Resuming = a saved draft, not a partial organization.** The wizard's non-secret answers are saved
   server-side as a single draft document and can be reloaded after an interruption.
   - Stored in `application_settings` (global row, key `setup.draft`, JSON). No schema change is expected.
   - Contents: only the business fields the wizard collects (names, business type, PAN, GST status, GSTIN,
     state, addresses, financial-year start, the Administrator's username and display name). **Never the
     password** or any credential; a strict field whitelist rejects any other key (including anything named
     like a password), and the size is capped.
   - A draft is advisory: `POST /setup/complete` re-validates every field from scratch and does not trust it.
   - Concurrency: last-write-wins is not allowed; the row's `version` is used for optimistic concurrency and a
     stale save returns 409.
   - A draft carries a format version; an incompatible draft is discarded with a notice rather than guessed at.
   - It is deleted inside the completion transaction. After completion the draft routes refuse.
   - `organizations.setup_step` is not used for resumption (no partial organization exists); it is left as
     reserved/unused and documented as such.
3. **Explicit login after setup.** `POST /setup/complete` returns **no session token**: on success it returns
   201 with the organization id, the Administrator's username and `nextStep: "login"`. The user then signs in
   through the normal `POST /auth/login`, keeping one token-issuing path (lockout, audit, generic failures, rate
   limiting all apply to the first login too).
4. **Setup state and concurrency.** Setup is required while no organization has `setup_completed_at`. The
   completion transaction takes a transaction-scoped advisory lock and re-checks that state inside the lock, so
   two simultaneous calls cannot both succeed; the loser gets 409 `BIZ_0001`. No database constraint may limit the
   number of organizations (the data model and existing tests rely on multi-organization support).
5. **Routes and guards.** Routes: `GET /setup/status` (returns only whether setup is required),
   `GET /setup/draft`, `PUT /setup/draft`, `POST /setup/complete`. Guards for all four: the launch secret (global
   hook, ADR-0010/0013) plus a **setup-incomplete precondition**; there is no user authentication or permission
   check because no user can exist yet. `PUT /setup/draft` and `POST /setup/complete` also have per-route rate
   limits. Errors are generic and never echo input; request bodies are never logged. Every business route added
   after this task must use `requireAuthenticatedUser` and `requirePermission` (ADR-0014).
6. **Password handling.** The Administrator password appears only in the `POST /setup/complete` body, is checked
   against the password policy, hashed, and never stored in the draft, the audit event, logs or the response.

## Alternatives rejected

- Persisting a partial organization and tracking `setup_step`: violates "no partial organization" and needs
  cleanup logic for abandoned setups.
- Returning a session from setup: creates a second token-issuing path that bypasses lockout/rate limiting.
- Client-side-only draft: lost when renderer storage is cleared, and the renderer should hold no business state.

## Consequences

- Risk **R-051 (first-run takeover):** while setup is incomplete, whoever can call `POST /setup/complete` with the
  launch secret becomes the Administrator. Compensating controls: loopback only, per-launch secret known only to
  the shell and its renderer, per-route rate limit, refusal after completion, audit event. The residual exposure is
  accepted (same trust boundary as R-037) and must be restated in the Task 1.4 report.
- The draft holds personal business data (PAN, GSTIN, addresses) unencrypted in the database until completion; it
  is covered by the same backups as other data and removed on completion.
- Task 1.4 gains two routes beyond the earlier outline (`GET`/`PUT /setup/draft`); nothing else is added.
- Draft validation is intentionally looser than completion validation (partial answers are allowed), so tests must
  cover both.

## Implementation record (Task 1.4)

**Code:** `packages/setup` (service, validators, schemas, draft), `packages/reference-data` (the Task 1.1 seed moved
into a package so it can run on the setup transaction; `prisma/seed/reference/*` are thin re-export shims so the seed
CLI and Task 1.1 tests are unchanged), `apps/api/src/setup-routes.ts`, auth service additions `prepareNewUser` /
`insertUser` (hash outside the transaction, insert inside it) and an `Actor.system` identity.

**Draft definition**

- _Storage location:_ one row in `application_settings` (`organization_id` NULL, key `setup.draft`) in the same
  PostgreSQL database - not a file, so there is nothing on disk to commit; `.gitignore` additionally ignores
  `setup-draft*.json` / `*.setup-draft.json` as a guard against stray exports. A single-statement UPDATE is atomic,
  so an interrupted save never destroys the previous valid draft (the "atomic file replacement" concern does not
  arise because the draft is not file-backed).
- _Format/version:_ `{ "formatVersion": 1, "data": {...} }`; `data` is a strict object of optional wizard fields
  (business, location, warehouse, financial-year start, administrator username/display name/e-mail). There is **no**
  password field; unknown keys (password, passwordHash, token, launch secret, credential, key...) are rejected on
  save and on read. Maximum size 16 KiB; request body limit 32 KiB.
- _Validation:_ shape and length only when saving (half-finished forms are normal); full business validation at
  completion, which never trusts the draft.
- _Corruption handling:_ a stored draft that is not exactly the current format (invalid shape, extra keys, wrong or
  missing version) is never returned: `GET /setup/draft` reports `{draft: null, discarded: true}` and deletes it;
  `PUT` simply overwrites it; `/setup/status` reports `draftAvailable: false`. Completed-ness never depends on the
  draft.
- _Deletion:_ removed inside the completion transaction. After completion the draft routes answer 409.
- _Future format changes:_ `parseStored` accepts only the current `formatVersion`; a future version adds an explicit
  migration branch for older drafts (documented in code). An unmigratable older or newer draft is discarded with a
  notice, never guessed at. The user re-enters the (non-secret) fields; the password was never saved anyway.
- _Concurrency:_ optimistic, via the row `version`; stale save -> 409 `DB_0002`.

**Authoritative state and replay protection**

- `setupRequired` = no organization has `setup_completed_at`. Evaluated from the database on every request, so an
  API/Electron restart or a deleted/corrupt draft cannot re-open setup.
- Completion runs under `pg_advisory_xact_lock` and re-checks that state inside the lock. A test that removes the
  re-check makes the concurrency tests fail, i.e. the lock is demonstrably required.
- Database invariants (migration `20261019000000_task_1_4_setup_invariants`, constraints + trigger, no schema
  change): PAN/GSTIN/state-code formats, GST-status rules (registered requires GSTIN; unregistered forbids it),
  GSTIN-state and GSTIN-PAN consistency, and `setup_completed_at` is immutable once set (no clearing or changing).
  A "only one completed organization" unique index was deliberately NOT added: the data model supports several
  organizations and existing tests rely on it; the advisory lock plus re-check enforce single bootstrap instead.

**Transaction contents (one transaction):** organization; organization settings (`locale` = IN/INR/Asia/Kolkata,
`setup` provenance); primary location; primary warehouse; first financial year; reference data (permissions, the five
role templates, units, UNREVIEWED tax placeholders - no duplicate role definitions); Administrator user with the seeded
"Administrator" role; draft deletion; `setup.completed` audit event; `setup_completed_at`. Eleven failure-injection
points are tested; each leaves zero rows in every table and an intact draft, and a retry then succeeds.

**Audit identity:** no authenticated user exists, so none is fabricated. Bootstrap events (`setup.completed`,
`user.create`) have `user_id` NULL and `after_values.actor = "system:bootstrap"`; user activity carries the user's id.
Nothing is audited for a rolled-back attempt because the audit rows are part of the same transaction.

**Bootstrap-route exception:** `GET /setup/status`, `GET|PUT /setup/draft` and `POST /setup/complete` are the only
business-initialisation routes that run without user authentication or permission checks. They are an exception because
no user can exist yet and must not become a pattern: every normal business route must use
`requireAuthenticatedUser` and `requirePermission` (ADR-0014). The routes are covered by the launch secret, the
database-authoritative precondition, rate limits (5/min completion, 60/min draft by default), body limits and
value-free error details.

**Scope interpretation:** the Task 1.4 brief mentioned "invoice sequence configuration" among fields to validate "where
applicable". PROJECT_STATE lists document numbering sequences as out of scope for Task 1.4, so no numbering
configuration is collected, validated or stored; it is the proposed Task 1.5.
