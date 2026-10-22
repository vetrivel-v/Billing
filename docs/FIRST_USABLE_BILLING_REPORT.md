# FIRST USABLE BILLING: milestone report

**This milestone is not the full Master Specification V2, and it is not approval for real business use.** R-040 (independent professional review of the GST reference data) is open. Every invoice this version can issue is a DEMO invoice unless a person deliberately switches real billing on after the checklist is met.

| Item                      | Value                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Milestone                 | Phase 1 Task 1.18: FIRST USABLE BILLING (the local commit that adds this file; `git log` gives its hash)                                                 |
| Previous commit           | Task 1.17 `ccb24f6` (amended during Task 1.17; see `git log` for the current hashes)                                                                     |
| Application version       | 0.0.1 (pre-release, no installer)                                                                                                                        |
| Database schema version   | `20261028000000_task_1_17_backup_recovery` (32 application tables, one view; Task 1.18 added no migration)                                               |
| Tests                     | 1301 tests passed in 90 files (unit and integration, including the real-Electron end-to-end); the final `verify:phase0` run is recorded in PROJECT_STATE |
| Coverage                  | 93.7% statements / 87.7% branches / 92.9% functions / 95.3% lines (thresholds 80/70/80/80 unchanged)                                                     |
| Production readiness      | NOT READY on a new installation; READY (the software's own checklist) after a tax review and a verified backup; real billing still off                   |
| GST reference data review | **Open (R-040).** A "review" in the software is the business's own confirmation, not a professional or government verification                           |

## What the software can do today (the exact supported workflow)

1. Start on an empty database and complete the **setup wizard**: business, address, GST registration, financial year, invoice numbering, first administrator.
2. **Sign in** (lockout, forced password change, idle timeout), see the **Dashboard**: DEMO figures labelled DEMO, recent invoices and payments, stock, backup status and the production readiness checklist, each section shown only if the role's permissions allow.
3. Maintain **customers**, **products** (goods and services, tracked or not) and the business's own **HSN/SAC list** (a new installation bundles none).
4. Record **opening stock** and later receipts and adjustments in an append-only stock ledger.
5. Review the **tax configuration** (a business confirmation), see the production checklist.
6. Create a **DEMO invoice**: choose customer and items, explicitly **confirm the place of supply**, preview the GST calculated by the TaxEngine, post. The invoice gets a permanent DEMO number, is immutable, and **does not change real stock**.
7. Open the invoice, **preview and save the A4 PDF** (marked DEMO on every page); print through the system dialog.
8. Record **DEMO payments** (partial or full, idempotent), see the derived balance and the receivables per customer.
9. Create an **encrypted backup**, **verify it** by restoring it into an isolated database, and (administrator) restore it for real with a safety backup.
10. Close and reopen the application: everything above persists.

## The complete end-to-end result

`tests/integration/fub-electron.int.test.ts` passes. It runs, in the **real Electron application** (real main process, preload and renderer served from `app://`, real API, real PostgreSQL that starts empty), two launches of the application that share one database:

- **Launch 1** drives the real screens through setup, sign-in, the empty Dashboard, a customer, an HSN code, a tracked product, opening stock (12), the tax review, a DEMO invoice (2 x 1,000.00 + 18% = 2,360.00, intra-state CGST 180.00 + SGST 180.00, place of supply confirmed first), the print preview, the saved PDF, a partial DEMO payment (1,000.00, balance 1,360.00), the rest (balance 0.00), the Dashboard with the figures, and a verified encrypted backup.
- **Database checks** (from the test, not the screens): one organization, one customer, one product; stock still **12** and the only stock movement is the opening stock (a DEMO invoice is not a stock event); one posted immutable DEMO invoice (an UPDATE is refused); two DEMO payments fully allocated; no production invoice or payment; one backup record with a PASS verification and an encrypted file.
- **The PDF** is read back from the file: it contains the invoice number, the customer, the totals and the DEMO marking, and was generated from the stored snapshot. It is deleted with its temporary folder at the end of the run.
- **Launch 2** is a new process with nothing in memory: setup stays completed, sign-in works, the customer, product and stock (12) exist, the invoice reports Paid with balance 0.00 from the persisted allocations, both payments are listed, DEMO receivables show the customer while real receivables are empty, the backup history and the verified status exist, the Dashboard shows the figures and the checklist (tax reviewed, backup verified: READY, real billing still off).
- It also asserts: no horizontal overflow at the real 1280 px window, no "Coming soon" entries, no Node in the renderer, no passphrase or control secret in the page or the service output.

**Real versus replaced:** the native save and print dialogs and the folder/file choosers are replaced by hooks that use a throw-away folder; the screens are operated from the main process with `executeJavaScript` and `@testing-library/dom` (Playwright is not installed). Nothing else is stubbed, and Electron's security settings are untouched.

## Other checks added in Task 1.18

- **Dashboard summary API** (`fub-api.int.test.ts`): empty-business zeros; DEMO and PRODUCTION counted separately and never summed (a PRODUCTION invoice and payment through the real gate seam beside DEMO ones); another organization's data never included; each standard role gets exactly the sections its catalogue permissions allow.
- **Permission matrix**: every guarded route (49 found in the route table) is called as each of the five standard roles: 403 without the permission, never 401/403/5xx with it. Expectations come from the permission catalogue, not from role names.
- **Dashboard screen** (`dashboard-real-api.int.test.tsx`): DEMO labelling, per-role sections, plain failure wording, and a sweep over ten screens proving SQL, Prisma, constraint names and stack traces never reach a person when the service fails.
- **Performance smoke** (modest, fictional, in-process API calls, no network or rendering): 2,000 customers, 2,000 products (152 tracked, 150 given opening stock), 120 DEMO invoices, 60 DEMO payments. Median (max) milliseconds over 9 runs: customers list 6 (22), customers search 6 (12), products list 6 (65), products search 9 (9), inventory list 7 (15), invoices list 7 (17), payments list 11 (21), receivables 6 (9), dashboard summary 24 (34). **Nothing larger was tried; no scale limit is claimed.**
- **Visual review** at 1000 and 1280 px (see below) found and fixed stale wording and header layout defects.

## Backup and restore

Task 1.17's engine is unchanged. In the journey the backup is created through the screen, verified by isolated restore (PASS recorded, readiness updated, the Dashboard shows "Verified"). Active restore is not part of the everyday journey; it stays covered by `backup-restore.int.test.ts` and the UI restore test.

## Security state

Launch secret on every API call; session tokens in memory only; Electron sandbox, context isolation and `app://` origin unchanged; no renderer file access (folder and file choosers go through the main process and a second secret); exact-permission authorization on every route, organization scope from the session, append-only audit rows for business and backup events; encrypted backups (AES-256-GCM, scrypt) with the passphrase never stored. No new IPC channel was added in Task 1.18. `npm audit`: 0 vulnerabilities. Not done: external penetration testing, code signing, an installer.

## R-104: test flakiness investigated

Earlier verification attempts failed on different unrelated tests. Findings (details and evidence in RISK_REGISTER R-104):

- **Electron exit crash (product code):** reproduced in isolation. `app.exit(1)` straight after start-up crashed Electron (exit 3221225477 or 2147483651) in 5 of 400 runs; with a half-second delay in `endProcess`, 0 of 600 crashed. Applied to every failure exit.
- **Fake-timer unit test (test race):** the tests advanced the fake clock before the session watcher's interval was registered. Reproduced under artificial CPU and memory load (2 of 20 runs failed); after the tests wait for the timers to exist, 0 of 30 failed under the same load.
- **jsdom screen test timeout and a fixture hook timeout:** not reproduced (the screen test passed 8 of 8 under the same load). Kept open with the captured failures; likely resource pressure on a machine with about 1 GB free memory.

## Open risks (the ones that matter for this milestone)

R-040 (GST reference data not professionally reviewed); R-097 and R-098 (backups kept on the same computer; a lost passphrase); R-099 to R-103 (restore side effects, scale, attachments, no scheduled backups); R-090/R-093/R-105 (no installed-app, printer, native dialog or external-drive verification); R-104 (intermittent test failures under load); R-106 (the READY checklist could be misread as certification). Full list: RISK_REGISTER.md.

## Known limitations (do not rely on any of these existing)

- **R-040:** the tax rates and categories are placeholders; no professional has reviewed them. Do not issue real tax invoices from this version.
- **Real billing is gated.** The shipped path issues DEMO invoices; switching on production billing needs the checklist and a deliberate step, and is not recommended before R-040 is closed.
- No **cancellation or credit notes**; no **returns or refunds**; no **payment reversal** or correction.
- Invoices and payments are **dated today only**; no backdating.
- No **saved drafts**: an invoice exists only once it is posted.
- No **services** on invoices; no shipping or other additional charges; no invoice-level discount (line discounts only).
- No **purchasing, expenses or accounting journals**, no GST returns or reports, no customer statements, no CSV import or export.
- No **marketplace or e-commerce integrations**, no e-invoice or e-way bill.
- No **installer** and no auto-update; the app is started from the project folder.
- **Not verified:** the native Windows print and save dialogs, a physical printer, a real external drive, the installed application (stand-ins were used; see the E2E section).
- No **remote access**, no multi-user networking, no cloud; one computer, one database.
- No scheduled or automatic backups; no point-in-time recovery; a lost passphrase cannot be recovered.
- Only the Administrator can restore; user administration screens beyond sign-in and password change are not built; role editing is not built.
- Performance was tried only at the modest volumes above.

## Visual review (1000 and 1280 px)

Screens inspected in a browser against the real API on fictional data: login, setup wizard (welcome), Dashboard, Customers, Products, Inventory, Tax, HSN/SAC, Billing list, New invoice, Invoice detail, Payments, Receivables, Backup & Recovery. Fixed: the Tax page still said a verified backup was "not available yet"; the New invoice and Billing empty-state wording and the invoice error text still described backup verification as the only blocker; the setup review page said backups "arrive in a later release"; page headers broke an invoice number across lines and put action buttons on their own row; button labels wrapped; invoice dates used the browser's US format while other screens use the Indian format. Not redesigned: nothing else.

## Requirements traceability

See REQUIREMENTS_MATRIX.md, section A2g13 and the First Usable Billing table, which separates **COMPLETE FOR FIRST USABLE BILLING**, **DEFERRED FOR PHASE 1 COMPLETION** and **FUTURE PHASE**. Deliberately deferred professional features are not marked complete.

## Commands executed on the final tree

`prisma validate`, `prisma generate`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run --coverage` (unit and integration, including the Electron end-to-end), `npm run build`, `npm audit`, `npm run verify:phase0` (all 8 gates).
