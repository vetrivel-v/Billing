# Project State

Last updated: 2026-10-16 (after Phase 1 Task 1.0). This file and the repository are the implementation record (spec section 44).

| Item                      | Value                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Application version       | 0.0.1 (pre-release)                                                                                                                           |
| Current phase             | **Phase 1 in progress: Task 1.0 complete; Task 1.1 not started**                                                                              |
| Current database version  | `20261016000000_phase0_foundation` (18 tables; Task 1.0 made no schema change, so no new migration)                                           |
| Last successful migration | `20261016000000_phase0_foundation` - applied to a clean database by the integration run and to the dev database on 2026-10-16                 |
| Last successful build     | 2026-10-16 - `npm run build` (api, web, desktop) PASS                                                                                         |
| Last successful test run  | 2026-10-16 - `npm run verify:phase0` all 8 gates PASS; 47 unit + 16 integration tests (63) passed; coverage 99.0% statements / 96.8% branches |
| Git                       | Branch `main`; Phase 0 committed as `40bfecd`; Task 1.0 changes are uncommitted in the working tree                                           |
| Release status            | Not releasable. No product functionality exists                                                                                               |

## Completed modules (Phase 0 scope only)

Repo scaffold; tooling (TypeScript strict, ESLint, Prettier, Vitest); environment validation; Prisma schema +
foundation migration; embedded dev/test PostgreSQL; Fastify API shell (health, error contract, security
headers); React status shell; hardened Electron shell; Phase 0 verification script; documentation set listed in
the completion report.

## Task 1.0 results (spikes; see docs/PHASE_1_TASK_1_0_COMPLETION_REPORT.md)

- ADR-0009 backup via verified logical export (spike in tests/recovery/spikes, not production code).
- ADR-0010 per-launch secret guard in the API (implemented, not yet wired into Electron).
- ADR-0011 Argon2id via @node-rs/argon2 (proven in Node 24.16 and Electron 44.8.0).
- Defect found and fixed: dev/test PostgreSQL clusters defaulted to WIN1252 and could not store Indian-language
  text (R-035); both are now forced to UTF8 with a regression test.

## In-progress modules

None.

## Not-started modules

Everything in spec sections 10-33 and 35-37 beyond the foundation tables: setup wizard, auth/RBAC, numbering
service, tax engine, customers, products, inventory, invoicing, PDF, payments, backup/restore, import/export,
reports, purchasing, accounting, e-commerce, reconciliation, compliance, installer. Domain packages
(`domain`, `tax-engine`, `accounting-engine`, `inventory-engine`, `document-engine`, `integration-core`, `ui`,
`reporting`) contain only a README.

## Open defects

None known.

## Open security issues

No critical defect known. Open risks needing design decisions before/at Phase 1: R-030 (embedded-postgres production suitability), R-032/R-037 (launch secret not yet wired; user auth pending), R-036 (logical backup limits), R-038 (Argon2 binary in packaged app). R-031 and R-033 are now Mitigating. See [RISK_REGISTER.md](RISK_REGISTER.md).

## Open data-integrity issues

None known. Migration safety (pre-migration backup, upgrade tests) is not implemented yet (R-010).

## Known limitations

- Docker Compose file was not executed (Docker not installed on this machine).
- Electron smoke check and `npm run dev` startup were verified manually, not in the automated suite.
- No Playwright, no pre-commit hook, no CI service, no OpenAPI document, no SBOM yet.
- TypeScript pinned to 6.0.x because typescript-eslint does not yet support 7.x.
- `embedded-postgres` is a beta-versioned package used for development and tests only.
- Prisma CLI reports an available 8.0 release candidate; intentionally not adopted.

## External integrations and verification status

None implemented. All marketplace, e-invoice, e-way bill, e-mail and WhatsApp integrations are
**NOT VERIFIED AGAINST LIVE SERVICE** (and not yet started).

## Exact next task

**Phase 1, Task 1.1 - reference seed.** Implement `prisma/seed/reference` and wire `prisma/seed/seed.ts`
(mode `reference`) to insert, idempotently and inside one transaction: the permission catalogue (stable keys such
as `sales.invoice.post`); the five predefined role templates (Administrator, Accountant, Billing Operator,
Warehouse Operator, Viewer/Auditor; spec section 11) with their role-permission mappings; default units; and tax
categories with effective-dated rates that are clearly flagged as requiring accountant review. Per-organization
rows are created for an existing organization only (the setup wizard comes later); global rows (permissions)
are seeded once. Add integration tests (idempotent re-run, no duplicate rows, role matrix matches spec section
11, warehouse operator has no cost/margin/accounting permission, viewer has no write permission). If a schema
change is needed, add a versioned migration and a migration test. Do not start authentication (Task 1.2+),
and do not recreate any Phase 0 or Task 1.0 module.
