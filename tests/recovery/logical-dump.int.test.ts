import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '@commercebill/test-utilities';
import {
  DumpCompatibilityError,
  DumpIntegrityError,
  compareDatabases,
  exportLogical,
  importLogical,
  type LogicalDump,
} from './spikes/logical-dump.js';

/** Newest migration directory = the schema version every freshly migrated database must report. */
function latestMigrationName(): string {
  const dir = resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .at(-1)!;
}

let source: IsolatedDatabase;
let dump: LogicalDump;

async function sql(url: string, text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(text, params);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  source = await createIsolatedDatabase(inject('pgAdminUrl'));
  const org = (
    await sql(
      source.url,
      `INSERT INTO organizations (legal_name, updated_at) VALUES ('DEMO Backup Co (fictional)', now()) RETURNING id`,
    )
  ).rows[0].id as string;
  const fy = (
    await sql(
      source.url,
      `INSERT INTO financial_years (organization_id, label, start_date, end_date, updated_at)
       VALUES ($1, '2026-27', '2026-04-01', '2027-03-31', now()) RETURNING id`,
      [org],
    )
  ).rows[0].id as string;
  // Values that break naive JSON/number handling: bigint > 2^53, high-precision decimals, quotes, unicode.
  await sql(
    source.url,
    `INSERT INTO document_sequences (organization_id, financial_year_id, document_type, prefix, last_number, updated_at)
     VALUES ($1, $2, 'INVOICE', 'INV/2026-27/"Ω"', 9007199254740993, now())`,
    [org, fy],
  );
  const cat = (
    await sql(
      source.url,
      `INSERT INTO tax_categories (organization_id, code, name, classification, updated_at)
       VALUES ($1, 'GST18', 'GST 18% — "std"', 'STANDARD', now()) RETURNING id`,
      [org],
    )
  ).rows[0].id as string;
  await sql(
    source.url,
    `INSERT INTO tax_rates (organization_id, category_id, rate_percent, cess_percent, effective_from, updated_at)
     VALUES ($1, $2, 18.0000, 0.1234, '2026-04-01', now())`,
    [org, cat],
  );
  await sql(
    source.url,
    `INSERT INTO audit_logs (organization_id, category, action, app_version, after_values)
     VALUES ($1, 'system', 'spike.test', '0.0.1', '{"k":[1,2,{"n":null}]}'::jsonb)`,
    [org],
  );
  dump = await exportLogical(source.url);
});

afterAll(async () => {
  await source?.drop();
});

describe('R-031 spike: logical dump and restore without pg_dump', () => {
  it('exports a manifest with schema version, row counts and checksums', () => {
    expect(dump.manifest.format).toBe('commercebill-logical-dump/1');
    expect(dump.manifest.schemaVersion).toBe(latestMigrationName());
    const counts = Object.fromEntries(dump.manifest.tables.map((t) => [t.name, t.rows]));
    expect(counts).toMatchObject({
      organizations: 1,
      document_sequences: 1,
      tax_rates: 1,
      audit_logs: 1,
    });
    expect(dump.manifest.tables.length).toBe(23);
  });

  it('restores into a freshly migrated isolated database with identical content', async () => {
    const target = await createIsolatedDatabase(inject('pgAdminUrl'));
    try {
      await importLogical(target.url, dump);
      expect(await compareDatabases(source.url, target.url)).toEqual([]);
      const seq = await sql(
        target.url,
        `SELECT last_number::text AS n, prefix FROM document_sequences`,
      );
      expect(seq.rows[0].n).toBe('9007199254740993'); // bigint beyond 2^53 survives exactly
      expect(seq.rows[0].prefix).toBe('INV/2026-27/"Ω"');
      const rate = await sql(target.url, `SELECT cess_percent::text AS c FROM tax_rates`);
      expect(rate.rows[0].c).toBe('0.1234');
    } finally {
      await target.drop();
    }
  });

  it('keeps the audit-log immutability trigger working after restore', async () => {
    const target = await createIsolatedDatabase(inject('pgAdminUrl'));
    try {
      await importLogical(target.url, dump);
      await expect(sql(target.url, `DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    } finally {
      await target.drop();
    }
  });

  it('rejects a tampered dump before touching the target', async () => {
    const target = await createIsolatedDatabase(inject('pgAdminUrl'));
    try {
      const tampered: LogicalDump = {
        ...dump,
        data: { ...dump.data, organizations: dump.data.organizations!.replace('DEMO', 'EVIL') },
      };
      await expect(importLogical(target.url, tampered)).rejects.toBeInstanceOf(DumpIntegrityError);
      expect(
        (await sql(target.url, `SELECT count(*)::int AS n FROM organizations`)).rows[0].n,
      ).toBe(0);
    } finally {
      await target.drop();
    }
  });

  it('rejects a schema-version mismatch', async () => {
    const target = await createIsolatedDatabase(inject('pgAdminUrl'));
    try {
      const other: LogicalDump = {
        ...dump,
        manifest: { ...dump.manifest, schemaVersion: '20991231000000_future' },
      };
      await expect(importLogical(target.url, other)).rejects.toBeInstanceOf(DumpCompatibilityError);
    } finally {
      await target.drop();
    }
  });

  it('refuses to overwrite a non-empty database', async () => {
    const target = await createIsolatedDatabase(inject('pgAdminUrl'));
    try {
      await importLogical(target.url, dump);
      await expect(importLogical(target.url, dump)).rejects.toBeInstanceOf(DumpCompatibilityError);
    } finally {
      await target.drop();
    }
  });

  it('is all-or-nothing: a failure part-way leaves the target empty', async () => {
    const target = await createIsolatedDatabase(inject('pgAdminUrl'));
    try {
      // Corrupt a later table with a check-constraint violation, but keep checksums consistent.
      const badRates = dump.data.tax_rates!.replace('"rate_percent":18', '"rate_percent":180');
      const { createHash } = await import('node:crypto');
      const bad: LogicalDump = {
        manifest: {
          ...dump.manifest,
          tables: dump.manifest.tables.map((t) =>
            t.name === 'tax_rates'
              ? { ...t, sha256: createHash('sha256').update(badRates).digest('hex') }
              : t,
          ),
        },
        data: { ...dump.data, tax_rates: badRates },
      };
      await expect(importLogical(target.url, bad)).rejects.toThrow(/tax_rates_percent_chk/);
      expect(
        (await sql(target.url, `SELECT count(*)::int AS n FROM organizations`)).rows[0].n,
      ).toBe(0);
    } finally {
      await target.drop();
    }
  });
});
