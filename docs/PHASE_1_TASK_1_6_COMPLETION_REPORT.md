# Phase 1 - Task 1.6 Completion Report: User Administration and Password Management

## Result

All ten approved routes are implemented behind the launch secret, with application-user authentication, exact
permission keys, 401/403 semantics and the approved audit events (ADR-0017). One migration was added. Nothing was pushed.

| #   | Route                            | Auth / permission                                              | Success   | Audit event                                                      |
| --- | -------------------------------- | -------------------------------------------------------------- | --------- | ---------------------------------------------------------------- |
| 1   | `GET /auth/me` (existing)        | session                                                        | 200       | -                                                                |
| 2   | `POST /auth/change-password`     | session                                                        | 204       | `user.password.changed` (failure: `user.password.change_failed`) |
| 3   | `GET /roles`                     | `security.role.read`                                           | 200       | -                                                                |
| 4   | `GET /users`                     | `security.user.read`                                           | 200       | -                                                                |
| 5   | `GET /users/:id`                 | `security.user.read`                                           | 200 / 404 | -                                                                |
| 6   | `POST /users`                    | `security.user.manage` (+ `security.role.manage` with roleIds) | 201       | `user.create`                                                    |
| 7   | `POST /users/:id/disable`        | `security.user.manage`                                         | 200       | `user.disable`                                                   |
| 8   | `POST /users/:id/enable`         | `security.user.manage`                                         | 200       | `user.enable`                                                    |
| 9   | `PUT /users/:id/roles`           | `security.role.manage`                                         | 200       | `user.roles.changed`                                             |
| 10  | `POST /users/:id/reset-password` | `security.user.reset_password`                                 | 204       | `user.password.reset`                                            |

## Points to review

- **Addition beyond the plan:** the privilege ceiling also applies to reset-password targets (ADR-0017). Easy to remove
  if you disagree, but a reset-only holder could otherwise take over an Administrator account.
- The brief wrote `security.role_manage`; the catalogue key is `security.role.manage`.
- Disable/enable have no ceiling (R-064).
- Removing only the service-level copy of the "role.manage on create" check does not fail a test because the route
  enforces it first; removing both does. This is defence in depth.

## Migration

`20261021000000_task_1_6_security_admin_invariant`: no table change; one counting function, one trigger function, five
deferred constraint triggers, advisory lock per organization. Forward-only; migration test with 8 cases (populated
upgrade, count semantics, every refused path with state unchanged, commit-time swap, per-organization and exempt
behaviour, two-client concurrency, forward-only).

## Tests

| Suite       | Count                                 |
| ----------- | ------------------------------------- |
| Unit        | 251 (246 + 5 privilege-ceiling tests) |
| Integration | 276 (215 + 8 migration + 53 HTTP)     |
| Total       | 527, all passing                      |

Coverage: 96.5% statements / 92.0% branches / 98.9% functions / 98.2% lines (thresholds 80/70/80/80, unchanged).
Existing Phase 0 and Phase 1 tests were not edited except the shared test fixture, which now sets high default limits
for the two new route-level rate limits (as it already does for login).

Escalation attempts tested over HTTP: role with permissions the caller lacks; own roles; create with roleIds while
lacking `security.role.manage` (including a role inside the caller's permissions); cross-organization role assignment;
disabling the last usable administrator; removing the last administrator's role (database level) and concurrent mutual
disable (exactly one succeeds).

Mutation checks (each made at least one test fail; sources restored and verified identical): ceiling on role changes,
own-role rule, role.manage on create (route and service), pending-change enforcement, revoke-other-sessions,
organization scope of user lookup.

## Commands executed

`npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run --coverage` (527 passed) and
`npm run verify:phase0` (all 8 gates PASS) on 2026-10-18.

## Risks

- Closed/mitigated: R-047, R-048. Reduced: R-055 (sole administrator recovery still missing).
- Opened: R-059 (mitigated), R-060, R-061, R-064 (accepted), R-062 (mitigating), R-063 (open, Task 1.7).
- Carried forward unchanged: R-037, R-043, R-046, R-049, R-050, R-053, R-054, R-058.

## Exact next task

See PROJECT_STATE.md, "Exact next task": Task 1.7 - audit-log read API and auditing of authorization denials.
Not started.
