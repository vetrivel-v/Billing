# ADR-0008: Loopback-only API with validated environment

- Status: Accepted
- Date: 2026-10-16

## Context

Spec section 38: bind to localhost only; no unauthenticated LAN exposure.

## Decision

`API_HOST` must be 127.0.0.1, localhost or ::1; any other value fails startup validation (`packages/validation`). CORS allows only configured origins. Helmet security headers and a coarse rate limit are on by default. Errors return stable codes plus a correlation ID and never stack traces. Logs redact credentials.

## Consequences

Loopback is not authentication: Phase 1 adds session auth and a per-launch shared secret between the Electron shell and API (risk R-032). Future LAN mode will need its own ADR.
