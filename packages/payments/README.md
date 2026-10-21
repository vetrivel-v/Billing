# @commercebill/payments

Task 1.16. Customer payments and receivables over the immutable invoices of Task 1.13.

- A payment is append-only and fully allocated to an invoice (the schema allows several invoices per payment later).
- There is no stored balance anywhere: `balance due = invoice grand total - sum(allocations)`, derived by the database.
- DEMO payments are separate records (own number series) that can only touch DEMO invoices and never enter production receivables. A demo payment is not money received.
- Recording is one transaction: lock the invoice, check the balance, take the number, write payment + allocation + audit; deferred database constraints re-check everything at COMMIT.
