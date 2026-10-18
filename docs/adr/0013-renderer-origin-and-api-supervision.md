# ADR-0013: Renderer served from app://, API supervised by the Electron shell

- Status: Accepted
- Date: 2026-10-18
- Task: Phase 1 Task 1.2 (requirement P1-SEC-01; completes ADR-0010)

## Context

ADR-0010 added a per-launch secret guard to the API, but nothing set or sent the secret. Wiring it exposed
two design questions: how the renderer (a page loaded by Electron) can call the loopback API under CORS, and
how the shell should start the API and hand it the secret without leaking it.

## Decision

1. **Renderer origin.** The built web app is served through a privileged custom scheme,
   `app://commercebill` (`protocol.registerSchemesAsPrivileged` with `standard`, `secure`, `supportFetchAPI`,
   `corsEnabled`; `protocol.handle` maps requests to files inside `apps/web/dist`). A page loaded from
   `file://` has the opaque origin `null`, which would force the API to allow `null` (any sandboxed frame or data:
   page). With `app://commercebill` the API allows exactly that one origin (`WEB_ORIGIN`). File mapping
   (`resolveAppRequest`) rejects other hosts/schemes, `..`, encoded and backslash traversal, NUL bytes and
   anything outside the web root. `file://` navigation is no longer allowed. Under the dev server the renderer
   origin is the Vite origin instead.
2. **Supervision.** The main process generates 32 random bytes (hex) per launch, picks a free loopback port,
   validates the configuration with the same Zod schema the API uses (in `NODE_ENV=production`, so
   `LAUNCH_SECRET` is mandatory), and spawns the built API bundle with the Electron binary in
   `ELECTRON_RUN_AS_NODE` mode. The child receives an **allow-listed environment** (system variables it needs,
   plus API settings and `LAUNCH_SECRET`); unrelated variables of the parent are not forwarded and nothing
   secret is placed in argv. The shell waits for `/health`, captures the child's output (capped, in memory) and
   stops the child on quit. If startup fails the user sees a dialog with a sanitized reason and nothing runs.
3. **Secret delivery to the renderer.** One argument-free preload method, `getApiAccess()`, returns
   `{ baseUrl, secret }`. The main process validates the **sender frame URL** (`isTrustedSender`) for every
   IPC channel; only the application's own origin (or the dev server when unpackaged) is accepted. The web client
   caches the result (not failures) and sends `x-commercebill-launch-secret` on every call except `/health`.
4. **Production rule.** `NODE_ENV=production` without `LAUNCH_SECRET` fails environment validation.
5. **CSP.** `connect-src` allows `'self'` and `http://127.0.0.1:*` (the port is chosen per launch).

## Consequences

- The secret is visible to the renderer by design (risk R-037). A compromised renderer, or another process of
  the same Windows user that can read process memory or environment, can obtain it; user sessions and
  per-operation authorization (P1-AUTH-01) remain mandatory.
- `getFreePort()` then binding is a small race (another process could take the port in between); startup then
  fails cleanly and the user can retry (risk R-044).
- The shell currently reads `DATABASE_URL` from its own environment (development). Supervising PostgreSQL and
  the packaged file layout (`apps/web/dist`, `apps/api/dist` relative paths) are Phase 6 work (risk R-045).
- The child's output is held in memory only; persistent diagnostic logging is a later task.
