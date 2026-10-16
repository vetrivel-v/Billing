/**
 * Starts a local PostgreSQL for DEVELOPMENT using the embedded-postgres npm package
 * (real PostgreSQL binaries; no Docker or system install, no admin rights needed).
 * Production/desktop packaging uses its own bundled PostgreSQL - see docs/adr/0003.
 *
 * Usage: npm run db:start   (leave running; Ctrl+C stops it)
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DEV_DB, devDatabaseUrl, repoRoot } from './lib/env.js';

const dataDir = resolve(repoRoot, '.data', 'pg-dev');
const needsInit = !existsSync(resolve(dataDir, 'PG_VERSION'));

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  port: DEV_DB.port,
  user: DEV_DB.user,
  password: DEV_DB.password,
  persistent: true,
  // Force UTF8: the Windows default (WIN1252) cannot store Indian-language text (risk R-035).
  initdbFlags: ['--encoding=UTF8'],
  onLog: () => {},
  onError: (e) => console.error('[postgres]', e),
});

if (needsInit) {
  console.log(`Initialising PostgreSQL data directory at ${dataDir}`);
  await pg.initialise();
}
await pg.start();
try {
  await pg.createDatabase(DEV_DB.database);
  console.log(`Created database ${DEV_DB.database}`);
} catch {
  // Already exists.
}
console.log(`PostgreSQL ready on ${DEV_DB.host}:${DEV_DB.port}`);
console.log(`DATABASE_URL=${devDatabaseUrl()}`);

const shutdown = async () => {
  console.log('Stopping PostgreSQL...');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30);
