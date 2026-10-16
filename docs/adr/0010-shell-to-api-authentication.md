# ADR-0010: Shell-to-API authentication with a per-launch secret

- Status: Accepted (guard implemented and tested; wiring into the Electron shell is requirement P1-SEC-01, which must land before any data-bearing API route)
- Date: 2026-10-16
- Resolves: risk R-032 (design); residual risk R-037

## Context

The API listens on 127.0.0.1 only (ADR-0008), but any process or OS user on the machine can connect to a
loopback port. Loopback binding is not authentication.

## Decision

Two layers:

1. **Per-launch secret (implemented).** The Electron main process generates 32 random bytes
   (`crypto.randomBytes`, hex-encoded, 64 chars) at every launch and passes them to the API child process via
   the `LAUNCH_SECRET` **environment variable** (never argv, never written to disk or logs). When
   `LAUNCH_SECRET` is set, the API rejects every request - including unknown routes, so there is no 404
   oracle - that lacks a matching `x-commercebill-launch-secret` header, using a constant-time comparison, with
   the stable error `AUTH_0001`/HTTP 401. Only `/health` (liveness, no data) is exempt. The renderer obtains the
   secret through a dedicated preload method (added with the shell-integration task, with argument validation
   and a security test) and attaches it to API calls. `LAUNCH_SECRET` must be at least 32 characters (env
   validation).
2. **User sessions (Phase 1 authentication task).** Login issues an opaque random session token stored only as
   a SHA-256 hash (`sessions.token_hash`), with inactivity timeout and revocation. Every operation then
   performs server-side permission checks. The launch secret never replaces user authorisation.

Logging: `authorization`, `cookie` and the launch-secret header are redacted, including when a handler logs a
header object under any key; default request logs contain no headers.

## Evidence

`apps/api/src/launch-secret.test.ts` (9 tests) and `packages/validation/src/env.test.ts`: missing, wrong,
truncated and extended secrets rejected; exempt-path matching; CORS preflight for the custom header; no change
in behaviour when no secret is configured; two leak tests (default logging and explicit header dump) confirm
the secret value, bearer token and cookie never appear in logs.

## Consequences

- The secret is only as protected as the renderer: a compromised renderer can read it (risk R-037), which is
  why user sessions and per-operation authorisation remain mandatory and the renderer is sandboxed (ADR-0006).
- A same-user process able to read the API process environment or Electron memory can also obtain the secret;
  this is within the "local malware as the same user" case accepted in THREAT_MODEL.md.
- Development without the Electron shell leaves the guard off. Production builds must always set it; this will
  be enforced by a production-mode requirement in env validation when the shell integration lands.
- `main.ts` already passes `LAUNCH_SECRET` to the guard, but the Electron shell does not generate or supply it
  yet (not wired; no end-to-end test of that path exists).
