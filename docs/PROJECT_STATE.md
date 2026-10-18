# Project State

Last updated: 2026-10-18 (after Phase 1 Task 1.1). This file and the repository are the implementation record (spec section 44).

| Item                      | Value                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application version       | 0.0.1 (pre-release)                                                                                                                                                                   |
| Current phase             | **Phase 1 in progress: Tasks 1.0 and 1.1 complete; Task 1.2 not started**                                                                                                             |
| Current database version  | `20261017000000_task_1_1_tax_reference_markers` (18 tables; Task 1.1 added review/effective-date columns to tax_categories and tax_rates)                                             |
| Last successful migration | `20261017000000_task_1_1_tax_reference_markers` - applied to clean databases by every integration file and to a populated previous-version database by the migration test, 2026-10-18 |
| Last successful build     | 2026-10-18 - `npm run build` (api, web, desktop) PASS                                                                                                                                 |
| Last successful test run  | 2026-10-18 - `npm run verify:phase0` all 8 gates PASS; 52 unit + 45 integration tests (97) passed; coverage 99.0% statements / 96.8% branches; npm audit 0 vulnerabilities            |
| Git                       | Branch `main`; Phase 0 = `40bfecd`; Task 1.0 = `e56bf6d`; governance docs = `8e81d9e`; Task 1.1 = the commit following `8e81d9e` (see `git log`); no remote configured                |
| Release status            | Not releasable. No product functionality exists                                                                                                                                       |

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

## Carried-forward obligations (from Task 1.0; still open after Task 1.1)

| ID         | Obligation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Must be done by                                                                                                                                                                        | Tracked in                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| P1-SEC-01  | **Wire the launch secret into Electron**: main process generates 32 random bytes per launch, passes `LAUNCH_SECRET` to the API via environment only, preload exposes a validated method for the renderer to obtain it, web client sends `x-commercebill-launch-secret`; production mode must refuse to start without it; add an end-to-end test shell -> API -> authorised call and unauthorised call rejected. The API guard exists and is unit-tested but **nothing sets or sends the secret today** | **Before any data-bearing API route is exposed** (i.e. in the same task as, or before, the first authenticated endpoint; target: the shell/API integration task that follows Task 1.1) | REQUIREMENTS_MATRIX P1-SEC-01; ADR-0010; R-032, R-037        |
| P1-BKP-01  | Production backup/restore module (streaming COPY, AES-256-GCM encryption, attachments, config, retention, verification workflow, restore wizard). The Task 1.0 logical-dump code is an **experimental spike, not production backup functionality**                                                                                                                                                                                                                                                     | Phase 1 backup task (before Phase 1 exit)                                                                                                                                              | REQUIREMENTS_MATRIX P1-BKP-01; ADR-0009; R-011, R-031, R-036 |
| P1-AUTH-01 | Password service using Argon2id with tuned cost (current spike parameters are the OWASP floor, ~17-20 ms), session tokens, lockout, RBAC enforcement                                                                                                                                                                                                                                                                                                                                                   | Phase 1 authentication task                                                                                                                                                            | REQUIREMENTS_MATRIX P1-AUTH-01; ADR-0011; R-033, R-038       |
| P6-ENC-01  | Production PostgreSQL initialisation must use `--encoding=UTF8` (dev/test already do)                                                                                                                                                                                                                                                                                                                                                                                                                  | Phase 6 packaging                                                                                                                                                                      | REQUIREMENTS_MATRIX P6-ENC-01; R-035                         |

## Known limitations

- **The backup code under tests/recovery/spikes is an experimental spike (in-memory, unencrypted, same schema version only). No production backup or restore exists.**
- **The API launch-secret guard is not wired into Electron**: neither the shell nor the web client sets or sends the secret (P1-SEC-01). With no `LAUNCH_SECRET` configured the guard is off.
- No password-hashing service, sessions or authorisation exist; Argon2id was only proven loadable.
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

**Phase 1, Task 1.2 - Electron shell supervises the API and supplies the launch secret (requirement P1-SEC-01).**
Proposed scope (not started; do not begin without approval):

1. The Electron main process generates 32 random bytes per launch, starts the built API bundle as a child
   process on 127.0.0.1 passing `LAUNCH_SECRET` (and the other validated env values) **through the environment
   only**, waits for `/health`, and stops the child on quit. The secret is never written to disk, argv or logs.
2. The preload exposes one new method (e.g. `getApiAccess()`) returning only the API base URL and the secret;
   it accepts no arguments and is covered by a security test; `DesktopBridge` type updated.
3. The web client sends `x-commercebill-launch-secret` on every API call (except `/health`) and shows a clear
   state when the API is unreachable or rejects the secret.
4. Env validation refuses to start the API in `NODE_ENV=production` without `LAUNCH_SECRET` (unit test).
5. Automated test (Electron smoke, extending `ELECTRON_SMOKE`): the renderer's authorised call to
   `/health/db` succeeds; the same call without the secret returns 401 `AUTH_0001`; the secret value does not
   appear in the API's log output.
6. All existing tests still pass: `npm run verify:phase0` (52 unit + 45 integration baseline, none weakened,
   gate-integrity checks intact); coverage thresholds unchanged and met.
7. No new data-bearing API route, authentication UI, session logic, backup code or business feature is added.
8. PROJECT_STATE, REQUIREMENTS_MATRIX (P1-SEC-01 -> Tested), RISK_REGISTER (R-032/R-037) updated; Task 1.2
   completion report written; ADR-0010 status updated to "implemented and wired".

Other open Phase 1 work, in no committed order: P1-AUTH-01 (password service, sessions, RBAC enforcement),
setup wizard, P1-BKP-01 (production backup), numbering service, tax engine, customers/products/inventory,
invoicing, PDF, payments, reports, import/export.
