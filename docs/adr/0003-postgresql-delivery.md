# ADR-0003: PostgreSQL delivery for dev, test and desktop

- Status: Accepted (dev/test); production bundling deferred to Phase 6
- Date: 2026-10-16

## Context

PostgreSQL is mandatory (spec section 5). Neither PostgreSQL nor Docker is installed on the development machine, and Docker must not be required for ordinary users. The npm package `embedded-postgres` ships real PostgreSQL 18 Windows binaries and runs without admin rights. Its package contains initdb, pg_ctl and postgres but NOT pg_dump or pg_restore (verified).

## Decision

Development: `npm run db:start` runs embedded PostgreSQL on 127.0.0.1:54329 with data in `.data/pg-dev`. Tests: a throwaway cluster on 54330 in a temp directory, with one uniquely named database per test file. `docker-compose.yml` is an optional alternative. Production: bundle and supervise PostgreSQL from the Electron shell; packaging approach and licence notices decided in Phase 6.

## Consequences

Real PostgreSQL semantics in tests (constraints, triggers, decimals). Backup implementation in Phase 1 must provide dump/restore tooling (bundle pg_dump/pg_restore or equivalent) - tracked as risk R-031. embedded-postgres is a beta-versioned package (18.4.0-beta.17); its stability for production use is unproven (risk R-030).
