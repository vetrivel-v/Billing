# Project State

Last updated: 2026-10-19 (after Phase 1 Task 1.9). This file and the repository are the implementation record (spec section 44).

| Item                      | Value                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application version       | 0.0.1 (pre-release)                                                                                                                                                                                                                                                                                                                             |
| Current phase             | **Phase 1 in progress: Tasks 1.0-1.9 complete; Task 1.10 not started**                                                                                                                                                                                                                                                                          |
| Current database version  | `20261022000000_task_1_9_customers` (21 tables: Task 1.9 added `customers` and `customer_code_counters`)                                                                                                                                                                                                                                        |
| Last successful migration | `20261022000000_task_1_9_customers` - applied to clean databases by every integration file and to a populated Task 1.8 database by its migration test, 2026-10-19                                                                                                                                                                               |
| Last successful build     | 2026-10-19 - `npm run build` (api, web, desktop) PASS                                                                                                                                                                                                                                                                                           |
| Last successful test run  | 2026-10-19 - `npm run verify:phase0` all 8 gates PASS; 384 unit + 344 integration tests (728) passed; coverage 95.7% statements / 91.3% branches / 97.4% functions / 97.2% lines (thresholds 80/70/80/80 unchanged); npm audit 0 vulnerabilities                                                                                                |
| Git                       | Branch `main`; Phase 0 = `40bfecd`; Task 1.0 = `e56bf6d`; governance docs = `8e81d9e`; Task 1.1 = `4bcccdc`; Task 1.2 = `963ebf9`; Task 1.3 = `94bb7e9`; Task 1.4 = `800e2f7`; Task 1.5 = `9dbfd55`; Task 1.6 = `d23ab67`; Task 1.7 = `2ee0a11`; Task 1.8 = `7cdc2a7`; Task 1.9 = the commit following it (see `git log`); no remote configured |
| Release status            | Not releasable. No product functionality exists                                                                                                                                                                                                                                                                                                 |

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
| 1.11 | Inventory / stock ledger vertical slice                                                                                                                                 | BLOCKER                                            |
| 1.12 | TaxEngine + GST configuration/review. **A short read-only TaxEngine design must be reviewed BEFORE any tax calculation is implemented**                                 | BLOCKER                                            |
| 1.13 | Sales invoice domain + API                                                                                                                                              | BLOCKER                                            |
| 1.14 | Billing UI + invoice preview/posting                                                                                                                                    | BLOCKER                                            |
| 1.15 | A4 invoice PDF + print                                                                                                                                                  | BLOCKER                                            |
| 1.16 | Payments + receivables                                                                                                                                                  | BLOCKER                                            |
| 1.17 | Production backup + verified restore                                                                                                                                    | BLOCKER (moved before the final E2E by decision D) |
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

**Phase 1, Task 1.10 - Product master vertical slice** (see "Approved Phase 1 roadmap"). Proposed scope and acceptance criteria; not started - do not
begin without approval. It follows the Task 1.9 pattern exactly (database -> migration -> service -> validation -> API -> authorization -> organization
isolation -> audit -> UI -> tests -> visual review).

1. **Database / migration:** `products` (internal UUID key; stable per-organization `sku` code, generated `PRD-000001` by default or typed; name; description;
   kind GOODS or SERVICE; HSN/SAC code text validated against the existing `hsn_sac_codes` reference (HSN for goods, SAC for services); unit of measure by reference to
   the organization's `units`; default `tax_category` reference to the organization's `tax_categories`; selling price (decimal, 2 places) and a "price includes tax" flag;
   `track_inventory` flag (only GOODS); barcode optional; active flag; timestamps; `version`). DB rules: sku format and per-organization uniqueness, price >= 0,
   SERVICE cannot track inventory, trigger making products undeletable with immutable id/organization/sku, `(organization, barcode)` unique where present.
   Purchase cost, margin, variants, price lists, images, categories/brands and e-commerce identifiers are deferred and recorded in the matrix (DEF-04 variants stays).
   Design guard: invoice and stock lines will reference a "sellable item" so variants can be added later. Migration test on a clean database and on a populated
   Task 1.9 database (customers and setup data unchanged).
2. **API (launch secret + session + exact keys):** `GET /products` (search by sku/name/barcode/HSN, filters kind/active/tracked, paging <= 100), `GET /products/:id`,
   `POST /products`, `PATCH /products/:id` (`expectedVersion`), `POST /products/:id/activate|deactivate`; read = `product.read`, write = `product.write`; no DELETE;
   organization from the session; value-free problems; 409 `DB_0002` on a stale version, 409 `BIZ_0001` on duplicate sku/barcode; **cost and margin fields are
   not exposed** (`product.cost.read` / `product.margin.read` unused until a cost field exists).
3. **Audit:** `product.create`, `product.update` (changed field names; price changes record before/after price), `product.deactivate`, `product.activate`; request-log query
   redaction already in place.
4. **UI (real API, no mock data):** the Products sidebar entry for `product.read`; list with search, filters and paging; new/edit form (Basic details, Classification
   and tax: HSN/SAC lookup against the reference list, unit, default tax category with the R-040 notice that rates are unreviewed placeholders, Pricing, Inventory tracking
   flag); deactivate/reactivate; read-only view without `product.write`; loading, empty, no-match, error states; stock figures are NOT shown (Task 1.11).
5. **Acceptance tests:** every Task 1.9 test category for products (create goods and service, validation incl. HSN/SAC kind and tracked-service refusal, sku uniqueness per
   organization, pagination, search, edit, deactivate/reactivate, optimistic-concurrency conflict, 401/403 per role template, organization isolation list/read/edit,
   audit rows without unnecessary data, logs); real-UI create/edit/search/close-and-reopen tests; visual review; all gates green, thresholds unchanged.
6. **Out of scope:** inventory quantities and movements (Task 1.11), tax calculation (Task 1.12), invoices, variants, price lists, CSV import/export, images.
