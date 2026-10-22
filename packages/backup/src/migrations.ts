/**
 * Creates the schema of a fresh database by running the application's OWN migrations ("migrate, then load", ADR-0009), in process,
 * and records them in `_prisma_migrations` exactly as Prisma does (name and SHA-256 of the file), so `prisma migrate deploy`
 * later sees the same state. The schema is never taken from a backup, so a backup cannot carry executable schema code.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { quoteIdent, withClient } from './dump.js';

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

const MIGRATION_DIR = /^\d{14}_[a-z0-9_]+$/;

export async function readMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && MIGRATION_DIR.test(e.name))
    .map((e) => e.name)
    .sort();
  const out: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(join(dir, name, 'migration.sql'), 'utf8');
    out.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return out;
}

/** The newest migration the running application knows: the schema version it expects. */
export async function expectedSchemaVersion(dir: string): Promise<string> {
  const all = await readMigrations(dir);
  const last = all.at(-1);
  if (!last) throw new Error('No migrations were found.');
  return last.name;
}

export async function applyMigrations(url: string, dir: string): Promise<string> {
  const migrations = await readMigrations(dir);
  return withClient(url, async (c) => {
    await c.query(`CREATE TABLE "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT, "rolled_back_at" TIMESTAMPTZ, "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`);
    for (const m of migrations) {
      await c.query('BEGIN');
      try {
        await c.query(m.sql);
        await c.query(
          `INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "applied_steps_count") VALUES ($1, $2, now(), $3, 1)`,
          [randomUUID(), m.checksum, m.name],
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    }
    return migrations.at(-1)!.name;
  });
}

/** Replaces the database name in a connection URL (used for the maintenance database and for isolated databases). */
export function withDatabaseName(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** A name for a database we create: fixed prefix, fixed alphabet. */
export const isolatedName = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

export async function createDatabase(adminUrl: string, name: string): Promise<void> {
  await withClient(adminUrl, async (c: pg.Client) => {
    await c.query(`CREATE DATABASE ${quoteIdent(name)}`);
  });
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  await withClient(adminUrl, async (c: pg.Client) => {
    await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  });
}
