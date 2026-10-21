# ADR-0025: Invoice document rendering and the desktop print/save IPC

- Status: Accepted and implemented in Phase 1 Task 1.15. R-040 stays open; a PDF does not make a DEMO invoice a production invoice.
- Date: 2026-10-20
- Builds on: ADR-0024 (immutable invoice snapshots), ADR-0018 (Electron shell security)

## Decisions

1. **Pure pipeline.** `InvoiceView` (the posted snapshot read from the API) -> `parseInvoiceSnapshot` (strict validation) -> `buildInvoiceDocument` (display view model) -> `renderInvoiceHtml` -> PDF. The package `@commercebill/document-engine` has no clock, I/O, network or script output, never recalculates GST or totals, and shows money only as decimal strings from the snapshot. The same HTML feeds the on-screen print preview and the PDF, so they cannot differ.
2. **Only the snapshot.** Documents never read current Customer, Product, Organization or tax master data. Reprinting a posted invoice after master-data changes produces byte-identical HTML.
3. **DEMO is not removable.** For a demo invoice the renderer always produces: an outlined `DEMO` watermark (fixed-position, so it is painted on every printed page), a banner, and `@page` margin-box text "DEMO - NOT A PRODUCTION TAX INVOICE" on every page. The functions take no options, so nothing can switch it off; the title is `DEMO INVOICE`. A production document never contains the word DEMO.
4. **No invented document types.** A production document with no taxed line is not titled TAX INVOICE: it is titled INVOICE with a notice that a Bill of Supply is not supported yet.
5. **Amount in words** (Indian terms, BigInt, from the stored INR total) is display only.
6. **IPC contract.** Two channels, `document:save-invoice-pdf` and `document:print-invoice`, each carrying one invoice SNAPSHOT. The main process checks the sender, validates the payload with the same schema, builds the HTML itself (a renderer-supplied `html` field is ignored), renders in a hidden window (JavaScript off, sandboxed, a throw-away in-memory session that cancels every non-`data:` request, no navigation or new windows), and chooses the destination only through the operating system save dialog (forced `.pdf`, a PDF magic-number check before writing). Print always opens the system print dialog (`silent: false`). Results are `{ status, fileName? }` and never contain a path. One output job runs at a time. The renderer gets no file-system, shell or navigation capability; the preload exposes exactly four methods.
7. **File names** come only from the document number, sanitized (no separators, `..`, control characters, Windows device names), prefixed `DEMO-` for demo invoices.
8. **No audit row per preview, save or print** in this task (R-092 records the open question); diagnostic logs carry no invoice content.
9. **Verification hooks.** An unpackaged-only check (`ELECTRON_DOC_SMOKE`, `ELECTRON_PDF_FIXTURE`) drives the real renderer and the real code path with the two native dialogs replaced; it is never active in a normal launch.

## Consequences

- Layout is tested by rendering real PDFs in Electron (page counts, per-page watermark) and by visual review; a physical printer and the native dialogs are not verified (R-093).
- Thermal 58/80 mm layouts, branding/templates, e-invoice QR/IRN, bank or UPI details and emailing are deferred.
