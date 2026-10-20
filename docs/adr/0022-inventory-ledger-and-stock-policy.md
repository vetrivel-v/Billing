# ADR-0022: Inventory is an append-only ledger with a trigger-maintained balance

- Status: Accepted and implemented in Phase 1 Task 1.11
- Date: 2026-10-20
- Builds on: ADR-0004 (exact decimals), ADR-0021 (sellable-item identity), the numbering ledger (Task 1.5) and spec sections 13 and 15

## Decisions

1. **Truth is the ledger.** Every physical stock change is one immutable row in `stock_movements` (signed `quantity_delta`, organization, warehouse, product, movement type, business date,
   actor, source identity, optional reason/reference/note). Nothing in the product table, the API or the UI can set a quantity: there is no `UPDATE`-a-balance route, and no
   `products.quantity`. Database triggers refuse `UPDATE`, `DELETE` and `TRUNCATE` of the ledger for any writer; there is no PATCH or DELETE route. A mistake is corrected with another,
   opposite movement (an adjustment).
2. **Movement types now, and room for later.** `OPENING_STOCK`, `STOCK_RECEIPT`, `ADJUSTMENT_INCREASE`, `ADJUSTMENT_DECREASE`. The type is a text column guarded by a CHECK (not a PostgreSQL enum),
   so Task 1.13 and later add `SALES_DISPATCH`, `CUSTOMER_RETURN`, `SUPPLIER_RETURN`, `TRANSFER_OUT/IN`, `DAMAGE`, `LOSS`, `FOUND`, `BUNDLE_*`, `SALE_RESERVATION`, `RESERVATION_RELEASE`,
   `RETURN_TO_ORIGIN` by widening the CHECK in a forward migration (an enum value cannot be removed again). The direction is implied by the type (a CHECK ties the sign to the type), so a caller
   gives a positive quantity and can never flip a direction by mistake.
3. **Balance strategy: option B, a projection that cannot drift.** `stock_balances (warehouse, product)` holds stock on hand. It is written ONLY by a trigger on the movement insert, in the same
   statement and transaction, under that row's lock; a second trigger refuses any write that does not come from that trigger (`pg_trigger_depth() < 2`), so the balance is not independently
   editable. It is not an authority: `reconcileBalances()` compares every balance with the ledger sum and the tests deliberately corrupt a balance to prove the check sees it. A rebuild
   from the ledger is a plain `SUM` per (warehouse, product). Summing the ledger on every read (option A) was rejected: invoice posting needs the current quantity inside its own locked transaction,
   and a projection gives that without a scan.
4. **Precision.** Quantities are `numeric(18,4)` (14 integer digits, 4 decimals), held as decimal STRINGS from the form to the column and back: never a JavaScript number. A unit may allow fewer
   places (PCS 0, KG 3, M 2): a value with more places than the unit allows, or than 4, is REFUSED, never rounded. One movement is limited to 12 integer digits. Display removes needless zeros
   (`2.5`, not `2.5000`) and groups in the Indian style.
5. **Negative stock is not allowed (policy for Task 1.13).** `stock_balances.quantity_on_hand >= 0` is a CHECK on the one row every movement of a (warehouse, product) must update, so two
   simultaneous decreases cannot both succeed: the second waits for the first row lock, re-reads the new quantity and fails. The refusal is transactional (no movement, no balance change,
   no audit row). Invoice posting (Task 1.13) therefore cannot oversell tracked goods; a later organization setting may relax the rule by migrating this CHECK.
6. **Only tracked goods have stock.** A service, or goods with `track_inventory = false`, can never receive a movement (trigger and engine). Task 1.13 must therefore treat an invoice line for such an item
   as having NO stock effect (no movement is created, none is expected). A product that has stock history keeps its unit and its inventory tracking (trigger + friendly product error), because changing
   them would change the meaning of, or hide, recorded quantities. Inactive products keep their stock and may still be adjusted.
7. **Warehouse.** Every row carries `warehouse_id` and the balance key is (warehouse, product), so multi-warehouse support needs no rewrite of history. Task 1.11 shows the one primary warehouse created at
   setup; no warehouse management UI (DEF-09). A warehouse and a product must belong to the movement's organization (application check and database trigger).
8. **Opening stock is the first record.** It is allowed only while the (warehouse, product) has no movement at all (checked by the engine and, under the same advisory lock, by a trigger); afterwards a
   correction is an adjustment. Five simultaneous opening stocks produce exactly one.
9. **Idempotency.** `UNIQUE (organization, source_type, source_ref, source_line_ref)` is the identity of a logical event. Manual operations use source type `MANUAL` and the client's operation id (the form
   creates one per entry; an unchanged retry reuses it, an edit starts a new one). The engine looks the identity up under the stock lock: the same content returns the original movement with
   `replayed: true` (HTTP 200, no second movement, no second audit row); the same id with DIFFERENT content is refused (409 `operation_id_reused`). Task 1.13 will use source type `SALES_INVOICE` with the
   invoice id and line id.
10. **Concurrency uses PostgreSQL, not a JavaScript lock.** A transaction-scoped advisory lock per (warehouse, product) serializes the engine check and the insert; the balance row lock and the CHECK are the backstop
    for any other writer. Tests run genuinely parallel requests: 40 receipts add up exactly; two decreases of 4 from 5 give one success and a final 1 (5 rounds); 12 decreases of 1 from 5 give exactly 5 successes;
    10 identical retries record one movement.
11. **The engine joins the caller's transaction.** `postStockMovement(tx, input)` in `@commercebill/inventory-engine` never opens or commits a transaction: Task 1.13 calls it inside the invoice's own transaction
    (validate, number, post invoice, dispatch stock, create receivable, COMMIT). It returns the posted movement and the balance after it, or a `StockError` with value-free problems. Auditing is the caller's job
    (the manual service audits; the invoice will audit itself).
12. **Authorization and isolation.** Reads use `inventory.stock.read`; the three operations use `inventory.adjustment.create` (so Viewer/Auditor, Billing Operator and Accountant read only; Administrator and
    Warehouse Operator write; the tests derive the expectation from the permission catalogue, not from role names). The organization always comes from the session. Another organization's product, warehouse or
    movement is "unknown" (400 for a body reference, 404 for a read), and a trigger refuses it for any writer. No inventory endpoint returns cost, margin, price or value.
13. **Audit and logs.** `inventory.opening_stock`, `inventory.receipt`, `inventory.adjustment` (category business) with movement id as the entity, and product id, warehouse id, movement type, signed quantity,
    business date and reason code. Reference and note stay in the ledger row only. Logs carry paths without query strings and never a quantity, note, reference, search term or token.
14. **No valuation.** No cost, FIFO, weighted average, COGS or stock value; Task 1.11 is physical quantity only.

## Consequences

- Task 1.17 (backup/restore): the balance protection trigger refuses a plain `INSERT` into `stock_balances`. A schema-then-data restore (triggers created last) works; a data-only restore must load the ledger and let the
  trigger rebuild, or run `reconcileBalances()` afterwards. R-080 records this for that task.
- Deferred (DEF-14): stock counts, transfers, reservations, serial/batch, costing and valuation, reorder levels and alerts, approval workflow for adjustments (`inventory.adjustment.approve`), warehouse management UI, CSV import,
  a running balance column in the ledger view (a running balance cannot be shown correctly from one page of a paginated history; the view shows the current stock instead).
