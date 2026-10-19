# ADR-0019: First-run setup wizard UI

- Status: Accepted and implemented in Phase 1 Task 1.8
- Date: 2026-10-19
- Builds on: ADR-0015 (setup design), ADR-0016 (numbering), ADR-0018 (shell and session handling)

## Decisions

1. **UI only over the existing API.** The wizard calls `GET /setup/status`, `GET/PUT /setup/draft` and the atomic
   `POST /setup/complete`. It never recreates transaction logic, and no backend redesign was needed.
2. **Fields come from the API, not the specification.** The wizard collects exactly what the strict setup schema accepts.
   Business phone/email/website, a stored country, a separate place of supply, bank/UPI details and a backup destination are
   not stored by Task 1.4, so they are not collected; the Welcome and Review pages say so and DEF-11 tracks them. Country is
   displayed as fixed text ("India"); the default place of supply is the business state.
3. **Eight steps.** Welcome, Business details, Address & location, GST registration, Financial year, Invoice numbering,
   Administrator, Review & complete. The briefed Bank & Payment and Backup Location steps are not form steps because nothing
   would store their values.
4. **Shared rules, server authority.** Browser-safe subpath exports (`@commercebill/setup/browser`,
   `@commercebill/numbering/browser`) give the wizard the server's PAN/GSTIN/PIN/date validators, state-code list and number
   formatter. The wizard still validates only for early feedback; the server re-validates everything and its value-free
   problem codes are mapped to wording.
5. **Draft.** Saved after each Continue/Back, in order (one queue, so quick clicks cannot collide on the version or let an
   older save overwrite a newer one); a stale version is retried once on top of the latest. Resume restores non-secret fields
   and lands on the first step needing attention; Start Over saves an empty draft after an explicit confirmation.
6. **Password.** Held only in component memory; never in the draft (strict schema would reject it), storage, URL, logs, audit, the
   review page or the DOM outside the active inputs. A password the server rejects is dropped. After success all form state is
   cleared.
7. **No automatic session.** Success returns to sign-in with the username filled in and the password field focused.
8. **Invoice example.** Formatted in the browser with the same function the server uses; it makes no request and consumes no number.
9. **Tax notice.** The GST step says tax configuration must be reviewed before real use and that installed rates are
   placeholders, not government-verified (R-040).

## Consequences

- Reloading the window during setup keeps only what was saved in the draft; the password must be entered again.
- Adding a setup field later means extending the backend schema first, then the wizard (one place each).
