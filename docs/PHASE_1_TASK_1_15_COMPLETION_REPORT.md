# Phase 1 - Task 1.15 Completion Report: A4 Invoice PDF, Print Preview and Printing

**A PDF does not make a DEMO invoice a production invoice. R-040 stays open; production billing stays unavailable until Task 1.17.**

## Visible functionality achieved

From an invoice: **Preview / Print** shows the A4 document exactly as it prints; **Print...** opens the system print dialog; **Save PDF** asks where to save. The document is built only from the posted snapshot, so reprinting an old invoice after the customer, product, price or tax changed gives the identical document. Every demo document carries the DEMO marking on every page.

## Requirements checked

T115-01 to T115-09 in REQUIREMENTS_MATRIX; the exact Task 1.15 acceptance criteria in PROJECT_STATE; ADR-0025.

## Points to review

- **Packaged check (R-090):** verified in a production-like Electron run, not an installed app (no installer yet). The native dialogs and a physical printer were NOT used (R-093); the check replaces the two dialogs with hooks and renders and writes a real PDF.
- No audit row is written for preview, save or print (R-092).
- Amount in words was included because the recorded criteria required it. A production document with no taxed line is labelled INVOICE with a notice, not TAX INVOICE.
- Footer shows only the poster's name; bank details, signature and terms do not exist in persisted configuration and were not invented.
- Existing tests changed: the bridge mocks in older UI tests gained the two new bridge methods; the Electron shell test now asserts the bridge surface.

## Tests

1178 tests passed (587 unit + 591 integration); coverage 94.6% statements / 89.7% branches / 94.6% functions / 96.0% lines. New: document-engine unit tests (35), IPC/guard-rail tests (11), invoice-pdf integration (9), production-like Electron flow (1), Billing UI document tests (4).

## Commands executed

`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run verify:phase0` (all 8 gates, on the final tree), `npm run build`, `npm audit`.
