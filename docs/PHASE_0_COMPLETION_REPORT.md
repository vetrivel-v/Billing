# Phase 0 Completion Report

Date: 2026-10-16 · Machine: Windows 11 Enterprise, Node v24.16.0, npm 11.13.0, git 2.55.0.

## Current phase and result

Phase 0 (architecture and foundation). **All Phase 0 exit criteria were met by commands executed on this
machine** (details below). Phase 1 has not been started. Nothing in this report claims product readiness;
no product functionality exists.

## Requirements addressed

P0-01 to P0-28 in [REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md). Statuses there distinguish Tested
(automated test executed) from Implemented (manually verified or document-only).

## Exit criteria (spec section 8) - evidence

| #   | Criterion                  | Command                                                                                                          | Actual result                                                                                                                                                                                                                                                               |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Repository installs        | `npm install` (root + workspaces)                                                                                | Succeeded; `npm audit`: found 0 vulnerabilities                                                                                                                                                                                                                             |
| 2   | TypeScript compilation     | `npm run typecheck`                                                                                              | PASS (api, desktop, web, database, shared-types, test-utilities, validation, root scripts/tests)                                                                                                                                                                            |
| 3   | Linting                    | `npm run lint`; `npm run format:check`                                                                           | PASS; PASS                                                                                                                                                                                                                                                                  |
| 4   | Test runner executes       | `npm test`                                                                                                       | 7 files, 32 tests passed                                                                                                                                                                                                                                                    |
| 5   | Test database starts       | `npm run test:integration`                                                                                       | Throwaway PostgreSQL 18 cluster started (port 54330); 1 file, 6 tests passed                                                                                                                                                                                                |
| 6   | Initial migration succeeds | `prisma migrate deploy` via `createIsolatedDatabase` (every integration file) and `npm run db:migrate` on dev DB | "All migrations have been successfully applied" for `20261016000000_phase0_foundation`                                                                                                                                                                                      |
| 7   | Electron shell starts      | `ELECTRON_SMOKE=1 npx electron .` in apps/desktop (after `npm run build`)                                        | `SMOKE_RESULT {"bridge":{"name":"CommerceBill Desktop","version":"0.0.1","platform":"win32"},"nodeExposed":false,"title":"CommerceBill Desktop"}` - page loaded from built web bundle, preload bridge worked, Node not exposed. Manual run; not part of the automated suite |
| 8   | API health check succeeds  | Built bundle `node dist/main.js` against dev DB; `curl`                                                          | `/health` -> HTTP 200 `{"status":"ok",...}`; `/health/db` -> HTTP 200, `database.status: "ok"`. Listener bound to 127.0.0.1:4310. `API_HOST=0.0.0.0` exits 1 with an env-validation message                                                                                 |
| 9   | Documentation initialized  | files listed below                                                                                               | Present                                                                                                                                                                                                                                                                     |

Aggregate gate run: `npm run verify:phase0` -> PASS for Prisma schema valid, Prisma client generated,
Type-check, Lint, Format check, Unit tests, Integration tests, Build (all 8), exit code 0.

Additional manual check: `npm run dev` (one-command startup) started embedded PostgreSQL, applied migrations,
API and Vite; `/health/db` returned ok and the web server answered HTTP 200.

## Coverage (actual)

`npx vitest run --coverage` (unit + integration, 38 tests): statements 98.73%, branches 97.91%, functions
100%, lines 98.61%. Thresholds (80/70/80/80) were **not changed** to obtain this. An earlier run before tests
were added failed the thresholds (79.8% statements, 62.7% branches); the gap was closed by adding tests and by
excluding `packages/test-utilities/**` (test infrastructure executed in a separate process), entry points
`main.ts`, `preload.ts` and generated code. Those exclusions are in `vitest.config.ts`.

## Files created

