# ADR-0012: Reference seed semantics, role matrix and tax placeholders

- Status: Accepted
- Date: 2026-10-18
- Task: Phase 1 Task 1.1

## Context

Phase 1 needs the permission catalogue, the five role templates (spec section 11), default units and tax
categories/rates before the setup wizard and authentication exist. The seed must be safe to run repeatedly
against a database that administrators may already have customised, must be all-or-nothing, and must not make
statutory claims (spec section 4).

## Decision

1. **Insert-if-absent only.** Every insert uses `ON CONFLICT DO NOTHING` (Prisma `createMany` with
   `skipDuplicates`) against the natural keys. Existing rows are never updated, deleted or recreated, so a
   second run inserts nothing, row ids are stable, renamed units stay renamed, extra grants an administrator
   added survive, and historical or future-dated tax rows are untouched. Consequence: if a later release adds a
   permission or a template grant, a re-run adds it, but a grant an administrator deliberately **revoked from a
   template role will be re-added** by a re-run. The seed is therefore run by setup/upgrade code, not casually;
   revocation-aware behaviour is deferred until the role-management feature exists.
2. **One transaction** (`prisma.$transaction`) covering permissions, roles, role-permissions, units, tax
   categories and tax rates; any failure rolls back everything (tested by failing after each of the six steps).
3. **Existing organization required.** Role, unit and tax rows are per organization. The seed refuses an unknown
   organization before inserting anything (including the global permission catalogue). The CLI selects the single
   existing organization or requires `--organization <uuid>`.
4. **Permission keys** are stable `<area>.<resource>.<verb>` identifiers. Tests assert by key, never by label.
   Role grants are derived from explicit key lists or simple rules in `prisma/seed/reference/roles.ts`:
   Administrator = every permission; Accountant = business and accounting permissions without any `security.*`,
   period unlock, integration credentials, backup, tax-configuration, numbering or posted-document removal;
   Billing Operator = customers, products (no cost/margin), orders, invoices, payments, printing;
   Warehouse Operator = stock operations with no cost, margin, valuation, financial or accounting access;
   Viewer/Auditor = read-only (plus print), **no export** by default (export is separately grantable).
5. **`sales.document.delete_posted` is defined but reserved.** It gives the spec's "no posted-document
   deletion" restriction a concrete key to withhold. Posted financial records are never hard-deleted (spec
   section 53); no feature uses the key, and only the Administrator holds it. Any future use must pass an ADR.
6. **Tax data are placeholders, flagged in the database.** Migration `20261017000000_task_1_1_tax_reference_markers`
   adds `origin` (`USER` | `REFERENCE_SEED`), `review_status` (`UNREVIEWED` | `REVIEWED`) and `review_note` to
   `tax_categories` and `tax_rates`, plus `effective_from`/`effective_to` on categories. Seeded rows are always
   `REFERENCE_SEED` / `UNREVIEWED` with a note stating they are not guaranteed current statutory rates and need
   review by an authorized accountant or tax professional. Rates are exact decimal strings (`'18.0000'`), open
   ended, starting at the placeholder date 2017-07-01 (start of the GST regime, not a legal assertion). Rate
   changes are made by closing the old row and inserting a new effective-dated row; history is never edited.
   The seeded slab set (0/5/12/18/28 plus nil, exempt, zero-rated, non-GST) is structural only and may not match
   the rates in force today - that is exactly why every row is `UNREVIEWED`.
7. **Reference vs demo.** `reference` inserts configuration only. `demo` remains a no-op in Task 1.1.

## Consequences

- No automatic enforcement yet prevents using an `UNREVIEWED` rate on an invoice; the tax-engine/invoicing tasks
  must surface the review status as a warning or block per business setting (risk R-040).
- The seed writes no audit-log rows (no user context exists yet); the setup wizard that invokes it should audit
  the event (risk R-041).
- Defining many permissions for future phases now (purchasing, accounting, integrations, backup) means the
  catalogue is complete for role design, but those features do not exist yet; keys for features that never ship
  should be removed deliberately via a migration-backed change, not silently.
