# Phase 1 - Task 1.11 Completion Report: Inventory / Stock Ledger Vertical Slice

## Visible functionality achieved

- **Inventory** in the sidebar (users with `inventory.stock.read`): stock list (SKU, product, warehouse, on hand, unit, status; search, status filter, paging; loading/empty/no-match/error states) and a product stock page with current stock and the immutable,
  server-paged movement history (separate Increase and Decrease columns, actor, reference/reason).
- **Opening stock**, **Manual stock receipt** (labelled "not a purchase") and **Stock adjustment** forms for users with `inventory.adjustment.create`; the adjustment form previews Current / Adjustment / Resulting stock, the server recomputes and decides.
- Read-only for everyone else; services and untracked goods are never listed or given stock; stock persists across close and reopen.

## Requirements checked

| Brief item                                                      | Result                                                                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Append-only ledger, no balance overwrite, immutable rows        | triggers refuse UPDATE/DELETE/TRUNCATE; no PATCH/DELETE route; tested at database and HTTP level                                    |
| Movement types now and later                                    | 4 types now; a CHECK (not an enum) widened by later migrations; ADR-0022                                                            |
| Exact quantities and precision                                  | numeric(18,4), decimal strings end to end, unit places enforced, excess refused not rounded                                         |
| Balance strategy                                                | trigger-maintained projection (option B), never editable, reconcilable; tested including deliberate corruption                      |
| Negative stock policy                                           | not allowed (CHECK under row lock); recorded for Task 1.13                                                                          |
| Non-inventory products rejected                                 | engine + trigger; never listed                                                                                                      |
| Warehouse scoping, isolation                                    | warehouse id on every row; primary warehouse shown; cross-organization refused in application and database                          |
| Opening stock policy                                            | only before any other movement of that stock; tested including a database-level race                                                |
| Manual receipt, adjustments with reason                         | done; reason OTHER needs a note                                                                                                     |
| Idempotency                                                     | unique source identity; replay returns the original (200), different content refused (409); lost-answer UI test                     |
| Concurrency                                                     | 40 receipts; 4-from-5 twice (5 rounds); 12 decreases; 5 openings; 10 identical retries - real PostgreSQL                            |
| Transaction API for invoice posting                             | `postStockMovement(tx, ...)`, documented in ADR-0022 and the package README; no invoice behaviour built                             |
| Authorization, audit, no cost/margin exposure                   | exact keys, catalogue-derived role tests; audit facts only; no price/cost field in any answer (tested)                              |
| UI, history without misleading running balance, decimal display | done; running balance deferred (not valid from one page); `2.5` not `2.5000`; Indian grouping                                       |
| No valuation / FIFO / COGS                                      | none built                                                                                                                          |
| Visual review                                                   | empty, populated, decimals, opening, receipt (decimal error), increase, decrease, negative-stock error, history, read-only, 1000 px |

## Points to review

- **Decisions I made (change on request):** opening stock once per product and warehouse; reasons COUNT_CORRECTION / FOUND / DAMAGE / LOSS / OTHER; an event may be dated up to one day ahead of UTC today (so India is never refused) but not before 2000-01-01; inactive
  products keep stock and can be adjusted; a product with stock keeps its unit and tracking (the Task 1.10 product service changed for this); `operationId` is required on every stock POST.
- **Layout fix from the visual review:** at 1000 px the stock table scrolled sideways; the Warehouse column is hidden below 1100 px (the page subtitle names the warehouse) and the row actions wrap to two lines; there is now no horizontal scroll at 1000 px.
- **Risks:** R-080 (backup restore must respect the balance protection trigger; Task 1.17), R-081 (negative stock refused outright; a later setting may relax it). R-040, R-053, R-063, R-074, R-076 unchanged.
- **Existing tests changed:** backup-spike table count 23 -> 25; the reference-seed test asserts the stock tables stay empty; two navigation tests count Inventory among built modules. No timeout raised; no threshold lowered.
- **Pre-existing noise, not from this task:** a `pg` deprecation warning about concurrent queries on one client appears in integration runs that use Prisma transactions (also in the products tests).
- **R-076:** the old `db:start` processes were not touched. The visual harness used its own throwaway PostgreSQL, stopped and deleted afterwards.

## Tests

| Suite       | Count            |
| ----------- | ---------------- |
| Unit        | 464              |
| Integration | 455              |
| Total       | 919, all passing |

Coverage: 95.2% statements / 91.0% branches / 96.2% functions / 96.5% lines (thresholds unchanged 80/70/80/80).
New: 9 engine unit tests, 6 form-model tests, 17 component tests, 12 migration tests, 37 HTTP tests (concurrency, idempotency, isolation, roles, audit, logs), 11 real-UI tests.
Mutation checks: 16 deliberate breaks (idempotency lookup, direction sign, organization scope on product, tracked check, audit on replay, write permission, unit decimal places, organization scope on warehouse and movement reads, no-negative CHECK, ledger append-only trigger, balance protection,
advisory lock, UI Number() for quantity, UI submit lock, UI operation id reuse) all failed at least one test. Two first survived: the unit-places break is killed by the engine unit test (the database rule gave the same refusal over HTTP) and the advisory-lock break needed a new
two-connection database race test, which now kills it. Sources restored and verified identical.

## Commands executed

`prisma generate`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run --coverage`, `npm run verify:phase0` (all 8 gates PASS, including the production build), `npm audit` (0 vulnerabilities), 2026-10-20.
