/**
 * Applies all pending Prisma migrations (`prisma migrate deploy`) to DATABASE_URL.
 * Falls back to the development database URL when DATABASE_URL is not set.
 * Pre-migration backup and validation (spec section 37) are Phase 1/6 work.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { devDatabaseUrl, loadDotEnv, repoRoot } from './lib/env.js';

loadDotEnv();
const databaseUrl = process.env.DATABASE_URL ?? devDatabaseUrl();
const prismaCli = resolve(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');

// Fixed argument list - no shell, no untrusted input.
const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl },
});
process.exit(result.status ?? 1);
