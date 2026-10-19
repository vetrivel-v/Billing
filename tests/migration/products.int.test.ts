import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';

const dir = resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');
const sql = (name: string) => readFileSync(resolve(dir, name, 'migration.sql'), 'utf8');
const previous = [
  '20261016000000_phase0_foundation',
  '20261017000000_task_1_1_tax_reference_markers',
  '20261018000000_task_1_3_auth_constraints',
  '20261019000000_task_1_4_setup_invariants',
  '20261020000000_task_1_5_document_numbering',
  '20261021000000_task_1_6_security_admin_invariant',
  '20261022000000_task_1_9_customers',
].map(sql);
const m10 = sql('20261023000000_task_1_10_products');

const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const f of cleanup.reverse()) await f();
});

async function rawDb(applyNew = true) {
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
  for (const m of previous) await c.query(m);
  if (applyNew) await c.query(m10);
  return c;
}

interface World {
  org: string;
  unit: string;
  tax: string;
}

/** An organization with one unit and one tax category (plain SQL, as the reference seed would create them). */
async function world(c: pg.Client, name = 'DEMO Mig10 Co (fictional)'): Promise<World> {
  const one = async (q: string, p: unknown[] = []) => (await c.query(q, p)).rows[0].id as string;
  const org = await one(
    `INSERT INTO organizations (legal_name, setup_completed_at, updated_at) VALUES ($1, now(), now()) RETURNING id`,
    [name],
  );
  const unit = await one(
    `INSERT INTO units (organization_id, code, name, updated_at) VALUES ($1, 'PCS', 'Pieces', now()) RETURNING id`,
    [org],
  );
  const tax = await one(
    `INSERT INTO tax_categories (organization_id, code, name, classification, updated_at)
     VALUES ($1, 'GST_18', 'GST 18%', 'STANDARD', now()) RETURNING id`,
    [org],
  );
  return { org, unit, tax };
}

type Row = Record<string, unknown>;

