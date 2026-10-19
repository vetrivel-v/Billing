# ADR-0021: Product master and the sellable-item identity

- Status: Accepted and implemented in Phase 1 Task 1.10
- Date: 2026-10-19
- Builds on: ADR-0004 (exact money), ADR-0020 (customer master pattern), spec section 13

## Decisions

1. **`products.id` is the sellable-item identity (no separate table yet).** Invoice lines and stock movements will reference the product id. Product variants (DEF-04) are
   deferred. When they arrive, a `product_variants` table is added and every EXISTING product receives exactly one default variant whose id EQUALS the product id (a data-only
   migration step). Lines and stock rows that already reference that id therefore remain valid and keep their meaning, with no rewriting of posted documents or stock history, and
   new lines can reference any variant id. A separate sellable-item table now would add a join, a second id and a second place for the SKU and price to live, for a feature that does not
   exist yet; the equal-id rule gives the same safety without it.
2. **Id and SKU are different things.** The key is an internal UUID. The SKU is the human-facing code: unique per organization, **immutable after creation** (a database trigger; posted
   documents will also snapshot it), normalised as trimmed + NFC + UPPER-CASE (pattern `[A-Z0-9][A-Z0-9._/-]{0,39}`), generated as `PRD-000001...` from a locked per-organization counter
   or typed by the user. A generated SKU skips a number already typed by hand. Barcodes are optional, unique per organization, stored as typed.
3. **Kinds.** GOODS and SERVICE only (bundles and digital products are not part of this milestone). Goods need a unit of measure and may track inventory; a service never tracks inventory
   (CHECK) and so can never generate stock movements. The kind cannot change after creation (trigger): flipping it would silently re-meaning any stock or documents.
4. **Money is exact decimal text.** Prices (`numeric(18,2)`, ADR-0004) travel as strings from the form through the API and validation to the column and back to the display. The pure validator
   never converts through a JavaScript number; a JSON number is accepted only through its exact text and inexact ones (0.1+0.2) are refused; a third decimal place is refused rather than
   rounded; negatives are refused. No selling-price-versus-MRP rule is imposed (none is specified). The UI formats rupees by string grouping (Indian lakh/crore) with no arithmetic.
5. **Tax is configuration only.** A product references an HSN/SAC code and a tax category and carries a price-includes-tax flag. No rate is copied into the product (rates are effective-dated
   and owned by the tax tables) and no tax is calculated or displayed (Task 1.12). The form says the rates installed with CommerceBill are placeholders (R-040).
6. **References are real and organization-scoped.** Units and tax categories are chosen by id from the caller's own organization's active entries; another organization's id is refused with the
   same answer as an unknown id, and triggers enforce it for any writer. An HSN code is required to be an HSN entry for goods and a SAC entry for services. A retired unit or category is refused only
   when a product is newly pointed at it, so existing products keep working. The HSN/SAC list is a global reference list that is EMPTY today (R-077): the product form says so and the code stays optional.
7. **No stock on the product.** There is no quantity column; the Task 1.11 ledger will be the only source of stock truth. Creating or editing a product never creates stock.
8. **Never deleted; concurrency.** No DELETE route and a trigger forbids deletion; products are deactivated/reactivated. PATCH and activate/deactivate carry the loaded `version`; a stale one is 409
   `DB_0002` and the UI offers Reload.
9. **Audit and logs.** `product.create|update|deactivate|activate` (category business). Update rows record changed field NAMES and values only for price, MRP, price basis, tracking, tax-category,
   unit and HSN/SAC identifiers and the active flag (price traceability is the purpose); names, descriptions and barcodes are never audited. Logs never contain prices, names, barcodes or search terms.
10. **Authorization.** `product.read` for list/get/reference lookups, `product.write` for create/edit/activate/deactivate, by exact key; organization always from the session.

## Consequences

- Deferred (DEF-13): variants, purchase cost/margin, reorder level, price lists, categories/brands, images, bundles, import/export, price history, a reviewed HSN/SAC data set.
- An effective-dated price history can be added later without touching posted documents, which snapshot their lines.
