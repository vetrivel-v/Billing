# Project State

Last updated: 2026-10-18 (after Phase 1 Task 1.6). This file and the repository are the implementation record (spec section 44).

| Item                      | Value                                                                                                                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application version       | 0.0.1 (pre-release)                                                                                                                                                                                                                                                           |
| Current phase             | **Phase 1 in progress: Tasks 1.0-1.6 complete; Task 1.7 not started**                                                                                                                                                                                                         |
| Current database version  | `20261021000000_task_1_6_security_admin_invariant` (19 tables: Task 1.6 changed no table; it added one function, one trigger function and five deferred constraint triggers)                                                                                                  |
| Last successful migration | `20261021000000_task_1_6_security_admin_invariant` - applied to clean databases by every integration file and to a populated previous-version database by its migration test, 2026-10-18                                                                                      |
| Last successful build     | 2026-10-18 - `npm run build` (api, web, desktop) PASS                                                                                                                                                                                                                         |
| Last successful test run  | 2026-10-18 - `npm run verify:phase0` all 8 gates PASS; 251 unit + 276 integration tests (527) passed; coverage 96.5% statements / 92.0% branches / 98.9% functions / 98.2% lines (thresholds 80/70/80/80 unchanged)                                                           |
| Git                       | Branch `main`; Phase 0 = `40bfecd`; Task 1.0 = `e56bf6d`; governance docs = `8e81d9e`; Task 1.1 = `4bcccdc`; Task 1.2 = `963ebf9`; Task 1.3 = `94bb7e9`; Task 1.4 = `800e2f7`; Task 1.5 = `9dbfd55`; Task 1.6 = the commit following it (see `git log`); no remote configured |
| Release status            | Not releasable. No product functionality exists                                                                                                                                                                                                                               |

## Completed modules (Phase 0 scope only)

Repo scaffold; tooling (TypeScript strict, ESLint, Prettier, Vitest); environment validation; Prisma schema +
foundation migration; embedded dev/test PostgreSQL; Fastify API shell (health, error contract, security
headers); React status shell; hardened Electron shell; Phase 0 verification script; documentation set listed in
the completion report.

## Task 1.0 results (spikes; see docs/PHASE_1_TASK_1_0_COMPLETION_REPORT.md)

- ADR-0009 backup via verified logical export (spike in tests/recovery/spikes, not production code).
- ADR-0010 per-launch secret guard in the API (implemented, not yet wired into Electron).
- ADR-0011 Argon2id via @node-rs/argon2 (proven in Node 24.16 and Electron 44.8.0).
- Defect found and fixed (also recorded in RISK_REGISTER R-035, REQUIREMENTS_MATRIX T10-05, DATABASE_CONVENTIONS rule 13, and the Task 1.0 report): dev/test PostgreSQL clusters defaulted to WIN1252 and could not store Indian-language
  text (R-035); both are now forced to UTF8 with a regression test.

## Task 1.1 results (reference seed; see docs/PHASE_1_TASK_1_1_COMPLETION_REPORT.md, ADR-0012)

- `npm run db:seed -- reference` inserts, in one transaction and idempotently (insert-if-absent, never
  delete/recreate): 70 permissions, 5 role templates with 162 grants (Administrator 70, Accountant 42, Billing Operator 14, Warehouse Operator 12, Viewer/Auditor 24), 13 units, 8 tax categories and 8 tax rates
  for an existing organization. `demo` stays a no-op. Counts are asserted in tests.
- Migration `20261017000000_task_1_1_tax_reference_markers`: origin / review_status / review_note on tax
  categories and rates, effective dating on categories. Seeded tax data are **UNREVIEWED placeholders, not
  statutory rates**; enforcement of review status in invoicing is not built (R-040).
- **Gate-integrity defect found and fixed (R-039):** the integration run exited 0 although a test had failed, so
  `verify:phase0` printed a false PASS once. Teardown now re-asserts the exit code and the gate cross-checks the
  Vitest JSON report; a negative control proved both. A Task 1.0 test that hard-coded the schema version was the
  failing test and now derives the newest migration name.
- Known behaviours: re-running the seed re-adds revoked template grants (R-042); seeding writes no audit row
  (R-041).

## Task 1.2 results (shell supplies the launch secret; see docs/PHASE_1_TASK_1_2_COMPLETION_REPORT.md, ADR-0013)

- P1-SEC-01 is **done and tested end to end**: the real Electron shell starts the real built API with a fresh
  per-launch secret (environment only, allow-listed child environment), the renderer (served from
  `app://commercebill`) obtains it through the argument-free `getApiAccess()` bridge (sender URL validated)
  and sends `x-commercebill-launch-secret`; calls without it return 401 `AUTH_0001`; the secret never appears in
  the API output or the shell's output. `NODE_ENV=production` without `LAUNCH_SECRET` fails validation.
