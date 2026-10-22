# Security

Target: OWASP ASVS Level 2 principles where applicable (spec section 38). This document describes what exists
today; anything not listed is NOT implemented. No claim of "secure" is made before the Phase 6 security review.

## Implemented in Phase 0

- API binds to loopback only; non-loopback `API_HOST` fails startup (tested).
- CORS restricted to configured origins; Helmet headers; global rate limit (tested for CORS/headers).
- Error responses carry stable codes and correlation IDs, never stack traces or SQL (tested).
- Log redaction for authorization/cookie headers and common secret field names.
- Electron: context isolation, sandbox, no Node integration, no webview, navigation lock, external-link
  allow-list, permission denial, single minimal IPC method (policy unit-tested; smoke-checked at runtime).
- Renderer Content-Security-Policy meta tag.
- Audit log is append-only at the database level (tested).
- `.env` files and generated artifacts are git-ignored; `.env.example` contains placeholders only.
- `npm audit`: 0 vulnerabilities at 2026-10-16 (re-run each gate).

## Not yet implemented (scheduled)

Authentication, password hashing (Argon2id), RBAC enforcement, session timeout/lock, login rate limiting,
credential encryption, backup encryption, upload validation, IPC argument validation beyond the current
no-argument channel, SBOM, dependency inventory, vulnerability procedure automation. See
[RISK_REGISTER.md](RISK_REGISTER.md) and [THREAT_MODEL.md](THREAT_MODEL.md).

## Reporting vulnerabilities

This is an internal project. Report suspected vulnerabilities privately to the project owner; do not open
public issues containing exploit details. Triage: reproduce, assign severity, record in
`PROJECT_STATE.md` "Open security issues", fix on a branch with a regression test, release note in
`CHANGELOG.md`. Critical findings block phase completion.

## Patch management

Run `npm audit` and review `npm outdated` at every phase gate. Security patches to Electron, Node-facing
libraries and PostgreSQL are applied promptly and verified with the full gate suite. Lockfile changes are
reviewed in the diff.

## Security test checklist (grows each phase)

