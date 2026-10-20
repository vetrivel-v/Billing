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
  '20261023000000_task_1_10_products',
].map(sql);
const m11 = sql('20261024000000_task_1_11_inventory');

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
  if (applyNew) await c.query(m11);
  return c;
}

type Row = Record<string, unknown>;

interface World {
  org: string;
  user: string;
  wh: string;
  unit0: string; // PCS, 0 decimal places
  unit3: string; // KG, 3 decimal places
  tax: string;
  pcs: string; // tracked goods in PCS
  kg: string; // tracked goods in KG
  service: string;
  untracked: string;
}

async function world(c: pg.Client, name = 'DEMO Mig11 Co (fictional)'): Promise<World> {
  const one = async (q: string, p: unknown[] = []) => (await c.query(q, p)).rows[0].id as string;
  const org = await one(
    `INSERT INTO organizations (legal_name, setup_completed_at, updated_at) VALUES ($1, now(), now()) RETURNING id`,
    [name],
  );
  const user = await one(
    `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at)
     VALUES ($1, 'mig.user', 'Mig User', '$argon2id$placeholder', now()) RETURNING id`,
    [org],
  );
  const wh = await one(
    `INSERT INTO warehouses (organization_id, code, name, is_primary, updated_at) VALUES ($1, 'MAIN', 'Main Warehouse', true, now()) RETURNING id`,
    [org],
  );
  const unit0 = await one(
    `INSERT INTO units (organization_id, code, name, decimal_places, updated_at) VALUES ($1, 'PCS', 'Pieces', 0, now()) RETURNING id`,
    [org],
  );
  const unit3 = await one(
    `INSERT INTO units (organization_id, code, name, decimal_places, updated_at) VALUES ($1, 'KG', 'Kilogram', 3, now()) RETURNING id`,
    [org],
  );
  const tax = await one(
    `INSERT INTO tax_categories (organization_id, code, name, classification, updated_at)
     VALUES ($1, 'GST_18', 'GST 18%', 'STANDARD', now()) RETURNING id`,
    [org],
  );
  const product = (sku: string, kind: string, unit: string | null, track: boolean) =>
    one(
      `INSERT INTO products (organization_id, sku, name, kind, unit_id, tax_category_id, selling_price, track_inventory, updated_at)
       VALUES ($1, $2, $2, $3, $4, $5, 10, $6, now()) RETURNING id`,
      [org, sku, kind, unit, tax, track],
    );
  return {
    org,
    user,
    wh,
    unit0,
    unit3,
    tax,
    pcs: await product('PCS-1', 'GOODS', unit0, true),
    kg: await product('KG-1', 'GOODS', unit3, true),
    service: await product('SRV-1', 'SERVICE', null, false),
    untracked: await product('UNT-1', 'GOODS', unit0, false),
  };
}

