# Developer Guide

## Layout and rules

See [ARCHITECTURE.md](ARCHITECTURE.md). Hard rules (spec section 53): no floating-point money, no silent edits of
posted records, no stock change without a movement, no unbalanced journals, no secrets in source control or
logs, no client-trusted totals or authorization. Do not duplicate domain logic in UI, API or integrations.

## Daily workflow

```bash
npm install
npm run db:generate
npm run dev                  # DB + migrate + API + web
npm run verify:phase0        # all gates (also the template for later phase gates)
```

- Database only: `npm run db:start` (leave running), then `npm run db:migrate`.
- Reset the dev database: stop `db:start`, delete `.data/pg-dev`, start again.
- Environment is validated at startup by `packages/validation`; a bad value fails fast and the message never
  includes the value.

## Changing the schema

1. Edit `prisma/schema.prisma`.
2. Create a new migration directory under `prisma/migrations/<timestamp>_<name>/migration.sql`. Generate SQL with
   `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` against a database
   that has all previous migrations applied (or `--from-migrations`), then append any hand-written SQL.
3. Apply with `npm run db:migrate`; run `npm run db:generate`.
4. Add/extend an integration test, update `docs/DATABASE_SCHEMA.md`, `RISK_REGISTER.md`, `PROJECT_STATE.md`.
   Never edit an applied migration; add a new one.

## Error handling conventions (spec section 48)

- Errors carry a **stable code** from `@commercebill/shared-types` `ErrorCodes` (`VAL_`, `BIZ_`, `AUTH_`, `INT_`,
  `DB_`, `SYS_`). Never rename a released code.
- API error body: `{ error: { code, message, dataSaved, correlationId } }`. The message is user-safe: no SQL, stack
  traces, secrets or internal paths. Details go only to the server log under the same correlation ID
  (`x-correlation-id` response header).
- Domain code throws typed errors; the API layer maps them to codes (mapping arrives with the first domain error
  classes in Phase 1). Unknown errors become `SYS_0500` with "No data was changed" only when that is true.

## Logging conventions

- Three streams are kept separate: business **audit** (database, append-only), **security** log and
  **diagnostic** log (files, Phase 1). Phase 0 provides structured Pino logs via Fastify.
- Redaction list: `LOG_REDACT_PATHS` in `apps/api/src/app.ts`. Never log passwords, tokens, API keys, card data or
  backup passwords. Do not log request bodies by default.
- Each request has a correlation ID (`req.id`, a UUID).

## Electron

Hardening baseline in ADR-0006. Add IPC channels only with: argument schema validation, a security test, and a
note in the ADR. The renderer must not receive Node, filesystem or shell access.

## Style

Prettier (`npm run format`), ESLint (`no-console` in app code; `parseFloat` banned), TypeScript strict with
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Imports use `.js` extensions for relative paths.
