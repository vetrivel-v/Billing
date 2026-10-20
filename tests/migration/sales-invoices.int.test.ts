import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';

const dir = resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');
const NEW = '20261026000000_task_1_13_sales_invoices';
const all = readdirSync(dir)
  .filter((d) => /^\d{14}_/.test(d))
  .sort();
const previous = all
  .filter((d) => d < NEW)
  .map((d) => readFileSync(resolve(dir, d, 'migration.sql'), 'utf8'));
const m13 = readFileSync(resolve(dir, NEW, 'migration.sql'), 'utf8');

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

describe('migration 20261026000000_task_1_13_sales_invoices - upgrade', () => {
  it('upgrades a populated Task 1.12 database: every existing row is untouched, and each INVOICE sequence gains a DEMO twin', async () => {
    const c = await rawDb();
    const org = await one(
      c,
      `INSERT INTO organizations (legal_name, setup_completed_at, updated_at) VALUES ('Populated Co (fictional)', now(), now()) RETURNING id`,
    );
    const user = await one(
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
       VALUES ($1, $2, 'INVOICE', 'INV/{FY}/', 6, 100, 7, now()), ($1, $2, 'CREDIT_NOTE', 'CN/{FY}/', 6, 1, 0, now())`,
      [org, fy],
    );
    const tax = await one(
      c,
      `INSERT INTO tax_categories (organization_id, code, name, classification, updated_at)
       VALUES ($1, 'GST_18', 'GST 18%', 'STANDARD', now()) RETURNING id`,
      [org],
    );
    const unit = await one(
      c,
      `INSERT INTO units (organization_id, code, name, decimal_places, updated_at) VALUES ($1, 'PCS', 'Pieces', 0, now()) RETURNING id`,
      [org],
    );
    const wh = await one(
      c,
      `INSERT INTO warehouses (organization_id, code, name, is_primary, updated_at) VALUES ($1, 'MAIN', 'Main', true, now()) RETURNING id`,
      [org],
    );
    const product = await one(
      c,
      `INSERT INTO products (organization_id, sku, name, kind, unit_id, tax_category_id, selling_price, track_inventory, updated_at)
       VALUES ($1, 'P-1', 'Widget', 'GOODS', $2, $3, 10, true, now()) RETURNING id`,
      [org, unit, tax],
    );
    await c.query(
      `INSERT INTO stock_movements (organization_id, warehouse_id, product_id, movement_type, quantity_delta, business_date, source_type, source_ref, created_by)
       VALUES ($1, $2, $3, 'OPENING_STOCK', 5, '2026-10-01', 'OPENING', 'seed', $4)`,
      [org, wh, product, user],
    );
    const tables = ['organizations', 'users', 'products', 'stock_movements', 'stock_balances'];
    const before: Record<string, unknown[]> = {};
    for (const t of tables) before[t] = (await c.query(`SELECT * FROM ${t} ORDER BY 1`)).rows;
    const invoiceSeq = (
      await c.query(`SELECT * FROM document_sequences WHERE document_type = 'INVOICE'`)
    ).rows[0];

    await c.query(m13);

    for (const t of tables)
      expect((await c.query(`SELECT * FROM ${t} ORDER BY 1`)).rows, t).toEqual(before[t]);
    expect(
      (await c.query(`SELECT * FROM document_sequences WHERE document_type = 'INVOICE'`)).rows[0],
    ).toEqual(invoiceSeq); // the production sequence is not touched
    const demo = (
      await c.query(
        `SELECT document_type, prefix, numeric_length, start_number, last_number, financial_year_id FROM document_sequences WHERE document_type = 'DEMO_INVOICE'`,
      )
    ).rows;
    expect(demo).toEqual([
      {
        document_type: 'DEMO_INVOICE',
        prefix: 'DEMO/{FY}/',
        numeric_length: 6,
        start_number: '1',
        last_number: '0',
        financial_year_id: fy,
      },
    ]);
    // idempotent in effect: only INVOICE sequences get a twin, once
    expect(Number((await c.query(`SELECT count(*) AS n FROM document_sequences`)).rows[0].n)).toBe(
      3,
    );
  });

  it('adds the invoice tables, the production view and the SALES_DISPATCH vocabulary (negative, only for SALES_INVOICE sources)', async () => {
    const c = await rawDb();
    await c.query(m13);
    const names = (
      await c.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('sales_invoices','sales_invoice_lines','production_sales_invoices') ORDER BY 1`,
      )
    ).rows.map((r) => r.table_name);
    expect(names).toEqual(['production_sales_invoices', 'sales_invoice_lines', 'sales_invoices']);

    // movement vocabulary: the existing types still work, a dispatch needs a negative quantity and an invoice source
    const org = await one(
      c,
      `INSERT INTO organizations (legal_name, setup_completed_at, updated_at) VALUES ('Vocab Co (fictional)', now(), now()) RETURNING id`,
    );
    const user = await one(
      c,
      `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at)
       VALUES ($1, 'u' || floor(random() * 1000000000)::text, 'A User', '$argon2id$placeholder', now()) RETURNING id`,
      [org],
    );
    const tax = await one(
      c,
      `INSERT INTO tax_categories (organization_id, code, name, classification, updated_at)
       VALUES ($1, 'GST_18', 'GST 18%', 'STANDARD', now()) RETURNING id`,
      [org],
    );
    const unit = await one(
      c,
      `INSERT INTO units (organization_id, code, name, decimal_places, updated_at) VALUES ($1, 'PCS', 'Pieces', 0, now()) RETURNING id`,
      [org],
    );
    const wh = await one(
      c,
      `INSERT INTO warehouses (organization_id, code, name, is_primary, updated_at) VALUES ($1, 'MAIN', 'Main', true, now()) RETURNING id`,
      [org],
    );
    const p = await one(
      c,
      `INSERT INTO products (organization_id, sku, name, kind, unit_id, tax_category_id, selling_price, track_inventory, updated_at)
       VALUES ($1, 'P-2', 'Widget', 'GOODS', $2, $3, 10, true, now()) RETURNING id`,
      [org, unit, tax],
    );
    const mv = (type: string, qty: number, srcType: string, ref: string) =>
      c.query(
        `INSERT INTO stock_movements (organization_id, warehouse_id, product_id, movement_type, quantity_delta, business_date, source_type, source_ref, source_line_ref, created_by)
         VALUES ($1, $2, $3, $4, $5, '2026-10-01', $6, $7, $7, $8)`,
        [org, wh, p, type, qty, srcType, ref, user],
      );
    await mv('OPENING_STOCK', 10, 'OPENING', 'o1');
    // positive quantity, wrong source type and a dispatch with no invoice line are all refused
    await expect(mv('SALES_DISPATCH', 2, 'SALES_INVOICE', 'x')).rejects.toThrow();
    await expect(mv('SALES_DISPATCH', -2, 'MANUAL', 'x')).rejects.toThrow();
    await expect(mv('SALES_DISPATCH', -2, 'SALES_INVOICE', 'x')).rejects.toThrow(); // no invoice line
    await expect(mv('NOT_A_TYPE', -2, 'SALES_INVOICE', 'x')).rejects.toThrow();
    expect(
      Number((await c.query(`SELECT quantity_on_hand AS q FROM stock_balances`)).rows[0].q),
    ).toBe(10);
  });

  it('refuses TRUNCATE of the invoice tables', async () => {
    const c = await rawDb();
    await c.query(m13);
    for (const t of ['sales_invoices', 'sales_invoice_lines'])
      await expect(c.query(`TRUNCATE ${t}`), t).rejects.toThrow();
  });
});
