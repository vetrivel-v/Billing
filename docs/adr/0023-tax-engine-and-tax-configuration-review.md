# ADR-0023: Pure TaxEngine, tax configuration review and the production gate

- Status: Accepted (implementation approval) and implemented in Phase 1 Task 1.12. **This is NOT professional tax approval: R-040 stays open.**
- Date: 2026-10-20
- Builds on: ADR-0004 (exact decimals), ADR-0020 (customer master), ADR-0021 (product master), ADR-0022 (inventory), spec sections 18-19

## Decisions

1. **The TaxEngine is a pure, deterministic package** (`@commercebill/tax-engine`). It has no database, clock, I/O, UI wording or floating point. It receives validated
   facts and returns a calculation snapshot or machine-readable errors. It never selects its own rate (the caller's `selectEffectiveRate` does), never derives a place of
   supply, never touches stock, customers, products, numbering or accounting.
2. **Ruleset FUB-GST-1 (provisional; engine 1.0.0; rounding policy HALF_UP_PAISE_V1).** Scaled-BigInt arithmetic; half-up at four named points only: line gross
   `round2(qty x price)`, percent discount `round2(gross x pct / 100)`, each tax component `round2(taxable x rate / 100)` (CGST and SGST/UTGST each `taxable x rate / 200`, one
   division, the half rate never rounded), and inclusive extraction `round2(L x 100 / (100 + rate))`. Tax is calculated per line and the invoice sums its lines; there is no
   invoice-level re-rounding of tax. An inclusive line keeps the customer-visible price exactly and returns the leftover paisa (at most one, tested over 3000 random invoices) as an explicit
   `roundingAdjustment`. CGST always equals SGST/UTGST. An optional whole-rupee round-off is a separate invoice line, default NONE. The result carries `engineVersion`,
   `rulesetVersion`, `roundingPolicyId`, an `inputHash` (SHA-256 of the canonical input) and a step-by-step `explanation` per line, and warns when the component sum differs from
   rounding the total rate.
3. **Rejected, never ignored.** Supported scope is domestic Goods, a regular GST-registered seller, a Tax Invoice, standard / nil-rated / exempt / non-GST lines, percent and fixed line
   discounts. Everything else returns a blocking code: composition or unregistered seller (`SELLER_NOT_SUPPORTED`), Services (`ITEM_KIND_UNSUPPORTED`), Bill of Supply
   (`DOCUMENT_TYPE_UNSUPPORTED`), zero-rated, export/SEZ, reverse charge, invoice discount, charges (shipping/packing/other), cess, advances, TCS/TDS and any unknown field.
   Nothing is faked: the output has no zero-valued cess or charge fields, only empty `levies`/`charges` lists.
4. **Place of supply is a FACT** supplied by the caller with its source (`SUGGESTED`, `USER_CONFIRMED`, `USER_OVERRIDE`). The engine validates it, classifies the supply and refuses a
   billing/delivery state mismatch unless the user explicitly chose (`USER_OVERRIDE`). A merely `SUGGESTED` place of supply calculates (for previews) but the result is `postable: false`
   with warning `PLACE_OF_SUPPLY_NOT_CONFIRMED`; Task 1.13 must refuse to post unless `postable`. CommerceBill's suggestion is never presented as a legal determination.
5. **One jurisdiction ruleset** (`FUB-GST-1-JURISDICTIONS` v1, UNREVIEWED) decides CGST+SGST (states and union territories with a legislature), CGST+UTGST (union territories without one)
   or IGST (different places, and "other territory"/centre jurisdiction codes). It is versioned, part of the configuration fingerprint and shown on the review screen. No other code decides this.
6. **Rates:** effective-dated, selected by the invoice date: exactly one rate in the category's window or a failure (`NO_EFFECTIVE_RATE`, `AMBIGUOUS_EFFECTIVE_RATE`). The database now forbids
   overlapping windows (advisory-locked trigger) and makes a rate immutable once written: only an open rate may be closed, once; a rate change is a new row. Categories keep code,
   classification and organization and are never deleted. A posted invoice therefore keeps its rate row; Task 1.13 must also snapshot the values (see its acceptance criteria).
7. **Customer model correction.** `customer_type` (B2C/B2B) became `customer_kind` (INDIVIDUAL/BUSINESS), independent of GST registration. B2B/B2C is derived per invoice from whether a
   recipient GSTIN is supplied. A GSTIN is required for REGISTERED and COMPOSITION customers. The migration refuses clearly, and changes nothing, if existing rows violate that; it never
   invents, clears or rewrites a GSTIN.
8. **Review by fingerprint.** The configuration fingerprint is a SHA-256 over the rule-set versions, the jurisdiction table, every category and every rate (values and dates, not marks or
   timestamps). `tax_configuration_reviews` is append-only (reviewer, stated capacity, time, notice version and text acknowledged, note, engine/ruleset/jurisdiction versions, fingerprint).
   A review is current only while the live fingerprint equals its fingerprint, so any change (new rate, edit, deactivation, rule-set change) makes it stale automatically; reverting a change
   restores it. Recording a review recomputes the fingerprint inside one repeatable-read transaction and refuses (409) if it is not the one the reviewer was shown. Distinct keys:
   `tax.config.read`, `tax.config.update`, `tax.config.review` (Administrator only by default). A review is a business confirmation recorded by CommerceBill; it is not government verification
   or legal certification, and the screens and the stored notice say so.
9. **DEMO / PRODUCTION gate.** Billing is DEMO by default. Production requires all of: a current review, a valid regular GST-registered seller (GSTIN and state), an HSN/SAC policy in force,
   and a verified backup/restore. The last fact is provided by Task 1.17; until then it is false, so `POST /tax/billing-mode {PRODUCTION}` is always refused (409, with the unmet requirements).
   Tests prove the gate with an injected fact; the application itself cannot reach production. Switching mode needs `tax.config.review` and is audited. Task 1.12 supplies the mode and gate;
   Task 1.13 implements demo invoices (a separate DEMO series, `is_demo` flag, DEMO watermark, no production sequence, never convertible, excluded from production reports and receivables).
10. **HSN/SAC** is now organization-scoped and user-maintained: code (2-8 digits), kind (HSN/SAC), description, active flag, origin (USER; IMPORT reserved), review status. Nothing is bundled or
    invented. Code, kind and organization never change; entries are never deleted; editing drops a confirmation; a product may only use its own organization's entry (trigger). The
    default policy `hsnSacRequired = true`; turning it off needs `tax.config.update`, an acknowledgement and a reason and is audited. No turnover-based digit-length validation.

## Consequences

- Task 1.13 acceptance criteria are recorded in PROJECT_STATE (call contract, snapshot content, race handling, DEMO series).
- Deferred (DEF-15): services, composition/unregistered sellers and Bill of Supply, invoice-level discount, charges, cess, zero-rated/export/SEZ, reverse charge, advances, TCS/TDS,
  e-invoice, e-way bill, credit-note reversal, an authoritative HSN/SAC import, turnover-based HSN digit rules, rate maintenance UI (rates are still entered through the database or a future screen).
- R-040 (unreviewed placeholder rates), R-077 (no reviewed HSN/SAC data) and the new R-082 to R-084 stay open for independent professional review.
