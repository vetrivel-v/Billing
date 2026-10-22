# @commercebill/backup

Task 1.17. Encrypted backups of the CommerceBill database and VERIFIED restore (ADR-0009, ADR-0027).

```
snapshot export (REPEATABLE READ, READ ONLY) -> per-table NDJSON -> container -> chunked AES-256-GCM (scrypt key) -> .cbbackup
.cbbackup -> decrypt -> validate manifest and checksums -> isolated database (migrate, then load) -> rebuild stock balances
          -> integrity checks -> PASS/FAIL record -> drop the isolated database
```

- No pg_dump/pg_restore is needed or used (the embedded PostgreSQL ships none, R-031): the export is a consistent SQL snapshot through the `pg` driver.
- The passphrase is never stored, logged, put in a manifest or passed on a command line.
- A backup is VERIFIED only by a restore into an isolated database that passes every integrity check. The active database is never touched by verification.
