# Phase 1 - Task 1.0 Completion Report

Date: 2026-10-16 · Node v24.16.0 · Electron 44.8.0 · Scope: resolve the three Phase 1 blockers with ADRs and
small spikes. No product features were added; no invoice, inventory, payment or accounting behaviour exists.

## Scope confirmation

From `docs/PROJECT_STATE.md` (exact next task after Phase 0): (1) R-031 backup dump/restore decision with a
proven dump + restore into an isolated database (ADR-0009); (2) R-032 shell-to-API authentication design
(ADR-0010); (3) R-033 Argon2id library proven under Node and Electron (ADR-0011). Task 1.1 was not started.

## Requirements addressed

T10-01 to T10-05 in [REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md). Risks changed: R-011, R-014, R-015,
R-027, R-031, R-032, R-033 updated; R-035 to R-038 added.

## What was built and what the evidence shows

| Item                | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup (ADR-0009)   | Decision: verified **logical export, "migrate then load"**. Spike proves: manifest with schema version + per-table row count + SHA-256; restore into an isolated freshly migrated DB gives identical per-table digests; `bigint` 9007199254740993 and `numeric` 0.1234 exact; audit trigger still blocks DELETE after restore; tampered dump rejected before any write; schema-version mismatch rejected; non-empty target refused; mid-load failure leaves target empty. `pg_dump` bundling was **not** evaluated empirically (no binaries available/authorised) - recorded as an unexplored alternative |
| API auth (ADR-0010) | `apps/api/src/launch-secret.ts` + hook in `app.ts`: constant-time check of `x-commercebill-launch-secret`; `/health` exempt; unknown routes also 401; CORS preflight still works; `LAUNCH_SECRET` (>= 32 chars) added to env validation. **Not wired into the Electron shell** and no user sessions yet                                                                                                                                                                                                                                                                                                   |
| Argon2id (ADR-0011) | `@node-rs/argon2`, Argon2id m=19456 KiB, t=2, p=1. Node output: `{"isArgon2id":true,"verifyCorrect":true,"verifyWrong":false,"verifyUnicode":true,"hashMs":17,"node":"24.16.0","electron":null}`. Electron output: same flags, `"hashMs":20,"node":"24.22.0","electron":"44.8.0"`                                                                                                                                                                                                                                                                                                                         |

## Defects found and fixed during the task

1. **R-035 (real defect, Phase 0 carry-over):** the embedded PostgreSQL clusters defaulted to `WIN1252`.
   Inserting Devanagari text failed: `character with byte sequence 0xce 0xa9 in encoding "UTF8" has no equivalent
in encoding "WIN1252"`. Fixed by `--encoding=UTF8` in `packages/test-utilities/src/index.ts` and
   `scripts/db-start.ts`; the existing (empty, throwaway) `.data/pg-dev` was deleted and recreated; verified
   `server_encoding = UTF8` on the fresh dev database; regression test added.
2. Redaction gap: pino's `req` serializer hid header redaction, so an explicit header dump under another key was
   not covered by `req.headers.*` paths. Added wildcard paths (`*.headers.authorization`, `*.headers.cookie`,
   `*.headers["x-commercebill-launch-secret"]`) after a failing leak test.
3. Lint: the CommonJS spike script needed a scoped ESLint override (`scripts/spikes/**/*.cjs`); rules were not
   loosened elsewhere.

## Files created

`docs/adr/0009-backup-without-pg-dump.md`, `0010-shell-to-api-authentication.md`,
`0011-argon2id-implementation.md`; `apps/api/src/launch-secret.ts`, `launch-secret.test.ts`;
`tests/recovery/spikes/logical-dump.ts`, `tests/recovery/logical-dump.int.test.ts`;
`tests/security/argon2.test.ts`, `argon2.electron.int.test.ts`; `scripts/spikes/argon2-check.cjs`; this report.

## Files modified

