# ADR-0002: Toolchain versions

- Status: Accepted
- Date: 2026-10-16

## Context

Versions were taken from the npm registry on 2026-10-16: Node 24.16 installed locally; Electron 44, Vite 8, React 19, Vitest 5, ESLint 10, Zod 4, Fastify 5, Tailwind 4, Prisma 7.10.1 (stable; 8.0 is only a release candidate). TypeScript latest is 7.0.2, but typescript-eslint 8.71 declares support for TypeScript <6.1.

## Decision

Pin TypeScript to ~6.0 (installed 6.0.3) so type-aware linting is supported. Use Prisma 7.10.1, not the 8.0 release candidate. Require Node >=22.12 (Vite 8 requirement). Lockfile (`package-lock.json`) is committed.

## Consequences

Upgrade TypeScript to 7.x once typescript-eslint supports it. Dependency versions are reviewed each phase (npm audit currently reports 0 vulnerabilities - see completion report).
