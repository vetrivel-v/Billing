# ADR-0009: Backup uses a verified logical export ("migrate, then load")

- Status: Accepted (spike proven; production implementation is a later Phase 1 task)
- Date: 2026-10-16
- Resolves: risk R-031

## Context

The embedded PostgreSQL binaries contain `initdb`, `pg_ctl` and `postgres` only; there is no `pg_dump` or
`pg_restore` (verified in Phase 0). The spec requires encrypted, verifiable backups with an isolated test
restore (section 36). Options considered:

1. **Bundle `pg_dump`/`pg_restore` from an official PostgreSQL Windows distribution.** Not evaluated
   empirically: it needs a separate binary download, licence/notice handling and version matching with the
   embedded server, none of which was authorised or available in this task.
2. **Logical export/import through the `pg` driver, with the schema created by the application's own
   migrations.** Implemented as a spike and tested (below).

## Decision

Backups are logical: for every application table, data is exported inside one `REPEATABLE READ READ ONLY`
snapshot as JSON text and a manifest records `format`, creation time, **schema version (last applied Prisma
migration)**, and per-table row count and SHA-256. Restore:

1. verifies all checksums **before touching the target**;
2. requires the target to be a freshly migrated database at the **same schema version**;
3. refuses any non-empty target (never overwrites active data; restore into the live database remains an
   explicit, separately authorised step with a pre-restore backup);
4. loads all tables in **one transaction** (all-or-nothing) using `session_replication_role = replica` to defer
   FK ordering (requires a superuser/owner role - true for the app-managed database);
5. leaves triggers intact (the audit-log immutability trigger is verified after restore).

Values are never parsed in JavaScript, so `bigint` beyond 2^53, `numeric` precision, `timestamptz`, `jsonb`
and Unicode round-trip exactly.

## Evidence (tests/recovery/logical-dump.int.test.ts, 7 tests, passing 2026-10-16)

Manifest content; restore into an isolated database with identical per-table digests; bigint 9007199254740993
and decimal 0.1234 preserved; audit trigger still blocks DELETE after restore; tampered dump rejected before any
write; schema-version mismatch rejected; non-empty target refused; mid-load constraint failure leaves the
target empty.

## Consequences

- The spike (`tests/recovery/spikes/logical-dump.ts`) is **not production code**: it holds whole tables in
  memory. The production module must stream with `COPY` (or cursor batches), add AES-256-GCM encryption with a
  password-derived key, include attachments and configuration, and produce the verification report (spec 36).
- Because the schema is not part of the dump, backups stay consistent across migrations, but a dump is only
  restorable at the same schema version. Cross-version restore means "restore on the old version, then
  upgrade" and is a documented limitation (risk R-036).
- If a future decision bundles `pg_dump`, it can be added as a second, faster format without changing this one.
