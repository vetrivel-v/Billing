# Phase 1 - Task 1.8 Completion Report: First-Run Setup Wizard UI

## Visible functionality achieved

- A fresh installation opens the **setup wizard**; a configured one opens **sign-in** and the wizard can never be reopened.
- Eight steps with a progress indicator, Back/Continue, inline and summary validation, keyboard operation and focus management.
- **Resume Setup / Start Over** (with confirmation) when a draft exists; the administrator password is always asked again.
- GST step with conditional GSTIN and the tax-review notice; financial-year summary; invoice number example that uses no number.
- Review page grouped by section with Edit buttons; a single atomic completion; then **sign-in with the username filled in and no session**.

## Field reconciliation (wizard vs Task 1.4/1.5 API)

| Collected and submitted                       | Notes                                                                |
| --------------------------------------------- | -------------------------------------------------------------------- |
| Legal name, trade name, business type, PAN    | all accepted by the API                                              |
| State, GST status, GSTIN                      | state is the business state and default place of supply              |
| Location name, address lines 1-2, city, PIN   |                                                                      |
| Warehouse name and code                       | optional, defaults Main Warehouse / MAIN                             |
| Financial-year start date                     | one year, validated by the server                                    |
| Invoice prefix, first number, width           | other document types use standard defaults; reset per financial year |
| Administrator name, username, email, password | password only in the final submission                                |

**Not supported by the backend, therefore not collected (DEF-11, R-071):** business phone/email/website; country as a stored
value (shown as "India"); separate default place of supply; bank name/account name/account number/IFSC/UPI ID; backup
destination; per-document-type prefixes and starts and an editable reset policy.

## Points to review

- The briefed steps 7 (Bank & Payment) and 9 (Backup Location) are not form steps: nothing stores their values. They are
  announced as "Not part of setup yet" on Welcome and Review, and no backup is claimed to be active.
- The `GST_STATUSES` constant moved from `schema.ts` to `validators.ts` (re-exported) so the browser export has no validation
  library dependency; two browser-safe subpath exports were added to the setup and numbering packages.
- Existing tests changed because the "Setup required" placeholder no longer exists: the Electron smoke test (first-screen
  heading is now "CommerceBill setup"), the Task 1.7 real-API test and one shell test. Their security assertions are unchanged.
- One timer test (idle timeout) failed once under whole-suite load; it passes alone (three runs). An async timeout of 5 s was
  set for the web component tests rather than weakening any assertion.
- The submit-lock mutation is equivalent: the Complete button is disabled while submitting; the lock is belt and braces.
- Screens were inspected in a browser against a throwaway empty database: the layout is clean; two real defects were found and
  fixed (error summary now names the field; focus goes to the password field after setup).

## Tests

| Suite       | Count                             |
| ----------- | --------------------------------- |
| Unit        | 343                               |
| Integration | 295 (7 new real-API wizard tests) |
| Total       | 638, all passing                  |

Coverage: 96.2% statements / 91.3% branches / 98.3% functions / 97.6% lines (thresholds unchanged 80/70/80/80). Real-API tests cover: fresh database launches the wizard; the whole journey
(draft contents, atomic creation of organization, location, warehouse, financial year, five sequences and administrator, no
session, draft removed, explicit sign-in); close/reopen/resume without the password; Start Over confirmation; a triple click creating
one organization; a server-only validation rejection creating nothing and succeeding after the fix; a completed installation
refusing the wizard and bootstrap endpoints; a second window finishing first. Secrets are checked in the draft row, requests,
URLs, trace-level server logs, audit rows, DOM, storage and location.

## Commands executed

`npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run --coverage`, `npm run verify:phase0` (all 8 gates PASS,
including the production build and the Electron smoke test), `npm audit` (0 vulnerabilities), 2026-10-19.

## Risks

- Opened: R-070 (mitigated), R-071 (open), R-072 (accepted).
- Unchanged: R-040 (**open** until independent review of the tax reference data), R-063 (deferred), R-065..R-069, R-052 and earlier.

## Exact next task

Task 1.9 - Customer master vertical slice. Scope and acceptance criteria are in PROJECT_STATE, "Exact next task". Not started.
