# Phase 1 - Task 1.1 Completion Report: Reference Seed

Dates: 2026-10-17 to 2026-10-18 · Node v24.16.0. Scope: approved Task 1.1 only. Task 1.2 was not started.

## Scope and acceptance criteria (as approved)

1. `reference` seed inserts permission catalogue, five role templates with grants, default units, and
   effective-dated tax categories/rates for an existing organization - **met** (T11-01).
2. Idempotent, no delete-and-recreate - **met** (T11-02).
3. One transaction; a failure part-way leaves nothing - **met** (T11-03).
4. Role/permission matrix per spec section 11, tested by stable keys - **met** (T11-04).
5. Exact decimals, effective dating, explicit accountant-review marking, history preserved - **met** (T11-05).
6. Stable unique unit codes; no demo data; `demo` is a no-op - **met** (T11-06, T11-07).
7. Integration tests cover 1-6; `verify:phase0` still passes - **met**.

## What was built

| Area      | Result                                                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seed      | `prisma/seed/reference/{permissions,roles,units-and-tax,index}.ts`; CLI `prisma/seed/seed.ts` (`reference [--organization <uuid>]`, `demo`). 70 permissions; 5 roles with 162 grants (Administrator 70, Accountant 42, Billing Operator 14, Warehouse Operator 12, Viewer/Auditor 24); 13 units; 8 tax categories; 8 tax rates  |
| Mechanism | One `prisma.$transaction`; `createMany(skipDuplicates)` = `ON CONFLICT DO NOTHING`; existing rows never updated or deleted; unknown organization rejected before any insert                                                                                                                                                     |
| Migration | `20261017000000_task_1_1_tax_reference_markers` (forward-only): `origin`, `review_status`, `review_note` on `tax_categories` and `tax_rates`; `effective_from`/`effective_to` on `tax_categories`; CHECK constraints. Existing rows get safe defaults. Prisma drift check against the migrated dev DB: "No difference detected" |
| ADR       | ADR-0012 (seed semantics, role matrix, `sales.document.delete_posted` reserved key, tax placeholders)                                                                                                                                                                                                                           |

Tax rows are **placeholders**: `origin=REFERENCE_SEED`, `review_status=UNREVIEWED`, note "not a guaranteed current
statutory rate ... must be reviewed by an authorized accountant or tax professional". The 0/5/12/18/28 slab set is
structural and may not match rates in force today.

## Defect found: false PASS from the integration gate (R-039)

My first full `verify:phase0` run printed **PASS** for the integration gate while the log showed
`1 failed | 44 passed`. The failing test was a Task 1.0 assertion that hard-coded the schema version
`20261016000000_phase0_foundation`, which became stale when the new migration was added. Investigation:

- `npm run test:integration` exited **0** with a failing test; unit runs and an empty `globalSetup` exited 1
  correctly. After our cluster teardown `process.exitCode` was still 1, yet the process exited 0. Not caused by
  `rmSync`. Root cause not isolated.
- Fixes: (a) `tests/integration/global-setup.ts` re-asserts the failing exit code at process exit; (b)
  `scripts/verify-phase0.ts` cross-checks the Vitest JSON report for the unit and integration gates (missing
  report, zero tests or any failure fails the gate); (c) the stale assertion now derives the newest migration
  directory name.
- Negative control: a temporary failing integration test gave npm exit 1 and JSON `failed=1, success=false`
  (temporary file removed).
- Assessment of earlier reports: the Phase 0 and Task 1.0 verification logs listed explicit all-passed counts
  with no failures, so their results stand; no earlier run is known to have hidden a failure.

## Tests

| Suite                                    | Before | After                                     |
| ---------------------------------------- | ------ | ----------------------------------------- |
| Unit (`npm test`)                        | 47     | **52** (+5 catalogue checks)              |
| Integration (`npm run test:integration`) | 16     | **45** (+26 reference seed, +3 migration) |
| Total                                    | 63     | **97**                                    |

