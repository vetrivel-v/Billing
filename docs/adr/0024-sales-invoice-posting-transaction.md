# ADR-0024: Sales invoice domain and the posting transaction

- Status: Accepted (design approved 2026-10-20) and implemented in Phase 1 Task 1.13. **This is NOT professional tax approval (R-040 open) and does NOT enable production billing.**
- Date: 2026-10-20
- Builds on: ADR-0016 (numbering), ADR-0022 (inventory ledger), ADR-0023 (TaxEngine and production gate), spec sections 18-19

## Decisions

1. **Posted-only (D1).** There are no persisted drafts and no draft endpoints. The invoice is composed in the browser from choices only (customer, products, quantities, discounts, place of
   supply); `sales_invoices` holds nothing but immutable `POSTED` invoices. A permanent number exists only because a posting committed.
2. **Choices travel, facts do not (D9).** The request never contains a price, a tax rate, a total or an organization. The unit price and price basis come from the Product, the rate from the
   effective-dated tax tables, the totals from the TaxEngine and the organization from the session. A request with an unknown field is a malformed request.
3. **Preview writes nothing.** `POST /invoices/preview` reloads the authoritative facts, runs the engine and returns the calculation, its identity
   `{ inputHash, configurationFingerprint, grandTotal }`, warnings and advisory stock information. No number, stock, receivable or posting audit exists after a preview.
4. **Post is ONE database transaction, in this order (D2):** advisory lock on the operation id -> replay lookup -> authoritative reload -> validation -> TaxEngine recomputation -> stale
   comparison against the previewed identity (`CALCULATION_STALE`, 409, nothing written, the fresh calculation is returned) -> production stock effects (fixed product-id order) ->
   number allocation -> invoice header and lines -> audit `invoice.post` -> COMMIT (deferred constraints run). Stock is posted BEFORE the number so an oversell consumes no number, and any failure
   at any step rolls back stock, number, invoice and audit together (tested by injected failures at every step).
5. **Mode is explicit (D6).** `mode` is `DEMO` or `PRODUCTION` on every preview and post and is never inferred. `PRODUCTION` is refused with `PRODUCTION_GATE_NOT_MET` until the Task 1.12 gate is
   eligible (a current review, a valid seller and a verified backup/restore, which cannot exist before Task 1.17) AND the organization is switched to PRODUCTION; a DEMO request while the
   organization is in PRODUCTION is `MODE_MISMATCH`.
6. **DEMO invoices are inert (D3).** They take their number from the `DEMO_INVOICE` sequence (`DEMO/{FY}/`, created at setup and backfilled by the migration), carry `is_demo = true`, full snapshots
   and a `stock_effect` of `NONE` on every line, never call the stock ledger, have no receivable, are excluded from the `production_sales_invoices` view and cannot be converted. A demo
   preview may show an advisory stock warning only. Real inventory effects are tested with the injected production-gate fact in isolated databases; the real gate is not weakened.
7. **PRODUCTION invoices.** Each tracked-goods line posts one `SALES_DISPATCH` movement (new movement type, always negative, source type `SALES_INVOICE`, ref = invoice id, line ref = line id);
   untracked goods have no stock effect. Insufficient stock is `INSUFFICIENT_STOCK` (409) and nothing is written. Production invoices record the current tax review id.
8. **Bidirectional stock integrity (D8).** Deferred constraint triggers at COMMIT: a `DISPATCH` line needs exactly its matching `SALES_DISPATCH` (organization, invoice, line, product,
   warehouse, quantity); a `NONE` line must have none; every `SALES_DISPATCH` movement must belong to a `DISPATCH` line of a non-demo invoice. No demo invoice can own a dispatch.
9. **Date (D4).** The invoice date is the current business date in Asia/Kolkata only: no future dating and no backdating, in an open financial year. Backdating is deferred and needs its own
   policy and permission design.
10. **Mixed price basis (D5).** An invoice mixing tax-inclusive and tax-exclusive products is blocked with `MIXED_PRICE_BASIS`; nothing is converted and the TaxEngine is unchanged.
11. **Place of supply.** A suggestion alone is not postable. Post requires `placeOfSupply { stateCode, choice }` (`CONFIRMED` must equal the suggestion, `OVERRIDE` is required when
    billing and delivery states differ). The invoice stores the state, its source (`USER_CONFIRMED` / `USER_OVERRIDE`), the confirming user and the time. Opening a preview is never a
    confirmation: the screen of Task 1.14 must require an explicit user action.
12. **Idempotency.** `UNIQUE (organization_id, post_operation_id)`. The same operation id with the same canonical request returns the original invoice (HTTP 200, `replayed: true`: same number,
    no second stock movement or audit row); the same id with different content is `OPERATION_ID_REUSED` (409). The canonical request fingerprint is stored on the immutable invoice. The calculation
    identity is a freshness token, not content.
13. **Immutability and snapshots.** UPDATE, DELETE and TRUNCATE of headers and lines are refused by triggers; a line can only be inserted in the transaction that created its invoice (`xmin`
    check); there is no PATCH, PUT or DELETE route. Seller, customer, billing/shipping address, product, unit, HSN/SAC, tax category, rate, place-of-supply and the full calculation JSON are copied
    onto the invoice, so later master-data changes never alter a posted invoice.
14. **Receivable (Option A).** There is no receivable table. A production invoice stores its `grand_total` immutably; Task 1.16 adds append-only payment allocations, and
    `balanceDue = grandTotal - sum(allocations)`. A demo invoice has no receivable. There are no double-entry journals in this task.
15. **Audit.** One `invoice.post` row per posted invoice, in the same transaction, with facts only (number, type, demo flag, total, customer id, line count, operation id): no names, addresses or GSTINs.
    A replay or a preview writes none.
16. **Authorization.** `sales.invoice.write` previews, `sales.invoice.post` posts (a separate key), `sales.invoice.read` reads/lists. Organization scope comes from the session; another
    organization's ids are `not found`.

## Consequences

- A mistaken production invoice cannot be edited or cancelled until credit notes exist (not in scope): the correction path is a future credit note.
- Production billing stays impossible in the shipped application until Task 1.17 provides the verified backup/restore fact; the injected-fact test seam (`AppDeps.backupRestoreVerified`) is a
  default-false dependency, not a code branch in the posting path.
- Reports must read `production_sales_invoices` (or filter `is_demo = false`) so demo documents never reach GST or sales totals.
- The injected-failure tests use temporary triggers in isolated test databases; there is no test-only branch in the production code.
