# Changelog

## 0.0.1 - Unreleased (Phase 0)

- Monorepo scaffold (npm workspaces), strict TypeScript, ESLint, Prettier, Vitest.
- Prisma 7 schema and first migration: 18 foundation/system tables, check constraints, partial unique indexes,
  append-only audit-log triggers.
- Fastify API with `/health` and `/health/db`, stable error contract, security headers, CORS and rate limit.
- React + Vite + Tailwind shell showing system status; Electron shell with hardened window policy.
- Embedded PostgreSQL development database and isolated integration-test databases.
- Architecture, ADRs, risk register, requirements matrix, project state, threat model.
