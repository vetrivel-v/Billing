# Phase 1 - Task 1.2 Completion Report: Shell supplies the launch secret (P1-SEC-01)

Date: 2026-10-18 · Node v24.16.0 · Electron 44.8.0. Scope: approved Task 1.2 only. Task 1.3 was not started.

## Acceptance criteria (from PROJECT_STATE.md) and result

| #   | Criterion                                                                                                                                                                                                    | Result                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Main process generates 32 random bytes per launch, starts the built API on 127.0.0.1 with `LAUNCH_SECRET` via environment only, waits for `/health`, stops the child on quit; secret never in disk/argv/logs | **Met.** `api-supervisor.ts` (7 unit tests incl. env-only delivery, allow-listed child env, early-exit and timeout paths); stop on `will-quit`; e2e confirms no 64-hex string in shell output and `secretInApiOutput:false` |
| 2   | One argument-free preload method returning only base URL and secret; security test; `DesktopBridge` updated                                                                                                  | **Met.** `getApiAccess()`; IPC sender-URL validation on every channel (`isTrustedSender`, 5 policy tests). Note: the rejection path is unit-tested on the URL check, not with a live hostile frame                          |
| 3   | Web client sends the header on every call except `/health`; clear state when unreachable/rejected                                                                                                            | **Met.** `api.ts` (8 tests) and `StatusPanel` ("Not authorised" vs "Unreachable")                                                                                                                                           |
| 4   | Production API refuses to start without `LAUNCH_SECRET`                                                                                                                                                      | **Met.** `env.ts` `superRefine`; 3 new env tests                                                                                                                                                                            |
| 5   | Electron smoke e2e: authorised `/health/db` succeeds; without secret 401 `AUTH_0001`; secret not in API log                                                                                                  | **Met.** `tests/integration/electron-shell.int.test.ts` (6 tests)                                                                                                                                                           |
| 6   | Existing tests pass; `verify:phase0` baseline intact; thresholds unchanged                                                                                                                                   | **Met** (counts below)                                                                                                                                                                                                      |
| 7   | No new data-bearing route, auth UI, sessions, backup or business feature                                                                                                                                     | **Met**                                                                                                                                                                                                                     |
| 8   | Governance docs, report, ADR-0010 status                                                                                                                                                                     | **Met** (this report; ADR-0013 added)                                                                                                                                                                                       |

## Design decision required (ADR-0013)

Serving the renderer from `file://` gives the page the opaque origin `null`, which would have forced the API's
CORS allow-list to accept `null`. The renderer is therefore served from a privileged custom scheme
`app://commercebill` with traversal-safe file mapping; the API allows exactly that origin. `file://` navigation
is no longer permitted. CSP `connect-src` now allows `http://127.0.0.1:*` because the API port is chosen per
launch. Full rationale and consequences are in `docs/adr/0013-renderer-origin-and-api-supervision.md`.

## Actual end-to-end output (real Electron, real built API, real PostgreSQL)

Run against the development database, `SMOKE_RESULT` (secret value intentionally not part of the output):

```
{"origin":"app://commercebill","title":"CommerceBill Desktop","bridge":{"name":"CommerceBill Desktop","version":"0.0.1","platform":"win32"},"nodeExposed":false,"secretLength":64,"baseUrlIsLoopback":true,"authorisedDb":{"status":200,"code":null,"db":"ok"},"unauthorisedDb":{"status":401,"code":"AUTH_0001","db":null},"livenessWithoutSecret":{"status":200,...},"ui":{"api":"ok","db":"ok"},"secretInApiOutput":false}
```

(`livenessWithoutSecret` abbreviated here; it was `{"status":200,"code":null,"db":null}`.) The same assertions
run in the automated test against an isolated database.

## Defects and observations during the task

1. **Genuine bug (fixed):** `startApi` decided the child had exited by `exitCode !== null`; a child killed by
   `kill()` has `exitCode === null` and a `signalCode`, so `hasExited()` was false after `stop()`. Now checks
   both. Caught by the new unit test.
2. **Test-infrastructure fragility (fixed, R-034):** a user-interrupted command left an orphan `postgres.exe`
   holding the fixed test port 54330; subsequent integration runs printed "No test files found" and an
   unhandled "Unknown Error: undefined" plus "close timed out". The test cluster now uses a free OS-assigned
   port. The orphan was killed manually.
