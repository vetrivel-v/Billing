import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';

const migrationsDir = resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');
const first = readFileSync(
  resolve(migrationsDir, '20261016000000_phase0_foundation', 'migration.sql'),
  'utf8',
);
const second = readFileSync(
  resolve(migrationsDir, '20261017000000_task_1_1_tax_reference_markers', 'migration.sql'),
  'utf8',
);

const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const f of cleanup) await f();
});

async function rawDb() {
  const adminUrl = inject('pgAdminUrl');
  const name = `cb_mig_${Math.random().toString(16).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  cleanup.push(async () => {
    await c.end();
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await a.end();
  });
  return c;
}

describe('migration 20261017000000_task_1_1_tax_reference_markers', () => {
  it('upgrades a populated previous-version database, giving existing rows safe defaults', async () => {
    const c = await rawDb();
    await c.query(first); // previous supported version
    const org = (
      await c.query(
        `INSERT INTO organizations (legal_name, updated_at) VALUES ('DEMO Mig Co (fictional)', now()) RETURNING id`,
      )
    ).rows[0].id;
    const cat = (
      await c.query(
        `INSERT INTO tax_categories (organization_id, code, name, classification, updated_at) VALUES ($1,'OLD','Old','STANDARD', now()) RETURNING id`,
        [org],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO tax_rates (organization_id, category_id, rate_percent, effective_from, updated_at) VALUES ($1,$2,18,'2026-04-01', now())`,
      [org, cat],
    );

    await c.query(second);

    const rate = (
      await c.query(
        `SELECT origin, review_status, review_note, rate_percent::text AS r FROM tax_rates`,
      )
    ).rows[0];
    expect(rate).toMatchObject({
      origin: 'USER',
      review_status: 'UNREVIEWED',
      review_note: null,
      r: '18.0000',
    });
    const category = (
      await c.query(
        `SELECT origin, review_status, effective_from, effective_to FROM tax_categories`,
      )
    ).rows[0];
    expect(category).toMatchObject({
      origin: 'USER',
      review_status: 'UNREVIEWED',
      effective_from: null,
      effective_to: null,
    });
  });

  it('applies cleanly on an empty database after the first migration and enforces its constraints', async () => {
    const c = await rawDb();
    await c.query(first);
    await c.query(second);
    const org = (
      await c.query(
        `INSERT INTO organizations (legal_name, updated_at) VALUES ('DEMO Mig2 Co (fictional)', now()) RETURNING id`,
      )
    ).rows[0].id;
    const bad = (sql: string) => c.query(sql, [org]);
    await expect(
      bad(
        `INSERT INTO tax_categories (organization_id, code, name, classification, origin, updated_at) VALUES ($1,'A','A','STANDARD','BOGUS', now())`,
      ),
    ).rejects.toThrow(/tax_categories_origin_chk/);
    await expect(
      bad(
        `INSERT INTO tax_categories (organization_id, code, name, classification, review_status, updated_at) VALUES ($1,'B','B','STANDARD','MAYBE', now())`,
      ),
    ).rejects.toThrow(/tax_categories_review_chk/);
    await expect(
      bad(
        `INSERT INTO tax_categories (organization_id, code, name, classification, effective_from, effective_to, updated_at) VALUES ($1,'C','C','STANDARD','2027-01-01','2026-01-01', now())`,
      ),
    ).rejects.toThrow(/tax_categories_effective_chk/);
  });

  it('is not re-runnable (forward-only): a second application fails instead of silently changing data', async () => {
    const c = await rawDb();
    await c.query(first);
    await c.query(second);
    await expect(c.query(second)).rejects.toThrow(/already exists/);
  });
});
