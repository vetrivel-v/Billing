# Phase 1 - Task 1.9 Completion Report: Customer Master Vertical Slice

## Visible functionality achieved

- **Customers** in the sidebar (users with `customer.read`): a list with server-side search (code, name, phone, e-mail, GSTIN), Active/Inactive/All and B2B/B2C filters,
  paging of 25, and loading, empty, no-match and error states.
- **New customer** and **Edit customer** on one form: Basic details (type B2B/B2C, name, display name, code), Tax details (GST registration, GSTIN when needed, PAN, place of supply),
  Billing address, Shipping address ("same as billing" checkbox), Contact, Other details (credit limit, payment terms, notes). Conditional GST fields, required/optional markers, inline errors,
  a summary naming each field, focus on the first problem, save progress state.
- **Deactivate / Reactivate** with confirmation (nothing is ever deleted), a read-only view for users without `customer.write`, and a clear message on a concurrent change.
- Reload / close and reopen: customers persist (real PostgreSQL).

## Requirements checked

| Brief item                                                                    | Result                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Minimum customer model, GST rules, place of supply stored, no tax calculation | done; see ADR-0020                                                         |
| Customer code strategy (separate from the id, unique per organization)        | generated `CUS-000001...` or typed; per-organization counter               |
| Migration on clean and populated Task 1.8 database                            | 9 migration tests; existing organization/user/location rows unchanged      |
| API, authorization by exact keys, 401 vs 403, organization isolation          | 30 HTTP tests incl. every role template and cross-organization attempts    |
| Audit without unnecessary personal data                                       | verified in rows and logs                                                  |
| Concurrency conflict (stable result, UI explanation)                          | 409 `DB_0002`; simultaneous-edit race tested; UI Reload flow               |
| UI create / edit / search / close-reopen against the real API                 | 10 real-UI tests                                                           |
| Visual review                                                                 | done (list, empty, B2B registered, B2C, validation errors, edit, inactive) |

## Points to review

- **Two defects found and fixed by this task's tests:** (1) request logs contained full URLs, so searching by phone, e-mail or GSTIN would have written personal data to the logs - the logger now
  records the path only; (2) `%` and `_` typed into search acted as SQL wildcards - they are now literal.
- Rules I chose (change on request): a B2C customer is always unregistered; GSTIN must start with the billing state code and contain the PAN (as the setup wizard does for the business);
  GSTIN is unique per organization (inactive customers still count); composition customers may omit a GSTIN (as at setup); `gstStatus` must be sent explicitly on create; the code cannot be edited.
- State is stored as the code only (names derived), shipping columns exist only when delivery differs, and the place of supply is an explicit stored fact that defaults to the delivery state.
- Existing tests changed: backup-spike table count 19 -> 21; three shell navigation tests (Customers is now a real link; Billing used for the "Coming soon" cases). The sign-in screen has no organization
  chooser (single-organization desktop install), so the UI isolation test creates the second organization after signing in; direct-link isolation is proven at API level (404) and by a component test.
- A redundant header "Cancel" button was removed (two Cancel buttons were ambiguous).
- **Flaky timeouts, then a stability setting:** on the first full run of this task two older API unit tests (`app.test.ts`, `launch-secret.test.ts`) timed out at the 5 s default while the machine was under load (the unit gate took 55 s instead of ~12 s); the same tests passed in the coverage run, alone, and on a full re-run. I set `testTimeout: 15 s` for the unit project (assertions unchanged). The gate result I report is from a fully green run.
- Observation (R-076): three `npm run db:start` process trees from 2026-10-18 are still running on this machine (not started by this task). They do not affect tests.

## Tests

| Suite       | Count            |
| ----------- | ---------------- |
| Unit        | 384              |
| Integration | 344              |
| Total       | 728, all passing |

Coverage: 95.7% statements / 91.3% branches / 97.4% functions / 97.2% lines (thresholds unchanged 80/70/80/80).
New: customer validation unit tests, customer form model tests, 22 component tests, 9 migration tests, 30 HTTP integration tests, 10 real-UI integration tests.
Mutation checks: ten deliberate breaks (organization scope on get, version check removed, write needing only read, GSTIN-required removed, personal data added to audit, full URL in logs, search wildcards live, generated-code skip removed, read-only fields enabled) each made at least one test fail; sources were restored and verified identical.

## Commands executed

`prisma generate`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run --coverage`, `npm run verify:phase0` (all 8 gates PASS, including the production build and Electron
smoke test), `npm audit` (0 vulnerabilities), 2026-10-19.

## Risks

- Opened: R-073 (accepted), R-074 (open), R-075 (accepted), R-076 (open, tooling).
- Unchanged: R-040 and R-053 (**open** until independent review of tax/state reference data), R-063 (deferred), R-070..R-072, R-065..R-069 and earlier.

## Exact next task

Task 1.10 - Product master vertical slice. Scope and acceptance criteria are in PROJECT_STATE, "Exact next task". Not started.
