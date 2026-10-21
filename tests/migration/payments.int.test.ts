import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';

const dir = resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');
const NEW = '20261027000000_task_1_16_payments';
const all = readdirSync(dir)
  .filter((d) => /^\d{14}_/.test(d))
  .sort();
const previous = all
  .filter((d) => d < NEW)
  .map((d) => readFileSync(resolve(dir, d, 'migration.sql'), 'utf8'));
const m16 = readFileSync(resolve(dir, NEW, 'migration.sql'), 'utf8');

const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const f of cleanup.reverse()) await f();
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
  cleanup.push(async () => {
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await a.end();
  });
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  cleanup.push(() => c.end());
  for (const m of previous) await c.query(m);
  return c;
}
const one = async (c: pg.Client, q: string, p: unknown[] = []) =>
  (await c.query(q, p)).rows[0].id as string;

describe('migration 20261027000000_task_1_16_payments - upgrade', () => {
  it('upgrades a populated Task 1.13 database: existing rows are untouched, and each PAYMENT_RECEIPT sequence gains a DEMO twin', async () => {
    const c = await rawDb();
    const org = await one(
      c,
      `INSERT INTO organizations (legal_name, setup_completed_at, updated_at) VALUES ('Populated Co (fictional)', now(), now()) RETURNING id`,
    );
    await one(
      c,
      `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at)
       VALUES ($1, 'u' || floor(random() * 1000000000)::text, 'A User', '$argon2id$placeholder', now()) RETURNING id`,
      [org],
    );
    const fy = await one(
      c,
      `INSERT INTO financial_years (organization_id, label, start_date, end_date, updated_at)
       VALUES ($1, '2026-27', '2026-04-01', '2027-03-31', now()) RETURNING id`,
      [org],
    );
    await c.query(
      `INSERT INTO document_sequences (organization_id, financial_year_id, document_type, prefix, numeric_length, start_number, last_number, updated_at)
       VALUES ($1, $2, 'PAYMENT_RECEIPT', 'PAY/{FY}/', 6, 100, 7, now()), ($1, $2, 'INVOICE', 'INV/{FY}/', 6, 1, 0, now()), ($1, $2, 'DEMO_INVOICE', 'DEMO/{FY}/', 6, 1, 0, now())`,
      [org, fy],
    );
    const before = (
      await c.query(`SELECT * FROM document_sequences WHERE document_type = 'PAYMENT_RECEIPT'`)
    ).rows[0];
    const orgs = (await c.query(`SELECT * FROM organizations ORDER BY id`)).rows;

    await c.query(m16);

    expect(
      (await c.query(`SELECT * FROM document_sequences WHERE document_type = 'PAYMENT_RECEIPT'`))
        .rows[0],
    ).toEqual(before);
    expect((await c.query(`SELECT * FROM organizations ORDER BY id`)).rows).toEqual(orgs);
    const demo = (
      await c.query(
        `SELECT document_type, prefix, numeric_length, start_number, last_number, financial_year_id FROM document_sequences WHERE document_type = 'DEMO_PAYMENT_RECEIPT'`,
      )
    ).rows;
    expect(demo).toEqual([
      {
        document_type: 'DEMO_PAYMENT_RECEIPT',
        prefix: 'DPAY/{FY}/',
        numeric_length: 6,
        start_number: '1',
        last_number: '0',
        financial_year_id: fy,
      },
    ]);
    expect(Number((await c.query(`SELECT count(*) AS n FROM document_sequences`)).rows[0].n)).toBe(
      4,
    );
  });

  it('adds the payment tables and the derived balance view, with the value rules and immutability in place', async () => {
    const c = await rawDb();
    await c.query(m16);
    const names = (
      await c.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('payments','payment_allocations','invoice_balances') ORDER BY 1`,
      )
    ).rows.map((r) => r.table_name);
    expect(names).toEqual(['invoice_balances', 'payment_allocations', 'payments']);
    for (const t of ['payments', 'payment_allocations'])
      await expect(c.query(`TRUNCATE ${t}`), t).rejects.toThrow();
    // the balance is derived: there is no balance column on invoices or payments
    const cols = (
      await c.query(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('sales_invoices','payments','payment_allocations') AND column_name ~ 'balance|paid|outstanding'`,
      )
    ).rows;
    expect(cols).toEqual([]);
    const checks = (
      await c.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'payments'::regclass AND contype = 'c' ORDER BY 1`,
      )
    ).rows.map((r) => r.conname);
    expect(checks).toEqual(
      expect.arrayContaining([
        'payments_amount_positive',
        'payments_demo_matches_type',
        'payments_method_valid',
        'payments_reference_required',
        'payments_status_valid',
      ]),
    );
  });
});
