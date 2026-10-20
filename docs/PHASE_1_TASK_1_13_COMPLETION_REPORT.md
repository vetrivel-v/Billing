# Phase 1 - Task 1.13 Completion Report: Sales Invoice Domain and Posting Transaction

**This is implementation approval only. R-040 stays open; passing these tests does not enable production billing (`PRODUCTION` is refused until Task 1.17).**

## Visible functionality achieved

- API only (the billing screen is Task 1.14): preview an invoice, post it once, list and read posted invoices. Demo invoices get `DEMO/{FY}/` numbers, never touch stock and are not tax invoices.
- Setup now creates a sixth numbering sequence (`DEMO_INVOICE`); existing organizations receive one by migration.

## Requirements checked

T113-01 to T113-14 in REQUIREMENTS_MATRIX; decisions D1-D9 and the receivable Option A in ADR-0024.

## Points to review

- Production posting is proven only with an injected "backup/restore verified" fact in isolated test databases (R-087); the shipped application cannot reach it.
- A posted production invoice cannot be corrected until credit notes exist (R-088); backdating is deferred (R-086); the receivable is derived (R-089).
- The posted `SALES_DISPATCH` movement type is a new vocabulary item in the stock ledger; the old stock APIs cannot create it.
- Existing tests changed: setup (six sequences), numbering registry list, logical-dump table count (28).

## Tests

1097 tests passed (531 unit + 566 integration); coverage 95.2% statements / 90.5% branches / 96.2% functions / 96.6% lines. New: invoices.int.test.ts (37), invoices-production.int.test.ts (22: tracked dispatch, replay, insufficient stock, concurrent oversell, A-F failure injection, invariant refusals), migration test (3), unit tests (9). Mutation checks killed.

## Commands executed

`prisma generate`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run --coverage`, `npm run verify:phase0` (all 8 gates), `npm run build`, `npm audit`.
