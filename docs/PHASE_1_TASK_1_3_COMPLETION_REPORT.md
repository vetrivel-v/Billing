# Phase 1 - Task 1.3 Completion Report: Authentication and Authorization Foundation (P1-AUTH-01)

Date: 2026-10-18 · Node v24.16.0 · Electron 44.8.0. Scope: Task 1.3 as recorded in PROJECT_STATE.md plus the
principles in the task brief. Task 1.4 was not started.

## Scope and result

| #   | Required                                                                                                                                                                       | Result                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1   | Password service (Argon2id, benchmarked cost, policy, constant-time verify, rehash)                                                                                            | **Met** - `packages/auth`                                                    |
| 2   | User/session service (create user, login, opaque session token hashed at rest, idle + absolute expiry, logout, revoke, per-account lockout, per-route login rate limit, audit) | **Met**                                                                      |
| 3   | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`; behind the launch secret; AUTH_0001/AUTH_0002; no enumeration; no secrets in logs                                     | **Met**                                                                      |
| 4   | `requirePermission('key')` resolving permissions server-side from the seeded tables; test-only routes prove allow/deny for all five templates                                  | **Met** (guards protect only test-only routes: no business routes exist yet) |
| 5   | Unit, integration, security tests; migration + migration test if schema changes                                                                                                | **Met**                                                                      |
| 6   | `verify:phase0` passes; thresholds unchanged                                                                                                                                   | **Met**                                                                      |
| 7   | Out of scope respected (no setup wizard, login UI, password reset, business features, backup)                                                                                  | **Met**                                                                      |

Task-brief principles: authentication and authorization are separate (launch secret is never used as a user
session; a valid session without it is 401); disabled users cannot create or use sessions; users are never
physically deleted (DB trigger); 401 and 403 are distinct; permission keys come from the seeded catalogue; no
hidden administrator bypass (tested); the Task 1.1 negative-permission tests are preserved and re-proved over HTTP.

## Design (ADR-0014)

- **Hash cost from measurement** (`npm run bench:password-hash`, median of 9 runs): 19 MiB/t=2 19 ms · 32 MiB/t=3
  46 ms · 48 MiB/t=3 62 ms · 64 MiB/t=3 84 ms · **64 MiB/t=4 110 ms (chosen)** · 96 MiB/t=3 131 ms · 128 MiB/t=3
  180 ms. Replaces the 17-20 ms OWASP-floor spike (ADR-0011). Configuration refuses weaker settings outside tests.
- **Sessions:** 32 CSPRNG bytes, header only, SHA-256 at rest (CHECK-enforced), 12 h absolute / 30 min idle,
  `last_seen_at` written at most every 30 s; revoked by logout, revoke-all and user disable.
- **Lockout:** 5 consecutive failures, 15 minutes, row-locked so concurrent guesses cannot bypass it.
- **No enumeration:** identical 401 body for unknown/wrong/disabled/locked/malformed; one Argon2 verify on every
  path (counted by a test). Remaining DB-timing differences of a few milliseconds are acknowledged, not claimed zero.
- **Migration** `20261018000000_task_1_3_auth_constraints` (constraints and a trigger only; schema.prisma unchanged).

## Files

Created: `packages/auth/{package.json,tsconfig.json,src/{index,config,password,password-policy,tokens,service}.ts}`
and tests (`password`, `password-policy`, `tokens-and-config`); `apps/api/src/{errors,auth-guard,auth-routes}.ts`;
`prisma/migrations/20261018000000_task_1_3_auth_constraints/migration.sql`; `scripts/benchmark-password-hash.ts`;
`tests/integration/{auth-fixture.ts,auth.int.test.ts,authorization.int.test.ts}`;
`tests/migration/auth-constraints.int.test.ts`; `docs/adr/0014-authentication-sessions-and-authorization.md`; this report.
Modified: `apps/api/src/app.ts` (auth wiring, ApiHttpError handling, configurable global/login rate limits),
`apps/api/package.json` (auth, zod, @node-rs/argon2 so the native module stays external in the bundle),
`packages/shared-types/src/index.ts` (LoginResponse, MeResponse), `package.json`/`package-lock.json`, and the
governance documents (PROJECT_STATE, REQUIREMENTS_MATRIX, RISK_REGISTER, DATABASE_SCHEMA, SECURITY, THREAT_MODEL).

## Defects and observations found during the task

1. **500 on unknown organization (fixed):** `POST /auth/login` with a non-existent `organizationId` tried to
   write an audit row referencing it (foreign key) and returned 500. Caught by the new case-insensitivity/
   organization test; the organization is now verified before use.
2. **Password policy gap (fixed):** `password123456` passed because only exact list entries matched. A "common
   word followed only by digits/symbols" rule was added.
3. **Test infrastructure:** the global API limiter (300/min) returned 429 during the 350-call role-matrix
   test; it is now configurable (`globalRateLimit`), default unchanged.
4. **Built API bundle:** `@node-rs/argon2` had to be declared in the API's dependencies so the bundler keeps the
   native module external; verified by booting the built API and by the Electron shell e2e test.
5. **Mutation checks (not committed code):** five deliberate breaks of the security logic - no idle check, no
   lock check, revoked sessions accepted, disabled-user check removed, administrator bypass in the guard - were
   applied together and made 10 tests fail (idle expiry, lockout x2, enumeration equality, logout, disable x2,
   revoke-all, admin no-bypass x2); sources were restored and verified identical.
6. R-043 (transient unit failure from Task 1.2) did not recur in this task's runs; it stays open.

## Tests

| Suite                         | Before | After                                                      |
| ----------------------------- | ------ | ---------------------------------------------------------- |
| Unit                          | 79     | **117** (+38: password 9, policy 14, tokens/config 15)     |
| Integration (incl. migration) | 51     | **102** (+51: auth 28, authorization 19, auth migration 4) |
| Total                         | 130    | **219**                                                    |

No existing test was removed or weakened. Highlights: same password -> different stored hashes; audit and logs
contain no passwords/hashes/tokens (trace-level log capture); 12 concurrent guesses leave exactly the threshold
count; absolute expiry at 725 minutes despite activity every 29; all 5 roles x 70 keys over HTTP; Administrator
loses a permission the moment the grant is deleted; a role from another organization grants nothing; the real
production Argon2 parameters work end to end.

## Commands executed and actual results

| Command                                                                                                                       | Result                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run bench:password-hash`                                                                                                 | table above                                                                                                                                                                        |
| `npm run typecheck`, `npx eslint .`                                                                                           | no errors (after replacing `any` in new tests with typed helpers)                                                                                                                  |
| `npx vitest run --project integration tests/migration tests/integration/auth.int tests/integration/authorization` (first run) | 9 failures: 429 from the global limiter, 500 on unknown org, an over-broad test regex                                                                                              |
| same, after fixes                                                                                                             | 47 passed (auth 28 + authorization 19)                                                                                                                                             |
| mutation run (see item 5)                                                                                                     | 10 failed / 37 passed, then sources restored                                                                                                                                       |
| `npm run verify:phase0`                                                                                                       | exit 0; all 8 gates PASS; Unit 15 files / 117 tests; Integration 9 files / 102 tests                                                                                               |
| `npx vitest run --coverage`                                                                                                   | 24 files, 219 tests passed; Statements 98.04% (452/461), Branches 94.30% (298/316), Functions 99.11% (112/113), Lines 99.27% (409/412); thresholds (80/70/80/80) unchanged and met |
| `npm audit`                                                                                                                   | found 0 vulnerabilities                                                                                                                                                            |
| no leftover `postgres.exe`/Electron processes                                                                                 | confirmed                                                                                                                                                                          |

Electron shell e2e (Task 1.2) still passes with the new bundled API (it computes the dummy Argon2 hash with the
production parameters at startup). No Playwright suite exists; the integration tests above are the end-to-end tests.

## Known limitations and risks

- No login UI, password change/reset or user-management routes; `must_change_password` is stored and returned
  but not enforced; no inactivity-lock/manual-lock UI (R-047, R-048).
- Guards protect only test-only routes; permission denials are logged, not audited; permissions are queried on
  every request (R-050); audit volume under attack is unbounded except by lockout/rate limits (R-049); the
  login limiter is coarse on loopback (R-046).
- The common-password list is a small built-in floor, not a breach corpus.
- Carried forward: P1-BKP-01, P6-ENC-01, R-040, R-041 (closed by the setup task), R-042, R-043, R-045.

## Exact next task

Task 1.4 - first-run setup service and API (backend only). Full scope and acceptance criteria are in
`docs/PROJECT_STATE.md`. Not started.