- [x] Non-loopback bind rejected
- [x] CORS allows only configured origin
- [x] Error body has no internals
- [x] Audit log UPDATE/DELETE/TRUNCATE rejected
- [x] Electron navigation / external URL policy
- [x] Authentication, authorization and privilege-escalation tests (Task 1.3: forged/altered tokens, cross-user, cross-organization, role revocation, no admin bypass)
- [x] Rate limiting and per-account lockout on login (Task 1.3; limiter is coarse on loopback, R-046)
- [x] Bootstrap routes: launch secret, database-authoritative precondition under advisory lock, rate limits, no session, no secret in draft/logs/audit, value-free validation errors (Task 1.4). They are the ONLY routes exempt from user authentication; every future business route must use requireAuthenticatedUser + requirePermission
- [x] User administration (Task 1.6): all routes behind launch secret + session + exact permission key; ceiling on role grants/revokes and on password-reset targets; no self role change; create-with-roles needs security.role.manage; organization taken from the session; cross-organization targets are 404 and cross-organization roles the same 400 as unknown roles
- [x] Password change/reset (Task 1.6): current password required, wrong one is 400 and counts toward lockout, policy and reuse checks, Argon2id, other sessions revoked, no password material in responses, logs or audit
- [x] Forced password change enforced (AUTH_0004); last usable administrator protected by the database for every path, including concurrency
- [x] Sign-in UI (Task 1.7): one generic failure for every cause, no username oracle (lockout hint identical for unknown and known names), no technical text, password field cleared after each attempt
- [x] Session token memory-only in the renderer (never storage, URL, DOM or logs) and separate from the launch secret; sign-out revokes the session; idle/absolute expiry and 401 handling; in-flight responses cannot resurrect an ended session
- [x] Navigation derived from permissions, never role names (the server still enforces every route)
- [x] Setup wizard (Task 1.8): the administrator password is memory-only (never in the draft, storage, URL, logs, audit, review page or DOM outside active inputs), a rejected password is dropped, completion creates no session, a completed installation cannot reopen the wizard or bootstrap endpoints, no bank/UPI/credential fields are collected
- [x] Customer master (Task 1.9): every route behind launch secret + session + exact customer.read / customer.write; organization from the session (other-organization ids are 404); optimistic concurrency; no DELETE route and a database trigger forbidding deletion; audit events carry no personal data; request logs carry no query strings (search terms) - found and fixed in this task; search wildcards escaped
- [x] Product master (Task 1.10): every route behind launch secret + session + exact product.read / product.write; organization from the session; reference lookups organization-scoped; database triggers keep a product on its own organization's unit and tax category; optimistic concurrency; no DELETE route and a trigger forbidding deletion; money is exact decimal strings end to end; audit rows carry no names, descriptions or barcodes; logs carry no prices, names, barcodes or search terms
- [x] Inventory (Task 1.11): every route behind launch secret + session + exact keys (`inventory.stock.read` for reads, `inventory.adjustment.create` for the three stock operations, `warehouse.read` for the warehouse list); organization from the session; another organization's product, warehouse and movement are unknown and a trigger refuses them for any writer; the stock ledger is append-only (UPDATE/DELETE/TRUNCATE refused by trigger; no PATCH/DELETE route) and the balance is writable only by the ledger trigger; stock can never go negative (CHECK, serialized by row and advisory locks); quantities are exact decimal strings; retries are idempotent; audit rows carry facts only (no note or reference); logs carry no quantities, notes, references, search terms or tokens; no inventory endpoint returns cost, margin or price
- [x] Tax configuration (Task 1.12): routes behind launch secret + session + three separate exact keys (`tax.config.read`, `tax.config.update`, `tax.config.review`; only the Administrator template holds review); organization from the session; tax rates, categories and reviews cannot be edited or deleted (triggers) and reviews are append-only; a review binds to the configuration fingerprint and is refused if the configuration changed; production billing cannot be switched on until Task 1.17 provides a verified backup/restore; HSN/SAC is organization-scoped and a product can only use its own organization's entry; audit rows carry facts only (no notes, capacity or descriptions) and logs carry none of that text or any search term; the screens and the stored notice state that a review is not government verification or legal certification
- [ ] Automated accessibility audit (planned, R-069)
- [ ] Path traversal / upload restrictions (Phase 1+)
- [x] Per-launch secret guard on API, wired into the shell and verified end to end (Tasks 1.0 and 1.2)
- [x] IPC sender-URL validation and app:// path-traversal protection (Task 1.2)
- [ ] IPC argument validation for every channel (Phase 1+)
- [x] Sensitive-data logging prevention test for header secrets (Task 1.0); extend per new secret field
- [ ] Backup encryption / wrong password / corruption (Phase 1)

## Task 1.13 controls (sales invoices)

- Exact permission keys: `sales.invoice.write` (preview), `sales.invoice.post` (post), `sales.invoice.read` (list/get); organization from the session; another organization's ids are not found.
- The browser sends choices only. Unknown fields are refused; prices, rates, totals and the organization are never trusted from the request.
- Posted invoices are immutable in the database (triggers) as well as in the API; deferred constraints keep numbers, totals and stock effects consistent at COMMIT.
- Idempotency by operation id; the same id with different content is refused.
- Logs and the `invoice.post` audit row carry no customer name, address, GSTIN or search text.
- Production posting is refused until the Task 1.12 gate is met (needs the Task 1.17 backup/restore fact); the test seam is a default-false dependency.

## Task 1.15 controls (Electron print and save IPC; ADR-0025)

- Two document channels only (`document:save-invoice-pdf`, `document:print-invoice`); the sender frame is checked, then the payload is validated strictly; the HTML is built in the main process (renderer HTML is ignored).
- The hidden render window runs with JavaScript off, sandbox on, a throw-away session that cancels every request except its own `data:` page, and no navigation or new windows.
- The destination is chosen only in the operating system save dialog; a `.pdf` extension is enforced; a PDF signature is checked before anything is written. The result never contains a path.
- Print never runs silently. The preload exposes exactly four methods and no file-system, shell or navigation capability (source guard-rail tests).
- Logs and diagnostics carry no invoice, customer or tax content. A document needs `sales.invoice.read` (the snapshot is read through the normal API and organization boundary).

