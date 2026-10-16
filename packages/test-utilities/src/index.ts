import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

export const TEST_PG = {
  host: '127.0.0.1',
  port: 54330,
  user: 'commercebill_test',
  // Throwaway credential for a temporary, loopback-only test cluster.
  password: 'commercebill_test_pw',
} as const;

export interface TestCluster {
  adminUrl: string;
  stop(): Promise<void>;
}

/** Start a throwaway PostgreSQL cluster in a temp directory (real PostgreSQL, isolated from dev data). */
export async function startTestCluster(port: number = TEST_PG.port): Promise<TestCluster> {
  const dir = mkdtempSync(join(tmpdir(), 'commercebill-pg-'));
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: TEST_PG.user,
    password: TEST_PG.password,
    persistent: false,
    // Force UTF8: the Windows default (WIN1252) cannot store Indian-language text (risk R-035).
    initdbFlags: ['--encoding=UTF8'],
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  return {
    adminUrl: `postgresql://${TEST_PG.user}:${TEST_PG.password}@${TEST_PG.host}:${port}/postgres`,
    async stop() {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface IsolatedDatabase {
  url: string;
  name: string;
  drop(): Promise<void>;
}

function withDatabase(adminUrl: string, database: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Create a fresh, uniquely named database and apply every Prisma migration to it. */
export async function createIsolatedDatabase(adminUrl: string): Promise<IsolatedDatabase> {
  const name = `cb_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(adminUrl, name);
  migrateDatabase(url);
  return {
    url,
    name,
    async drop() {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

/** Run `prisma migrate deploy` against the given URL (fixed argv, no shell). */
export function migrateDatabase(databaseUrl: string): void {
  const prismaCli = resolve(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');
  const r = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (r.status !== 0) {
    throw new Error(`prisma migrate deploy failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
}
