# Phase 1 - Task 1.16 Completion Report: Payments and Receivables

**Demo payments are not money. R-040 stays open; production billing stays unavailable until Task 1.17.**

## Visible functionality achieved

Open an invoice: see the grand total, what has been paid and the balance (worked out by the server), the payment history and **Record payment**. Record a partial or full payment; a payment beyond the balance is refused with the balance due; a double click or a lost answer cannot record twice. **Payments** lists recorded payments; **Receivables** shows invoiced, paid and outstanding per customer and per invoice. Everything on a demo invoice is marked DEMO and is not real money.

## Requirements checked

T116-01 to T116-10 in REQUIREMENTS_MATRIX; the exact Task 1.16 acceptance criteria in PROJECT_STATE; ADR-0026.

## Points to review

- Production payments exist only for production invoices, which the shipped app cannot create yet; they are tested through the injected gate seam (R-087).
- A recorded payment cannot be corrected (R-094); payments are dated today and one invoice at a time (R-095).
- A first version of the recording service computed the balance in the locking statement and let two concurrent payments both pass the check; the database constraint refused the over-allocation and the test caught it. The balance is now read in a second statement after the lock (see ADR-0026).
- The seventh setup numbering sequence (`DEMO_PAYMENT_RECEIPT`) changed setup, numbering and dump expectations; the invoice list gained Balance and Payment columns (Status removed).
- Visual review used the Vite dev server in the browser pane (not the installed app; R-090).

## Tests

1230 tests passed in 79 files; coverage 94.3% statements / 89.1% branches / 93.7% functions / 95.7% lines. New: payments.int.test.ts (26), payments-real-api.int.test.tsx (13), payments migration test (2), payments unit tests (6), web payment model tests (10).

## Commands executed

`prisma generate`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run --coverage`, `npm run verify:phase0` (all 8 gates, on the final tree), `npm run build`, `npm audit`.