## Task 1.16 controls (payments and receivables; ADR-0026)

- Exact permission keys: `sales.payment.record` (record), `sales.payment.read` (list, view, receivables); organization from the session; another organization's invoice, customer or payment is not found. Warehouse Operator has no payment access.
- The browser sends choices only. Unknown fields (balance, already paid, customer, organization) are refused; the balance is always derived from the immutable grand total and the persisted allocations.
- Payments and allocations are immutable in the database (triggers) as well as in the API; the over-allocation limit is enforced by a locked, deferred database constraint, not only by the service or the screen.
- Idempotency by operation id; the same id with different content is refused.
- No card numbers, PINs or credentials are collected: a reference that looks like a card number is refused. Logs and the audit row carry no reference, notes or customer content.
- DEMO payments are separate records that can only touch demo invoices and never enter production receivables.

## Task 1.17 controls (backup and verified restore; ADR-0027)

- Archives are encrypted and authenticated (AES-256-GCM in chunks, scrypt key from the user's passphrase, unique salt and nonce per file, header and final-chunk flag authenticated). A wrong passphrase, any changed byte, a removed, reordered or appended chunk and a truncated file are refused before anything is read as data. A reader refuses key-derivation parameters above its limits, so a hostile file cannot demand unbounded memory or time.
- The passphrase is typed by the user, sent once in a request body over the loopback connection and dropped. It is never stored, logged, audited, put in a URL, a manifest, the command line or an environment variable. It cannot be recovered (R-098).
- A restored archive is untrusted input: only `manifest.json` and `data/<table>.ndjson` entry names are accepted, extracted to generated names (no path from the archive is ever used), with entry and size caps; data must match the manifest checksums before it is loaded; a manifest of another format, version, schema or organization is refused.
- The renderer has no file-system access. The backup folder and the restore file are chosen through argument-free IPC; the main process checks the sender, opens the native dialog and registers the path with the service using a second secret (`CONTROL_SECRET`) that never reaches the renderer; the service accepts only an existing writable folder or a recognisable `.cbbackup` file and returns only a display name and an opaque id. Control routes answer 403 without the secret (timing-safe comparison).
- `backup.history.read` reads; `backup.create` and `backup.restore` are Administrator only; the organization comes from the session; another organization's backups are not found.
- One operation at a time (advisory lock); a restore pauses the API (503) except health and backup status, takes a verified safety backup first, swaps databases by rename and keeps the previous one; any failure leaves the live data untouched.
- The production gate fact comes from the persisted verification record (PASS, current engine, schema and database, at most 30 days), never from a boolean; the `AppDeps` seam is test-only. Verification never switches the billing mode.
- Audit rows carry facts only (user, time, file name, outcome, failed check names); logs carry no passphrase, key, session or business data. Retention removes only recognised backup files the service itself recorded and never the newest verified backup.

## Windows packaging controls (installed runtime; ADR-0029)

- The private PostgreSQL listens on 127.0.0.1 only, on a random free port, with `scram-sha-256` and a generated password; the service also listens on 127.0.0.1 only. The installed-application test connects to both from the computer's own LAN addresses and must be refused. No firewall rule is created.
- The database password and the safety-backup passphrase are generated with a CSPRNG and stored only in `config\secrets.bin`, encrypted with Windows DPAPI (Electron `safeStorage`) for the current user. They are never sent to the renderer, written to a log (redaction is tested), placed in a bundle or in source.
- Install is per user and needs no elevation; the uninstaller keeps business data. Program files and data are separate folders.
- A database that is missing or unreadable is never replaced silently by a new empty one; a newer database is refused by an older program; a failed pre-upgrade backup or migration blocks normal start-up.
- The `RunAsNode` fuse stays enabled because the service runs under the Electron binary as Node; it is limited by the launch secret, loopback-only binding and the control-secret channel. The packaged end-to-end driver needs a marker file the release installer does not contain (R-111).
- The installer is unsigned unless a certificate is supplied at build time (R-108). SHA-256 is recorded in `release/installer-info.json`.
- `npm audit --omit=dev --audit-level=high` is part of `verify:release`.
