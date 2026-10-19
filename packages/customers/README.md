# @commercebill/customers

Customer master (Task 1.9): validation (`validate.ts`, pure), the organization-scoped service (`service.ts`) with
optimistic concurrency, audit events and generated customer codes. The package records customer FACTS (including GST
status and place of supply); it makes no tax decision (Task 1.12) and never deletes a customer.