async function insert(c: pg.Client, w: World, overrides: Row = {}) {
  const row: Row = {
    organization_id: w.org,
    sku: 'PRD-000001',
    name: 'Fictional Widget',
    kind: 'GOODS',
    unit_id: w.unit,
    tax_category_id: w.tax,
    selling_price: '1180.00',
    updated_at: new Date(),
    ...overrides,
  };
  const cols = Object.keys(row);
  const res = await c.query(
    `INSERT INTO products (${cols.map((k) => `"${k}"`).join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    cols.map((k) => row[k]),
  );
  return res.rows[0].id as string;
}

const hsn = async (c: pg.Client, code: string, kind: 'HSN' | 'SAC') =>
  (
    await c.query(`INSERT INTO hsn_sac_codes (code, kind) VALUES ($1, $2) RETURNING id`, [
      code,
      kind,
    ])
  ).rows[0].id as string;

describe('migration 20261023000000_task_1_10_products', () => {
  it('upgrades a populated Task 1.9 database without touching its data', async () => {
    const c = await rawDb(false);
    const w = await world(c, 'DEMO Configured Co (fictional)');
    await c.query(
      `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at)
       VALUES ($1, 'configured.admin', 'Admin', '$argon2id$placeholder', now())`,
      [w.org],
    );
    await c.query(
      `INSERT INTO business_locations (organization_id, name, address_line1, updated_at) VALUES ($1, 'Head Office', '1 Road', now())`,
      [w.org],
    );
    await c.query(
      `INSERT INTO customers (organization_id, code, customer_type, legal_name, billing_address_line1, billing_state_code, place_of_supply_state_code, updated_at)
       VALUES ($1, 'CUS-000001', 'B2C', 'Fictional Buyer', '1 Test Lane', '27', '27', now())`,
      [w.org],
    );
    const tables = [
      'organizations',
      'users',
      'business_locations',
      'customers',
      'units',
      'tax_categories',
    ];
    const before: Record<string, unknown[]> = {};
    for (const t of tables) before[t] = (await c.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
    await c.query(m10);
    for (const t of tables)
      expect((await c.query(`SELECT * FROM ${t} ORDER BY id`)).rows, t).toEqual(before[t]);
    expect((await c.query(`SELECT count(*)::int AS n FROM products`)).rows[0].n).toBe(0);
    await insert(c, w); // usable straight away
  });

  it('stores exact decimals, with defaults, for goods and services', async () => {
    const c = await rawDb();
    const w = await world(c);
    const goods = await insert(c, w, {
      selling_price: '0.10',
      mrp: '1234567890123456.78',
      track_inventory: true,
    });
    const service = await insert(c, w, {
      sku: 'SRV-1',
      kind: 'SERVICE',
      unit_id: null,
      selling_price: '999.99',
    });
    const rows = (
      await c.query(
        `SELECT id, selling_price::text AS sp, mrp::text AS mrp, version, is_active, price_includes_tax, track_inventory FROM products`,
      )
    ).rows;
    const g = rows.find((r) => r.id === goods)!;
    expect(g).toMatchObject({
      sp: '0.10',
      mrp: '1234567890123456.78',
      version: 1,
      is_active: true,
      price_includes_tax: false,
      track_inventory: true,
    });
    expect(rows.find((r) => r.id === service)!.sp).toBe('999.99');
    // a third decimal place is rounded by the column, never stored: the service layer refuses it before this point
    await expect(
      insert(c, w, { sku: 'TOO-BIG', selling_price: '10000000000000000.00' }),
    ).rejects.toThrow(/numeric field overflow/);
  });

  it('scopes the SKU and the barcode to the organization', async () => {
    const c = await rawDb();
    const a = await world(c, 'Org A (fictional)');
    const b = await world(c, 'Org B (fictional)');
    await insert(c, a, { sku: 'ABC-1', barcode: '8901234567890' });
    await expect(insert(c, a, { sku: 'ABC-1' })).rejects.toThrow(
      /products_organization_id_sku_key/,
    );
    await expect(insert(c, a, { sku: 'ABC-2', barcode: '8901234567890' })).rejects.toThrow(
      /products_organization_id_barcode_key/,
    );
    await insert(c, b, { sku: 'ABC-1', barcode: '8901234567890' }); // another organization: fine
    await insert(c, a, { sku: 'NB-1' });
    await insert(c, a, { sku: 'NB-2' }); // many products without a barcode
  });

  it('enforces the money, kind, unit, inventory and format rules in the database', async () => {
    const c = await rawDb();
    const w = await world(c);
    let n = 0;
    const bad = (over: Row, rule: RegExp) =>
      expect(insert(c, w, { sku: `T${++n}`, ...over })).rejects.toThrow(rule);
    await bad({ selling_price: '-0.01' }, /products_selling_price_not_negative/);
    await bad({ mrp: '-1' }, /products_mrp_not_negative/);
    await bad({ kind: 'BUNDLE' }, /products_kind_valid/);
    await bad({ name: '   ' }, /products_name_present/);
    await bad({ sku: 'lower case' }, /products_sku_format/);
    await bad({ unit_id: null }, /products_goods_have_unit/); // goods need a unit
    await bad(
      { kind: 'SERVICE', track_inventory: true, unit_id: null },
      /products_service_no_inventory/,
    );
    await bad({ barcode: 'has space' }, /products_barcode_format/);
    // a service may have no unit and no HSN/SAC; goods may omit the HSN
    await insert(c, w, { sku: 'OK-SRV', kind: 'SERVICE', unit_id: null });
    await insert(c, w, { sku: 'OK-GOODS' });
  });

  it('checks references: own-organization unit and tax category, and HSN for goods / SAC for services', async () => {
    const c = await rawDb();
    const a = await world(c, 'Org A (fictional)');
    const b = await world(c, 'Org B (fictional)');
    const h = await hsn(c, '8517', 'HSN');
    const s = await hsn(c, '998314', 'SAC');
    await expect(insert(c, a, { sku: 'X1', unit_id: b.unit })).rejects.toThrow(
      /unit of measure belongs to another organization/,
    );
    await expect(insert(c, a, { sku: 'X2', tax_category_id: b.tax })).rejects.toThrow(
      /tax category belongs to another organization/,
    );
    await expect(insert(c, a, { sku: 'X3', hsn_sac_code_id: s })).rejects.toThrow(
      /goods use an HSN code/,
    );
    await expect(
      insert(c, a, { sku: 'X4', kind: 'SERVICE', unit_id: null, hsn_sac_code_id: h }),
    ).rejects.toThrow(/goods use an HSN code/);
    const goods = await insert(c, a, { sku: 'G1', hsn_sac_code_id: h });
    await insert(c, a, { sku: 'S1', kind: 'SERVICE', unit_id: null, hsn_sac_code_id: s });
    // the same rules apply to updates
    await expect(
      c.query(`UPDATE products SET unit_id = $2 WHERE id = $1`, [goods, b.unit]),
    ).rejects.toThrow(/another organization/);
    await expect(
      c.query(`UPDATE products SET hsn_sac_code_id = $2 WHERE id = $1`, [goods, s]),
    ).rejects.toThrow(/goods use an HSN code/);
    // referenced rows cannot be removed from under a product
    await expect(c.query(`DELETE FROM units WHERE id = $1`, [a.unit])).rejects.toThrow();
    await expect(c.query(`DELETE FROM tax_categories WHERE id = $1`, [a.tax])).rejects.toThrow();
  });

  it('never deletes a product and never changes its identity or kind', async () => {
    const c = await rawDb();
    const a = await world(c, 'Org A (fictional)');
    const b = await world(c, 'Org B (fictional)');
    const id = await insert(c, a);
    await expect(c.query(`DELETE FROM products WHERE id = $1`, [id])).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      c.query(`UPDATE products SET sku = 'NEW-SKU' WHERE id = $1`, [id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      c.query(`UPDATE products SET organization_id = $2 WHERE id = $1`, [id, b.org]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      c.query(`UPDATE products SET kind = 'SERVICE' WHERE id = $1`, [id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      c.query(`UPDATE products SET created_at = now() - interval '1 day' WHERE id = $1`, [id]),
    ).rejects.toThrow(/cannot be changed/);
    await c.query(
      `UPDATE products SET is_active = false, name = 'Renamed', selling_price = '1.50', version = version + 1, updated_at = now() WHERE id = $1`,
      [id],
    );
    expect(
      (await c.query(`SELECT is_active, version FROM products WHERE id = $1`, [id])).rows[0],
    ).toEqual({ is_active: false, version: 2 });
    await expect(c.query(`DELETE FROM organizations WHERE id = $1`, [a.org])).rejects.toThrow();
  });

  it('has a per-organization SKU counter that cannot go negative', async () => {
    const c = await rawDb();
    const w = await world(c);
    await c.query(
      `INSERT INTO product_code_counters (organization_id, updated_at) VALUES ($1, now())`,
      [w.org],
    );
    expect(
      (await c.query(`SELECT last_number::int AS n FROM product_code_counters`)).rows[0].n,
    ).toBe(0);
    await expect(c.query(`UPDATE product_code_counters SET last_number = -1`)).rejects.toThrow(
      /product_code_counters_not_negative/,
    );
    await expect(
      c.query(
        `INSERT INTO product_code_counters (organization_id, updated_at) VALUES ($1, now())`,
        [w.org],
      ),
    ).rejects.toThrow();
  });

  it('is forward-only: applying it twice fails instead of silently changing data', async () => {
    const c = await rawDb();
    await expect(c.query(m10)).rejects.toThrow(/already exists/);
  });
});
