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
- [ ] Authentication / authorization / privilege escalation (Phase 1)
- [ ] Rate limiting on login (Phase 1)
- [ ] Path traversal / upload restrictions (Phase 1+)
- [x] Per-launch secret guard on API, wired into the shell and verified end to end (Tasks 1.0 and 1.2)
- [x] IPC sender-URL validation and app:// path-traversal protection (Task 1.2)
- [ ] IPC argument validation for every channel (Phase 1+)
- [x] Sensitive-data logging prevention test for header secrets (Task 1.0); extend per new secret field
- [ ] Backup encryption / wrong password / corruption (Phase 1)
