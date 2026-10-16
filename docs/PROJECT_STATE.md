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
| Git                       | Branch `main`; Phase 0 = `40bfecd`; Task 1.0 = `e56bf6d`; governance-doc corrections made after that commit are uncommitted                   |
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
- Defect found and fixed (also recorded in RISK_REGISTER R-035, REQUIREMENTS_MATRIX T10-05, DATABASE_CONVENTIONS rule 13, and the Task 1.0 report): dev/test PostgreSQL clusters defaulted to WIN1252 and could not store Indian-language
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

## Carried-forward obligations from Task 1.0 (must not be lost)

| ID         | Obligation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Must be done by                                                                                                                                                                        | Tracked in                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| P1-SEC-01  | **Wire the launch secret into Electron**: main process generates 32 random bytes per launch, passes `LAUNCH_SECRET` to the API via environment only, preload exposes a validated method for the renderer to obtain it, web client sends `x-commercebill-launch-secret`; production mode must refuse to start without it; add an end-to-end test shell -> API -> authorised call and unauthorised call rejected. The API guard exists and is unit-tested but **nothing sets or sends the secret today** | **Before any data-bearing API route is exposed** (i.e. in the same task as, or before, the first authenticated endpoint; target: the shell/API integration task that follows Task 1.1) | REQUIREMENTS_MATRIX P1-SEC-01; ADR-0010; R-032, R-037        |
| P1-BKP-01  | Production backup/restore module (streaming COPY, AES-256-GCM encryption, attachments, config, retention, verification workflow, restore wizard). The Task 1.0 logical-dump code is an **experimental spike, not production backup functionality**                                                                                                                                                                                                                                                     | Phase 1 backup task (before Phase 1 exit)                                                                                                                                              | REQUIREMENTS_MATRIX P1-BKP-01; ADR-0009; R-011, R-031, R-036 |
| P1-AUTH-01 | Password service using Argon2id with tuned cost (current spike parameters are the OWASP floor, ~17-20 ms), session tokens, lockout, RBAC enforcement                                                                                                                                                                                                                                                                                                                                                   | Phase 1 authentication task                                                                                                                                                            | REQUIREMENTS_MATRIX P1-AUTH-01; ADR-0011; R-033, R-038       |
| P6-ENC-01  | Production PostgreSQL initialisation must use `--encoding=UTF8` (dev/test already do)                                                                                                                                                                                                                                                                                                                                                                                                                  | Phase 6 packaging                                                                                                                                                                      | REQUIREMENTS_MATRIX P6-ENC-01; R-035                         |

## Known limitations

- **The backup code under tests/recovery/spikes is an experimental spike (in-memory, unencrypted, same schema version only). No production backup or restore exists.**
- **The API launch-secret guard is not wired into Electron**: neither the shell nor the web client sets or sends the secret (P1-SEC-01). With no `LAUNCH_SECRET` configured the guard is off.
- No password-hashing service, sessions or authorisation exist; Argon2id was only proven loadable.
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

### Task 1.1 acceptance criteria

1. `npm run db:seed -- reference` (or `tsx prisma/seed/seed.ts reference`) completes against a freshly migrated
   database and inserts the permission catalogue, the five role templates with role-permission mappings,
   default units and tax categories/rates for an existing organization.
2. The seed is **idempotent**: running it twice leaves identical row counts and no duplicates; it runs in one
   transaction (failure part-way inserts nothing).
3. The role matrix matches spec section 11: Administrator has every permission; Warehouse Operator has **no**
   cost, margin or accounting permission; Billing Operator has no period-unlock, posted-document deletion or
   integration-credential permission; Viewer/Auditor has no write permission and export only if separately
   granted; Accountant has no security-administration permission.
4. Tax categories/rates are effective-dated, use exact decimals, and are flagged as requiring review by an
   authorised accountant (no claim of statutory correctness).
5. No demo data is inserted; `demo` mode remains a no-op.
6. Integration tests cover criteria 1-5 and pass; any schema change has a versioned migration and a migration
   test (none is expected).
7. `npm run verify:phase0` still passes (47 unit + 16 integration tests as baseline, none weakened); coverage
   thresholds unchanged and met.
8. PROJECT_STATE, REQUIREMENTS_MATRIX and RISK_REGISTER updated and a Task 1.1 completion report written.

Out of scope for Task 1.1: authentication, launch-secret wiring (P1-SEC-01), production backup (P1-BKP-01),
any invoice, inventory, payment or accounting behaviour.
