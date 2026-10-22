# Phase 1 - Task 1.18 Completion Report: FIRST USABLE BILLING

**This task integrates and proves the existing Phase 1 product; it adds no feature beyond the minimum Dashboard summary. R-040 stays open; every invoice this version issues is a DEMO invoice unless a person deliberately switches real billing on.** The milestone report is [FIRST_USABLE_BILLING_REPORT.md](FIRST_USABLE_BILLING_REPORT.md).

## Visible functionality achieved

The Dashboard now shows real, server-computed facts: DEMO sales today and this month, receivables outstanding, payments received today, recent invoices and payments, tracked-product stock, backup and recovery status and the production readiness checklist (READY or NOT READY, with wording that it is not a certification). The whole path from an empty database to a verified backup, and back after a restart, is proved in the real Electron application.

## Requirements checked

T118-01 to T118-09 and the First Usable Billing traceability table in REQUIREMENTS_MATRIX; the exact Task 1.18 criteria in PROJECT_STATE; ADR-0028.

## Points to review

- **READY is not approval.** After a tax review and a verified backup the checklist reads READY while R-040 is open; the wording on the Dashboard and the Tax page says so (R-106).
- **The end-to-end check is real but not Playwright:** a driver run from the Electron main process; the native dialogs are replaced by hooks (R-105).
- **A new installation has no HSN/SAC list.** The journey adds one code first; this is a product fact stated in the user guide.
- **Defects found and fixed:** stale "not available yet" / "arrives in a later release" wording on the Tax page, the New invoice and Billing screens, the setup review page and an invoice error message; page headers broke an invoice number and put buttons on their own row; button labels wrapped; invoice dates used a different format from the rest. A fake-timer test race and an Electron failure-exit crash were fixed with measurements (R-104).
- **R-104 remains open** for two load-sensitive tests that could not be reproduced (a jsdom screen test and a fixture hook); the evidence is in the risk register.

## Tests

1301 tests passed in 90 files; coverage 93.7% statements / 87.7% branches / 92.9% functions / 95.3% lines (thresholds 80/70/80/80 unchanged). New: `fub-electron.int.test.ts` (5), `fub-api.int.test.ts` (8), `dashboard-real-api.int.test.tsx` (4), `fub-performance.int.test.ts` (1).

## Commands executed

`prisma validate`, `prisma generate`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run --coverage`, `npm run build`, `npm audit`, `npm run verify:phase0` (all 8 gates, on the final tree).
