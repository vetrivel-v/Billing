# Project State

Last updated: 2026-10-16. This file and the repository are the implementation record (spec section 44).

| Item                      | Value                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Application version       | 0.0.1 (pre-release)                                                                                                           |
| Current phase             | **Phase 0 complete (gates passed); Phase 1 not started**                                                                      |
| Current database version  | `20261016000000_phase0_foundation` (18 tables)                                                                                |
| Last successful migration | `20261016000000_phase0_foundation` - applied to a clean database by the integration run and to the dev database on 2026-10-16 |
| Last successful build     | 2026-10-16 - `npm run build` (api, web, desktop) PASS                                                                         |
| Last successful test run  | 2026-10-16 - `npm run verify:phase0`: all 8 gates PASS; 32 unit + 6 integration tests passed; coverage 98.7% statements       |
| Git                       | Repository initialized on branch `main`; files staged, **no commit made yet**                                                 |
| Release status            | Not releasable. No product functionality exists                                                                               |

## Completed modules (Phase 0 scope only)

Repo scaffold; tooling (TypeScript strict, ESLint, Prettier, Vitest); environment validation; Prisma schema +
foundation migration; embedded dev/test PostgreSQL; Fastify API shell (health, error contract, security
headers); React status shell; hardened Electron shell; Phase 0 verification script; documentation set listed in
the completion report.

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

No critical defect known. Open risks needing design decisions before/at Phase 1: R-031 (no pg_dump in embedded
binaries), R-032 (loopback API needs authentication), R-033 (Argon2 native module), R-030 (embedded-postgres
production suitability). See [RISK_REGISTER.md](RISK_REGISTER.md).

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

**Phase 1, Task 1.0 - resolve the three Phase 1 blockers with ADRs and small spikes (no feature code):**

1. R-031: decide how backups will dump/restore PostgreSQL (bundle official `pg_dump`/`pg_restore` binaries for
   Windows vs. alternative), prove a dump + restore into an isolated database on this machine, record as
   ADR-0009.
2. R-032: design shell-to-API authentication (per-launch secret + session tokens), ADR-0010.
3. R-033: choose and install the Argon2id implementation, prove it loads under Node and under the Electron
   runtime, ADR-0011.

Then **Task 1.1 - reference seed**: permission catalogue, the five predefined role templates (spec section 11),
default units, tax categories/rates flagged as requiring accountant review; with integration tests. Do not
recreate any Phase 0 module; extend `prisma/seed/reference` and `prisma/seed/seed.ts`.
