# Phase 1 - Task 1.12 Completion Report: TaxEngine and Tax Configuration Review

**This is implementation approval only. Ruleset FUB-GST-1 and the jurisdiction table are not professionally approved; R-040 stays open; passing these tests does not enable production billing.**

## Visible functionality achieved

- **Tax** in the sidebar (users with `tax.config.read`): the installed tax categories and effective-dated rates with their review status and a "placeholder" warning; the jurisdiction rules (UNREVIEWED); a requirements checklist and a "Demo billing only" banner;
  the review status (not reviewed / reviewed / out of date) with who reviewed, in what capacity and when; the HSN/SAC policy; a review form (the notice, your capacity, a note, an acknowledgement) for users with `tax.config.review`; and the append-only review history.
- **Tax > HSN/SAC codes:** the organization's own list (nothing is bundled): search, type/status filters, paging, add, edit description, deactivate/reactivate, and a per-entry confirmation for reviewers.
- **Customers:** "Customer kind" Business / Individual replaces B2B / B2C; the GST fields follow the GST registration only; a GSTIN is required for registered and composition customers.
- No invoice, preview, numbering, stock, receivable or PDF behaviour was built.

## Requirements checked

| Brief item                                                                | Result                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure TaxEngine package, scaled BigInt, no float, half-up at named points  | done; source-scanning test; ADR-0023                                                                                                                                                             |
| FUB-GST-1 provisional rules, returned versions/hash/explanations          | engine 1.0.0, FUB-GST-1, HALF_UP_PAISE_V1, input hash, per-line explanation and rounding adjustment                                                                                              |
| Customer model correction and refusing migration                          | `customer_kind`; GSTIN required for REGISTERED and COMPOSITION; refuses clearly and changes nothing; never fabricates a GSTIN                                                                    |
| Seller scope and deferrals rejected, not ignored                          | machine-readable codes for composition/unregistered seller, services, Bill of Supply, zero-rated, export/SEZ, reverse charge, invoice discount, charges, cess, advances, TCS/TDS, unknown fields |
| Percentage and fixed line discounts                                       | implemented and tested (including rounding and the inclusive case)                                                                                                                               |
| Place of supply fact, source, selection rule                              | engine validates and records; suggestion is not postable; explicit choice required when states differ; Task 1.13 owns the confirmation                                                           |
| Review permission and fingerprint gate, append-only review                | three separate keys; fingerprint over rules, jurisdictions, categories and rates; stale on any change; reverting restores; refuses a changed configuration                                       |
| DEMO numbering support                                                    | mode and gate support only (Task 1.13 implements demo invoices); recorded in the Task 1.13 acceptance criteria                                                                                   |
| Organization-scoped HSN/SAC maintenance and policy                        | list/search/create/edit/confirm, isolation, audit; `hsnSacRequired = true`; turning it off needs permission, acknowledgement and reason; nothing invented                                        |
| Jurisdiction ruleset versioned, UNREVIEWED, in the fingerprint, displayed | done                                                                                                                                                                                             |
| Production safety gate                                                    | DEMO only: production needs a current review, a valid regular seller, an HSN/SAC policy AND a verified backup/restore (Task 1.17), so it is always refused today                                 |
| Rate overlap prevention, immutability                                     | advisory-locked trigger; rates and categories immutable; only an open rate can be closed, once                                                                                                   |
| Migration tests, audit, organization isolation                            | 15 migration tests (clean and populated Task 1.11 database, three refusal cases); audit and isolation over HTTP                                                                                  |

## Points to review

- **Decisions I made (change on request):** only the Administrator template holds `tax.config.review` (an accountant must be granted it); switching billing mode also needs `tax.config.review`; the HSN requirement policy needs `tax.config.update`; HSN code format is 2-8 digits; reviews are ordered by database creation time;
  rate rows have no editing screen yet (DEF-15). The `tax_rates_check_window` trigger leaves a row with an existing `(category, start)` key to the unique index so the idempotent seed keeps working.
- **Calculation judgement calls the reviewer should look at:** independent half-rate CGST/SGST rounding (the component sum can differ from rounding the total rate by one paisa; the engine warns), the inclusive-price residual (returned per line, never hidden), and rounding at line level. R-082 records this.
- **UTGST/SGST table:** written from general knowledge, marked UNREVIEWED, shown on the review screen (R-083).
- **Visual review (real API, fictional data):** Tax configuration, HSN/SAC list and the Customer form were inspected; at 1000 px and 1100 px none of them scrolls sideways (measured). One defect found and fixed: the header link "Tax configuration" on the HSN/SAC page wrapped onto two lines in a narrow window (now one line). The review form, the not-reviewed/stale/empty and error states are covered by the component and real-UI tests rather than screenshots.
- **Existing tests changed:** customer tests (kind/GSTIN rules, `kind` filter), product/HSN tests (organization-scoped entries), the reference-seed test (closes the seeded open-ended rate before adding a later one), the backup-spike table count 25 -> 26. No timeout raised; no threshold lowered.
- **Task 1.13 acceptance criteria** are recorded in PROJECT_STATE ("Exact next task"): DEMO series and flags, calling the engine, place-of-supply confirmation and snapshot, the full snapshot content, the single transaction with the preview-versus-posting race check, and stock/receivable steps.
- **R-076:** the old `db:start` processes were not touched.

## Tests

| Suite       | Count             |
| ----------- | ----------------- |
| Unit        | 522               |
| Integration | 504               |
| Total       | 1026, all passing |

Coverage: 94.9% statements / 90.6% branches / 95.9% functions / 96.2% lines (thresholds unchanged 80/70/80/80).
New: 46 engine tests (every approved worked example, boundary dates, every rejected scenario, determinism and stable input hash, 3,000 seeded random invoices, source scan for floating point), 15 migration tests, 23 HTTP tests, 12 component tests, 11 real-UI tests.
Mutation checks: 20 deliberate breaks all killed (floor and half-down rounding, full rate on components, inclusive extraction, the inclusive price pin, truncated percent discount, truncated gross, UTGST handled as SGST, place-of-supply selection rule, suggested place treated as postable, rate window, exclusive end date,
rates left out of the fingerprint, backup requirement always met, review ignoring a changed configuration, review with only the read permission, organization scope on HSN edit, overlap trigger, append-only reviews, rate values editable). One survived at first (percent-discount truncation) and a new rounding test now kills it. Sources restored and verified identical.

## Commands executed

`prisma generate`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run --coverage`, `npm run verify:phase0` (all 8 gates), `npm audit` (0 vulnerabilities), 2026-10-20.
