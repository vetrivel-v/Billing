# ADR-0026: Payments and receivables (append-only allocations)

- Status: Accepted and implemented in Phase 1 Task 1.16. R-040 stays open; demo payments are not money.
- Date: 2026-10-21
- Builds on: ADR-0024 (Option A receivable), ADR-0016 (numbering), ADR-0025 (DEMO philosophy)

## Decisions

1. **No stored balance.** `balance due = invoice grand total - sum(allocations)`, derived by the database (the `invoice_balances` view and the same arithmetic inside the recording transaction). The invoice stays immutable; its display state (UNPAID, PARTIALLY_PAID, PAID) is derived, never written. The request carries no balance, amount already paid, customer or organization.
2. **Append-only payments and allocations.** `payments` and `payment_allocations` refuse UPDATE, DELETE and TRUNCATE for every writer. A posted payment cannot be edited or deleted; correction (reversal, refund, adjustment) is a future task and the screens say so. A payment is always fully allocated at creation (allocations sum to its amount); the schema allows several invoices per payment, the API records one.
3. **Over-allocation protection in the database.** The service locks the invoice row (`FOR NO KEY UPDATE`, in its own statement; the balance is read by a second statement because under READ COMMITTED a statement that waited for a lock keeps its old snapshot) and a deferred commit-time constraint re-checks `sum(allocations) <= grand total` after taking the same lock. Two concurrent payments are serialized: exactly one succeeds. (The integration test found the snapshot problem the first time it ran; the constraint had already refused the over-allocation.)
4. **DEMO payments are separate records.** `is_demo`, the `DEMO_PAYMENT_RECEIPT` number series (`DPAY/{FY}/`), allocatable only to DEMO invoices; a production payment only to production invoices (checked by the service and by a database trigger); never part of production receivables; never convertible. `mode` is explicit on every request and must match the invoice.
5. **Idempotency.** `UNIQUE (organization, post_operation_id)` plus the canonical request fingerprint: the same operation and content returns the original payment (HTTP 200, no new rows, number or audit); the same operation with different content is `OPERATION_ID_REUSED` (409).
6. **Transaction.** Advisory lock on the operation, replay check, invoice lock, validation (mode, amount, date, balance), number from the existing numbering ledger, payment, allocation, audit `payment.create`, COMMIT with deferred constraints (number issued by the ledger; payment fully allocated; no over-allocation). Any failure leaves no payment, allocation, number or audit row.
7. **Date and methods.** The payment date is the current business date only (a supplied date must equal it); backdating is deferred. Methods: CASH, BANK_TRANSFER, UPI, CARD, CHEQUE, OTHER; a reference is required for bank transfer, UPI and cheque; a reference that looks like a card number (13-19 digits passing the Luhn check) is refused; no card numbers, PINs or credentials are ever collected.
8. **Receivables views.** Per customer (invoiced, paid, outstanding) and per invoice, for production or for demo (never mixed), computed by the server.
9. **Audit and logs.** One `payment.create` row with facts only (no reference or notes); logs carry no payment content.
10. **Permissions.** `sales.payment.read` reads, `sales.payment.record` records; Warehouse Operator has neither.

## Consequences

- Payments cannot be corrected until reversal/refund exists (R-094). Receipt PDFs, customer statements and age buckets are later work.
- Production payments exist only for production invoices, which the shipped application cannot yet create (gate: Task 1.17); they are tested through the injected-gate seam.
