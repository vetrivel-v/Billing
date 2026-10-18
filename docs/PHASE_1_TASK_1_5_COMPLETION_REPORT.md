# Phase 1 - Task 1.5 Completion Report: Document Numbering Engine and Setup-Time Sequence Configuration

Date: 2026-10-18 · Node v24.16.0. Architecture: ADR-0016. Task 1.6 was not started.

## Important: the brief was cut off

The Task 1.5 instructions ended mid-heading at **"G. RETRIES AND IDEMPOTENCY"**. Sections A-F were received; G and
anything after it (including any testing, governance and git instructions) were not. I implemented G as
"per-document idempotent allocation" (below), followed the testing/governance pattern of earlier tasks, and did **not**
commit (no commit instruction was received). Please confirm or correct the G design (R-058).

## Result against sections A-F

| Section                                                                                                                                                                                                    | Result                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Sequence engine by organization, document type, financial year, optional location, prefix, suffix, width, start number, current state, reset policy, active flag; extensible; format from configuration | **Met.** `@commercebill/numbering`; `INV/2026-27/000001` etc. are only the default configuration `INV/{FY}/`. Extra dimensions: extend `SequenceScope`, the lookup and the unique index in one place     |
| B. Stable machine-readable document-type codes                                                                                                                                                             | **Met.** `INVOICE`, `CREDIT_NOTE`, `DEBIT_NOTE`, `PURCHASE_ORDER`, `PAYMENT_RECEIPT` (DB CHECK on the form); labels are display-only; no document workflows created                                      |
| C. Financial-year scoping; history queryable and never renumbered                                                                                                                                          | **Met.** Independent per-year sequences; `openFinancialYear`; `listSequences`; ledger freezes printed numbers; start number frozen once used; sequences never deleted                                    |
| D. Concurrency enforced by PostgreSQL, not an in-process lock                                                                                                                                              | **Met.** `SELECT ... FOR UPDATE` plus database triggers/constraints; tests below                                                                                                                         |
| E. Allocation inside the posting transaction; rollback policy documented, no gapless claim                                                                                                                 | **Met.** `allocate(tx, ...)`; rollback leaves no gap; committed numbers are permanent; policy in ADR-0016                                                                                                |
| F. Drafts get no permanent number                                                                                                                                                                          | **Met.** No draft path exists; test shows only posting consumes a number                                                                                                                                 |
| G. Retries and idempotency                                                                                                                                                                                 | **Interpreted** (brief truncated): `documentRef` unique per organization + type; same document -> same number; concurrent duplicates -> one number; same document in another year's sequence -> conflict |

PROJECT_STATE scope also met: setup-time configuration (`numbering` section, defaults, atomic creation, draft fields,
validation) - see below.

## Design highlights (ADR-0016)

- **Ledger table** `document_number_allocations` (append-only): printed number frozen at allocation, unique per
  (sequence, number), (organization, type, printed text), (organization, type, document). It provides idempotency,
  immutability, collision detection and the gap report.
- **Database invariants** (migration `20261020000000_task_1_5_document_numbering`): counter advances by exactly one
  (first number = start number); identity columns immutable; start number frozen after first use; no deletes; type,
  reset-policy, affix-length and start-fits-width CHECKs; ledger rows must match their sequence and cannot exceed
  the counter; ledger append-only.
- **Format rules:** prefix/suffix limited to `A-Za-z0-9/._-` plus `{FY}` (<= 40 chars); width 1-18; with yearly
  reset the format must contain `{FY}` (otherwise two years would print the same text - rejected at configuration,
  and caught again by a collision check before any write).
- **Setup:** five sequences created inside the existing atomic setup transaction (new `numbering` step, now 12 tested
  failure points), `numbering` setting `{scopeByLocation:false}`, bootstrap audit per sequence.

## Review follow-up (section G review)

After the review of the truncated section G, two tests were added without any code change: a retry of the SAME document
after its transaction rolled back (gets the number the failed attempt would have had, no gap, then a further retry
reuses it), and simultaneous requests for one document against TWO financial years (exactly one ledger row and one
consumed number; every loser fails with `document_already_numbered` and its counter increment is rolled back). The
idempotency tests were repeated four times without a failure.

## Defects found while building (fixed before this report)

1. A number collision (two years printing the same text) surfaced as the wrong error (`document_already_numbered`),
   because Prisma's unique-violation metadata did not name the column. Fixed with an explicit pre-check before any
   write (precise `number_collision`) and a defensive fallback.