- Remaining limits: DATABASE_URL still comes from the shell's environment (dev only); packaged layout and
  PostgreSQL supervision are Phase 6 (R-045); no user authentication yet.
- Reliability notes: a leftover `postgres.exe` from an interrupted run broke later integration runs; the test
  cluster now uses a free port (R-034). One unit run reported 3 failing tests in 3 files: one confirmed pre-existing
  test (`launch-secret.test.ts` "rejects requests without the secret ..."), one new supervisor test (real bug,
  fixed) and one unidentified (output not captured); not reproduced in 10 later complete passes (R-043).

## Task 1.3 results (authentication and authorization foundation; see docs/PHASE_1_TASK_1_3_COMPLETION_REPORT.md, ADR-0014)

- New package `@commercebill/auth`: Argon2id hasher (64 MiB, t=4, p=1, ~110 ms, benchmarked), password policy,
  session tokens (SHA-256 at rest), configuration, and `createAuthService` (create/disable/enable user, login,
  token authentication, logout, revoke-all, per-account lockout, audit).
- API: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` (behind the launch secret) and reusable guards
  `requireAuthenticatedUser` / `requirePermission('key')` (401 `AUTH_0001` vs 403 `AUTH_0002`, permissions from
  the database per request, no administrator bypass). Only test-only routes use the guards so far.
- Migration `20261018000000_task_1_3_auth_constraints`: canonical usernames, token-hash shape, expiry order,
  users cannot be deleted. Test-verified role matrix: 5 roles x 70 permission keys over HTTP.
- Bugs found by the new tests and fixed before commit: an unknown `organizationId` at login caused a 500
  (audit foreign key); the test global rate limit needed to be configurable; the password policy missed
  "common word + digits" (e.g. `password123456`). Five deliberate mutations of the security logic (idle timeout,
  lock check, revocation check, disabled-user check, administrator bypass) were each caught by tests; sources
  restored and verified identical.
- Not built (by scope): login UI, password change/reset, user-management routes, setup wizard, enforcement of
  `must_change_password`, inactivity/manual lock UI. See R-046..R-050.

## Task 1.4 results (first-run setup, backend only; see docs/PHASE_1_TASK_1_4_COMPLETION_REPORT.md, ADR-0015)

- New packages `@commercebill/setup` (service, validators, draft) and `@commercebill/reference-data` (the Task 1.1 seed,
  now runnable on a caller's transaction; `prisma/seed/reference/*` are re-export shims).
- API (behind the launch secret; **bootstrap routes, the only routes exempt from user authentication**):
  `GET /setup/status`, `GET|PUT /setup/draft`, `POST /setup/complete` (201, no token, `nextStep: "login"`).
- `POST /setup/complete` is one transaction: organization, settings, location, warehouse, financial year, reference data,
  Administrator with the seeded role, draft cleanup, `system:bootstrap` audit event, completion marker. Eleven injected
  failure points leave zero rows; one of many concurrent submissions succeeds (advisory lock + in-lock re-check).
- The resumable draft is a password-free, strictly whitelisted, versioned row in `application_settings`; corrupt or
  incompatible drafts are discarded; completed-ness is decided only by the database.
- Migration `20261019000000_task_1_4_setup_invariants`: identifier format checks, GST-status rules, GSTIN/state/PAN
  consistency, immutable `setup_completed_at`.
- Bugs/oddities found while testing (all fixed before commit): Prisma cannot read the `void` result of
  `pg_advisory_xact_lock` via `$queryRaw` (now `$executeRaw`); pasted values with surrounding spaces exceeded length
  limits before trimming (now trimmed first, never the password); several test-design slips. Four deliberate
  mutations (no in-lock re-check, draft not deleted, password leaked into audit, password accepted by the draft schema)
  were each caught; sources restored and verified identical.
- Closes R-041 for first-run setup. New risks R-052..R-055 (draft PII, unreviewed state table, lock-based
  single-bootstrap, no password recovery).
- Interpretation recorded: "invoice sequence configuration" is not collected here because PROJECT_STATE listed document
  numbering as out of scope; it is the core of proposed Task 1.5.

## Task 1.5 results (document numbering engine; see docs/PHASE_1_TASK_1_5_COMPLETION_REPORT.md, ADR-0016)

- New package `@commercebill/numbering`: stable document-type codes (INVOICE, CREDIT_NOTE, DEBIT_NOTE, PURCHASE_ORDER,
  PAYMENT_RECEIPT), configuration-driven formatting (`{FY}` token), validation, and a service that works on the caller's
  transaction: `allocate`, `createSequence`, `updateSequence`, `listSequences`, `openFinancialYear`, `findGaps`.
- Migration `20261020000000`: `reset_policy`, `is_active`, the append-only `document_number_allocations` ledger, and
  database triggers/constraints so the counter can only advance by one, history cannot be rewritten or deleted, and
  no duplicate number/text/document can be committed - even by code that bypasses the engine.
- Concurrency: row lock (`FOR UPDATE`) plus those invariants, no in-process lock. 40 parallel allocations, parallel
  allocations with rollbacks (no gap), and 96 allocations across 8 sequences all behave; removing the lock makes four tests
  fail; a deliberately unlocked allocator still cannot commit a duplicate.
- Idempotent per document (`documentRef`, including retry after rollback and a same-document race across two financial years); drafts never consume numbers; rollback leaves no gap (policy in ADR-0016,
  no statutory claim); configuration changes never renumber history.
- First-run setup now also creates the five sequences (defaults or the wizard's answers) inside its atomic transaction
  (12 failure points tested); the setup draft accepts the same non-secret numbering fields.
- **The Task 1.5 brief was cut off at section G; the idempotency design is my reading of it (R-058).**
- Existing-test changes caused by the schema growing: the backup-spike table-count assertion 18 -> 19, and setup
  tests now expect 3 organization settings, 5 sequences and a 12th rollback step.
- Mutation checks: removing the row lock failed 4 concurrency tests; removing the idempotency and active checks failed
  5; a combined mutation that also skips a number each time failed 16 (the skip is rejected by the database trigger). Source restored and verified identical.

## Task 1.6 results (user administration and password management; see docs/PHASE_1_TASK_1_6_COMPLETION_REPORT.md, ADR-0017)

- Ten routes behind the launch secret and the Task 1.3 guards: `GET /auth/me` (existing), `POST /auth/change-password`,
  `GET /roles`, `GET /users`, `GET /users/:id`, `POST /users`, `POST /users/:id/disable`, `/enable`,
  `PUT /users/:id/roles`, `POST /users/:id/reset-password`. Every one is organization-scoped from the session.
- Password change: authenticated only (no catalogue key); wrong current password is 400 `VAL_0001`
  `current_password_incorrect` (not 401), counts toward lockout and is rate limited; reuse of the current password is
  refused; revokes the caller's OTHER sessions and keeps the current one; clears the forced-change flag.
- Forced change enforced (`AUTH_0004`): a user on a temporary password may only call `/auth/me`,
  `/auth/change-password`, `/auth/logout`. 401 still precedes it.
- Administrator password reset: the administrator supplies the temporary password; the server never generates or
  returns one; the target's sessions are revoked, lockout cleared, change forced.
- Role-assignment safeguards: (a) privilege ceiling - roles granted OR revoked must be within the caller's own
  permissions; (b) no changing your own roles; (c) `POST /users` with non-empty `roleIds` also needs
  `security.role.manage`. **Addition beyond the approved plan:** the same ceiling applies to reset-password
  (the target's effective permissions must be within the caller's), otherwise a reset-only holder could take over an
  Administrator. Flagged in the report for review.
- Last-usable-administrator protection is in PostgreSQL (migration `20261021000000`): deferred constraint triggers on
  `users`, `user_roles`, `role_permissions`, `roles`, `permissions` plus an advisory lock per organization, so
  concurrent removals of different administrators cannot both commit. Organizations whose setup is not complete are
  exempt (R-060). The service takes the same lock early and returns 409 instead of a failed commit.
- The brief wrote `security.role_manage`; the real catalogue key is `security.role.manage` (used throughout).
- Tests: +5 unit (privilege ceiling), +8 migration, +53 HTTP integration (every route: no session, no launch secret,
  each other role template, exact-key custom role; escalation attempts; password flows; forced change; reset; disable/
  enable; role assignment; last administrator including concurrent mutual disable; cross-organization isolation;
  secret leakage). Mutation checks (ceiling, own-role rule, role.manage-on-create, pending-change enforcement, revoke-others,
  organization scope) each made a test fail; sources restored and verified identical. Removing only the service-level
  copy of the role.manage-on-create check does not fail a test because the route enforces it first (defence in depth).

## In-progress modules

None.

## Not-started modules

Everything in spec sections 10-33 and 35-37 beyond the foundation tables: setup wizard, auth/RBAC, numbering
service, tax engine, customers, products, inventory, invoicing, PDF, payments, backup/restore, import/export,
reports, purchasing, accounting, e-commerce, reconciliation, compliance, installer. Domain packages
(`domain`, `tax-engine`, `accounting-engine`, `inventory-engine`, `document-engine`, `integration-core`, `ui`,
`reporting`) contain only a README.

## Open defects

None known.

## Open security issues

No critical defect known. Open risks needing design decisions before/at Phase 1: R-030 (embedded-postgres production suitability), R-032/R-037 (launch secret not yet wired; user auth pending), R-036 (logical backup limits), R-038 (Argon2 binary in packaged app). R-031 and R-033 are now Mitigating. See [RISK_REGISTER.md](RISK_REGISTER.md).

## Open data-integrity issues

None known. Migration safety (pre-migration backup, upgrade tests) is not implemented yet (R-010).

## Carried-forward obligations (still open after Task 1.3)

| ID         | Obligation                                                                                                                                                                                                                                                                | Must be done by                           | Tracked in                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| P1-SEC-01  | ~~Wire the launch secret into Electron~~ **DONE in Task 1.2** (tested end to end; ADR-0013)                                                                                                                                                                               | done                                      | REQUIREMENTS_MATRIX P1-SEC-01                                |
| P1-BKP-01  | Production backup/restore module (streaming COPY, AES-256-GCM encryption, attachments, config, retention, verification workflow, restore wizard). The Task 1.0 logical-dump code is an **experimental spike, not production backup functionality**                        | Phase 1 backup task (before Phase 1 exit) | REQUIREMENTS_MATRIX P1-BKP-01; ADR-0009; R-011, R-031, R-036 |
| P1-AUTH-01 | **DONE through Task 1.6** (Argon2id service, sessions, RBAC guards, password change/reset, forced change, user and role administration; ADR-0014, ADR-0017). Still open: login UI, audit-log read API and auditing of permission denials (R-063), role/permission editing | Later Phase 1 tasks                       | REQUIREMENTS_MATRIX P1-AUTH-01; R-055, R-063                 |
| P6-ENC-01  | Production PostgreSQL initialisation must use `--encoding=UTF8` (dev/test already do)                                                                                                                                                                                     | Phase 6 packaging                         | REQUIREMENTS_MATRIX P6-ENC-01; R-035                         |

## Known limitations

- **The backup code under tests/recovery/spikes is an experimental spike (in-memory, unencrypted, same schema version only). No production backup or restore exists.**
- The launch secret is enforced only when the shell (or a test) supplies `LAUNCH_SECRET`; running the API alone in development (`npm run dev`) leaves the guard off. Production mode refuses to start without it.
- The setup routes are the only non-health, non-auth routes and are deliberately exempt from user authentication (bootstrap exception, ADR-0015). Apart from the Task 1.6 user-administration routes, only test-only routes use the guards: no business route exists yet. Task 1.6 added the user-administration and password routes; there is still no login UI.
- Docker Compose file was not executed (Docker not installed on this machine).
- Electron smoke check and `npm run dev` startup were verified manually, not in the automated suite.
- No Playwright, no pre-commit hook, no CI service, no OpenAPI document, no SBOM yet.
- TypeScript pinned to 6.0.x because typescript-eslint does not yet support 7.x.
- `embedded-postgres` is a beta-versioned package used for development and tests only.
- Prisma CLI reports an available 8.0 release candidate; intentionally not adopted.

## External integrations and verification status

None implemented. All marketplace, e-invoice, e-way bill, e-mail and WhatsApp integrations are
**NOT VERIFIED AGAINST LIVE SERVICE** (and not yet started).

## Exact next task

**Phase 1, Task 1.7 - audit-log read API and auditing of authorization denials.** Proposed (not started; do not begin
without approval). Requirement IDs T17-xx are assigned at the start.

Why: Task 1.6 writes security audit events (`user.create`, `user.disable`, `user.enable`, `user.roles.changed`,
`user.password.changed`, `user.password.reset`, `user.password.change_failed`) but nothing can read them, and a 403 is
only logged, not audited (R-063). `security.audit.read` exists in the catalogue (Viewer/Auditor holds it).

Scope:

1. `GET /audit-logs` (`security.audit.read`): organization-scoped, keyset or limit/offset paging (limit <= 100), filters
   by action, entity type/id, user and time range; returns no secret material; response shape documented.
2. Record authorization denials (`auth.permission.denied`: user, route pattern, permission key, correlation id;
   rate-limited or aggregated so a denied-request flood cannot flood the table - R-049 interaction) and AUTH_0004
   blocks if wanted.
3. Redaction check: a test that scans every audit row type for password material, hashes and tokens.
4. Out of scope: any UI, export, retention/archival, hash chaining (R-017), role/permission editing, business routes.

Acceptance criteria: 401 without a session; 403 for every role without `security.audit.read`; organization isolation
(Org A cannot read Org B rows); paging bounds and invalid-query 400s; denial events created exactly once per denied
request and containing no request body; audit rows stay append-only; `npm run verify:phase0` passes with the 527-test
baseline not weakened and thresholds unchanged; PROJECT_STATE, REQUIREMENTS_MATRIX, RISK_REGISTER, an ADR and a
completion report updated.

Other open Phase 1 work, in no committed order: login/setup UI, P1-BKP-01 (production backup), tax engine,
customers/products/inventory, invoicing, PDF, payments, reports, import/export.
