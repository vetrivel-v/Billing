# ADR-0018: Application shell, sign-in UI and renderer session handling

- Status: Accepted and implemented in Phase 1 Task 1.7
- Date: 2026-10-19
- Builds on: ADR-0010 (shell-to-API authentication), ADR-0013 (renderer origin), ADR-0014 (sessions), ADR-0017

## Decisions

1. **Router:** `react-router` with `HashRouter`. It works from `app://`, `file://` and the dev server with no server
   rewrites. The session state machine (booting, unreachable, setup-required, signed-out, signed-in) decides what is
   reachable; a deep link followed before sign-in is kept, the address is reset to `/` after sign-out.
2. **Token handling:** the session token is held only in a React ref inside `AuthProvider`. It is passed to the API
   client per call and sent only as `Authorization: Bearer`. It is never written to storage, the URL, the DOM or logs.
   The Electron launch secret remains a separate header supplied by the preload bridge on every call.
3. **Generic failure and lockout feedback:** the server's login answer is identical for every failure (ADR-0014), so the
   page shows one message. Lockout feedback is a client-side estimate: after 5 consecutive failures for the same typed
   name the page adds a notice that sign-in "may be blocked for about 15 minutes". The count is the same for names that
   do not exist, so it cannot be used to discover usernames (R-065).
4. **Expired vs revoked:** the server returns the same 401 for both. The client says "expired" when its own clock passed
   the known expiry or idle limit, and otherwise "ended (signed out elsewhere or revoked)".
5. **Idle handling:** pointer/key activity is tracked; while the user is active a keep-alive `GET /auth/me` is sent after
   a third of the idle timeout; with no activity for the full idle timeout the client signs out and revokes. Responses
   that arrive after the session ended are discarded (a test-found defect, fixed).
6. **Permission-driven navigation:** entries are shown when their permission key is held (customer.read, product.read,
   inventory.stock.read, sales.invoice.read, org.settings.read); Dashboard needs none. Unbuilt modules are shown disabled
   with "Coming soon" and are not links. No role name is consulted. The server remains authoritative.
7. **Shared primitives:** `@commercebill/ui` holds presentation-only components (no API, router or state) styled with
   Tailwind and a `brand` colour scale; only what this slice needs. Light theme only for now.
8. **Backend addition:** `GET /auth/me` returns `organizationName` and `roles` for display.

## Consequences

- A fresh installation shows "Setup required" until Task 1.8 delivers the wizard.
- Reloading the window signs the user out (memory-only token). This is intended.
- The Electron smoke test now observes the first screen heading rather than the Phase 0 status panel.
