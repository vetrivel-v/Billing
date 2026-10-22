/**
 * Loads an exported snapshot into an EMPTY, freshly migrated database ("migrate, then load", ADR-0009).
 *
 * All tables load in ONE transaction with `session_replication_role = replica` (so foreign keys do not constrain the load order;
 * this needs a superuser or owner role, which the application-managed database has). The protective triggers do not fire during
 * the load, so the backup service re-verifies every business rule they enforce afterwards (integrity.ts) before it accepts a restore.
 *
 * R-080: `stock_movements` is authoritative and `stock_balances` is a protected projection. The projection in the backup is NOT
 * loaded: balances are REBUILT from the loaded ledger (strategy A), and the rebuilt balances are then compared with the projection
 * the backup carried. Any difference fails verification.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type pg from 'pg';
import { applicationTables, EXCLUDED_TABLES, quoteIdent } from './dump.js';

export class RestoreError extends Error {
  constructor(
    message: string,
    readonly code: 'TARGET_NOT_EMPTY' | 'UNKNOWN_TABLE' | 'MISSING_TABLE' | 'LOAD_FAILED',
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

/** The projection table: never loaded from a backup, always rebuilt from the ledger. */
export const PROJECTION_TABLE = 'stock_balances';
const BATCH = 500;

/** Streams an NDJSON file as batches of line texts (each line is one JSON object; never parsed in JavaScript). */
export async function* batches(file: string, size = BATCH): AsyncGenerator<string[]> {
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let batch: string[] = [];
  for await (const line of rl) {
    if (line === '') continue;
    batch.push(line);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

export async function assertEmpty(c: pg.Client): Promise<void> {
  for (const t of await applicationTables(c)) {
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${quoteIdent(t)}`);
    if (r.rows[0]?.n !== '0')
      throw new RestoreError('The restore target is not empty.', 'TARGET_NOT_EMPTY');
  }
}

export interface LoadResult {
  loaded: Record<string, number>;
  rebuiltBalances: number;
}

/**
 * `files` maps a table name to its NDJSON file. Every table of the target (except the excluded ones) must be present, and no
 * unknown table may be loaded.
 */
export async function loadSnapshot(c: pg.Client, files: Map<string, string>): Promise<LoadResult> {
  const target = (await applicationTables(c)).filter((t) => !EXCLUDED_TABLES.includes(t));
  for (const t of files.keys())
    if (!target.includes(t))
      throw new RestoreError(
        'The backup contains a table the application does not have.',
        'UNKNOWN_TABLE',
      );
  for (const t of target)
    if (!files.has(t))
      throw new RestoreError(
        'The backup is missing a table the application needs.',
        'MISSING_TABLE',
      );
  await assertEmpty(c);
  const loaded: Record<string, number> = {};
  await c.query('BEGIN');
  try {
    await c.query(`SET LOCAL session_replication_role = 'replica'`);
    for (const t of target) {
      if (t === PROJECTION_TABLE) continue;
      let n = 0;
      for await (const lines of batches(files.get(t)!)) {
        await c.query(
          `INSERT INTO ${quoteIdent(t)} SELECT * FROM json_populate_recordset(null::${quoteIdent(t)}, $1::json)`,
          [`[${lines.join(',')}]`],
        );
        n += lines.length;
      }
      loaded[t] = n;
    }
    // Strategy A (R-080): the projection is rebuilt from the authoritative ledger.
    const rebuilt = await c.query(
      `INSERT INTO "stock_balances" ("organization_id", "warehouse_id", "product_id", "quantity_on_hand", "updated_at")
       SELECT "organization_id", "warehouse_id", "product_id", sum("quantity_delta"), max("created_at") FROM "stock_movements" GROUP BY 1, 2, 3`,
    );
    // Columns that take their value from a sequence (a BIGSERIAL) were loaded with explicit values: advance each sequence past them, or
    // the next normal insert would collide.
    const serial = await c.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`,
    );
    for (const col of serial.rows) {
      const t = quoteIdent(col.table_name);
      const k = quoteIdent(col.column_name);
      await c.query(
        `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT max(${k}) FROM ${t}), 1), (SELECT count(*) > 0 FROM ${t}))`,
        [t, col.column_name],
      );
    }
    await c.query('COMMIT');
    return { loaded, rebuiltBalances: rebuilt.rowCount ?? 0 };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    if (e instanceof RestoreError) throw e;
    throw new RestoreError('The backup data could not be loaded into the database.', 'LOAD_FAILED');
  }
}
