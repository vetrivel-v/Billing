/**
 * SPIKE (Task 1.0, ADR-0009): logical export/import of application data using only the `pg` driver,
 * because the bundled embedded PostgreSQL ships no pg_dump/pg_restore (risk R-031).
 *
 * Approach: schema is NOT dumped; the target database is created by the application's own migrations
 * ("migrate, then load"). Data is exported per table as JSON text and re-inserted with
 * json_populate_recordset, which preserves numeric/bigint/timestamptz/jsonb exactly because values are
 * never parsed in JavaScript.
 *
 * NOT production code: no streaming (whole tables in memory), no encryption, no attachments.
 * The production implementation is a later Phase 1 task and must stream (COPY) and encrypt.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';

export interface DumpManifest {
  format: 'commercebill-logical-dump/1';
  createdAt: string;
  /** Last applied Prisma migration; restore refuses a different schema version. */
  schemaVersion: string;
  tables: { name: string; rows: number; sha256: string }[];
}

export interface LogicalDump {
  manifest: DumpManifest;
  /** table name -> JSON array text (kept as text so no JS number precision is lost) */
  data: Record<string, string>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function schemaVersion(c: pg.Client): Promise<string> {
  const r = await c.query<{ migration_name: string }>(
    `SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name DESC LIMIT 1`,
  );
  const name = r.rows[0]?.migration_name;
  if (!name) throw new Error('No applied migrations found');
  return name;
}

async function appTables(c: pg.Client): Promise<string[]> {
  const r = await c.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name <> '_prisma_migrations'
      ORDER BY table_name`,
  );
  return r.rows.map((x) => x.table_name);
}

// Table names come from information_schema, never from user input; quote defensively anyway.
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export async function exportLogical(url: string): Promise<LogicalDump> {
  return withClient(url, async (c) => {
    // One snapshot for all tables so the dump is internally consistent.
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const data: Record<string, string> = {};
      const tables: DumpManifest['tables'] = [];
      for (const t of await appTables(c)) {
        const r = await c.query<{ j: string; n: string }>(
          `SELECT COALESCE(json_agg(x ORDER BY x::text), '[]'::json)::text AS j, count(*)::text AS n
             FROM ${q(t)} x`,
        );
        const row = r.rows[0];
        if (!row) throw new Error(`No result for ${t}`);
        data[t] = row.j;
        tables.push({ name: t, rows: Number(row.n), sha256: sha256(row.j) });
      }
      return {
        manifest: {
          format: 'commercebill-logical-dump/1' as const,
          createdAt: new Date().toISOString(),
          schemaVersion: await schemaVersion(c),
          tables,
        },
        data,
      };
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

export class DumpIntegrityError extends Error {}
export class DumpCompatibilityError extends Error {}

/** Verify checksums before touching the target. Throws DumpIntegrityError on any mismatch. */
export function verifyDump(dump: LogicalDump): void {
  for (const t of dump.manifest.tables) {
    const text = dump.data[t.name];
    if (text === undefined) throw new DumpIntegrityError(`Missing data for table ${t.name}`);
    if (sha256(text) !== t.sha256) throw new DumpIntegrityError(`Checksum mismatch for ${t.name}`);
  }
}

/**
 * Load a dump into an already-migrated, EMPTY database inside one transaction (all-or-nothing).
 * Never targets a non-empty database. Uses session_replication_role=replica to defer FK ordering
 * (requires a superuser/owner role - recorded as a constraint in ADR-0009).
 */
export async function importLogical(url: string, dump: LogicalDump): Promise<void> {
  verifyDump(dump);
  await withClient(url, async (c) => {
    const target = await schemaVersion(c);
    if (target !== dump.manifest.schemaVersion) {
      throw new DumpCompatibilityError(
        `Schema version mismatch: dump ${dump.manifest.schemaVersion}, target ${target}`,
      );
    }
    for (const t of await appTables(c)) {
      const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${q(t)}`);
      if (r.rows[0]?.n !== '0') throw new DumpCompatibilityError(`Target table ${t} is not empty`);
    }
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL session_replication_role = 'replica'`);
      for (const t of dump.manifest.tables) {
        await c.query(
          `INSERT INTO ${q(t.name)} SELECT * FROM json_populate_recordset(null::${q(t.name)}, $1::json)`,
          [dump.data[t.name]],
        );
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

/** Compare per-table content digests between two databases. Returns names of differing tables. */
export async function compareDatabases(urlA: string, urlB: string): Promise<string[]> {
  const [a, b] = await Promise.all([exportLogical(urlA), exportLogical(urlB)]);
  return a.manifest.tables
    .filter((t) => b.manifest.tables.find((u) => u.name === t.name)?.sha256 !== t.sha256)
    .map((t) => t.name);
}
