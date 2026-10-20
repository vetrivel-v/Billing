# Phase 1 - Task 1.14 Completion Report: Billing UI and Invoice Preview/Posting

**Billing works end to end in DEMO mode only. R-040 stays open; production billing stays unavailable until Task 1.17.**

## Visible functionality achieved

Billing -> New invoice -> choose customer -> add items and quantities -> optional line discount -> confirm the place of supply -> Preview (server-calculated GST) -> Post demo invoice -> permanent DEMO number -> read-only invoice with the immutable snapshot. Posting a demo invoice does not change the Inventory screen. The Invoice List has search, type and date filters and paging; viewers can list and open invoices but cannot compose or post.

## Requirements checked

T114-01 to T114-10 in REQUIREMENTS_MATRIX; the exact acceptance criteria recorded in PROJECT_STATE after Task 1.13.

## Points to review

- The list shows taxable value and GST, so `InvoiceSummaryView` gained `taxableSubtotal` and `taxTotal` (additive). GST classification (B2B/B2C) is not in the list.
- The UI never offers PRODUCTION; `PRODUCTION_GATE_NOT_MET`, `MODE_MISMATCH`, `INSUFFICIENT_STOCK` and the other stable codes have wording (unit-tested), but only the demo paths are exercised end to end in the UI (production posting remains covered at the API level, Task 1.13).
- The invoice date is shown as "Today" (the server decides it, Asia/Kolkata).
- Visual review used the Vite dev server in the browser pane at 1000 and 1280 px; the packaged Electron shell was not re-inspected (R-090).
- A demo invoice cannot be voided (immutable); R-091 records the risk of mistaking it for a real invoice, to be handled by Task 1.15 watermarks.

## Tests

1118 tests passed in 70 files; coverage 94.5% statements / 89.7% branches / 94.5% functions / 95.9% lines. New: billing-real-api.int.test.tsx (11), model.test.ts (10); shell navigation tests updated.

## Commands executed

`npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run --coverage`, `npm run verify:phase0` (all 8 gates), `npm run build`, `npm audit`.
