# Project State

Last updated: 2026-10-22 (after Phase 1 Task 1.17). This file and the repository are the implementation record (spec section 44).

| Item                      | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application version       | 0.0.1 (pre-release)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Current phase             | **Phase 1 in progress: Tasks 1.0-1.17 complete; Task 1.18 (First Usable Billing E2E) not started**                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Current database version  | `20261028000000_task_1_17_backup_recovery` (32 tables: Task 1.17 added `backup_records` and `backup_verifications`; one view `invoice_balances`)                                                                                                                                                                                                                                                                                                                                                                                        |
| Last successful migration | `20261028000000_task_1_17_backup_recovery` - applied to clean databases by every integration file and to a populated Task 1.16 database by its migration test, 2026-10-22                                                                                                                                                                                                                                                                                                                                                               |
| Last successful build     | 2026-10-22 - `npm run build` (api, web, desktop) PASS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Last successful test run  | 2026-10-22 - `npm run verify:phase0` all 8 gates PASS on the committed Task 1.17 tree (after earlier attempts failed on unrelated load-sensitive tests, see R-104); 1283 tests passed in 86 files; coverage 93.6% statements / 87.8% branches / 92.7% functions / 95.2% lines (thresholds 80/70/80/80 unchanged); npm audit 0 vulnerabilities                                                                                                                                                                                           |
| Git                       | Branch `main`; Phase 0 = `40bfecd`; Task 1.0 = `e56bf6d`; governance docs = `8e81d9e`; Task 1.1 = `4bcccdc`; Task 1.2 = `963ebf9`; Task 1.3 = `94bb7e9`; Task 1.4 = `800e2f7`; Task 1.5 = `9dbfd55`; Task 1.6 = `d23ab67`; Task 1.7 = `2ee0a11`; Task 1.8 = `7cdc2a7`; Task 1.9 = `7fb72f3`; Task 1.10 = `9aaf4fa`; Task 1.11 = `a905e97`; Task 1.12 = `8dbf291`; Task 1.13 = `7f7479f`; Task 1.14 = `0b716ff`; Task 1.15 = `ffb6717`; Task 1.16 = `f0371d1`; Task 1.17 = the commit following it (see `git log`); no remote configured |
| Release status            | Not releasable. No product functionality exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

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
- The setup routes are the only non-health, non-auth routes and are deliberately exempt from user authentication (bootstrap exception, ADR-0015). Apart from the Task 1.6 user-administration routes, only test-only routes use the guards: no business route exists yet. There is now a sign-in page, shell and dashboard (Task 1.7); the setup wizard now runs on a fresh installation (Task 1.8).
- Docker Compose file was not executed (Docker not installed on this machine).
- Electron smoke check and `npm run dev` startup were verified manually, not in the automated suite.
- No Playwright, no pre-commit hook, no CI service, no OpenAPI document, no SBOM yet.
- TypeScript pinned to 6.0.x because typescript-eslint does not yet support 7.x.
- `embedded-postgres` is a beta-versioned package used for development and tests only.
- Prisma CLI reports an available 8.0 release candidate; intentionally not adopted.

## External integrations and verification status

None implemented. All marketplace, e-invoice, e-way bill, e-mail and WhatsApp integrations are
**NOT VERIFIED AGAINST LIVE SERVICE** (and not yet started).

## Task 1.17 results (production backup and verified restore; see docs/PHASE_1_TASK_1_17_COMPLETION_REPORT.md, ADR-0027)

**A verified backup does not enable production billing. R-040 stays open; the production gate needs the tax review, seller registration, HSN/SAC policy AND a recent verified backup, and switching to PRODUCTION stays a separate, deliberate step.**

