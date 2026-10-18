# Threat Model (initial, Phase 0)

Method: STRIDE over the trust boundaries below. This is an initial model; it is revisited at every phase.

## Assets

Financial records and journals; invoice numbering integrity; customer PII (names, addresses, GSTIN, phone,
email); credentials (user password hashes, future marketplace/e-invoice credentials); backups; audit log.

## Actors

Legitimate business users (five roles); other local OS users; local malware running as the same user;
a malicious file (import CSV/XLSX, attachment, backup archive); network attackers (only via optional
internet integrations; no inbound LAN exposure by default); a stolen/lost computer or backup media.

## Trust boundaries and data flows

1. Renderer (untrusted UI code, may render untrusted data) <-> Electron main (preload bridge).
2. Renderer/Electron <-> API over loopback HTTP.
3. API <-> PostgreSQL over loopback.
4. API/Electron <-> filesystem (attachments, backups, logs) in the per-user data directory.
5. API <-> optional external providers (marketplaces, e-invoice, e-mail, WhatsApp Business).

## Threats and controls

| ID   | STRIDE                 | Threat                                                                                     | Control (status)                                                                                                                                                                             |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-01 | Spoofing               | Local process calls the loopback API                                                       | Per-launch secret (implemented, tested end to end) + session auth (planned, R-032)                                                                                                           |
| T-02 | Spoofing               | Brute-force login                                                                          | Argon2id, lockout, rate limit, failed-login audit (implemented, tested - Task 1.3)                                                                                                           |
| T-03 | Tampering              | Modify posted documents                                                                    | Immutability + reversal model (planned); DB triggers on posted tables (planned)                                                                                                              |
| T-04 | Tampering              | Edit/delete audit events                                                                   | Append-only triggers (implemented, tested)                                                                                                                                                   |
| T-05 | Tampering              | Malicious CSV/XLSX (formula injection, huge file)                                          | Validation, size limits, escape on export (planned)                                                                                                                                          |
| T-06 | Tampering              | Path traversal in attachments/backups                                                      | Random internal filenames, approved directory (planned)                                                                                                                                      |
| T-07 | Repudiation            | User denies an action                                                                      | Audit log with user, correlation ID, before/after (table exists; writers planned)                                                                                                            |
| T-08 | Information disclosure | Secrets in logs/errors                                                                     | Pino redaction, stable sanitized errors (implemented; leak test planned)                                                                                                                     |
| T-09 | Information disclosure | Backup stolen                                                                              | Encrypted backup archive (planned)                                                                                                                                                           |
| T-10 | Information disclosure | XSS in renderer reads data                                                                 | React escaping, CSP, no remote content, context isolation (implemented baseline)                                                                                                             |
| T-11 | Denial of service      | Request flood on loopback                                                                  | Rate limit (implemented, coarse)                                                                                                                                                             |
| T-12 | Denial of service      | Large import exhausts memory                                                               | Streaming parse, row limits (planned)                                                                                                                                                        |
| T-13 | Elevation              | Renderer compromise reaches Node/OS                                                        | Sandbox, no nodeIntegration, minimal bridge, navigation lock (implemented)                                                                                                                   |
| T-14 | Elevation              | Privilege escalation between roles                                                         | Server-side permission checks on every guarded request, no admin bypass (implemented, tested - Task 1.3); no business routes use them yet                                                    |
| T-15 | Elevation              | Malicious dependency                                                                       | Lockfile, audit, SBOM (partially: audit)                                                                                                                                                     |
| T-16 | Tampering              | Duplicate webhook/idempotency abuse                                                        | Idempotency keys + unique constraints (planned)                                                                                                                                              |
| T-17 | Elevation              | First-run takeover: first caller of `/setup/complete` becomes Administrator                | Launch secret, loopback, rate limit, lock + in-lock re-check, setup refused after completion, immutable completion marker, audit event (implemented, tested - Task 1.4; residual risk R-051) |
| T-18 | Tampering              | Duplicate, skipped or rewritten document numbers (concurrent posting, retries, direct SQL) | Row lock + DB invariants (counter +1 only, unique number/text/document, append-only ledger, immutable identity), idempotent allocation (implemented, tested - Task 1.5)                      |

## Out of scope / accepted for now

A user with OS-level access to the unlocked session, or a PostgreSQL superuser, can read or alter data
(partially mitigated by backups and, later, hash-chained audit rows; R-017). Physical disk encryption
(BitLocker) is recommended in admin documentation but not enforced.
