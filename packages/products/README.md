# @commercebill/products

Product master (Task 1.10): pure validation (`validate.ts`, shared with the UI), the organization-scoped service (`service.ts`)
with optimistic concurrency, audit events, generated SKUs and reference lookups. A product stores tax CONFIGURATION (HSN/SAC and a
tax-category reference) only: no tax is calculated here (Task 1.12) and there is no stock quantity (Task 1.11). Products are never
deleted. All money is an exact decimal STRING: it is never converted through a JavaScript number.