- **`@commercebill/backup`:** encrypted backup archive (`*.cbbackup`: AES-256-GCM in 1 MiB chunks, scrypt key from the user's passphrase, unique salt and nonce, header and final-chunk flag authenticated), container with an allow-list of entry names and generated extraction names, strict manifest with per-table SHA-256, consistent logical export under one `REPEATABLE READ` snapshot (concurrent writes neither blocked nor included; `sessions` excluded), migrate-then-load restore (stock projection rebuilt from the ledger, R-080), 22 set-based integrity checks, the backup service and its records.
- **Verified restore:** decrypt, validate, restore into an isolated database, run the integrity checks, compare the re-exported content with the manifest, persist PASS or FAIL in the append-only `backup_verifications`, remove the isolated database. A wrong passphrase or damaged file is reported and records no result.
- **Production gate:** `BACKUP_RESTORE_VERIFIED` is read from the persisted record (latest PASS, current engine, schema and database, at most 30 days). FAIL, migration, restore and age each make it false. The `AppDeps.backupRestoreVerified` seam remains test-only. Real tests drive the real gate (verified backup + tax review, then PRODUCTION) with no injection.
- **Guided restore:** administrator opens a backup, types `RESTORE`; maintenance mode (503); a verified `PRE_RESTORE` safety backup; load into a new database with the integrity checks; atomic rename swap; the previous database kept; history carried over; new database identity (gate false until a new verification); sessions not restored. Failure at any step leaves the live data untouched.
- **Safety:** one operation at a time (409 busy); conservative retention; control-secret channel so the renderer never supplies or sees a path; control routes 403 without the secret; audit rows without secrets or data; logs without passphrase, key or session.
- **UI:** Settings, Backup & Recovery (readiness panel, folder, create with confirmed passphrase and loss warning, history with verification state, verify, retention, restore workflow); Settings landing page. The Settings entry is no longer "Coming soon", so no navigation entry is unbuilt.
- **Tests:** 17 backup integration tests, 6 restore integration tests, 6 real-API UI tests, 1 production-like Electron test, 3 migration tests (incl. populated upgrade), backup unit tests, 4 desktop IPC unit tests; mutation checks (final-chunk flag, container allow-list, gate ignoring FAIL, control secret, maintenance mode, retention, content identity, manifest checksum) recorded in the completion report. Existing tests changed: bridge now has six methods, table count 32, Settings no longer "Coming soon".
- **Electron check (production-like, item 24):** the real Backup & Recovery screens in the real renderer from `app://`, real IPC and control channel, real API and database: choose folder, create and verify a backup, open it for restore. Only the two native dialogs are replaced by hooks. **Remains for a manual installer smoke test:** the native folder and file dialogs, a real removable drive, and the installed (packaged) application (R-090, R-093). No external drive was tested.
- **Not built:** scheduled/automatic backups, cloud storage, point-in-time recovery, passphrase recovery, attachments in backups, cross-version restore, removal of the kept previous database (R-097 to R-103).

## Task 1.16 results (payments and receivables; see docs/PHASE_1_TASK_1_16_COMPLETION_REPORT.md, ADR-0026)

**Demo payments are not money. R-040 stays open; production billing (and so production payments in the shipped app) stays unavailable until Task 1.17.**

- **Receivable model (no stored balance):** `balance due = immutable invoice grand total - sum(persisted allocations)`, derived by the database (`invoice_balances` view and the recording transaction). Invoice list and detail now show paid, balance and a derived status (UNPAID / PARTIALLY_PAID / PAID); the invoice itself is untouched.
- **Payments:** append-only `payments` and `payment_allocations` (UPDATE/DELETE/TRUNCATE refused for every writer); `POST /payments` (`sales.payment.record`), `GET /payments`, `GET /payments/:id`, `GET /receivables`, `GET /receivables/customers/:id` (`sales.payment.read`); methods CASH, BANK_TRANSFER, UPI, CARD, CHEQUE, OTHER with reference rules; card-number-like references refused; amount exact (two decimals); date = today; one invoice per payment (schema allows several).
- **Over-allocation protection:** the invoice row is locked, the balance re-read in a second statement, and a deferred commit-time constraint re-checks the sum under the same lock. Real PostgreSQL concurrency tests: two payments of 2,000 against a 2,000 balance -> exactly one succeeds; eight of 500 against 2,000 -> exactly four.
- **Idempotency:** same operation id and content returns the original payment (200, no new rows/number/audit); different content is `OPERATION_ID_REUSED`; ten simultaneous retries create one payment.
- **DEMO payments:** separate records, `DEMO_PAYMENT_RECEIPT` numbers `DPAY/{FY}/` (seven setup sequences now), demo invoices only (service and database trigger), never in production receivables; DEMO wording on every screen.
- **Rollback:** failure injected after the number, after the payment insert, at the allocation, at the audit insert and at the deferred commit check: nothing is left (no payment, allocation, number gap or audit row); fabricated numbers, part-allocated payments and over-allocation are refused at COMMIT.
- **UI:** invoice detail payment summary and history with Record payment; record-payment page (server balance, safe retry, double-click protection); Payments list; Receivables and per-customer pages (production or demo, never mixed); no edit/delete/reverse control exists.
- **Tests:** 26 API/database integration tests (concurrency, idempotency, rollback, immutability, isolation, permissions, reopening), 2 migration tests, 13 real-API UI tests, 6 + 10 unit tests; mutation checks (invoice lock, balance check, mode check, replay fingerprint, permission key, both immutability triggers, the over-allocation, payment and kind checks, Luhn, reference rule) all killed (two first survived and needed a direct allocation test and a corrected pattern).
- **Visual review (real API, fictional data, 1000 and 1280 px):** unpaid, partly paid and paid invoices, the record page with the over-payment error, payment list, receivables and customer view, demo and production; the invoice and payment lists overflowed at 1000 px and were tightened (secondary columns hidden below 1100 px, smaller padding, wrapping customer column); the payment search box was squeezed and was given room.
- **Existing tests changed:** setup and numbering expectations follow the seventh sequence; the logical-dump table count is 30; the invoice list shows Balance and Payment instead of Status.
- **Not built:** refunds, reversal, credit/debit notes, receipt PDF, statements, gateways, bank reconciliation, backdating, multi-invoice allocation in the API, journals.

## Task 1.15 results (A4 invoice PDF, print preview and printing; see docs/PHASE_1_TASK_1_15_COMPLETION_REPORT.md, ADR-0025)

**A PDF does not make a DEMO invoice a production invoice. R-040 stays open; production billing stays unavailable until Task 1.17.**

- **`@commercebill/document-engine`** (pure): snapshot validation, view model, A4 HTML, Indian amount in words, safe file names. Shows only stored snapshot values (never master data), never recalculates, deterministic (same invoice, byte-identical HTML).
- **DEMO marking** on every page: outlined DEMO watermark, banner, page-margin text "DEMO - NOT A PRODUCTION TAX INVOICE", title DEMO INVOICE, DEMO- file name; no option removes it. A production document with no taxed line is titled INVOICE with a not-a-Tax-Invoice notice (no Bill of Supply is invented).
- **UI:** Invoice Detail has **Preview / Print** (sandboxed iframe preview of the exact document) and **Save PDF**; the preview page has **Print...** and **Save PDF**; buttons are disabled with an explanation outside the desktop app.
- **Electron IPC:** `document:save-invoice-pdf` and `document:print-invoice` only; sender checked, payload validated, HTML built in the main process, hidden locked-down render window, OS save dialog (forced .pdf, PDF check before write), OS print dialog (never silent); results carry no path; preload exposes exactly four methods.
- **Tests:** 35 document-engine unit tests, 11 IPC/guard-rail unit tests, 9 PDF integration tests (real posted invoices; real Electron PDFs: valid A4, multi-page, per-page DEMO check with a production negative control), 4 new UI tests, 1 production-like Electron flow test (sign in, list, detail, preview, save, print); mutation checks (watermark, margin text, banner, row/header page-break rules, escaping, traversal, demo prefix, demo-flag mismatch, payload validation, sender check, wording, title) all killed (one first survived and needed interior `..` cases).
- **Packaged-Electron check (R-090):** exercised in a production-like run (built bundles from app://, real API and PostgreSQL, real preload/IPC): sign in, invoice list, detail, Preview / Print, Save PDF (real PDF written and checked) and the Print path up to the native dialog. **Not verified:** an installed/packaged app (no installer yet), the native save and print dialogs themselves, any physical printer (R-093).
- **Visual review (A4 PDFs rendered from Electron, fictional data):** one-line intra-state, inter-state, discount, fractional quantity, multi-rate, 90-line multi-page (9 pages), DEMO, different billing/shipping, production no-tax. Fixed: the narrow Item column (table widths and font), HSN wrapping, a misleading supply note on no-tax documents, a heavy watermark.
- **Not built:** 58/80 mm receipts, templates, email/WhatsApp, e-invoice QR/IRN, bank/UPI details, credit/debit-note PDFs, any audit row per print (R-092).

## Task 1.14 results (billing UI; see docs/PHASE_1_TASK_1_14_COMPLETION_REPORT.md)

**Billing is usable end to end in DEMO mode only. R-040 stays open; production billing stays unavailable until Task 1.17.**

- **Billing** appears in the sidebar for `sales.invoice.read` (permission-derived, never from a role name) and opens the **Invoice List** (`GET /invoices`): number, date, customer, taxable value, GST, total, DEMO/Production badge and status; search, type and date filters, server-side paging, loading / empty / no-match / error states.
- **New invoice** (`sales.invoice.write`): keyboard-first customer and product search (real data), several lines, exact decimal-string quantities checked against the unit, optional percent or fixed line discount, read-only price (no override), services listed but refused with a reason, an unmissable DEMO banner, explicit place-of-supply confirmation (suggestion never auto-confirmed; billing/shipping mismatch needs an explicit pick), server preview with all totals, advisory stock warnings.
- **Staleness:** any edit after a preview disables Post until previewed again; `CALCULATION_STALE` at post shows the server's new totals and needs a second explicit Post (button becomes "Post with updated totals").
- **Posting:** one `operationId` per candidate request (reused for double clicks and retries, renewed on any edit); a lost answer shows "Retry posting" with the same entry and resolves to the same invoice and number. Success opens the **Invoice Detail**: an immutable, read-only snapshot with DEMO marking and no edit/delete/cancel controls.
- **API change (additive):** `InvoiceSummaryView` gained `taxableSubtotal` and `taxTotal` for the list. The web `ApiError` now keeps `details`.
- **Tests:** 11 real UI -> API -> PostgreSQL tests (navigation/permissions, compose and preview with no business writes, mixed price basis, split places of supply, post + snapshot + stock untouched + reopen, double click, lost response, stale calculation, preview-only user, expired session, log hygiene) and 10 model unit tests; the shell navigation tests follow Billing becoming a real link.
- **Visual review (real API, fictional data, 1000 and 1280 px):** list, New invoice with three lines and a discount, and the posted DEMO detail were inspected; no horizontal page scroll. The line table overflowed by 5 px at 1000 px and was tightened (shorter discount options, compact remove button).
- **Not built:** PDF/print, payments, credit notes, drafts, production activation, custom prices, invoice discount, charges.

## Task 1.13 results (sales invoice domain and posting transaction; see docs/PHASE_1_TASK_1_13_COMPLETION_REPORT.md, ADR-0024)

**Implementation approval only. R-040 stays open and passing these tests does NOT enable production billing: `PRODUCTION` is refused until Task 1.17 provides a verified backup/restore.**

- **Posted-only invoices (D1):** `sales_invoices` / `sales_invoice_lines` hold immutable POSTED invoices with full seller, customer, product, tax, place-of-supply snapshots and the calculation JSON. No drafts, no PATCH/PUT/DELETE; UPDATE, DELETE and TRUNCATE are refused by triggers.
- **API:** `POST /invoices/preview` (`sales.invoice.write`; writes nothing), `POST /invoices` (`sales.invoice.post`; 201 new, 200 replay), `GET /invoices`, `GET /invoices/:id` (`sales.invoice.read`). Requests carry choices only (mode, customer, products, quantities, discounts, place of supply, operation id, previewed calculation identity).
- **Posting transaction (D2):** lock on operation id -> replay -> reload -> validation -> TaxEngine recomputation -> stale comparison (`CALCULATION_STALE`) -> production stock -> number -> invoice -> audit `invoice.post` -> COMMIT with deferred constraints. Injected failures at every step roll everything back.
- **Mode (D6):** explicit `DEMO`/`PRODUCTION`. DEMO invoices use the `DEMO_INVOICE` sequence (`DEMO/{FY}/`), never touch the stock ledger, have no receivable and are excluded from `production_sales_invoices`. PRODUCTION posts one `SALES_DISPATCH` per tracked line (new movement type) and fails with `INSUFFICIENT_STOCK` rather than overselling.
- **Other decisions:** invoice date = today (Asia/Kolkata) only (D4); `MIXED_PRICE_BASIS` blocks mixed price bases (D5); the product price is authoritative (D9); idempotency by `(organization, operation id)` with `OPERATION_ID_REUSED`; place of supply needs an explicit user choice; receivable Option A (no table; Task 1.16 allocations).
- **Database (migration `20261026000000_task_1_13_sales_invoices`):** two tables, the widened movement vocabulary, DEMO twin sequences backfilled for existing organizations, deferred integrity triggers, the `production_sales_invoices` view. Setup now creates six sequences.
- **Tests:** 37 HTTP DEMO tests, 22 production / concurrency / failure-injection / invariant tests, 3 migration tests, 9 unit tests. Mutation checks (stale comparison, demo stock skip, post/read permission keys, immutability trigger, the three deferred integrity triggers) all killed (one permission survivor first, fixed by a role-without-post test).
- **Existing tests changed:** setup, numbering registry and the logical-dump table count follow the sixth sequence and the two new tables.
- **Deferred:** backdating (R-086), drafts, credit notes, returns, cancellation (R-088), custom prices, charges, invoice-level discount, services, export/SEZ, reverse charge, PDFs, payments (R-089).

## Task 1.12 results (TaxEngine and tax configuration review; see docs/PHASE_1_TASK_1_12_COMPLETION_REPORT.md, ADR-0023)

**Implementation approval only. Ruleset FUB-GST-1 and the jurisdiction table are NOT professionally approved: R-040 stays open, and passing these tests does NOT enable production billing.**

- **Pure TaxEngine** (`@commercebill/tax-engine`): `calculate()` takes validated facts and returns a calculation snapshot or machine-readable errors (engine 1.0.0, ruleset FUB-GST-1, rounding HALF_UP_PAISE_V1, a SHA-256 input hash, a step-by-step explanation per
  line, a per-line rounding adjustment). Scaled-BigInt arithmetic, half-up at four named rounding points, per-line calculation, independent CGST and SGST/UTGST, an explicit inclusive-price residual, invoice totals summing the lines, round-off default NONE. A source-scanning test
  keeps floating point out. Supported: domestic Goods, a regular GST-registered seller, a Tax Invoice, exclusive/inclusive prices, percent and fixed line discounts, standard / nil-rated / exempt / non-GST lines. Everything else (Services, composition or unregistered seller,
  Bill of Supply, zero-rated, export/SEZ, reverse charge, invoice discount, shipping/packing/other charges, cess, advances, TCS/TDS, unknown fields) is REJECTED with a code, never ignored.
- **Pure helpers:** `selectEffectiveRate` (exactly one rate or a failure), the configuration fingerprint, `reviewState`, `evaluateProductionGate`, `sellerConfigurationProblems`, and the versioned jurisdiction ruleset (UNREVIEWED) with `classifySupply`.
- **Place of supply** is a caller-supplied fact with a source (`SUGGESTED`, `USER_CONFIRMED`, `USER_OVERRIDE`): an explicit choice is required when billing and delivery states differ, a merely suggested value calculates but is `postable: false`, and a missing/invalid value blocks. Task 1.13 owns the invoice-time confirmation and snapshot.
- **Database (migration `20261025000000_task_1_12_tax_configuration`):** customer kind rename and GSTIN rule (refuses clearly and changes nothing if existing data violates it); tax rates cannot overlap and are immutable (only an open rate can be closed, once); categories keep code and classification and are never deleted;
  append-only `tax_configuration_reviews`; `hsn_sac_codes` organization-scoped and user-maintained.
- **Customer correction:** `customer_type` B2C/B2B became `customer_kind` INDIVIDUAL/BUSINESS, independent of GST registration; B2B/B2C is derived per invoice from a supplied recipient GSTIN; a GSTIN is required for REGISTERED and COMPOSITION. Customer screens, API filter (`kind`) and tests updated.
- **Review by fingerprint:** a SHA-256 over the rule-set versions, the jurisdiction table, every category and every rate. A review (reviewer, stated capacity, time, notice version/text, note, engine/ruleset/jurisdiction versions) is current only for exactly that fingerprint, so any change makes it stale and reverting restores it. Recording refuses a configuration that changed
  after it was shown. Three separate permissions: `tax.config.read`, `tax.config.update`, `tax.config.review` (Administrator only by default). The screens and the stored notice say that a review is NOT government verification or legal certification.
- **DEMO / PRODUCTION:** DEMO by default. Production needs a current review, a valid regular registered seller, an HSN/SAC policy and a verified backup/restore; the last is false until Task 1.17, so `POST /tax/billing-mode {PRODUCTION}` is always refused today (proved with an injected fact in tests).
- **HSN/SAC:** organization-scoped list the user types in (no catalogue bundled or invented): code, kind, description, active, origin, review status; list/search/create/edit/confirm; code and kind immutable; a product can use only its own organization's entry. Policy `hsnSacRequired = true` by default; turning it off needs
  `tax.config.update`, an acknowledgement and a reason, and is audited. No turnover-based digit validation.
- **API:** `GET /tax/configuration`, `GET|POST /tax/configuration/reviews`, `POST /tax/billing-mode`, `PUT /tax/hsn-requirement`, `GET|POST /tax/hsn-sac`, `PATCH /tax/hsn-sac/:id`, `POST /tax/hsn-sac/:id/review`. **UI:** Tax (configuration and review) and Tax > HSN/SAC codes.
- **Audit:** `tax.configuration.review`, `billing.mode.change`, `tax.hsn_requirement.change`, `hsn_sac.create|update|review` (facts only; no notes, capacities or descriptions). Logs carry none of that text.
- **Tests:** 46 engine tests (all approved worked examples, boundary dates, every rejected scenario, determinism and input hash, 3,000 seeded random invoices, source scan), 15 migration tests, 23 HTTP tests, 12 component tests, 11 real-UI tests. Mutation checks: 20 deliberate breaks (rounding, component rate, inclusive extraction,
  residual, discount and gross truncation, UTGST, place-of-supply rules, postable, rate window, boundary, fingerprint, gate, review/permission/organization scope, overlap trigger, append-only trigger, rate immutability) all killed (one first survived and needed a new rounding test); sources restored and verified identical.
- **Existing tests changed:** customer tests follow the new kind/GSTIN rules (composition now needs a GSTIN; registered individuals are valid; filter `kind`); product/HSN tests create organization-scoped entries; the reference-seed test closes the seeded open-ended rate before adding a future rate (overlap rule); the backup-spike table count 25 -> 26. No timeout raised; no threshold lowered.
- **Decisions to confirm:** the Administrator template alone holds `tax.config.review` (an accountant must be given it by an administrator); mode switching also needs `tax.config.review`; the tax rate rows are still entered through the database (no rate screen yet, DEF-15); order of reviews uses the database creation time.

## Task 1.11 results (inventory / stock ledger vertical slice; see docs/PHASE_1_TASK_1_11_COMPLETION_REPORT.md, ADR-0022)

- **Visible result:** the Inventory sidebar entry is real for users holding `inventory.stock.read`: a stock list (SKU, product, warehouse, on hand, unit, status; search, Active/Inactive/All, paging of 25; loading, empty, no-match, error),
  a product stock page (stock on hand and the immutable, server-paged movement history with separate Increase/Decrease columns), and for users holding `inventory.adjustment.create` three forms: **Opening stock**, **Manual stock receipt** (labelled as
  not a purchase: no supplier, bill or payment) and **Stock adjustment** (increase/decrease, required reason, a Current / Adjustment / Resulting preview that the server recomputes). Services and untracked goods are never listed and never receive stock.
  After creating a tracked product the Product hint "Stock can be added from Inventory" is now true.
- **Database (migration `20261024000000_task_1_11_inventory`):** append-only `stock_movements` (signed `numeric(18,4)`, type CHECK widenable by later migrations, business date, actor, `(organization, source type, source ref, source line ref)` unique idempotency identity) and
  `stock_balances` (a projection keyed by warehouse + product, CHECK `>= 0`). Triggers: ledger UPDATE/DELETE/TRUNCATE refused; balance written only by the ledger trigger; same-organization product and warehouse, tracked goods only, unit decimal places, opening stock only first;
  a product with stock keeps its unit and tracking. Tested on a clean database and a populated Task 1.10 database.
- **Policies recorded for Task 1.13 (ADR-0022):** negative stock is NOT allowed; an invoice line for a service or untracked goods creates NO stock movement; inventory posting is `postStockMovement(tx, ...)` inside the caller's transaction, idempotent by source identity (`SALES_INVOICE` + invoice id + line id).
- **Balance strategy:** projection maintained by a trigger in the same transaction, never editable, reconcilable against the ledger (`reconcileBalances`, tested including deliberate corruption).
- **API:** `GET /warehouses` (`warehouse.read`), `GET /inventory/stock`, `GET /inventory/movements`, `GET /inventory/movements/:id` (`inventory.stock.read`), `POST /inventory/opening-stock | receipts | adjustments` (`inventory.adjustment.create`, `operationId` required). No PATCH/PUT/DELETE of a movement.
  Role expectations come from the permission catalogue: Administrator and Warehouse Operator write; Accountant, Billing Operator and Viewer/Auditor read only.
- **Audit:** `inventory.opening_stock`, `inventory.receipt`, `inventory.adjustment` (movement id, product id, warehouse id, type, signed quantity, date, reason code; never reference or note). A replayed retry writes no second row.
- **Concurrency and idempotency (real PostgreSQL):** 40 parallel receipts add up exactly; two decreases of 4 from 5 give one success and stock 1 (5 rounds); 12 decreases of 1 from 5 give exactly 5 successes; 5 opening stocks give one; 10 identical retries give one movement; a lost answer followed by Save again changes stock once.
- **Tests:** 12 migration, 37 HTTP, 11 real-UI, 23 web component/model and 9 engine unit tests. Mutation checks: 16 deliberate breaks all killed; two first survived the HTTP/migration files - the unit-decimal-places break is killed by the engine unit test (the database rule gave the same refusal over HTTP), and the advisory-lock break needed a new two-connection database race test. Sources restored and verified identical.
- **Existing tests changed:** backup-spike table count 23 -> 25; reference-seed test asserts `stock_movements` and `stock_balances` stay empty; shell and Task 1.7 navigation tests count Inventory among built modules. No timeout was raised.
- **Product change:** the product service refuses a unit change or turning tracking off once stock exists (friendly problem codes, plus a trigger).
- **Decisions to confirm:** opening stock once per product and warehouse; adjustment reasons COUNT_CORRECTION / FOUND / DAMAGE / LOSS / OTHER (OTHER needs a note); a stock event may be dated at most one day ahead of UTC today; inactive products keep their stock and can be adjusted; no running-balance column (not correct from one page of history).

## Task 1.10 results (product master vertical slice; see docs/PHASE_1_TASK_1_10_COMPLETION_REPORT.md, ADR-0021)

- **Visible result:** the Products sidebar entry is real for users holding `product.read`: a product list (server-side search by SKU, name,
  barcode or HSN/SAC prefix; Active/Inactive/All, Goods/Services and Tracked/Not-tracked filters; paging of 25; loading, empty, no-match and error
  states), a New product form (Basic details, Classification, Tax, Pricing, Inventory settings), an Edit form, Deactivate / Reactivate with confirmation,
  and a read-only view for users without `product.write`. The price area says plainly whether the price "includes GST" or is "+ applicable GST" and
  echoes the rupee amount (Indian grouping); it shows NO GST amount and NO tax breakdown. Verified by component tests, tests that drive the real UI
  against the real API and PostgreSQL, and a visual review (empty list, populated list, goods form, service form, validation errors, edit, inactive, read-only,
  column widths at 1000, 1100 and 1280 px).
- **Database (migration `20261023000000_task_1_10_products`):** `products` (internal UUID key; per-organization stable `sku`; `kind` GOODS | SERVICE; name;
  description; HSN/SAC reference; unit reference; tax-category reference; `mrp` and `selling_price` as `numeric(18,2)`; `price_includes_tax`;
  `track_inventory`; barcode; active flag; timestamps; `version`) and `product_code_counters`. Rules in the database: sku/barcode formats, unique
  `(organization, sku)` and `(organization, barcode)`, non-negative prices, goods need a unit, a service can never track inventory, **no quantity or stock column**,
  a trigger that makes products **undeletable** and their id, organization, sku, kind and creation time **immutable**, and a trigger that only allows the
  organization's OWN unit and tax category and an HSN code for goods / SAC code for services. Tested on a clean database and on a populated Task 1.9 database
  (organization, user, location, customer, units and tax categories unchanged).
- **Money is exact:** prices are decimal strings end to end - browser form, API JSON, validation, `numeric(18,2)` column and display. No JavaScript number
  is used for money (a JSON number is accepted only through its exact text and anything inexact such as 0.1+0.2 is refused). A third decimal place is refused,
  never rounded. A value like 1234567890123456.78 survives the browser, the API and PostgreSQL. No "selling price <= MRP" rule is imposed.
- **Service (`@commercebill/products`):** pure validation shared with the UI (value-free problem codes), organization-scoped service, generated SKUs
  `PRD-000001...` (typed SKUs are upper-cased; generated ones skip taken numbers), optimistic concurrency by `version`, reference checks (another organization's
  unit or category looks exactly like an unknown id; a retired unit/category is refused for NEW use only), no-op edits change nothing, deactivation instead of deletion.
- **API (launch secret + `requireAuthenticatedUser` + `requirePermission`; organization from the session):** `GET /products`, `GET /products/:id`, `POST /products`,
  `PATCH /products/:id` (needs `expectedVersion`), `POST /products/:id/activate|deactivate`, plus the form's reference lookups `GET /products/references`
  (own-organization active units and tax categories, and the size of the HSN/SAC list) and `GET /products/references/hsn-sac`. Read = `product.read`, write =
  `product.write`; no DELETE; a stale version is 409 `DB_0002`; duplicate SKU/barcode is 409 `BIZ_0001`; other organizations' products are 404.
- **Audit:** `product.create`, `product.update`, `product.deactivate`, `product.activate`. Update rows list changed field NAMES; values are recorded only for
  price/MRP/price-basis/tracking/tax-category/unit/HSN-SAC identifiers/active flag (price traceability is the purpose of the audit, as recorded in the Task 1.10 criteria);
  names, descriptions and barcodes are never written to audit rows. Prices, names, barcodes and search terms never appear in the server logs (tested at trace level).
- **HSN/SAC reference list is EMPTY after seeding** (no reviewed data exists; the hsn_sac_codes table has never been populated). The product form says so
  and lets the product be saved without a code; when codes exist, the picker searches the real list on the server and sends only the chosen id. No code is invented.
  R-077 records that real HSN/SAC data needs a reviewed source.
- **Variants guard (ADR-0021):** no separate sellable-item table now. `products.id` IS the sellable-item identity that invoice lines and stock movements will reference;
  when variants arrive each existing product gets exactly one default variant whose id equals the product id, so posted lines and stock history stay valid.
- **Defect found by the new tests and fixed:** after a successful create the form released its submit lock before the page navigated away, so a very late second
  click could create a second record. The form (customers too) now stays locked until the page has gone (regression test added).
- **Second defect, found by an intermittent test failure (not raised by a timeout):** the Customers list reset its page in an effect that could run AFTER a click on
  Next and silently undo it (the new Products list had copied it). Both lists now reset the page during render when the search term changes, with a regression test; 12 of 12
  repeat runs of both real-UI test files passed afterwards. A Task 1.8 wizard test that asserted keyboard focus before the focusing effect ran now waits for it. No timeout was raised.
- **Tests:** +48 unit net and +51 integration tests (see report). Mutation checks (ten breaks, see report) each failed at least one test; sources restored and verified identical.
- **Existing tests changed:** backup-spike table count 21 -> 23; the reference-seed test now asserts the `products` table stays EMPTY after seeding; two shell/Task 1.7
  navigation tests count Products among the built modules.

## Task 1.9 results (customer master vertical slice; see docs/PHASE_1_TASK_1_9_COMPLETION_REPORT.md, ADR-0020)

- **Visible result:** the Customers sidebar entry is now real for users holding `customer.read`: a customer list (server-side search,
  Active/Inactive/All and B2B/B2C filters, paging of 25), a New customer form (sections: Basic details, Tax details, Billing address,
  Shipping address, Contact, Other details), an Edit form, Deactivate / Reactivate with confirmation, a read-only view for users without
  `customer.write`, and loading, empty, no-match and error states. Verified by component tests, tests that drive the real UI against the
  real API and PostgreSQL, and a visual review (list with records, empty state, B2B registered form with validation errors, B2C form, edit,
  inactive customer).
- **Database (migration `20261022000000_task_1_9_customers`):** `customers` (internal UUID key; stable per-organization `code`; type B2C/B2B;
  names; contact; GST status and GSTIN; PAN; billing address with GST state code; shipping address held only when different from billing;
  place-of-supply state code as a stored fact for Task 1.12; credit limit; payment terms; notes; active flag; timestamps; `version`) and
  `customer_code_counters`. Database rules: code format, unique `(organization, code)`, one GSTIN per organization (partial unique index),
  GSTIN required for registered / forbidden for unregistered, B2C must be unregistered, GSTIN/PAN/state/PIN/country formats, non-negative credit limit,
  payment terms 0-365, shipping-column consistency, and a trigger that makes customers **undeletable** and their id, organization, code and creation time
  **immutable**. Tested on a clean database and on a populated Task 1.8 database (existing rows unchanged), including every constraint.
- **Service (`@commercebill/customers`):** pure validation shared with the UI (same rules, value-free problem codes), organization-scoped service,
  generated codes `CUS-000001...` from a locked per-organization counter (a hand-typed code is also accepted, upper-cased; generated codes skip taken numbers;
  concurrent creations get distinct codes), optimistic concurrency by `version`, no-op edits change nothing, deactivation instead of deletion.
- **API (behind the launch secret, `requireAuthenticatedUser` + `requirePermission`; organization from the session):** `GET /customers`,
  `GET /customers/:id`, `POST /customers`, `PATCH /customers/:id` (needs `expectedVersion`), `POST /customers/:id/activate|deactivate`. Read =
  `customer.read`, write = `customer.write`. There is no DELETE. A stale version is 409 `DB_0002`; duplicate code/GSTIN is 409 `BIZ_0001` with a field problem;
  other organizations' customers are 404.
- **Audit:** `customer.create`, `customer.update`, `customer.deactivate`, `customer.activate` (category business, actor, organization, customer id,
  correlation id). Update rows list the changed field NAMES and only non-personal values (type, GST status, payment terms, credit limit, flags); names,
  phones, e-mail, addresses, GSTIN, PAN and notes are never written to the audit log.
- **Logging fix found by this task:** the API logged full URLs, so a customer search by phone, e-mail or GSTIN would have put personal data in the logs.
  The request logger now writes the path only (`?[query redacted]`). Tested at trace level.
- **Search bug found by tests and fixed:** `%` and `_` typed into search acted as wildcards (a search for `%` returned every customer). They are now escaped
  and matched literally (a customer named `Fifty%Off Traders` is found by `Fifty%Off`).
- **GST scope kept separate from tax:** the customer records GST status, GSTIN, billing/shipping state and place of supply as facts; no tax is
  calculated (Task 1.12). A GSTIN is checked for FORMAT and check character and for consistency with the billing state and PAN; **no portal check is made
  and nothing claims a GSTIN belongs to a real business** (the form says so). R-040 and R-053 stay open.
- **Tests:** +41 unit net, +9 migration tests, +30 HTTP API tests (authorization by role template, isolation, concurrency, audit, logs) and +10 real-UI tests.
  Mutation checks (see report) each failed at least one test; sources restored and verified identical.
- **Existing tests changed:** the backup-spike table count 19 -> 21; three shell navigation tests now treat Customers as a real link (Billing is used for the
  "Coming soon" assertions); the fake API helper records query strings; the test `call` helper accepts PATCH; the reference-seed test now asserts that the `customers` table stays EMPTY after seeding (it used to assert the table did not exist); the Task 1.7 real-API test expects four "Coming soon" entries; the unit-test timeout is 15 s (see the completion report).

## Task 1.8 results (first-run setup wizard UI; see docs/PHASE_1_TASK_1_8_COMPLETION_REPORT.md, ADR-0019)

- **Visible result:** a fresh installation opens an 8-step setup wizard (Welcome, Business details, Address & location,
  GST registration, Financial year, Invoice numbering, Administrator, Review & complete). Completing it returns to the sign-in
  page with the administrator's username filled in and **no session**; a configured installation shows sign-in and can never
  reopen the wizard. Verified by component tests, tests that drive the real UI against the real API and a real empty PostgreSQL
  database, the real Electron smoke start, and a visual review of Welcome, Business, Address, GST, Invoice numbering,
  Administrator (with a validation error), Review and the success -> sign-in transition.
- **No backend redesign.** The wizard uses only the existing Task 1.4/1.5 endpoints (`GET/PUT /setup/draft`, `GET /setup/status`,
  atomic `POST /setup/complete`). Two browser-safe subpath exports were added (`@commercebill/setup/browser`,
  `@commercebill/numbering/browser`) so the UI reuses the server's own validators, state-code list and number formatter.
- **Fields reconciled against the API - nothing is collected that the server would discard.** Supported and shown: legal name,
  trade name, business type, PAN, state, GST status and GSTIN, location name and address lines, city, PIN, warehouse name/code,
  financial-year start, invoice prefix / first number / width, administrator name, username, email, password.
  **Master-spec setup fields NOT supported by the backend and therefore NOT collected (deferred, see REQUIREMENTS_MATRIX DEF-11):**
  business phone, email and website; country (India shown as fixed text, not stored); a separate "default place of supply"
  (it is the business state); bank name / account name / account number / IFSC / UPI ID; backup destination; other
  document-type prefixes and per-document starting numbers (standard defaults apply); an editable reset policy (always
  per financial year). The review page and Welcome page say so plainly. No backup is claimed to be active (Task 1.17).
- **Draft/resume:** non-secret fields are saved after each Continue/Back, serialised in order so quick clicks cannot collide or
  overwrite newer data; Resume restores fields and lands on the first step needing attention (the Administrator step, because
  the password is never saved); Start Over needs confirmation; a corrupted draft is reported as discarded by the existing backend.
- **Password handling:** kept only in memory while the Administrator/Review steps exist; never in the draft, storage, URL, logs, audit,
  the review page or the DOM outside the active inputs; a password the server rejects is dropped.
- **Tax notice:** the GST step states that tax configuration should be reviewed before real use and that the installed rates are
  placeholders, not government-verified. **R-040 stays OPEN.**
- **Tests:** +48 unit net and +7 real-API integration tests (see report). Mutation checks (password in draft, restored password,
  GSTIN rule removed, auto-login after setup, password shown on review, Start Over without confirmation, preview contacting the
  server) each failed at least one test; the submit-lock mutation is equivalent because the Complete button is disabled while
  submitting (the lock is belt and braces). Sources restored and verified identical.
- **Existing tests changed:** the placeholder "Setup required" page is replaced by the wizard, so the Electron smoke test, the Task 1.7
  real-API test and one shell test now expect the wizard heading ("CommerceBill setup"). A timer test is given a 5-second
  async timeout because it failed once under whole-suite load (it passes alone, three times).

## Task 1.7 results (application shell + login UI; see docs/PHASE_1_TASK_1_7_COMPLETION_REPORT.md, ADR-0018)

- **Visible result:** launching CommerceBill on a configured database now shows a real sign-in page (not the Phase 0
  status page); after sign-in the shell and dashboard appear. Verified three ways: component tests, a jsdom DOM test
  against the real Fastify API and a real PostgreSQL database, and the real Electron smoke test (first screen is chosen
  from a launch-secret-protected call). The screens were also viewed in a browser against a throwaway API.
- **Implemented:** HashRouter navigation; real API client (`apps/web/src/api.ts`); `/setup/status` launch check
  ("Setup required" placeholder - the wizard is Task 1.8 - and "CommerceBill is not ready" with retry); login with one
  generic failure message, client-side lockout feedback, 429 and unreachable-service wording; forced password change
  (`AUTH_0004`) as the only reachable screen until done; voluntary change from the header; sign-out (revokes the session);
  expired/ended session handling (absolute expiry, idle timeout with keep-alive while the user is active, 401 on any
  request); permission-driven sidebar (Dashboard, Customers, Products, Inventory, Billing, Settings); dashboard with real
  account, organization, role, session and live service-status data only.
- **Session security:** the token lives only in a React ref (memory): never in localStorage, sessionStorage, the URL, the
  DOM or logs (asserted by tests, including against the real token). The launch secret stays a separate header supplied by
  the Electron bridge on every call.
- **Reusable primitives:** new `@commercebill/ui` package: Button, TextInput, PasswordInput, Alert, Card, PageHeader,
  Spinner/LoadingState, EmptyState, AppHeader/Sidebar/AppShell (skip link, focus-visible styles, aria attributes).
- **Backend change (small, justified by the UI):** `GET /auth/me` also returns `organizationName` and `roles` (display only).
- **Existing test changed:** the Electron smoke probe now reads the first screen heading instead of the Phase 0
  status-panel test ids (the status page is no longer the home screen). The assertions about the secret, the loopback URL,
  authorised/unauthorised calls and secret non-disclosure are unchanged.
- **Dependency added:** `react-router` 8.4.0 (npm audit: 0 vulnerabilities). Coverage now also measures `.tsx` files.
- **Tests:** +44 unit net (new UI-primitive, API-client and shell/auth/navigation/session tests; the three old App tests moved into the shell test file) and +12 DOM-against-real-API
  integration tests. Mutation checks (unfiltered navigation, removed forced-change gate, token written to localStorage,
  removed lockout hint, removed in-flight-session guard, ignored expiry) each failed at least one test; sources restored and
  verified identical. One real defect was found by the tests and fixed: a keep-alive response arriving after sign-out could
  have resurrected the session.

## Approved Phase 1 roadmap: FIRST USABLE BILLING (approved 2026-10-19)

**Milestone:** from the real Windows/Electron UI: start the app, complete first-run setup, create the administrator, log
in, see the shell/dashboard, create a customer and a tracked product, confirm GST information, receive opening stock,
create a sales invoice, calculate GST with the approved TaxEngine, post it, receive a permanent number (Task 1.5
engine), reduce stock, hold the receivable state, produce an A4 invoice, print/export it as PDF, record full or
partial payment, see the remaining customer balance, and close and reopen the application without losing anything.
**The milestone is not complete until Task 1.18 passes.**

| Task | Vertical slice                                                                                                                                                          | Class                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1.7  | Application shell + login UI (router, API client, `/setup/status` gate, login, lockout feedback, forced password change, permission-driven navigation, dashboard shell) | BLOCKER                                            |
| 1.8  | Setup wizard UI                                                                                                                                                         | BLOCKER                                            |
| 1.9  | Customer master vertical slice (database, service, API, permission, organization scope, validation, audit, UI, tests)                                                   | BLOCKER                                            |
| 1.10 | Product master vertical slice                                                                                                                                           | BLOCKER                                            |
| 1.11 | Inventory / stock ledger vertical slice (done 2026-10-20)                                                                                                               | BLOCKER                                            |
| 1.12 | TaxEngine + GST configuration/review. (done 2026-10-20) **A short read-only TaxEngine design must be reviewed BEFORE any tax calculation is implemented**               | BLOCKER                                            |
| 1.13 | Sales invoice domain + API                                                                                                                                              | BLOCKER                                            |
| 1.14 | Billing UI + invoice preview/posting                                                                                                                                    | BLOCKER                                            |
| 1.15 | A4 invoice PDF + print                                                                                                                                                  | BLOCKER                                            |
| 1.16 | Payments + receivables                                                                                                                                                  | BLOCKER                                            |
| 1.17 | Production backup + verified restore (done 2026-10-21)                                                                                                                  | BLOCKER (moved before the final E2E by decision D) |
| 1.18 | Dashboard basics + FIRST USABLE BILLING Electron E2E                                                                                                                    | BLOCKER                                            |

Decisions recorded (all approved 2026-10-19):

- **A - TaxEngine:** the Task 1.12 design must cover at least place of supply, intra-state CGST+SGST, inter-state IGST,
  inclusive and exclusive pricing, discounts, additional/shipping charges, HSN/SAC association, nil-rated, exempt, non-GST,
  cess extensibility, decimal precision, rounding, effective-dated rates and historical tax snapshots. **R-040 stays open
  until the tax reference/rate data has had independent professional review; passing tests does not close it.**
- **B - Receivable state:** receivables are `invoice total - allocated payments = outstanding balance`, held in
  immutable invoice / payment / allocation records that Phase 2 accounting will later use as its source. **The Phase 2
  double-entry journal engine is NOT part of this milestone.**
- **C - Permission-denial audit:** deferred. The Audit Read API and the permission-denial audit-table feature are not
  built before FIRST USABLE BILLING; R-063 stays open. Required business/security audit events keep being written with
  the existing audit architecture.
- **D - Backup:** production backup and verified restore (Task 1.17) happen before the final E2E (Task 1.18).
- **Do not use real business financial records before backup/restore is verified AND R-040 reference data has been
  independently reviewed.**

Deferred (kept in REQUIREMENTS_MATRIX, status Deferred with the intended milestone): audit-log read API/filters/browsing
(after Task 1.18), permission-denial audit rows (after Task 1.18, R-063), advanced user-management UI, role/permission
editing, product variants (Phase 1 exit item; the invoice and stock lines reference a "sellable item" so variants can be
added later), manual sales orders, credit notes/returns, customer statements, GST sales reports, CSV import/export
(Phase 1 exit items after Task 1.18), scheduled backup and advanced backup UI, multi-warehouse UI beyond one default,
and everything in Phases 2-5 (purchasing, full accounting reports, marketplaces, e-invoice, e-way bill, advanced
dashboards, template designer).

## Exact next task

**Phase 1, Task 1.18 - Dashboard basics and the FIRST USABLE BILLING Electron end-to-end check** (needs approval; not started). It completes the approved milestone. Acceptance criteria:

1. **Dashboard basics:** the dashboard shows real, server-derived facts only (no invented figures): invoices posted today and this month with totals, outstanding receivables total, the number of customers with a balance, low or negative stock count, the date of the last backup and whether it is verified, and the DEMO or PRODUCTION mode. Every figure comes from existing records (invoices, payments, receivables view, stock balances, backup records); DEMO and production are never added together; empty states are explained; permission-driven (a user sees only what their permissions allow).
2. **The milestone path, driven through the real UI in the real Electron application** (unpackaged, built bundles served from `app://`, real API, real PostgreSQL, fictional data): start the app on an empty database; complete first-run setup and create the administrator; sign in; see the shell and dashboard; create a customer; create a tracked product; confirm the GST information (seller registration, tax review, HSN/SAC policy); receive opening stock; create a sales invoice; calculate GST with the TaxEngine; post it and receive a permanent number; see stock reduced; see the receivable; open the A4 preview; save the PDF; print (dialogs replaced by hooks); record a partial payment and then the final payment; see the remaining balance fall to nil; create and verify a backup (Task 1.17); close and reopen the application and find everything intact (customer, product, stock, invoice, number, payments, balances, backup history, verification).
3. **Both modes:** the whole path runs in DEMO mode; a second run switches to PRODUCTION only after the production gate is genuinely met (reviewed tax configuration, valid seller registration, HSN/SAC policy, verified backup), using NO injected gate seam, and proves that a production invoice and payment can be issued, numbered, backed up, verified and restored. The tax data used must be marked as fictional test data; R-040 stays open and the report must say that real business use still needs independent professional review of the tax rates.
4. **Restore proof inside the milestone:** after the production run, a backup is restored into the application (active restore) and the invoice, its number, the payment and the balance are checked identical; numbering continues without a gap or reuse.
5. **Reopen and failure checks:** close and reopen after each major step group; a forced close during a backup leaves the live data usable and no partial backup file listed as good; a wrong passphrase, a wrong folder and a refused production switch all show plain messages.
6. **Documentation and defects:** a first-usable user walkthrough in BILLING_USER_GUIDE and ADMIN_GUIDE (including the daily backup routine); every defect found is fixed with a regression test or recorded as a risk; the remaining manual installer checks (native dialogs, a real printer, a real removable drive, the packaged installer) are listed explicitly in the report as NOT done.
7. **Tests and gates:** the E2E is an automated test in the integration project; `npm run verify:phase0` passes on the final committed tree; coverage thresholds (80/70/80/80) and the test timeouts are not weakened.
8. **Out of scope:** the Phase 2 double-entry journal engine, credit notes and returns, customer statements, GST reports, CSV import/export, purchases, scheduled backups, cloud storage, the installer/packaging (Phase 6), and any claim that the product is ready for real business use.
