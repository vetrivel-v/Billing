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
- [ ] Automated accessibility audit (planned, R-069)
- [ ] Path traversal / upload restrictions (Phase 1+)
- [x] Per-launch secret guard on API, wired into the shell and verified end to end (Tasks 1.0 and 1.2)
- [x] IPC sender-URL validation and app:// path-traversal protection (Task 1.2)
- [ ] IPC argument validation for every channel (Phase 1+)
- [x] Sensitive-data logging prevention test for header secrets (Task 1.0); extend per new secret field
- [ ] Backup encryption / wrong password / corruption (Phase 1)
