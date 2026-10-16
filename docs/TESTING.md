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

## Gate sequence

`npm run verify:phase0` runs: schema validate, client generate, type-check, lint, format check, unit,
integration, build. Later phases extend this with e2e, accounting balance, inventory reconciliation, migration
and backup/restore checks (spec section 9).
