# Project State

Last updated: 2026-10-18 (after Phase 1 Task 1.4). This file and the repository are the implementation record (spec section 44).

| Item                      | Value                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application version       | 0.0.1 (pre-release)                                                                                                                                                                                                               |
| Current phase             | **Phase 1 in progress: Tasks 1.0-1.4 complete; Task 1.5 not started**                                                                                                                                                             |
| Current database version  | `20261019000000_task_1_4_setup_invariants` (18 tables; Task 1.4 added constraints and a trigger only)                                                                                                                             |
| Last successful migration | `20261019000000_task_1_4_setup_invariants` - applied to clean databases by every integration file and to a populated previous-version database by the migration tests, 2026-10-18                                                 |
| Last successful build     | 2026-10-18 - `npm run build` (api, web, desktop) PASS                                                                                                                                                                             |
| Last successful test run  | 2026-10-18 - `npm run verify:phase0` all 8 gates PASS; 200 unit + 163 integration tests (363) passed; coverage 96.8% statements / 93.4% branches / 99.0% functions / 98.7% lines; npm audit 0 vulnerabilities                     |
| Git                       | Branch `main`; Phase 0 = `40bfecd`; Task 1.0 = `e56bf6d`; governance docs = `8e81d9e`; Task 1.1 = `4bcccdc`; Task 1.2 = `963ebf9`; Task 1.3 = `94bb7e9`; Task 1.4 = the commit following it (see `git log`); no remote configured |
| Release status            | Not releasable. No product functionality exists                                                                                                                                                                                   |

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

| ID         | Obligation                                                                                                                                                                                                                                         | Must be done by                           | Tracked in                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| P1-SEC-01  | ~~Wire the launch secret into Electron~~ **DONE in Task 1.2** (tested end to end; ADR-0013)                                                                                                                                                        | done                                      | REQUIREMENTS_MATRIX P1-SEC-01                                |
| P1-BKP-01  | Production backup/restore module (streaming COPY, AES-256-GCM encryption, attachments, config, retention, verification workflow, restore wizard). The Task 1.0 logical-dump code is an **experimental spike, not production backup functionality** | Phase 1 backup task (before Phase 1 exit) | REQUIREMENTS_MATRIX P1-BKP-01; ADR-0009; R-011, R-031, R-036 |
| P1-AUTH-01 | **Foundation DONE in Task 1.3** (Argon2id service, sessions, lockout, RBAC guards; ADR-0014). Still open: password change/reset, user-management routes, enforcement of `must_change_password`, login UI                                           | Later Phase 1 tasks                       | REQUIREMENTS_MATRIX P1-AUTH-01; R-047, R-048                 |
| P6-ENC-01  | Production PostgreSQL initialisation must use `--encoding=UTF8` (dev/test already do)                                                                                                                                                              | Phase 6 packaging                         | REQUIREMENTS_MATRIX P6-ENC-01; R-035                         |

## Known limitations

- **The backup code under tests/recovery/spikes is an experimental spike (in-memory, unencrypted, same schema version only). No production backup or restore exists.**
- The launch secret is enforced only when the shell (or a test) supplies `LAUNCH_SECRET`; running the API alone in development (`npm run dev`) leaves the guard off. Production mode refuses to start without it.
- The setup routes are the only non-health, non-auth routes and are deliberately exempt from user authentication (bootstrap exception, ADR-0015). The auth guards otherwise protect only test-only routes: no normal business route exists yet. There is no login UI, password change/reset or user-management API (R-047, R-048).
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

**Phase 1, Task 1.5 - document numbering engine and setup-time sequence configuration (spec section 17; backend only).**
Proposed scope (not started; do not begin without approval). No requirement IDs yet: assign T15-xx at the start.

Scope:

1. A numbering service in a package (no HTTP) working on the **caller's transaction client** so the number is allocated
   in the same transaction that posts the document (spec section 17):
   - `allocate(tx, { organizationId, documentType, financialYearId, locationId? })` takes the `document_sequences` row with
     `SELECT ... FOR UPDATE`, increments `last_number` and returns the formatted number (prefix + zero-padded number +
     suffix, e.g. `INV/2026-27/000001`). It never creates a missing sequence implicitly (error instead), never
     reuses a number, and raises a clear error when the number would exceed the configured length.
   - `configure`/`list` for sequences and a `preview` that formats a sample number. Document types are a fixed,
     tested registry (INVOICE, CREDIT_NOTE, DEBIT_NOTE, PURCHASE_ORDER, PAYMENT; extendable by migration-free code).
   - Validation: prefix/suffix limited to letters, digits and `/ - _ .`; numeric length 1-18; start number >= 1;
     start number cannot be lowered once any number has been allocated.
2. **Setup integration:** `POST /setup/complete` accepts an optional `numbering` section (invoice prefix and starting
   number, credit-note, debit-note, purchase and payment prefixes; sensible defaults such as `INV/<FY>/`), validated
   server-side, and creates the first financial year's sequences **inside the existing atomic transaction**. The draft
   schema gains the same optional, non-secret fields (still no password; draft `formatVersion` unchanged because the
   change is additive and optional - recorded in the ADR).
3. Out of scope: invoices or any document tables, posting logic, gap reports (they need documents; deferred), financial-year
   rollover and locking, per-location numbering UI, any UI, new business routes.
4. Tests (acceptance criteria):
   - unit: formatting, padding, overflow, prefix/suffix validation, start-number rules;
   - integration: N concurrent allocations in separate transactions return distinct, consecutive numbers with no
     duplicates or skips; an allocation inside a transaction that rolls back leaves the counter unchanged (the number was
     never committed, so it is not "released" - documented policy); allocations for different financial years/documents/
     locations are independent; allocation without a configured sequence fails with a clear error; the NULL-location
     uniqueness (partial index) is respected;
   - setup: completion with and without a `numbering` section creates the expected sequences atomically; the 11 failure
     points still leave zero rows (including zero sequences); invalid numbering input is rejected without writes; the
     draft accepts numbering fields but still rejects any secret field;
   - If a schema change is needed: versioned migration plus migration test (a CHECK on prefix/suffix characters is the
     expected candidate).
5. `npm run verify:phase0` still passes (200 unit + 163 integration baseline, none weakened, gate-integrity checks
   intact); coverage thresholds unchanged and met. Task 1.3 authentication and Task 1.4 setup tests must keep passing.
6. PROJECT_STATE, REQUIREMENTS_MATRIX, RISK_REGISTER updated (risk R-024 financial-year sequence errors, R-003 duplicate
   invoice numbers); an ADR for the allocation and policy decisions; a Task 1.5 completion report.

Other open Phase 1 work, in no committed order: login/setup UI, password change/reset and user-management routes
(R-047, R-048, R-055), P1-BKP-01 (production backup), tax engine, customers/products/inventory, invoicing, PDF,
payments, reports, import/export.
