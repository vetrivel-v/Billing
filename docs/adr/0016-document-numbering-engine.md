# ADR-0016: Document numbering engine

- Status: Accepted and implemented in Phase 1 Task 1.5
- Date: 2026-10-18
- Builds on: ADR-0015 (setup transaction), spec sections 16, 17 and 35
- Note on the brief: the Task 1.5 instructions were cut off at section "G. RETRIES AND IDEMPOTENCY", so sections
  G onward were not received. The idempotency design below is my reading of that heading and is easy to adjust
  (risk R-058).

## Context

Posted documents need permanent, unique, correctly formatted numbers that survive concurrency, retries, failures and
configuration changes, without turning drafts into numbered documents and without making statutory claims.

## Decision

1. **Engine on the caller's transaction.** `@commercebill/numbering` exposes `allocate(tx, scope, { documentRef })`
   taking the transaction client of the posting operation. The counter update, the ledger row and (later) the posted
   document commit or roll back together. "Allocate, commit, then create the document" is not offered.
2. **Stable codes.** Sequences are identified by machine codes `INVOICE`, `CREDIT_NOTE`, `DEBIT_NOTE`,
   `PURCHASE_ORDER`, `PAYMENT_RECEIPT` (database CHECK: `^[A-Z][A-Z0-9_]*$`). Labels are display-only. A code only
   means a sequence may exist; no document workflow is created by it. (PROJECT_STATE called the last one "payment";
   `PAYMENT_RECEIPT` is the spec's document name and nothing used the old word.)
3. **Dimensions.** A sequence is unique per organization + document type + financial year + optional business
   location (existing unique constraint plus the NULL-location partial index). Per-location numbering is an
   organization setting (`numbering.scopeByLocation`, default false): when on, the location is required; when off, a
   location is rejected rather than ignored. Callers pass a `SequenceScope` object, so adding a future dimension
   means extending that type, the lookup and the unique index in one place - invoice logic that passes the scope
   through does not change.
4. **Format from configuration.** Printed number = prefix + zero-padded counter + suffix. Prefix/suffix are templates
   limited to letters, digits and `/ . _ -` plus the token `{FY}` (expanded from the financial year's label), at most
   40 characters; width 1-18; start number >= 1 and must fit the width. With reset policy `FINANCIAL_YEAR` the
   format must contain `{FY}` (numbers restart each year, so otherwise two years would print the same text); with
   `NEVER` it need not. Nothing like `INV/2026-27/000001` is hard-coded: that text is the default configuration
   `INV/{FY}/`.
5. **Reset policy and new years.** `FINANCIAL_YEAR` restarts at 1 in a new year; `NEVER` continues after the previous
   year's last number. `openFinancialYear` derives the new year's sequences from the previous year's active ones,
   idempotently, without touching the previous year's sequences or any issued number. Historical sequences stay
   queryable (`listSequences`); sequences are never deleted, only deactivated.
6. **History is frozen.** Every issued number is stored as printed in the append-only `document_number_allocations`
   ledger. Changing a prefix, width or year later affects only future numbers; re-requesting an old document returns
   its original text. The start number cannot change once a number has been issued.
7. **Drafts.** Drafts carry only an internal id. There is no draft-numbering path and no configuration switch for it
   (none is required): only posting calls `allocate`. Abandoned drafts therefore consume nothing.
8. **Rollback policy (no statutory claim).** If the surrounding transaction rolls back, the counter and the ledger
   row roll back too and the number is issued to the next document: failures create no gap. A committed allocation
   is permanent and is never reissued, even if its document is later cancelled or voided. No claim is made that
   gapless numbering is legally required; the design simply avoids gaps caused by failures and exposes
   `findGaps` to show any that appear (it can only be non-empty if database invariants were bypassed).
9. **Idempotency.** `documentRef` (the document's internal id) is unique per organization + document type. Asking
   again for the same document - after a retry, a timeout, or concurrently - returns the same number with
   `reused: true` and advances nothing. The same reference in a different sequence (another year/location) is a
   `document_already_numbered` error, so one document can never hold two numbers of the same type.
10. **Concurrency is a PostgreSQL guarantee.** `allocate` locks the sequence row with `SELECT ... FOR UPDATE`; there is
    no in-process lock. Independently, the database enforces: the counter may only advance by exactly one (first
    number = start number); identity columns are immutable; ledger numbers, printed texts and documents are unique;
    a ledger row must match its sequence and cannot exceed the counter; the ledger is append-only. A test runs a
    deliberately wrong allocator with no lock and shows the database still refuses to commit a duplicate; removing the
    lock from the real engine makes its concurrency tests fail.
11. **Setup.** First-run setup creates the five sequences for the first financial year inside its existing
    transaction from optional wizard answers (invoice prefix and start number, credit-note, debit-note, purchase and
    payment prefixes, width) with defaults `INV/{FY}/`, `CN/{FY}/`, `DN/{FY}/`, `PO/{FY}/`, `PAY/{FY}/`, width 6; the
    `numbering` setting is created; each creation is audited as `system:bootstrap`. The draft accepts the same
    non-secret fields; its `formatVersion` stays 1 because the addition is optional.

## Consequences

- Posting serializes per sequence (one transaction holds the row lock until it commits): fine for a small business,
  but a long posting transaction delays others (R-056). Callers must keep the transaction short and lock multiple
  sequences in a consistent order.
- Switching an organization to per-location numbering later requires creating location sequences first; allocation
  fails with `sequence_not_found` until they exist (R-057).
- Gap reporting works from the ledger; a document-level reconciliation (every posted document has a ledger row)
  arrives with the document tables.
- The ledger grows with every posted document; archival is a later decision.
