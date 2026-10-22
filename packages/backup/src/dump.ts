/**
 * Consistent logical export of the application database (ADR-0009, ADR-0027).
 *
 * One connection, one transaction at REPEATABLE READ READ ONLY: every table is read from the SAME snapshot, so the export is
 * internally consistent even while the application keeps writing (writers are never blocked and never seen). Each table is written
 * as NDJSON (one `row_to_json` object per line, in primary-key order so the bytes are reproducible) through a server-side cursor in
 * batches, so memory use is bounded. Values are never parsed in JavaScript: numeric, bigint, timestamptz, jsonb and Unicode
 * therefore round-trip exactly.
 *
 * `sessions` is excluded on purpose: a backup must never contain active session material. The schema is NOT exported: a restore
 * creates it by running the application's own migrations ("migrate, then load").
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

/** Tables that are never exported (live session material). */
export const EXCLUDED_TABLES: readonly string[] = ['sessions'];
/** The migration bookkeeping table: recreated by the migrations, never exported. */
const MIGRATIONS_TABLE = '_prisma_migrations';
const BATCH = 1000;

export interface TableDump {
  name: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export const quoteIdent = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

export async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: 'commercebill-backup' });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function currentSchemaVersion(c: pg.Client): Promise<string> {
  const r = await c.query<{ migration_name: string }>(
    `SELECT migration_name FROM ${MIGRATIONS_TABLE}
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1`,
  );
  const name = r.rows[0]?.migration_name;
  if (!name) throw new Error('No applied migrations were found.');
  return name;
}

/** Every application table, in a stable order. Names come from the catalog, never from a user. */
export async function applicationTables(c: pg.Client): Promise<string[]> {
  const r = await c.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> $1
      ORDER BY table_name`,
    [MIGRATIONS_TABLE],
  );
  return r.rows.map((x) => x.table_name);
}

async function orderBy(c: pg.Client, table: string): Promise<string> {
  const r = await c.query<{ column_name: string }>(
    `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    [quoteIdent(table)],
  );
  return r.rows.length > 0
    ? r.rows.map((x) => `t.${quoteIdent(x.column_name)}`).join(', ')
    : 't::text';
}

async function dumpTable(c: pg.Client, table: string, filePath: string): Promise<TableDump> {
  const out = await open(filePath, 'wx', 0o600);
  const hash = createHash('sha256');
  let rows = 0;
  let bytes = 0;
  try {
    await c.query(
      `DECLARE cb_cursor NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS j FROM ${quoteIdent(table)} t ORDER BY ${await orderBy(c, table)}`,
    );
    for (;;) {
      const r = await c.query<{ j: string }>(`FETCH ${BATCH} FROM cb_cursor`);
      if (r.rows.length === 0) break;
      const chunk = Buffer.from(r.rows.map((x) => `${x.j}\n`).join(''), 'utf8');
      hash.update(chunk);
      await out.write(chunk, 0, chunk.length);
      rows += r.rows.length;
      bytes += chunk.length;
    }
    await c.query('CLOSE cb_cursor');
    await out.sync();
  } finally {
    await out.close();
  }
  return { name: table, rows, bytes, sha256: hash.digest('hex') };
}

export interface SnapshotExport {
  tables: TableDump[];
  schemaVersion: string;
  /** Files by table name. */
  files: Map<string, string>;
}

/** Exports every non-excluded table from ONE consistent snapshot into `outDir` (one `<table>.ndjson` file each). */
export async function exportSnapshot(
  url: string,
  outDir: string,
  opts: { onSnapshot?: () => Promise<void> | void } = {},
): Promise<SnapshotExport> {
  return withClient(url, async (c) => {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      // The snapshot is fixed by the first query of the transaction; anything after this point is not in the backup.
      const schemaVersion = await currentSchemaVersion(c);
      await opts.onSnapshot?.();
      const tables: TableDump[] = [];
      const files = new Map<string, string>();
      for (const t of await applicationTables(c)) {
        if (EXCLUDED_TABLES.includes(t)) continue;
        const file = join(outDir, `${t}.ndjson`);
        tables.push(await dumpTable(c, t, file));
        files.set(t, file);
      }
      return { tables, schemaVersion, files };
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  });
}
