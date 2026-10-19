# Phase 1 - Task 1.10 Completion Report: Product Master Vertical Slice

## Visible functionality achieved

- **Products** in the sidebar (users with `product.read`): a list with server-side search (SKU, name, barcode, HSN/SAC), Active/Inactive/All, Goods/Services and Tracked/Not-tracked filters,
  paging of 25, and loading, empty, no-match and error states; prices are right-aligned rupee amounts with their GST basis ("incl. GST" / "+ GST").
- **New product** and **Edit product** on one form: Basic details (type Goods/Service, name, SKU, barcode, description), Classification (HSN/SAC picker over the real reference list, unit of measure),
  Tax (tax category with the "placeholder rates" notice), Pricing (selling price, MRP, "includes GST" / "does not include GST" with a rupee echo and no tax breakdown), Inventory settings (goods only).
- **Deactivate / Reactivate** with confirmation (nothing is ever deleted), a read-only view for users without `product.write`, and a clear message on a concurrent change.
- Reload / close and reopen: products persist (real PostgreSQL).

## Requirements checked

| Brief item                                                                                | Result                                                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Minimum sellable-item model; exact decimals; no tax calculation                           | done; ADR-0021; prices are decimal strings end to end                                      |
| Future variant guard documented without a premature table                                 | ADR-0021 decision 1 (default variant id = product id)                                      |
| GOODS / SERVICE rules; service never tracks inventory; kind immutable                     | CHECK + trigger + service + UI                                                             |
| SKU strategy (stable, organization-scoped, not the key, immutable)                        | generated `PRD-000001` or typed; per-organization counter; trigger                         |
| Reference data: unit, tax category, HSN/SAC by real ids; invalid/foreign/inactive refused | service + DB triggers; HSN list honestly reported empty (R-077)                            |
| No stock quantity or stock logic                                                          | no column, no field, no route; tested                                                      |
| Migration on clean and populated Task 1.9 database                                        | 8 migration tests; existing rows unchanged                                                 |
| API, authorization by exact keys, 401 vs 403, organization isolation                      | 32 HTTP tests incl. every role template and cross-organization attempts                    |
| Audit without unnecessary data; logs without prices/search terms                          | verified in rows and trace-level logs                                                      |
| Concurrency (409, UI Reload)                                                              | tested over HTTP, in components and in the real UI                                         |
| UI create / edit / search / filter / close-reopen on the real API                         | 11 real-UI tests                                                                           |
| Visual review                                                                             | done (list populated/empty, goods, service, validation, edit, inactive, read-only, widths) |

## Points to review

- **Decisions I made (change on request):** `kind` and `sku` cannot be edited; the tax category is required (every sellable item needs a tax treatment; "Nil rated" etc. are categories);
  HSN/SAC is optional (the reference list is empty); a unit is optional for services; MRP is included, purchase cost and reorder level are not (not in the approved scope); a product barcode is unique
  per organization; prices have two decimals (`numeric(18,2)` per ADR-0004).
- **PROJECT_STATE vs the brief on auditing prices:** the recorded criteria say price changes record before/after price; the brief says follow Task 1.9's privacy pattern. I kept price values
  (business configuration, needed for traceability) and excluded names, descriptions and barcodes. Easy to drop prices from audit rows if you prefer.
- **Defect found and fixed:** the New product/customer form released its submit lock before navigating away, so a late second click could save twice; now it stays locked until the page is gone (test added).
- **Layout fixes from the visual review:** a very long product name made the table wider than the window - names now wrap (also for customers); the Inventory column was shortened; padding tightened. At 1000 px
  the table scrolls horizontally by about 44 px; at 1100 px and above it fits.
- **Existing tests changed:** backup-spike table count 21 -> 23; the reference-seed test asserts the `products` table stays empty after seeding; the shell and Task 1.7 navigation tests count Products among built modules.
- **R-076 / process instability:** no timeout was raised. Three intermittent failures were investigated and each was a real race, not load: (1) the customer list real-UI paging test failed about 2 runs in 7 - the list pages reset the page in an effect that could run AFTER a click on Next and silently undo it (a genuine bug, also in the new Products list); fixed by resetting the page during render, with a regression test that also caught a flaw in my first fix; 12 of 12 repeat runs of both real-UI files passed afterwards; (2) a Task 1.8 wizard test asserted keyboard focus before the effect that sets it ran - it now waits; the three other focus assertions were made wait-safe too; (3) a late second click could create a second record (see Defect above). The nine `npm run db:start` processes from 2026-10-18 (R-076) were measured and are idle: 43-45 MB each, 0.09-0.53 s of CPU in total since they started, system CPU 2-9 percent; nothing was terminated.

## Tests

| Suite       | Count            |
| ----------- | ---------------- |
| Unit        | 432              |
| Integration | 395              |
| Total       | 827, all passing |

Coverage: 95.5% statements / 91.0% branches / 97.3% functions / 96.9% lines (thresholds unchanged 80/70/80/80; no timeout was raised in this task).
New: product validation and money unit tests, form model and rupee-format tests, 36 component tests, 8 migration tests, 32 HTTP integration tests, 11 real-UI integration tests.
Mutation checks: ten deliberate breaks (organization scope on get, version check removed, write needing only read, a third decimal place allowed, services allowed to track inventory, unit organization check removed, names added to audit rows, search wildcards live, UI converting prices through Number, read-only fields enabled) each made at least one test fail; the generated-SKU skip check was not separately mutated (it is covered by the same test as the customer code skip). Sources were restored and verified identical.

## Commands executed

`prisma generate`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run --coverage`, `npm run verify:phase0` (all 8 gates PASS, including the production build and Electron smoke test),
`npm audit` (0 vulnerabilities), 2026-10-19.

## Risks

- Opened: R-077 (open: HSN/SAC reference data), R-078 (accepted), R-079 (mitigating, see R-079).
- Unchanged: R-040 and R-053 (**open**), R-063 (deferred), R-074, R-076, R-070..R-072 and earlier.

## Exact next task

Task 1.11 - Inventory / stock ledger vertical slice. Scope and acceptance criteria are in PROJECT_STATE, "Exact next task". Not started.