`apps/api/src/app.ts` (launch-secret hook, redaction paths, `logStream` test hook), `apps/api/src/main.ts`
(passes `LAUNCH_SECRET`), `packages/validation/src/env.ts` and `env.test.ts`,
`packages/test-utilities/src/index.ts`, `scripts/db-start.ts`, `tests/integration/database.int.test.ts`
(encoding test), `eslint.config.js`, `package.json` / `package-lock.json` (`@node-rs/argon2`; `electron` also
declared as a root dev dependency so the tests can resolve it), and the documents `PROJECT_STATE.md`,
`REQUIREMENTS_MATRIX.md`, `RISK_REGISTER.md`.

## Migrations

None. Task 1.0 changed no schema, so no migration was required or created; the single existing migration
`20261016000000_phase0_foundation` is unchanged.

## Tests added (25)

Unit (15): launch-secret guard and leak tests (9), env `LAUNCH_SECRET` (2), Argon2 under Node (4).
Integration (10): logical dump/restore (7), Argon2 under Node and Electron (2), UTF8 encoding (1).
Unit total 32 -> 47; integration total 6 -> 16.

## Commands executed and actual results

| Command                                                                        | Result                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install @node-rs/argon2`                                                  | added; `npm audit`: found 0 vulnerabilities                                                                                                             |
| `npx vitest run --project integration tests/recovery` (first run)              | FAILED: WIN1252 encoding error (defect 1)                                                                                                               |
| same, after UTF8 fix                                                           | 1 file, 7 tests passed                                                                                                                                  |
| `npx vitest run tests/security`                                                | 2 files, 6 tests passed                                                                                                                                 |
| `npm run verify:phase0` (first run)                                            | exit 1: Lint FAIL (CJS spike script); all other gates PASS                                                                                              |
| `npm run verify:phase0` (after scoped ESLint override)                         | exit 0: Prisma schema valid, client generated, Type-check, Lint, Format check, Unit tests, Integration tests, Build - all PASS                          |
| Totals from that run                                                           | Unit: 9 files, 47 tests passed. Integration: 3 files, 16 tests passed. Combined 63 (Phase 0 baseline was 38; no Phase 0 test was removed or weakened)   |
| `npx vitest run --coverage`                                                    | 12 files, 63 tests passed; Statements 99% (99/100), Branches 96.77% (60/62), Functions 100% (29/29), Lines 98.87% (88/89); thresholds met and unchanged |
| `npm audit`                                                                    | found 0 vulnerabilities                                                                                                                                 |
| Fresh dev DB: `npm run db:start`, `npm run db:migrate`, `SHOW server_encoding` | migration applied; `UTF8`                                                                                                                               |
| End-to-end tests                                                               | None exist yet (Playwright is not installed; Task 1.0 has no user-facing workflow), so none were run                                                    |

The final `verify:phase0` run after the documentation edits is recorded in the last section below.

## Known limitations

- The logical-dump module is a spike (in-memory, unencrypted, no attachments, same schema version only).
- The launch secret is not generated or supplied by the Electron shell yet; there is no end-to-end test of that
  path. User sessions and authorisation do not exist.
- Argon2 cost parameters are the OWASP floor (about 17-20 ms here); only win32-x64 was exercised; no packaged-app
  test.
- `pg_dump` bundling was not tested, so the "logical export is the better choice" conclusion is based on
  requirements and spike evidence, not a measured comparison.
- Docker Compose remains unexecuted (Docker not installed).

## Newly discovered risks

R-035 (UTF8, mitigated for dev/test), R-036 (logical backup limits), R-037 (launch secret exposure to a
compromised renderer, accepted), R-038 (Argon2 binary in packaged app).

## Integration-verification status

No external integrations exist; all remain NOT VERIFIED AGAINST LIVE SERVICE.

## Exact next task

Phase 1, Task 1.1 - reference seed (permission catalogue, five role templates, default units, flagged tax
categories/rates) with integration tests. Full wording is in `docs/PROJECT_STATE.md`. It has not been started.

## Final regression run (after all documentation edits)

`npm run verify:phase0` -> exit 0; all 8 gates PASS (Prisma schema valid, Prisma client generated, Type-check,
Lint, Format check, Unit tests: 9 files / 47 tests, Integration tests: 3 files / 16 tests, Build). All 38
Phase 0 tests still pass unchanged. Nothing is committed; changes are in the working tree.
