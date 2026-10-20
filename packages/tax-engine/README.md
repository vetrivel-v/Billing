# @commercebill/tax-engine

Pure, deterministic GST calculation (Task 1.12, ADR-0023). No database, no clock, no I/O, no UI wording, no floating point:
scaled-BigInt arithmetic with half-up rounding at four named points. Ruleset **FUB-GST-1** (provisional; implementation approval
only, NOT professional tax approval - R-040 stays open).

- `calculate(input)` - the whole invoice in, a calculation snapshot (or machine-readable errors) out, with engine/ruleset/rounding
  versions, an input hash and a step-by-step explanation per line.
- `selectEffectiveRate(category, rates, date)` - the effective-dated rate selector (exactly one rate or a failure).
- `computeConfigurationFingerprint`, `reviewState`, `evaluateProductionGate`, `sellerConfigurationProblems` - the review/gate helpers.
- `JURISDICTIONS` / `classifySupply` - the versioned jurisdiction ruleset (UNREVIEWED) that decides CGST+SGST, CGST+UTGST or IGST.

Supported: domestic goods, a regular GST-registered seller, tax invoice, exclusive/inclusive prices, percent and fixed line discounts,
standard / nil-rated / exempt / non-GST lines. Everything else is rejected with a code, never ignored.