3. **Unexplained transient failures (R-043, open) - corrected account.** My first version of this report said
   "two pre-existing `launch-secret.test.ts` tests failed". That was an inference I could not support: the run's
   output was only captured through `tail -25` and no log was saved. What the captured output actually shows:
   - Command: `npx vitest run --project unit` (first full unit run after the Task 1.2 test files were added).
   - Summary line: `Test Files 3 failed | 9 passed (12)`, `Tests 3 failed | 76 passed (79)` - three failing
     tests in three different files.
   - Failure [2/3]: `apps/api/src/launch-secret.test.ts` > "API with a launch secret (R-032 spike)" > "rejects
     requests without the secret using the stable error contract" - a **pre-existing Task 1.0 test**. The error
     message was above the captured window and is unknown.
   - Failure [3/3]: `apps/desktop/src/api-supervisor.test.ts` > "starts the child, waits for health, supplies
     the secret by env, and stops it" - a **new Task 1.2 test**, `AssertionError: expected false to be true` at
     `hasExited()`; a genuine bug (item 1), fixed.
   - Failure [1/3]: **not captured, unidentified** (a third file; it is not known whether it was pre-existing or
     new).
     Subsequent successful executions (all with full pass totals unless noted): isolated `apps/api` run (no failures
     printed; summary not captured); full unit run after the fix 79/79; `verify:phase0` unit gate 79/79; three
     repeated unit runs 79/79 each; coverage run (all 126 tests); a verbose count run (no failures seen; summary not
     captured); three **simultaneous** unit runs during a concurrent full integration run, 79/79 each (a deliberate
     attempt to reproduce under load); final `verify:phase0` unit gate 79/79. That is 10 complete passes with a
     captured total, and none reproduced the failure. `launch-secret.test.ts` itself passed in every one of them.
     Nothing was skipped, retried-until-green, quarantined or weakened, and production code was not changed to make
     the observation disappear. Hypothesis (unverified): timing/load sensitivity during the first cold run; the
     load experiment did not support it.
4. Several multi-line shell heredocs were mangled by the tool; files were rewritten with the file tools. No
   effect on the final content (verified by typecheck, lint, format and tests).

## Tests

| Suite                                    | Before | After                                                                                                                                                             |
| ---------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (`npm test`)                        | 52     | **79** (+27: supervisor 7, app protocol 9, desktop security +2, web api +5, StatusPanel +1, env +3)                                                               |
| Integration (`npm run test:integration`) | 45     | **51** (+6 in `electron-shell.int.test.ts`: authorised/401/log-leak e2e, fresh secret per launch, missing DATABASE_URL, three built-API production-refusal tests) |
| Total                                    | 97     | **130**                                                                                                                                                           |

