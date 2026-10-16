# ADR-0006: Electron hardening baseline

- Status: Accepted
- Date: 2026-10-16

## Context

Spec section 38 requires context isolation, sandbox, no node integration, a minimal validated preload bridge, navigation restrictions and an external-link allow-list.

## Decision

BrowserWindow uses contextIsolation, sandbox, nodeIntegration=false, webviewTag=false. Navigation is limited to file:// (and the dev server when unpackaged). New windows are always denied; allow-listed https origins open in the system browser. All permission requests are denied. The preload exposes one read-only method (`getAppInfo`) through `contextBridge`. Policy functions live in `apps/desktop/src/security.ts` and are unit-tested. The renderer HTML carries a Content-Security-Policy.

## Consequences

Each new IPC channel needs an ADR note, schema validation of its arguments and a security test. Verified by an Electron smoke check (page loads, bridge works, Node not exposed).