let seq = 0;
async function move(c: pg.Client, w: World, over: Row = {}) {
  const row: Row = {
    organization_id: w.org,
    warehouse_id: w.wh,
    product_id: w.pcs,
    movement_type: 'STOCK_RECEIPT',
    quantity_delta: '10',
    business_date: '2026-10-01',
    source_type: 'TEST',
    source_ref: `op-${++seq}`,
    created_by: w.user,
    ...over,
  };
  const cols = Object.keys(row);
  return (
    await c.query(
      `INSERT INTO stock_movements (${cols.map((k) => `"${k}"`).join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((k) => row[k]),
    )
  ).rows[0].id as string;
}

const decrease = { movement_type: 'ADJUSTMENT_DECREASE', reason_code: 'LOSS' };

const onHand = async (c: pg.Client, w: World, product = w.pcs) =>
  (
    await c.query(
      `SELECT quantity_on_hand::text AS q FROM stock_balances WHERE warehouse_id = $1 AND product_id = $2`,
      [w.wh, product],
    )
  ).rows[0]?.q as string | undefined;

const count = async (c: pg.Client) =>
  (await c.query(`SELECT count(*)::int AS n FROM stock_movements`)).rows[0].n as number;

describe('migration 20261024000000_task_1_11_inventory', () => {
  it('upgrades a populated Task 1.10 database without touching its data', async () => {
    const c = await rawDb(false);
    const w = await world(c);
    await c.query(
      `INSERT INTO customers (organization_id, code, customer_type, legal_name, billing_address_line1, billing_state_code, place_of_supply_state_code, updated_at)
       VALUES ($1, 'CUS-000001', 'B2C', 'Fictional Buyer', '1 Test Lane', '27', '27', now())`,
      [w.org],
    );
    const tables = ['organizations', 'users', 'warehouses', 'units', 'products', 'customers'];
    const before: Record<string, unknown[]> = {};
    for (const t of tables) before[t] = (await c.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
    await c.query(m11);
    for (const t of tables)
      expect((await c.query(`SELECT * FROM ${t} ORDER BY id`)).rows, t).toEqual(before[t]);
    expect(await count(c)).toBe(0);
    expect((await c.query(`SELECT count(*)::int AS n FROM stock_balances`)).rows[0].n).toBe(0);
    await move(c, w); // usable straight away
  });

  it('keeps the balance equal to the ledger, with exact decimals', async () => {
    const c = await rawDb();
    const w = await world(c);
    await move(c, w, { movement_type: 'OPENING_STOCK', quantity_delta: '7' });
    await move(c, w, { quantity_delta: '3' });
    await move(c, w, { ...decrease, quantity_delta: '-4' });
    expect(await onHand(c, w)).toBe('6.0000');
    await move(c, w, { product_id: w.kg, quantity_delta: '0.001' });
    await move(c, w, { product_id: w.kg, quantity_delta: '2.5' });
    await move(c, w, { product_id: w.kg, ...decrease, quantity_delta: '-0.002' });
    expect(await onHand(c, w, w.kg)).toBe('2.4990');
    const drift = await c.query(
      `SELECT b.product_id FROM stock_balances b
       LEFT JOIN (SELECT product_id, sum(quantity_delta) s FROM stock_movements GROUP BY product_id) m ON m.product_id = b.product_id
       WHERE b.quantity_on_hand IS DISTINCT FROM m.s`,
    );
    expect(drift.rows).toHaveLength(0);
  });

  it('refuses every UPDATE, DELETE and TRUNCATE of a posted movement', async () => {
    const c = await rawDb();
    const w = await world(c);
    const id = await move(c, w);
    for (const set of [
      'quantity_delta = 99',
      'product_id = product_id',
      "movement_type = 'OPENING_STOCK'",
      "note = 'x'",
      'organization_id = organization_id',
      'warehouse_id = warehouse_id',
    ]) {
      await expect(
        c.query(`UPDATE stock_movements SET ${set} WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
    }
    await expect(c.query(`DELETE FROM stock_movements WHERE id = $1`, [id])).rejects.toThrow(
      /append-only/,
    );
    await expect(c.query(`TRUNCATE stock_movements`)).rejects.toThrow(/append-only/);
    expect(await onHand(c, w)).toBe('10.0000');
  });

  it('refuses any direct write to a balance', async () => {
    const c = await rawDb();
    const w = await world(c);
    await move(c, w);
    await expect(c.query(`UPDATE stock_balances SET quantity_on_hand = 999`)).rejects.toThrow(
      /maintained by the stock ledger/,
    );
    await expect(c.query(`DELETE FROM stock_balances`)).rejects.toThrow(
      /maintained by the stock ledger/,
    );
    await expect(
      c.query(
        `INSERT INTO stock_balances (organization_id, warehouse_id, product_id, quantity_on_hand) VALUES ($1, $2, $3, 5)`,
        [w.org, w.wh, w.kg],
      ),
    ).rejects.toThrow(/maintained by the stock ledger/);
    await expect(c.query(`TRUNCATE stock_balances`)).rejects.toThrow(/append-only/);
    expect(await onHand(c, w)).toBe('10.0000');
  });

  it('never lets stock go negative, and leaves no partial change when it refuses', async () => {
    const c = await rawDb();
    const w = await world(c);
    await move(c, w, { quantity_delta: '5' });
    await expect(move(c, w, { ...decrease, quantity_delta: '-6' })).rejects.toThrow(
      /stock_balances_not_negative/,
    );
    expect(await onHand(c, w)).toBe('5.0000');
    expect(await count(c)).toBe(1);
    // a decrease with no stock at all
    await expect(
      move(c, w, { product_id: w.kg, ...decrease, quantity_delta: '-1' }),
    ).rejects.toThrow(/stock_balances_not_negative/);
    await move(c, w, { ...decrease, quantity_delta: '-5' }); // exactly to zero is fine
    expect(await onHand(c, w)).toBe('0.0000');
  });

  it('allows movements only for tracked goods of the same organization', async () => {
    const c = await rawDb();
    const w = await world(c);
    const other = await world(c, 'Other Org (fictional)');
    await expect(move(c, w, { product_id: w.service })).rejects.toThrow(
      /only goods that track inventory/,
    );
    await expect(move(c, w, { product_id: w.untracked })).rejects.toThrow(
      /only goods that track inventory/,
    );
    await expect(move(c, w, { product_id: other.pcs })).rejects.toThrow(
      /belongs to another organization/,
    );
    await expect(move(c, w, { warehouse_id: other.wh })).rejects.toThrow(
      /warehouse belongs to another organization/,
    );
    await expect(move(c, w, { organization_id: other.org })).rejects.toThrow(
      /belongs to another organization/,
    );
    expect(await count(c)).toBe(0);
  });

  it('enforces the unit precision, direction, reason and format rules', async () => {
    const c = await rawDb();
    const w = await world(c);
    await expect(move(c, w, { quantity_delta: '1.5' })).rejects.toThrow(
      /more decimal places than the unit allows/,
    ); // PCS = 0 places
    await expect(move(c, w, { product_id: w.kg, quantity_delta: '1.2345' })).rejects.toThrow(
      /more decimal places/,
    ); // KG = 3 places
    await move(c, w, { product_id: w.kg, quantity_delta: '1.234' });
    await expect(move(c, w, { quantity_delta: '0' })).rejects.toThrow(
      /stock_movements_delta_not_zero/,
    );
    await expect(move(c, w, { quantity_delta: '-1' })).rejects.toThrow(
      /stock_movements_sign_matches_type/,
    );
    await expect(move(c, w, { ...decrease, quantity_delta: '1' })).rejects.toThrow(
      /sign_matches_type/,
    );
    await expect(move(c, w, { movement_type: 'ADJUSTMENT_INCREASE' })).rejects.toThrow(
      /stock_movements_reason_valid/,
    ); // an adjustment needs a reason
    await expect(
      move(c, w, { movement_type: 'ADJUSTMENT_INCREASE', reason_code: 'MISC' }),
    ).rejects.toThrow(/stock_movements_reason_valid/);
    await expect(move(c, w, { reason_code: 'FOUND' })).rejects.toThrow(
      /stock_movements_reason_valid/,
    ); // a receipt has no reason code
    await expect(
      move(c, w, { movement_type: 'SALES_DISPATCH', quantity_delta: '-1' }),
    ).rejects.toThrow(/violates check constraint/);
    await expect(move(c, w, { source_type: 'lower' })).rejects.toThrow(/source_type_format/);
    await expect(move(c, w, { source_ref: '' })).rejects.toThrow(/source_ref_length/);
    await expect(move(c, w, { note: '   ' })).rejects.toThrow(/note_length/);
    await expect(move(c, w, { reference: 'x'.repeat(61) })).rejects.toThrow(/reference_length/);
    await expect(move(c, w, { quantity_delta: '1234567890123456' })).rejects.toThrow(
      /numeric field overflow/,
    );
  });

  it('allows opening stock only before any other movement of that stock', async () => {
    const c = await rawDb();
    const w = await world(c);
    await move(c, w, { movement_type: 'OPENING_STOCK', quantity_delta: '4' });
    await expect(
      move(c, w, { movement_type: 'OPENING_STOCK', quantity_delta: '1' }),
    ).rejects.toThrow(/opening stock can only be recorded/);
    await move(c, w, { product_id: w.kg, quantity_delta: '1' }); // a receipt first ...
    await expect(
      move(c, w, { product_id: w.kg, movement_type: 'OPENING_STOCK', quantity_delta: '1' }),
    ).rejects.toThrow(/opening stock can only be recorded/); // ... so no opening stock any more
  });

  it('serializes two simultaneous opening stocks in the database itself (no help from the engine)', async () => {
    const c = await rawDb();
    const w = await world(c);
    const c2 = new pg.Client({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password as string,
      database: c.database,
    });
    await c2.connect();
    try {
      await c.query('BEGIN');
      await c2.query('BEGIN');
      await move(c, w, { movement_type: 'OPENING_STOCK', quantity_delta: '4' }); // holds the lock until commit
      const second = move(c2, w, { movement_type: 'OPENING_STOCK', quantity_delta: '6' });
      const settled = second.then(
        () => 'ok',
        (e: Error) => e.message,
      );
      await new Promise((r) => setTimeout(r, 500));
      await c.query('COMMIT'); // only now can the second one look: it must see the first and refuse
      expect(await settled).toMatch(/opening stock can only be recorded/);
      await c2.query('ROLLBACK');
    } finally {
      await c2.end();
    }
    expect(await onHand(c, w)).toBe('4.0000');
  });

  it('identifies one logical event once per organization (idempotency identity)', async () => {
    const c = await rawDb();
    const a = await world(c, 'Org A (fictional)');
    const b = await world(c, 'Org B (fictional)');
    await move(c, a, { source_ref: 'same', source_line_ref: '1' });
    await expect(move(c, a, { source_ref: 'same', source_line_ref: '1' })).rejects.toThrow(
      /stock_movements_organization_id_source_type_source_ref/,
    );
    await move(c, a, { source_ref: 'same', source_line_ref: '2' }); // another line of the same document
    await move(c, b, { source_ref: 'same', source_line_ref: '1' }); // another organization
    expect(await onHand(c, a)).toBe('20.0000');
  });

  it('keeps unit and inventory tracking of a product that has stock history', async () => {
    const c = await rawDb();
    const w = await world(c);
    await c.query(`UPDATE products SET unit_id = $1 WHERE id = $2`, [w.unit3, w.pcs]); // no stock yet: allowed
    await c.query(`UPDATE products SET unit_id = $1 WHERE id = $2`, [w.unit0, w.pcs]);
    await move(c, w);
    await expect(
      c.query(`UPDATE products SET unit_id = $1 WHERE id = $2`, [w.unit3, w.pcs]),
    ).rejects.toThrow(/keeps its unit and inventory tracking/);
    await expect(
      c.query(`UPDATE products SET track_inventory = false WHERE id = $1`, [w.pcs]),
    ).rejects.toThrow(/keeps its unit and inventory tracking/);
    await c.query(`UPDATE products SET name = 'Renamed', selling_price = 12 WHERE id = $1`, [
      w.pcs,
    ]); // ordinary edits are fine
  });

  it('cannot delete a warehouse, product or user that the ledger references', async () => {
    const c = await rawDb();
    const w = await world(c);
    await move(c, w);
    await expect(c.query(`DELETE FROM warehouses WHERE id = $1`, [w.wh])).rejects.toThrow();
    await expect(c.query(`DELETE FROM products WHERE id = $1`, [w.pcs])).rejects.toThrow();
    await expect(c.query(`DELETE FROM users WHERE id = $1`, [w.user])).rejects.toThrow();
  });
});
