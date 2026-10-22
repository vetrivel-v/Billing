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

export async function applyMigrations(
  url: string,
  dir: string,
  opts: { upTo?: string } = {},
): Promise<string> {
  const all = await readMigrations(dir);
  const migrations = opts.upTo ? all.filter((m) => m.name <= opts.upTo!) : all;
  if (migrations.length === 0) throw new Error('No migrations to apply.');
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

export type MigrationState =
  /** No migration table: a brand-new, empty database. */
  | 'empty'
  | 'current'
  | 'pending'
  /** The database has migrations this application does not know: it was written by a NEWER version. */
  | 'ahead'
  /** An applied migration's file differs from the one this application ships. */
  | 'tampered'
  /** A migration started and did not finish (an interrupted upgrade by another tool). */
  | 'failed';

export interface MigrationStatus {
  state: MigrationState;
  /** The newest migration the database has. */
  current: string | null;
  /** The newest migration this application knows. */
  expected: string;
  pending: string[];
}

/** Compares the database with the migrations this application ships. Reads only. */
export async function migrationStatus(url: string, dir: string): Promise<MigrationStatus> {
  const shipped = await readMigrations(dir);
  const expected = shipped.at(-1)?.name ?? '';
  return withClient(url, async (c) => {
    const exists = (
      await c.query<{ t: string | null }>(
        `SELECT to_regclass('public._prisma_migrations')::text AS t`,
      )
    ).rows[0]!.t;
    if (!exists)
      return {
        state: 'empty' as const,
        current: null,
        expected,
        pending: shipped.map((m) => m.name),
      };
    const rows = (
      await c.query<{
        migration_name: string;
        checksum: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
      }>(
        `SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name`,
      )
    ).rows;
    const done = rows.filter((r) => r.finished_at && !r.rolled_back_at);
    const current = done.at(-1)?.migration_name ?? null;
    const byName = new Map(shipped.map((m) => [m.name, m]));
    const pending = shipped
      .filter((m) => !done.some((r) => r.migration_name === m.name))
      .map((m) => m.name);
    if (rows.some((r) => !r.finished_at && !r.rolled_back_at))
      return { state: 'failed' as const, current, expected, pending };
    if (done.some((r) => !byName.has(r.migration_name)))
      return { state: 'ahead' as const, current, expected, pending };
    if (done.some((r) => byName.get(r.migration_name)!.checksum !== r.checksum))
      return { state: 'tampered' as const, current, expected, pending };
    return {
      state: pending.length === 0 ? ('current' as const) : ('pending' as const),
      current,
      expected,
      pending,
    };
  });
}

/**
 * Applies only the migrations the database does not have yet, each in its own transaction (PostgreSQL DDL is transactional, so a failing
 * migration leaves the database exactly as it was before that migration). Never initialises a database: the caller decides.
 */
export async function applyPendingMigrations(url: string, dir: string): Promise<string[]> {
  const status = await migrationStatus(url, dir);
  if (status.state === 'empty') {
    await applyMigrations(url, dir);
    return status.pending;
  }
  if (status.state !== 'pending') {
    if (status.state === 'current') return [];
    throw new Error(`The database cannot be upgraded safely (${status.state}).`);
  }
  const todo = (await readMigrations(dir)).filter((m) => status.pending.includes(m.name));
  await withClient(url, async (c) => {
    for (const m of todo) {
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
  });
  return todo.map((m) => m.name);
}
