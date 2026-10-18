# Phase 1 - Task 1.4 Completion Report: First-Run Setup Service and API (backend only)

Date: 2026-10-18 · Node v24.16.0 · Electron 44.8.0. Architecture: ADR-0015 (approved before implementation).
Task 1.5 was not started.

## Result against the brief

| Requirement                                                                                                                                          | Result                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap security: routes behind the launch secret, usable only while setup is genuinely incomplete                                                 | **Met.** Database-authoritative precondition on every request, re-checked under an advisory lock; missing launch secret -> 401 on all four routes (test 15) |
| After completion: bootstrap creation unavailable, replay creates nothing, restart does not re-enable, draft deletion/corruption irrelevant           | **Met** (tests 10, 11, 12); the database also refuses to clear or change `setup_completed_at` (trigger)                                                     |
| Atomic final submit (organization, settings, location, warehouse, financial year, administrator, role assignment) using the Task 1.1 reference roles | **Met.** One transaction; roles come from the seed running inside it - no duplicate role definitions (test 6, 18)                                           |
| Rollback proof                                                                                                                                       | **Met.** Failure injected after each of 11 steps (and once over HTTP): zero rows in 15 tables, no audit row, draft intact, retry succeeds (test 13)         |
| Draft: location, schema/version, validation, corruption handling, deletion, future changes                                                           | **Met and defined** in ADR-0015 "Implementation record". Stored in `application_settings`, strict whitelist, no password/hash/token/secret/credential/key   |
| Administrator password hashing and non-disclosure                                                                                                    | **Met.** Task 1.3 Argon2id architecture; no password/hash in responses, trace-level logs, audit, draft or errors (tests 6, 7)                               |
| `/setup/status` privacy                                                                                                                              | **Met.** Exactly `{ setupRequired, draftAvailable }`                                                                                                        |
| Rate limit, replay, concurrency                                                                                                                      | **Met.** 5/min completion, 60/min draft (429 `AUTH_0003` tested); 8 identical and 6 different concurrent submissions -> exactly one succeeds                |
| Server-side validation of final input                                                                                                                | **Met** for the approved rules (below)                                                                                                                      |
| No session / explicit login                                                                                                                          | **Met.** 201 with `{organizationId, administratorUsername, nextStep: "login"}`; zero sessions; login works afterwards with all 70 permissions               |
| Auditability without a fabricated user                                                                                                               | **Met.** `user_id` NULL, `actor: "system:bootstrap"`; nothing audited for rolled-back attempts                                                              |
| Bootstrap routes recorded as an exception                                                                                                            | **Met** (ADR-0015, SECURITY.md, route code comment, matrix)                                                                                                 |
| Tests 1-19, gates, no threshold changes                                                                                                              | **Met** (see below)                                                                                                                                         |

## Interpretations you should know about

1. **"Invoice sequence configuration" is not implemented.** The brief listed it "where applicable" among fields defined
   in PROJECT_STATE, but PROJECT_STATE put document numbering sequences out of scope for Task 1.4. I did not collect,
   validate or store it; it is the core of proposed Task 1.5 (which extends this same atomic transaction).
2. **The draft is database-backed, not file-backed**, as ADR-0015 (approved) specified. The file-replacement clause in
   the brief therefore does not apply; a single UPDATE is atomic, so a failed save cannot destroy the previous valid
   draft. `.gitignore` additionally ignores `setup-draft*.json` and `*.setup-draft.json`.
3. **No unique index limits the number of completed organizations**, because the data model is multi-organization.
   The single-bootstrap guarantee is the advisory lock + in-lock re-check (a mutation test shows it is required),
   plus the immutability trigger. Recorded as R-054.
4. COMPOSITION taxpayers may have a GSTIN but are not required to (only the approved rules - registered requires one,
   unregistered must not - are enforced).

## Validation rules applied (approved set only)

PAN format; GSTIN format, published mod-36 checksum (verified against the widely published specimen
`27AAPFU0939F1ZV`), first two digits equal to the state code, embedded PAN equal to the entered PAN; GST-status rules;
state code must be in the (unreviewed, R-053) table; PIN format; real calendar date for the financial-year start
(2000-2100; end = day before the next anniversary; label `2026-27` or `2026`); administrator username shape and the
Task 1.3 password policy; required fields; strict unknown-key rejection; trimming of pasted values (never the password).
Problems are returned as field path + rule code only, never the submitted value. **No GSTIN or PAN is claimed to be real.**

## Defects and oddities found while building (all fixed before commit)

1. `pg_advisory_xact_lock` returns `void`, which Prisma `$queryRaw` cannot deserialize (every completion returned 500);
   now `$executeRaw`.
2. Pasted values with surrounding spaces (`27aapfu0939f1zv`) exceeded schema length limits before they could be
   trimmed; strings are now trimmed first, the password never.
