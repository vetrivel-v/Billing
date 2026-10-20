# @commercebill/inventory-engine

Status: implemented in Phase 1 Task 1.11 (ADR-0022). Physical stock QUANTITY only: no cost, valuation or tax.

- `postStockMovement(tx, input)` - the only way stock changes. It runs INSIDE a caller-owned Prisma transaction (it never commits), so invoice posting (Task 1.13) can call it as one step of its own transaction.
  Positive quantity in; the movement type decides the direction. Returns the posted movement and the balance after it, or throws `StockError` (value-free problems).
- `reconcileBalances(db, organizationId)` - integrity check: every `stock_balances` row against the sum of its ledger rows. Empty = consistent.
- `createInventoryService(...)` - stock list, movement history, warehouses and the three manual operations (opening stock, manual receipt, adjustment) with their audit rows.
- `parseQuantity`, `addQuantities`, `compareQuantities`, `formatQuantity`, `validateOperation` - exact decimal-string quantity helpers and request validation, also exported from `/browser` for the UI (the server never trusts them).

Rules enforced by the database as well as here: tracked goods only, same-organization product and warehouse, quantity within the unit's decimal places (refused, never rounded), no negative stock, opening stock before any other
movement, append-only ledger, balance writable only by the ledger trigger, one posting per `(organization, source type, source ref, source line ref)`.
