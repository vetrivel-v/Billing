# Post-FUB Usability Task 1: Business Profile and Settings UX: Completion Report

Date: 2026-10-23. Decision record: [ADR-0030](adr/0030-business-profile-and-settings-layout.md). Not started and not to be started here: invoice correction, credit notes, returns, refunds, payment reversal, production jobs, BOM, purchasing, marketplace integration, remote access. R-040 stays open; production billing is not enabled.

## 1. The problem and the fix

After first-run setup there was no screen to correct seller details, so Production Readiness could show "Seller GST registration recorded and valid: NOT READY" with no way out. There is now **Settings, Business Profile**; an administrator enters or corrects the GST registration status and GSTIN, presses Save, and the Dashboard reflects the persisted facts immediately. Each unmet readiness item that the application can correct has a **Fix** link to the right screen.

## 2. Inspection findings (before changing anything)

- GST facts exist on both the **organization** (status, GSTIN, state) and the **primary business location** (GSTIN, state, address). Invoicing reads the location first; the production gate reads the organization. The authoritative model is documented in ADR-0030: both are always saved together in one transaction; other locations are untouched.
- The readiness check judged the GSTIN with its **own shape-only pattern**, while setup also checked the check character: two rules. Now one shared rule set (`sellerRegistrationProblems`) serves setup, the profile (server and browser) and readiness (`sellerGateProblems`). The tax engine's copy was removed. Consequence: a GSTIN that is well-shaped but has a wrong check character is now not ready (test fixtures were changed to a valid fictional GSTIN; real data could never have contained such a value).
- The tax-review fingerprint excludes seller identity by design (the seller requirement is evaluated on every read), so a profile change never makes a review stale; documented and tested. No invalidation rule was invented.
- Existing keys `org.settings.read` / `org.settings.update` fit; **no new permission**.

## 3. What was built

`GET`/`PUT /business-profile`; `packages/setup` business-profile service and seller rules; web Settings landing, Business Profile page, Fix links on the Dashboard and Tax pages; shell/layout fixes; tests; documents.

## 4. Settings layout defects (root causes)

1. The shell's `<main>` was not positioned, so absolutely positioned screen-reader text sat outside the window and stretched the document: the Dashboard and Tax pages measured 981 px and 861 px in a 700 px window (a blank strip and a second scrollbar). Fixed: `<main>` is `relative`, the shell clips, only the content area scrolls (measured 700 = 700 afterwards).
2. Card grids changed to two columns at a window width of 1280 px, but the page beside the sidebar is about 220 px narrower, so 1000 px windows got one long column; cards also stretched to the tallest card in their row. Fixed with `CardGrid` (columns follow the area width, natural card heights).

Visually reviewed with fictional data in the in-app browser at 1000 x 700, 1280 x 800 and 1280 x 900: Settings landing, Business Profile (including the GSTIN error and the saved state), Production Readiness before (seller NOT READY) and after (seller ready) the correction, and the Backup & Recovery, About, Tax and Dashboard pages. At 1280 x 900 the Business Profile fits without scrolling.

## 5. Tests

- `tests/integration/business-profile.int.test.ts` (21 tests, real API and PostgreSQL): load, valid save, name and address persistence, organization and location kept in step, invalid GSTIN (shape and check character), registered without GSTIN, unregistered with GSTIN, state and PAN mismatch, unknown state, stale version, duplicate location name, no-op save writes nothing, **rollback of both records**, 401 and 403 per role, organization isolation, audit content, no seller data in trace-level logs, readiness changes after a correction, fingerprint unchanged, **posted invoice seller snapshot unchanged**, persistence in a new application instance.
- `tests/integration/business-profile-ui.int.test.tsx` (9 tests, real screens against the real API): Settings groups, load, client and server validation messages, save, readiness Fix links (seller to Business Profile, backup to Backup & Recovery, tax review to Tax Configuration), no Fix for a met item, read-only view, close and reopen.
- `packages/setup/src/seller-rules.test.ts`, `apps/web/src/layout.test.tsx`.
- Regressions run and green: setup, setup wizard, tax configuration and tax UI, invoices and production invoices, invoice PDF, dashboard, backup UI, authorization matrix, customers, First Usable Billing API and Electron end-to-end, Electron shell and backup. Updated for the new wording: the Settings link names in the end-to-end driver and the desktop backup driver.

## 6. Final verification

See the hand-over message for the commit hash and the `verify:release` result on the committed tree.

## 7. Roadmap recorded (not built)

The clarified business (made-to-order custom manufacturing, not buy-and-resell) is recorded in PROJECT_STATE and the requirements matrix (DEF-16 to DEF-18): Sales Orders, Order Source / Channel, customization requirements, design and attachment references, Made-to-Order products, Raw Materials, Components, Packaging materials, BOM, Production Jobs, material consumption, waste and reprint tracking, production status, raw-material procurement, marketplace order ingestion and external SKU mapping.

## 8. Known limits

Phone, email, website, bank details and logo are still not stored (DEF-11) and are listed on the screen as such. Only the primary location is editable. A correctly formatted GSTIN is not proof of a genuine registration (R-118). New risks R-118 to R-121.
