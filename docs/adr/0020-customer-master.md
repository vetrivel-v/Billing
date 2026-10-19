# ADR-0020: Customer master domain model

- Status: Accepted and implemented in Phase 1 Task 1.9
- Date: 2026-10-19
- Builds on: ADR-0014 (authorization), ADR-0016 (numbering), ADR-0018/0019 (UI), spec section 12

## Decisions

1. **Id and code are different things.** The primary key is an internal UUID. `code` is the human-facing identifier: unique per organization, immutable once created
   (database trigger), generated as `CUS-000001...` from a locked per-organization counter (`customer_code_counters`) or typed by the user (upper-cased, pattern
   `[A-Z0-9][A-Z0-9._/-]{0,29}`). A generated code skips a number already typed in by hand. The counter lives in the creating transaction, so a rolled-back creation
   returns its number and concurrent creations cannot collide. The numbering engine of Task 1.5 is for financial documents (financial-year scoped) and is not reused.
2. **Types.** `B2C` and `B2B` only (a CHECK that a later migration can widen when marketplace/reseller types are designed). A B2C customer is always GST unregistered.
3. **GST facts, not tax decisions.** The customer stores GST status (registered / unregistered / composition, the same enum as the organization), GSTIN, PAN, billing and
   shipping state codes and a **place-of-supply state code**. Registered requires a GSTIN; unregistered must not have one; composition may. A GSTIN is checked for format,
   check character and consistency with the billing state and the PAN, and is unique per organization. There is no portal verification and the UI says so (R-074). The tax
   engine (Task 1.12) reads these facts; this slice computes no tax.
4. **Place of supply.** Defaults to the delivery state (billing state, or the shipping state when delivery differs) and follows an address change unless it was set
   explicitly. The stored value is explicit so later documents can snapshot it.
5. **Addresses.** One billing address plus an optional shipping address stored in the same row (`shipping_same_as_billing` flag; shipping columns are NULL when the flag is
   true, enforced by a CHECK). State is stored as the two-digit code only; names come from the reference list (no drift). Addresses can later move into a table without
   changing customer identity.
6. **Never deleted.** Customers will be referenced by posted documents. There is no DELETE route and a trigger rejects DELETE; customers are made inactive and can be
   reactivated. Inactive customers stay readable and editable and are hidden from the default list.
7. **Concurrency.** `version` optimistic concurrency: PATCH and activate/deactivate carry the version the caller loaded; a stale version is a 409 `DB_0002`, the UI explains it
   and offers Reload. A PATCH that changes nothing creates no version and no audit row.
8. **Audit and logs.** Events `customer.create|update|deactivate|activate` (category business). Update rows record the changed field NAMES and only non-personal values; personal
   data is never written to the audit log. The request logger now omits query strings, because searches carry personal data (found by this task's tests).
9. **Search.** Server-side, parameter-bound (ORM) substring search over code, names, phones, e-mail and GSTIN with LIKE wildcards escaped; fixed ordering by name then code;
   paging <= 100. No query language.
10. **Authorization.** `customer.read` for list/get, `customer.write` for create/edit/activate/deactivate, by exact permission key; organization always from the session.

## Consequences

- Deferred (DEF-12): multiple shipping addresses, opening balance, price lists, tax exemption, marketplace reference, tags, attachments, statements, ageing, histories,
  credit-limit enforcement, merge, import/export.
- A very large customer set may need a trigram index (R-073).