3. Test-design slips found by the first runs (global/setup rate limits throttling a 48-test file, a draft version
   expectation, an audit-timestamp comparison that the fixed test clock made ambiguous, a 415 for text bodies).
4. **Mutation checks** (temporary, reverted, sources verified identical): removing the in-lock re-check made both
   concurrency tests fail; not deleting the draft failed "draft deleted"; leaking the password into the audit event
   failed the leak test; allowing a password in the draft schema failed the draft tests - six tests failed in total.

## Tests

| Suite                         | Before | After                                                           |
| ----------------------------- | ------ | --------------------------------------------------------------- |
| Unit                          | 117    | **200** (+83: validators 37, validate-input + draft schemas 46) |
| Integration (incl. migration) | 102    | **163** (+61: setup 48, setup-invariants migration 13)          |
| Total                         | 219    | **363**                                                         |

Brief item to test mapping: 1 -> "fresh installation"; 2 -> "valid draft"; 3 -> "draft never contains..." (+ failed final
submission); 4 -> "corrupted draft" (6 corruption variants incl. a smuggled password); 5 -> "valid setup completes"; 6 ->
"password hashed"; 7 -> "no password or hash appears" (responses, trace logs, audit, settings); 8 -> "no session"; 9 ->
"explicit login"; 10 -> "status completed"; 11 -> "second completion"; 12 -> "restart"; 13 -> 11-step rollback +
HTTP rollback; 14 -> two concurrency tests; 15 -> launch secret x4 routes; 16 -> 11 invalid-input cases; 17 -> rate
limits; 18 -> five roles/reference data; 19 -> the unchanged Task 1.3 suites (28 + 19 tests) still pass.

## Commands executed and actual results

| Command                                                                                             | Result                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc` / `npm run typecheck`, `npx eslint .`                                                     | no errors                                                                                                                                                                          |
| `npx vitest run --project unit packages/setup`                                                      | 2 files, 83 tests passed (after two real fixes noted above)                                                                                                                        |
| `npx vitest run --project integration tests/migration/setup-invariants tests/integration/setup.int` | first runs failed (lock/void, rate limits); final: 48 + 13 passed                                                                                                                  |
| Mutation run (4 mutations)                                                                          | 6 failed / 42 passed, sources restored (diff clean)                                                                                                                                |
| `npm run verify:phase0`                                                                             | exit 0; all 8 gates PASS; Unit 17 files / 200 tests; Integration 11 files / 163 tests                                                                                              |
| `npx vitest run --coverage`                                                                         | 28 files, 363 tests passed; Statements 96.78% (783/809), Branches 93.42% (469/502), Functions 98.95% (189/191), Lines 98.72% (695/704); thresholds (80/70/80/80) unchanged and met |
| `npm audit`                                                                                         | found 0 vulnerabilities                                                                                                                                                            |
| leftover `postgres.exe` / Electron processes                                                        | none                                                                                                                                                                               |

The Electron shell e2e test (Task 1.2) passed unchanged with the new API bundle. No Playwright suite exists; there is
no setup UI yet.

## Files

Created: `packages/setup/**` (service, schema, validators, validate-input, india-state-codes, tests),
`packages/reference-data/**` (moved from `prisma/seed/reference`), `apps/api/src/setup-routes.ts`,
`prisma/migrations/20261019000000_task_1_4_setup_invariants/migration.sql`, `tests/integration/setup.int.test.ts`,
`tests/migration/setup-invariants.int.test.ts`, `docs/adr/0015-first-run-setup-design.md` (written before
implementation, completed after), this report.
Modified: `packages/auth/src/service.ts` (`prepareNewUser`, `insertUser`, `Actor.system`),
`packages/shared-types/src/index.ts`, `apps/api/src/{app,errors}.ts`, `prisma/seed/reference/{index,permissions}.ts`
(now shims), `tests/integration/auth-fixture.ts`, `.gitignore`, `package.json`/`package-lock.json`, and the governance
documents (PROJECT_STATE, REQUIREMENTS_MATRIX, RISK_REGISTER, DATABASE_SCHEMA, SECURITY, THREAT_MODEL).
No `schema.prisma` change.

## Known limitations and risks

R-041 mitigated for first-run setup (standalone seed CLI still unaudited). New: R-052 (draft holds unencrypted business
PII until completion), R-053 (state-code table unreviewed), R-054 (lock-based single-bootstrap), R-055 (no in-app
password recovery). Carried forward: R-040, R-042, R-043, R-045, R-046, R-047, R-048, R-051 (controls implemented,
residual accepted). Not built: wizard UI, document numbering, most spec section 10 fields, user-management routes.

## Exact next task

Task 1.5 - document numbering engine and setup-time sequence configuration (backend only). Full scope and acceptance
criteria are in `docs/PROJECT_STATE.md`. Not started.
