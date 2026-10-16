# ADR-0007: Append-only audit log in the database

- Status: Accepted
- Date: 2026-10-16

## Context

Spec section 33: ordinary users cannot edit or delete audit events.

## Decision

`audit_logs` rows are protected by BEFORE UPDATE/DELETE row triggers and a BEFORE TRUNCATE statement trigger that raise an exception. Secrets are redacted by the application before insertion. Security logs and diagnostic logs are separate (files), not rows in this table.

## Consequences

A database superuser can still drop triggers; tamper-evidence (hash chaining) is a candidate Phase 6 hardening (risk R-017). Retention/archival of audit rows needs a controlled, audited procedure.