No Phase 0/1.0/1.1 test was removed or weakened. The Task 1.0 `security.test.ts` expectations that allowed
`file://` were replaced because the policy intentionally changed (file:// is now rejected).

## Review round (before commit): secret-handling evidence

Each claim checked against code and tests (final run: `npm run verify:phase0`, exit 0, all 8 gates PASS; unit
12 files / 79 tests; integration 6 files / 51 tests; zero failures; Electron shell e2e file: 6 tests passed):

| Claim                                         | Evidence                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh secret per launch                       | `generateLaunchSecret()` = 32 `randomBytes`, called once in `startLocalApi` per process start; unit test (two calls differ, 64 hex); **e2e test launches the real shell twice and compares one-way SHA-256 fingerprints: different**                                                                                                            |
| Passed to the API without being persisted     | Only an in-memory variable in main + the child's environment. `grep` of non-test app/package source finds **no** file writes, localStorage/sessionStorage/cookies/IndexedDB; no 64-hex literal exists in the repository; the database schema has no column for it; unit test proves it is not in argv and unrelated parent env is not forwarded |
| Request without secret -> 401                 | e2e: renderer call without header gets `401 AUTH_0001`; `launch-secret.test.ts` (missing, wrong, truncated, extended secrets; unknown routes also 401)                                                                                                                                                                                          |
| Request with secret succeeds                  | e2e: `/health/db` 200 with `database: ok`; the React UI shows API ok / DB ok                                                                                                                                                                                                                                                                    |
| Not in normal or diagnostic logs              | e2e: API's captured output and the shell's stdout/stderr contain no 64-hex string and not the secret; two leak tests with header dumps (redaction); crash diagnostics replace the secret with `[REDACTED]` (unit test). No diagnostic export exists yet                                                                                         |
| Not exposed unnecessarily to the renderer     | It **is** delivered to the renderer's JavaScript because the renderer makes the calls (accepted, R-037; ADR-0013). Limits: only through one argument-free bridge method; sender frame URL validated; kept in a module variable (not URL, DOM, storage); never returned by the smoke check; contextIsolation + sandbox on                        |
| Comparison/validation is server-side          | `launchSecretMatches` (constant-time, in the API process) in an `onRequest` hook; the renderer never decides authorisation                                                                                                                                                                                                                      |
| Fails safely on missing/invalid configuration | Real built API process exits 1: production without `LAUNCH_SECRET` ("LAUNCH_SECRET is required when NODE_ENV=production"); secret shorter than 32 chars (value not echoed); non-loopback `API_HOST`; shell exits 1 with variable name only for missing `DATABASE_URL`                                                                           |

## Commands executed and actual results

| Command                                                                                                                                                                          | Result                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm install -D @commercebill/validation -w @commercebill/desktop`                                                                                                               | 0 vulnerabilities                                                                                                                                                              |
| `npm run typecheck`, `npx eslint .`                                                                                                                                              | no errors                                                                                                                                                                      |
| `npx vitest run --project integration tests/integration/electron-shell`                                                                                                          | 2 tests passed (also after the free-port change: 21 s, no leaked processes)                                                                                                    |
| Manual smoke against dev DB (`ELECTRON_SMOKE=1`, `electron .`)                                                                                                                   | output above, exit 0, no Electron process left                                                                                                                                 |
| `npm run verify:phase0` (before the review additions)                                                                                                                            | exit 0; all 8 gates PASS; unit 79; integration 47                                                                                                                              |
| `npm run verify:phase0` (FINAL, after the review additions, from the current working tree)                                                                                       | exit 0; all 8 gates PASS (Prisma validate, generate, Type-check, Lint, Format check, Unit 12 files / 79 tests, Integration 6 files / 51 tests, Build); no failures             |
| Unit suite repeated 3 times                                                                                                                                                      | 79 passed each time                                                                                                                                                            |
| `npx vitest run --coverage` (measured before the review additions; not re-run - later changes were test files and smoke-only code in `main.ts`, which is excluded from coverage) | 18 files, 126 tests passed; Statements 98.49% (196/199), Branches 93.84% (122/130), Functions 100% (57/57), Lines 98.86% (174/176); thresholds (80/70/80/80) unchanged and met |
| `npm audit`                                                                                                                                                                      | found 0 vulnerabilities                                                                                                                                                        |

No Playwright end-to-end suite exists; the Electron shell test is the Task 1.2 end-to-end test.

## Files

Created: `apps/desktop/src/{api-supervisor,app-protocol}.ts` and their tests, `tests/integration/electron-shell.int.test.ts`,
`docs/adr/0013-renderer-origin-and-api-supervision.md`, this report.
Modified: `apps/desktop/src/{main,preload,security,security.test}.ts`, `apps/desktop/package.json`,
`apps/web/{index.html,src/api.ts,src/api.test.ts,src/StatusPanel.tsx,src/StatusPanel.test.tsx,src/vite-env.d.ts}`,
`packages/shared-types/src/index.ts`, `packages/validation/src/{env,env.test}.ts`,
`packages/test-utilities/src/index.ts`, `package-lock.json`, `README.md`, and the governance documents
(`PROJECT_STATE`, `REQUIREMENTS_MATRIX`, `RISK_REGISTER`, `SECURITY`, `THREAT_MODEL`, ADR-0010). No migration
was needed: the database schema is unchanged (current version `20261017000000_task_1_1_tax_reference_markers`).

## Known limitations and risks

- No user authentication yet; the secret authorises the shell's renderer, not a person (P1-AUTH-01).
- `DATABASE_URL` is read from the shell's environment (development only); the packaged file layout and
  PostgreSQL supervision are Phase 6 (R-045). Verified on Windows only.
- R-037 (secret visible to the renderer, accepted), R-044 (free-port race, accepted), R-043 (unexplained transient,
  open).
- Carried forward unchanged: P1-BKP-01, P1-AUTH-01, P6-ENC-01, R-041 (seed audit), R-042, R-040.

## Exact next task

Task 1.3 - authentication and authorization foundation (P1-AUTH-01). Full proposed scope and acceptance criteria
are in `docs/PROJECT_STATE.md`. Not started.
