# Testing

Framework: Vitest 5 (`vitest.config.ts` defines two projects). Playwright (end-to-end) is not installed yet;
it is added in Phase 1 with the first user-facing workflow.

| Project     | Command                    | Includes                                                            | Notes                                                                                                                                                                        |
| ----------- | -------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | `npm test`                 | `*.test.ts(x)` under packages, apps, `tests/unit`, `tests/security` | jsdom per-file via `// @vitest-environment jsdom`                                                                                                                            |
| integration | `npm run test:integration` | `*.int.test.ts`                                                     | Global setup starts a throwaway PostgreSQL cluster (temp dir, port 54330); each file creates a uniquely named database and runs `prisma migrate deploy` on it, then drops it |

Directories reserved by spec section 6: `tests/unit`, `tests/integration`, `tests/e2e`, `tests/security`,
`tests/migration`, `tests/recovery`. Only integration currently contains a file; the others are created when
their first test exists.

## Rules

- Do not lower coverage thresholds (spec section 41). Thresholds in `vitest.config.ts` apply to
  `npm run test:all -- --coverage`; actual numbers are reported in the completion report.
- A requirement is "Tested" only if a relevant test executed successfully.
- Mocks and sandbox adapters must be labelled as such in code and reports.
- Tests that need the database must use `createIsolatedDatabase`; never run against the development database.

## Gate integrity (R-039)

On Windows the integration run once exited 0 although a test had failed. `tests/integration/global-setup.ts`
re-asserts the failing exit code, and `scripts/verify-phase0.ts` runs the unit and integration gates with
`--reporter=json` and fails the gate if the report is missing, empty or contains any failed test. Never judge a
gate by the exit code alone; read the printed "Tests" line.

Additional directories now in use: `tests/unit` (catalogue checks), `tests/migration` (migration tests),
`tests/recovery` (backup spike), `tests/security` (Argon2 spike).

## Gate sequence

`npm run verify:phase0` runs: schema validate, client generate, type-check, lint, format check, unit,
integration, build. Later phases extend this with e2e, accounting balance, inventory reconciliation, migration
and backup/restore checks (spec section 9).

## End-to-end and milestone checks (Task 1.18)

- `tests/integration/fub-electron.int.test.ts`: First Usable Billing in the real Electron app (see DEVELOPER_GUIDE). Real: main process, preload, renderer, API, PostgreSQL. Replaced: the native save, print and folder/file dialogs. Driven from the main process with `executeJavaScript`, not Playwright.
- `tests/integration/fub-api.int.test.ts`: the dashboard summary and the permission matrix across the standard roles, derived from the permission catalogue and the route table.
- `tests/integration/dashboard-real-api.int.test.tsx`: the Dashboard screen against the real API, including a sweep proving no screen shows raw technical wording when the service fails.
- `tests/integration/fub-performance.int.test.ts`: a modest representative-data smoke test (measured, not a benchmark).
- `tests/e2e/pdf-text.ts`: extracts the text of a Chromium-generated PDF so a test can prove what an invoice PDF says.
