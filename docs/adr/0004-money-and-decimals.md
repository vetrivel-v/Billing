# ADR-0004: Money is exact decimal

- Status: Accepted
- Date: 2026-10-16

## Context

Spec sections 18 and 53 forbid binary floating point for money.

## Decision

Database: `Decimal(18,2)` for money, `Decimal(7,4)` for rates, `Decimal(18,4)` for quantities. Application: a decimal library (decimal.js, to be added with the first domain package in Phase 1) with explicit scale and rounding mode; no JS `number` in monetary code. ESLint forbids `parseFloat`. Posted documents store calculation snapshots rather than re-deriving from configuration.

## Consequences

Slightly more verbose arithmetic. Prisma returns `Decimal` objects, so serialization to JSON must use strings. Boundary-rounding tests are mandatory (spec section 41).
