# CommerceBill Desktop

Local-first billing, inventory, accounting and e-commerce order management for small Indian e-commerce
businesses (Windows, INR, GST). The authoritative specification is
[`COMMERCEBILL_MASTER_SPEC_V2.md`](COMMERCEBILL_MASTER_SPEC_V2.md).

> **Status: Phase 0 (architecture and foundation).** There is no billing functionality yet. See
> [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md) for exactly what exists and the next task.
>
> This software does not guarantee legal, accounting or GST compliance. GST configuration and any
> tax reports must be reviewed by an authorized accountant or tax professional.

## Prerequisites

- Windows 11, Node.js >= 22.12 (developed on 24.16), npm >= 10
- No system PostgreSQL and no Docker required (embedded PostgreSQL is used for development and tests)

## Quick start (development)

```bash
npm install
npm run db:generate        # generate the Prisma client
npm run dev                # starts embedded PostgreSQL, applies migrations, starts API (4310) and web (5173)
```

In another terminal, with `npm run dev` running:

```bash
curl http://127.0.0.1:4310/health        # API health
curl http://127.0.0.1:4310/health/db     # database health
npm run build
# Electron shell: starts the built API itself with a per-launch secret and serves the web app from app://
# DATABASE_URL must point at a migrated database (e.g. the one from `npm run dev` / `npm run db:start`).
# In PowerShell set it first:  $env:DATABASE_URL = "postgresql://..."  (then run only the npm command)
DATABASE_URL="postgresql://commercebill:commercebill_dev@127.0.0.1:54329/commercebill_dev" npm run start -w @commercebill/desktop
```

Optional: `docker compose up -d` provides PostgreSQL instead of the embedded one (same port and credentials).
Copy `.env.example` to `.env` to override defaults.

## Verification commands

| Command                                 | What it does                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                     | Strict TypeScript across all workspaces                                                                                                                 |
| `npm run lint` / `npm run format:check` | ESLint / Prettier                                                                                                                                       |
| `npm test`                              | Unit tests (Vitest)                                                                                                                                     |
| `npm run test:integration`              | Integration tests against an isolated throwaway PostgreSQL, applying all migrations                                                                     |
| `npm run build`                         | Builds API (tsup), web (Vite) and desktop (tsup)                                                                                                        |
| `npm run verify:phase0`                 | Runs every Phase 0 gate and prints PASS/FAIL                                                                                                            |
| `npm run db:seed -- reference`          | Insert reference data (permissions, role templates, units, UNREVIEWED placeholder tax rates) for the single existing organization; `-- demo` is a no-op |

## Documentation

[PROJECT_STATE](docs/PROJECT_STATE.md) · [REQUIREMENTS_MATRIX](docs/REQUIREMENTS_MATRIX.md) ·
[RISK_REGISTER](docs/RISK_REGISTER.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [ADRs](docs/adr) ·
[DATABASE_SCHEMA](docs/DATABASE_SCHEMA.md) · [DATABASE_CONVENTIONS](docs/DATABASE_CONVENTIONS.md) ·
[DEVELOPER_GUIDE](docs/DEVELOPER_GUIDE.md) · [TESTING](docs/TESTING.md) · [SECURITY](docs/SECURITY.md) ·
[THREAT_MODEL](docs/THREAT_MODEL.md) · [PHASE_0_COMPLETION_REPORT](docs/PHASE_0_COMPLETION_REPORT.md) ·
[CHANGELOG](CHANGELOG.md)

User, admin and operational guides listed in spec section 45 are created in the phase that delivers the
feature they describe.