- Root: `package.json`, `package-lock.json`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`,
  `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.gitattributes`, `.gitignore`, `.env.example`,
  `vitest.config.ts`, `prisma.config.ts`, `docker-compose.yml`, `README.md`, `CHANGELOG.md`.
- `apps/api` (app.ts, main.ts, app.test.ts, tsup.config.ts, configs), `apps/web` (index.html, vite.config.ts,
  App, StatusPanel, ErrorBoundary, api client, three test files), `apps/desktop` (main.ts, preload.ts,
  security.ts, security.test.ts, tsup.config.ts).
- `packages/shared-types`, `packages/validation` (env.ts + test), `packages/database` (index.ts + test),
  `packages/test-utilities`; README-only: domain, tax-engine, accounting-engine, inventory-engine,
  document-engine, integration-core, ui, reporting.
- `prisma/schema.prisma`, `prisma/migrations/20261016000000_phase0_foundation/migration.sql`,
  `migration_lock.toml`, `prisma/seed/` (seed.ts, reference/, demo/).
- `scripts/` (dev.ts, db-start.ts, db-migrate.ts, verify-phase0.ts, lib/env.ts).
- `tests/integration/` (global-setup.ts, database.int.test.ts); `.gitkeep` in reserved test/sample dirs;
  README stubs in `integrations/*` and `templates/*` marking them NOT STARTED.
- `docs/`: ARCHITECTURE, PROJECT_STATE, REQUIREMENTS_MATRIX, RISK_REGISTER, DATABASE_SCHEMA,
  DATABASE_CONVENTIONS, DEVELOPER_GUIDE, TESTING, SECURITY, THREAT_MODEL, this report, `adr/0001-0008`.

## Files modified

`COMMERCEBILL_MASTER_SPEC_V2.md` was not modified.

## Migrations created

`20261016000000_phase0_foundation`: 18 tables (organizations, organization_settings, business_locations,
financial_years, warehouses, users, roles, permissions, user_roles, role_permissions, sessions,
document_sequences, tax_categories, tax_rates, hsn_sac_codes, units, audit_logs, application_settings),
one enum, check constraints, partial unique indexes, and audit-log immutability triggers.

## Tests added

Unit (32): env validation (12), API health/error contract/CORS/headers (7), web API client (3), web App + ErrorBoundary (3), Electron security policy (3), database ping (2), web StatusPanel (2). Integration (6): migration to empty DB, constraints,
decimal storage, audit-log append-only, sequence uniqueness with NULL location, API `/health/db` with a real DB.

## Problems found and fixed during the run (Phase 0 scope)

1. API bundle failed at runtime (`Dynamic require of "events"`): `pg` was inlined into the ESM bundle. Fixed by
   declaring `pg`, `@prisma/client` and `@prisma/adapter-pg` as API dependencies so tsup keeps them external.
2. Integration assertion expected the audit-trigger message through Prisma, which maps the error to a generic
   foreign-key message. The trigger did block the write; the test now asserts rejection via the ORM and the
   `append-only` message via raw SQL.
3. First coverage run failed thresholds; fixed with real tests (see Coverage).
4. Removed a deprecated Fastify option (`disableRequestLogging`).

## Known limitations

See [PROJECT_STATE.md](PROJECT_STATE.md). Notably: Docker Compose not executed (Docker not installed);
Electron smoke and `npm run dev` verified manually; no Playwright, pre-commit hook, CI service, OpenAPI,
SBOM; no commit created; TypeScript pinned at 6.0.3 for typescript-eslint support.

## Newly discovered risks

R-030 to R-034 in [RISK_REGISTER.md](RISK_REGISTER.md). Most important: **R-031** - the embedded PostgreSQL
package contains no `pg_dump`/`pg_restore`, which blocks the Phase 1 backup design until resolved.

## Integration-verification status

No integrations exist. All are NOT VERIFIED AGAINST LIVE SERVICE.

## Specification contradictions

None blocking; tensions are listed in [ARCHITECTURE.md](ARCHITECTURE.md) section 11.

## Project-state updates

PROJECT_STATE.md, REQUIREMENTS_MATRIX.md and RISK_REGISTER.md were created/updated at the end of this phase.

## Exact next task

Phase 1, Task 1.0 (ADR-0009/0010/0011 spikes for R-031/R-032/R-033), then Task 1.1 (reference seed). See
PROJECT_STATE.md.
