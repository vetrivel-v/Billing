# ADR-0001: npm workspaces monorepo

- Status: Accepted
- Date: 2026-10-16

## Context

The spec (section 6) requires a monorepo with apps and shared packages. pnpm is not installed on the target machine; npm 11 ships with Node.

## Decision

Use npm workspaces (`apps/*`, `packages/*`). Domain logic lives in packages; apps (api, web, desktop) are thin. Workspace packages export TypeScript source (`exports: ./src/index.ts`) and are bundled by tsup (api, desktop) or Vite (web); there is no per-package build step.

## Consequences

No extra tooling to install. Packages cannot be run with plain `node` without bundling or tsx. If build times or dependency hoisting become a problem, revisit (pnpm/turborepo) via a new ADR.
