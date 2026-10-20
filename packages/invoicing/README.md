# @commercebill/invoicing

Sales invoice domain (Task 1.13, ADR-0024): `preview` (no business writes), `post` (ONE transaction: authoritative reload, validation,
TaxEngine recomputation, stale comparison, production stock effects, number allocation, immutable invoice with snapshots, audit),
`list` and `get`. Posted-only: there are no drafts.

- DEMO invoices use the DEMO_INVOICE number series, never call the inventory engine and have no receivable.
- PRODUCTION invoices dispatch tracked goods (`SALES_DISPATCH`) and are refused until the production gate is met (Task 1.17).
- The browser supplies only choices (customer, products, quantities, discounts, place of supply, operation id, the previewed
  calculation identity). Prices, rates, totals and the organization are never taken from the request.
