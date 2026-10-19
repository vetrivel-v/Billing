# Phase 1 - Task 1.7 Completion Report: Application Shell and Login UI

## Visible functionality achieved

- Launch on a configured database -> **sign-in page** (the Phase 0 status page is gone).
- Valid sign-in -> **application shell**: header (organization, user, Change password, Sign out), sidebar (Dashboard,
  Customers, Products, Inventory, Billing, Settings) and a **dashboard** with real account, organization, role, session
  and live service-status information.
- Wrong credentials, lockout, rate limit and an unreachable service each have plain-language feedback.
- A user on a temporary password sees only "Choose a new password" until it is changed.
- Fresh installation -> "Setup required" (honest placeholder; the wizard is Task 1.8).
- Expired or revoked sessions return to sign-in with an explanation; sign-out revokes the session.

## Implemented against the brief

| Item                                         | Where                                           |
| -------------------------------------------- | ----------------------------------------------- |
| Router / navigation architecture             | `apps/web/src/App.tsx`, `main.tsx` (HashRouter) |
| Real API client                              | `apps/web/src/api.ts`                           |
| `/setup/status` launch check                 | `auth.tsx` boot, `pages.tsx`                    |
| Login, generic failure, lockout feedback     | `LoginPage.tsx`, `messages.ts`                  |
| AUTH_0004 forced change                      | `ChangePasswordPage.tsx`, `App.tsx`             |
| In-memory token, sign-out, expiry/revocation | `auth.tsx`                                      |
| Permission-driven navigation                 | `nav.ts`, `App.tsx`                             |
| Dashboard with real data only                | `pages.tsx`, `GET /auth/me` additions           |
| Reusable primitives                          | `packages/ui`                                   |

## Points to review

- **Backend change:** `GET /auth/me` now returns `organizationName` and `roles` (display only), needed for the dashboard.
- **Existing test changed:** `tests/integration/electron-shell.int.test.ts` and the smoke probe in
  `apps/desktop/src/main.ts` read the first screen heading ("Setup required" on the empty smoke database) instead of the
  Phase 0 status-panel test ids. The secret, loopback, authorised/unauthorised-call and no-leak assertions are unchanged.
- **Lockout feedback is a client-side estimate** (the server cannot reveal lockout without revealing usernames; R-065).
- **"Browser-level" test:** the application's real DOM (jsdom) talks over real HTTP to the real API and PostgreSQL.
  Real Electron is exercised by the existing smoke test (first screen). A Playwright/Electron E2E is Task 1.18 (R-068).
- Added dependency `react-router` 8.4.0 (audit: 0 vulnerabilities). Coverage now includes `.tsx` files.
- Light theme only; accessibility is built in but not audited (R-069).
- Screens were also viewed in a browser against a throwaway API (login, failure message, dashboard).

## Tests

| Suite       | Count                                                            |
| ----------- | ---------------------------------------------------------------- |
| Unit        | 295 (251 + 44: UI primitives, API client, shell/auth/navigation) |
| Integration | 288 (276 + 12 DOM-against-real-API)                              |
| Total       | 583, all passing                                                 |

Coverage: 96.4% statements / 91.9% branches / 98.4% functions / 98.3% lines (thresholds unchanged 80/70/80/80).
Mutation checks: six (unfiltered navigation, forced-change gate, token in localStorage, lockout hint, in-flight guard,
expiry) each failed at least one test; sources restored and verified identical. Defect found and fixed: a keep-alive
response after sign-out could resurrect the session.

## Commands executed

`npm run typecheck`, `npm run lint`, `npm run format:check`, `npx vitest run --coverage` (583 passed), `npm run
verify:phase0` (all 8 gates PASS, including the production build), `npm audit` (0 vulnerabilities), 2026-10-19.

## Risks

- Opened: R-065 (accepted), R-066 (mitigating), R-067 (accepted), R-068 (open), R-069 (open).
- Unchanged and carried forward: R-040 (open until independent tax-data review), R-063 (deferred), R-037, R-043, R-046,
  R-049, R-050, R-053, R-054, R-055, R-058, R-060..R-062, R-064.

## Exact next task

Task 1.8 - Setup wizard UI (PROJECT_STATE, "Exact next task"). Not started.