Task 1.1 tests: `tests/unit/reference-catalogue.test.ts` (5), `tests/integration/reference-seed.int.test.ts`
(26: inserts 2, idempotency 3, transaction safety 7 incl. failure after each of six steps, role matrix 7, tax and
units 4, reference-vs-demo and CLI 3), `tests/migration/tax-reference-markers.int.test.ts` (3: populated
previous-version upgrade, constraint enforcement, forward-only). Mutation check: deliberately broken role grants
(cost to Warehouse, period-unlock to Billing, export to Viewer, ...) were caught by 4 tests; the Accountant
mutation was neutralised by the template's own `security.` exclusion, not by a test gap. Source restored and
verified identical afterwards.

## Commands executed and actual results

| Command                                                                                  | Result                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma format`, `migrate diff --from-config-datasource --to-schema`                     | produced the column SQL; after applying: "No difference detected"                                                                                                                                                             |
| `npm run typecheck`, `npx eslint .`                                                      | no errors                                                                                                                                                                                                                     |
| `npx vitest run tests/unit tests/migration tests/integration/reference-seed.int.test.ts` | 3 files, 34 tests passed                                                                                                                                                                                                      |
| `npm run verify:phase0` (run 1)                                                          | exit 0 but integration log showed 1 failed (false PASS, see above)                                                                                                                                                            |
| negative control (temporary failing test)                                                | npm exit 1; JSON `failed=1`                                                                                                                                                                                                   |
| `npm run verify:phase0` (run 2, final code)                                              | exit 0; all 8 gates PASS: Prisma schema valid, client generated, Type-check, Lint, Format check, Unit tests (10 files / 52 tests), Integration tests (5 files / 45 tests), Build                                              |
| `npx vitest run --coverage`                                                              | 15 files, 97 tests passed; Statements 99% (99/100), Branches 96.77% (60/62), Functions 100%, Lines 98.87%; thresholds unchanged and met (seed code lives under `prisma/` and is outside the coverage include list, as before) |
| `npm audit`                                                                              | found 0 vulnerabilities                                                                                                                                                                                                       |
| `npm run db:seed -- demo`                                                                | prints the no-op message, exit 0                                                                                                                                                                                              |

No end-to-end (Playwright) tests exist; none were applicable to Task 1.1.

## Files

Created: `prisma/migrations/20261017000000_task_1_1_tax_reference_markers/migration.sql`,
`prisma/seed/reference/{index,permissions,roles,units-and-tax}.ts`, `tests/unit/reference-catalogue.test.ts`,
`tests/integration/reference-seed.int.test.ts`, `tests/migration/tax-reference-markers.int.test.ts`,
`docs/adr/0012-reference-seed-semantics.md`, this report.
Modified: `prisma/schema.prisma`, `prisma/seed/seed.ts`, `scripts/verify-phase0.ts`,
`tests/integration/global-setup.ts`, `tests/recovery/logical-dump.int.test.ts`, `README.md`, and the governance
documents `PROJECT_STATE`, `REQUIREMENTS_MATRIX`, `RISK_REGISTER`, `DATABASE_SCHEMA`, `TESTING`.

## Known limitations and new risks

- R-039 (gate integrity; mitigated, root cause unknown), R-040 (UNREVIEWED tax rates not yet enforced in
  invoicing), R-041 (seed writes no audit row), R-042 (re-run re-adds revoked template grants).
- Permission enforcement does not exist yet (P1-AUTH-01); the matrix is data only.
- The catalogue defines keys for features of later phases so roles are complete; unused keys remain until those
  features ship or are removed by a deliberate change.
- Carried forward unchanged: P1-SEC-01, P1-BKP-01, P1-AUTH-01, P6-ENC-01.

## Git

Committed locally as a separate Task 1.1 commit after review of the diff (no secrets, runtime databases or backup
artifacts; `.data/` and `packages/database/src/generated/` are git-ignored). The hash is reported in the session
reply and visible via `git log`. Nothing was pushed; no remote is configured.

## Exact next task

Task 1.2 - Electron shell supervises the API and supplies the launch secret (P1-SEC-01). Full proposed scope and
acceptance criteria are in `docs/PROJECT_STATE.md`. Not started.
