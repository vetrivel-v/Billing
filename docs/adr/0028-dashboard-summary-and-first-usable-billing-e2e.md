# ADR-0028: Dashboard summary and the First Usable Billing end-to-end harness

- Status: Accepted and implemented in Phase 1 Task 1.18. R-040 stays open; passing tests does not enable production billing.
- Date: 2026-10-22
- Builds on: ADR-0006 (Electron security baseline), ADR-0013 (renderer origin), ADR-0024/0026 (DEMO invoices and payments), ADR-0027 (verified backups)

## Dashboard summary

1. **One read-only endpoint, `GET /dashboard/summary`.** Every figure is computed by the database (grouped aggregates over `sales_invoices`, `payments`, the `invoice_balances` view, `stock_balances`) for the caller's organization only. The renderer never receives whole tables to aggregate.
2. **Sections follow permissions, never role names.** `sales.invoice.read` gives sales, receivables and recent invoices; `sales.payment.read` gives payments; `inventory.stock.read` gives stock; `backup.history.read` gives the recovery status; `tax.config.read` or `backup.history.read` gives the readiness checklist. A section the caller may not see is `null`, not zero.
3. **DEMO and PRODUCTION are never added.** The response carries `demo` and `production` objects side by side; the screen labels demo tiles "DEMO ..." in a coloured tile and shows real figures in a separate group only when real data exists or the mode is PRODUCTION.
4. **Nothing is invented.** No profit, margin, cost or accounting figure exists. "Stock" reports only tracked products with and without stock on hand, because no reorder levels exist.
5. **The readiness card reports the software's own gate honestly.** READY means the four technical requirements are met (tax review recorded, valid seller registration, HSN/SAC policy, verified backup); it does not mean the tax data is correct. The card says it is not a GST or legal certification, that the rates are placeholders until a professional has reviewed them (R-040), and that switching to real billing remains a deliberate step the person takes.

## End-to-end harness

6. **The real application.** The check runs the real Electron main process, preload and renderer served from `app://`, the real Fastify API and a real PostgreSQL database that starts empty. A driver script, bundled with esbuild and executed in the renderer by the main process (`runE2e`, enabled only by `ELECTRON_E2E=1` in an unpackaged build), operates the screens through labels, roles and buttons with `@testing-library/dom`. A real browser applies React updates after an event returns, so the driver waits a tick after each event.
7. **Two launches, one database.** The first launch runs setup through a verified backup; the second, a new process with nothing in memory, signs in and checks that the customer, product, stock, invoice, payments, balances, backup history and verified-recovery status persisted.
8. **What is real and what is replaced.** Replaced: the native save/print dialogs and the folder/file choosers (hooks answer with a throw-away folder). Everything else, including the IPC channels, the control-secret channel, the PDF renderer and the verification restore, is real. Playwright is not installed; adding a browser-driver dependency was not needed for this milestone. Security settings are not relaxed.
9. **PDF content is proved from the file.** `tests/e2e/pdf-text.ts` extracts text from the Chromium PDF (Flate streams, ToUnicode maps) so the test can assert the invoice number, customer, totals and the DEMO marking come from the stored snapshot.
10. **Exit codes.** Failure exits in the desktop shell go through `endProcess`, which waits half a second before `app.exit(code)`. Calling `app.exit(code)` immediately intermittently crashed Electron on Windows (about 1 in 100 isolated runs; 0 of 600 with the delay). It is a mitigation for a start-up race inside Electron (R-104).

## Consequences

- The checklist can read READY while R-040 is open; the wording must keep saying so (R-106).
- The driver depends on visible labels and roles, so a screen rename breaks it on purpose.
- The harness is test-only code in `main.ts`, like the earlier smoke modes; it is unreachable in a packaged build.