2. An invalid prefix produced two problem codes (it also "lacked {FY}"). The year-uniqueness rule now applies only
   to otherwise-valid affixes, so problems are reported once.
3. Test-design: the table-count assertion in the backup spike (18) had to become 19 because the schema gained a
   table; setup tests were updated for the new settings row, five sequences and 12th step. No assertion was weakened.
4. **Mutation checks** (temporary, reverted, sources verified identical): removing the row lock failed 4 concurrency
   tests; removing the idempotency and active checks failed 5; a combined mutation that also skips a number each time
   failed 16 (the skip is rejected by the database trigger).

## Tests

| Suite                         | Before | After                                                                              |
| ----------------------------- | ------ | ---------------------------------------------------------------------------------- |
| Unit                          | 200    | **246** (+46: numbering formatting, affix rules, validation, registry, setup plan) |
| Integration (incl. migration) | 163    | **215** (+52: numbering 33, numbering migration 11, setup +8)                      |
| Total                         | 363    | **461**                                                                            |

Highlights: 40 parallel allocations -> exactly 1..40; 30 parallel with every third rolled back -> exactly 1..20, no gap;
96 parallel allocations across 2 organizations x 2 years x 2 types -> each sequence exactly 1..12; ten simultaneous
requests for one document -> one number; a deliberately lock-free allocator cannot commit a duplicate; direct SQL cannot
skip, rewind, delete or rewrite; configuration changes leave issued numbers untouched; per-location numbering works only
when enabled.

## Commands executed and actual results

| Command                                                                     | Result                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx prisma migrate diff` (dev DB, then after applying)                     | generated the column/table SQL; afterwards "No difference detected"                                                                                                                |
| `npx tsc`, `npx eslint .`                                                   | no errors                                                                                                                                                                          |
| `npx vitest run --project unit packages/numbering`                          | 46 passed                                                                                                                                                                          |
| numbering integration (first run)                                           | 29 passed, 2 failed (items 1-2 above); after fixes 31 passed                                                                                                                       |
| setup + recovery suites                                                     | 63 passed                                                                                                                                                                          |
| `npx vitest run --project integration tests/migration/numbering-invariants` | 11 passed                                                                                                                                                                          |
| `npm run verify:phase0`                                                     | exit 0; all 8 gates PASS; Unit 18 files / 246 tests; Integration 13 files / 215 tests                                                                                              |
| `npx vitest run --coverage`                                                 | 31 files, 461 tests passed; Statements 96.96% (958/988), Branches 93.03% (641/689), Functions 99.09% (218/220), Lines 98.50% (856/869); thresholds (80/70/80/80) unchanged and met |
| `npm audit`                                                                 | found 0 vulnerabilities                                                                                                                                                            |
| leftover `postgres.exe` / Electron processes                                | none                                                                                                                                                                               |

The Electron shell end-to-end test and all Task 1.3/1.4 suites passed unchanged.

## Files

Created: `packages/numbering/**` (service, format, validate, document-types, tests),
`prisma/migrations/20261020000000_task_1_5_document_numbering/migration.sql`, `tests/integration/numbering.int.test.ts`,
`tests/migration/numbering-invariants.int.test.ts`, `docs/adr/0016-document-numbering-engine.md`, this report.
Modified: `prisma/schema.prisma`, `packages/setup/src/{schema,validate-input,service}.ts`, `packages/setup/package.json`,
`tests/integration/setup.int.test.ts`, `tests/recovery/logical-dump.int.test.ts` (18 -> 19 tables),
`package-lock.json`, and the governance documents (PROJECT_STATE, REQUIREMENTS_MATRIX, RISK_REGISTER, DATABASE_SCHEMA,
THREAT_MODEL). No API routes were added.

## Known limitations and risks

- R-058 (G interpreted), R-056 (posting serializes per sequence), R-057 (switching to per-location numbering later).
  R-003 and R-024 mitigated for the engine.
- No real document table uses the engine yet; the posting transaction is simulated by a test-only table.
- Choosing the financial year for a document date, financial-year creation/locking, and per-location configuration UI are
  later tasks. Only five document-type codes exist.
- Carried forward: R-040, R-042, R-043, R-045..R-048, R-051..R-055, P1-BKP-01, P6-ENC-01.

## Exact next task

Task 1.6 - authenticated user administration and password change API (the first routes using both
`requireAuthenticatedUser` and `requirePermission`). Full scope and acceptance criteria are in `docs/PROJECT_STATE.md`.
Not started.
