# @commercebill/tax-config

Tax CONFIGURATION services (Task 1.12, ADR-0023): the read model of tax categories and effective-dated rates, the append-only
review of the configuration (fingerprint gate), the user-maintained organization-scoped HSN/SAC list, the HSN/SAC requirement
policy and the DEMO/PRODUCTION billing mode with its production gate. It reads and writes the database; the calculation itself
lives in the pure `@commercebill/tax-engine`.

Passing the review or the gate checks is an internal safety control. It is NOT government verification and NOT a legal or tax
certification (R-040 stays open until independent professional review).
