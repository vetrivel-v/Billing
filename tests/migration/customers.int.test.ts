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
].map(sql);
const m9 = sql('20261022000000_task_1_9_customers');

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
  if (applyNew) await c.query(m9);
  return c;
}

async function org(c: pg.Client, name = 'DEMO Mig9 Co (fictional)') {
  return (
    await c.query(
      `INSERT INTO organizations (legal_name, setup_completed_at, updated_at) VALUES ($1, now(), now()) RETURNING id`,
      [name],
    )
  ).rows[0].id as string;
}

type Row = Record<string, unknown>;
const GOOD: Row = {
  code: 'CUS-000001',
  customer_type: 'B2B',
  legal_name: 'Fictional Buyer Co',
  gst_status: 'UNREGISTERED',
  billing_address_line1: '1 Test Road',
  billing_state_code: '27',
  place_of_supply_state_code: '27',
};

async function insert(c: pg.Client, orgId: string, overrides: Row = {}) {
  const row: Row = { organization_id: orgId, updated_at: new Date(), ...GOOD, ...overrides };
  const cols = Object.keys(row);
  const res = await c.query(
    `INSERT INTO customers (${cols.map((k) => `"${k}"`).join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}${row[cols[i]!] instanceof Date ? '' : ''}`).join(', ')}) RETURNING id`,
    cols.map((k) => row[k]),
  );
  return res.rows[0].id as string;
}

const GSTIN = '27ABCDE1234F1Z0';

describe('migration 20261022000000_task_1_9_customers', () => {
  it('upgrades a populated Task 1.8 database without touching its data', async () => {
    const c = await rawDb(false);
    const orgId = await org(c, 'DEMO Configured Co (fictional)');
    await c.query(
      `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at)
       VALUES ($1, 'configured.admin', 'Admin', '$argon2id$placeholder', now())`,
      [orgId],
    );
    await c.query(
      `INSERT INTO business_locations (organization_id, name, address_line1, updated_at) VALUES ($1, 'Head Office', '1 Road', now())`,
      [orgId],
    );
    const before = {
      orgs: (await c.query(`SELECT * FROM organizations ORDER BY id`)).rows,
      users: (await c.query(`SELECT * FROM users ORDER BY id`)).rows,
      locations: (await c.query(`SELECT * FROM business_locations ORDER BY id`)).rows,
    };
    await c.query(m9);
    expect((await c.query(`SELECT * FROM organizations ORDER BY id`)).rows).toEqual(before.orgs);
    expect((await c.query(`SELECT * FROM users ORDER BY id`)).rows).toEqual(before.users);
    expect((await c.query(`SELECT * FROM business_locations ORDER BY id`)).rows).toEqual(
      before.locations,
    );
    expect((await c.query(`SELECT count(*)::int AS n FROM customers`)).rows[0].n).toBe(0);
    // the new tables are usable straight away
    const id = await insert(c, orgId);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts a B2C and a registered B2B customer and gives each its own internal id', async () => {
    const c = await rawDb();
    const o = await org(c);
    const b2c = await insert(c, o, {
      code: 'CUS-000001',
      customer_type: 'B2C',
      legal_name: 'Walk-in Person',
    });
    const b2b = await insert(c, o, {
      code: 'CUS-000002',
      gst_status: 'REGISTERED',
      gstin: GSTIN,
      pan: 'ABCDE1234F',
    });
    expect(b2c).not.toBe(b2b);
    const row = (
      await c.query(
        `SELECT version, is_active, shipping_same_as_billing, country FROM customers WHERE id = $1`,
        [b2b],
      )
    ).rows[0];
    expect(row).toEqual({
      version: 1,
      is_active: true,
      shipping_same_as_billing: true,
      country: 'IN',
    });
  });

  it('scopes the customer code to the organization', async () => {
    const c = await rawDb();
    const a = await org(c, 'Org A (fictional)');
    const b = await org(c, 'Org B (fictional)');
    await insert(c, a, { code: 'CUS-000001' });
    await expect(insert(c, a, { code: 'CUS-000001', legal_name: 'Other' })).rejects.toThrow(
      /customers_organization_id_code_key/,
    );
    await insert(c, b, { code: 'CUS-000001' }); // the same code in another organization is fine
  });

  it('allows one GSTIN per organization (partial unique index), many unregistered customers', async () => {
    const c = await rawDb();
    const a = await org(c, 'Org A (fictional)');
    const b = await org(c, 'Org B (fictional)');
    const reg = { gst_status: 'REGISTERED', gstin: GSTIN };
    await insert(c, a, { code: 'A1', ...reg });
    await expect(insert(c, a, { code: 'A2', ...reg })).rejects.toThrow(
      /customers_organization_id_gstin_key/,
    );
    await insert(c, b, { code: 'B1', ...reg });
    await insert(c, a, { code: 'U1' });
    await insert(c, a, { code: 'U2' });
  });

  it('enforces the GST, format and range rules in the database', async () => {
    const c = await rawDb();
    const o = await org(c);
    let n = 0;
    const bad = (over: Row, rule: RegExp) =>
      expect(insert(c, o, { code: `T${++n}`, ...over })).rejects.toThrow(rule);
    await bad({ gst_status: 'REGISTERED' }, /customers_gstin_by_status/); // registered needs a GSTIN
    await bad({ gst_status: 'UNREGISTERED', gstin: GSTIN }, /customers_gstin_by_status/);
    await bad({ gst_status: 'REGISTERED', gstin: 'NOT-A-GSTIN' }, /customers_gstin_format/);
    await bad({ customer_type: 'B2C', gst_status: 'COMPOSITION' }, /customers_b2c_unregistered/);
    await bad({ customer_type: 'MARKETPLACE' }, /customers_type_valid/);
    await bad({ code: 'lower-case' }, /customers_code_format/);
    await bad({ legal_name: '   ' }, /customers_legal_name_present/);
    await bad({ pan: 'abc' }, /customers_pan_format/);
    await bad({ billing_state_code: '7' }, /customers_state_codes_format/);
    await bad({ billing_pin_code: '012345' }, /customers_pin_codes_format/);
    await bad({ country: 'India' }, /value too long|customers_country_format/);
    await bad({ credit_limit: -1 }, /customers_credit_limit_not_negative/);
    await bad({ payment_terms_days: 366 }, /customers_payment_terms_range/);
    // composition may be registered with or without a GSTIN
    await insert(c, o, { code: 'COMP1', gst_status: 'COMPOSITION' });
  });

  it('keeps shipping columns consistent with the same-as-billing flag', async () => {
    const c = await rawDb();
    const o = await org(c);
    await expect(
      insert(c, o, { code: 'S1', shipping_address_line1: '9 Dock Road' }),
    ).rejects.toThrow(/customers_shipping_consistency/);
    await expect(insert(c, o, { code: 'S2', shipping_same_as_billing: false })).rejects.toThrow(
      /customers_shipping_consistency/,
    );
    await insert(c, o, {
      code: 'S3',
      shipping_same_as_billing: false,
      shipping_address_line1: '9 Dock Road',
      shipping_state_code: '29',
    });
  });

  it('never deletes a customer and never changes its identity', async () => {
    const c = await rawDb();
    const a = await org(c, 'Org A (fictional)');
    const b = await org(c, 'Org B (fictional)');
    const id = await insert(c, a);
    await expect(c.query(`DELETE FROM customers WHERE id = $1`, [id])).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      c.query(`UPDATE customers SET code = 'CUS-999999' WHERE id = $1`, [id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      c.query(`UPDATE customers SET organization_id = $2 WHERE id = $1`, [id, b]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      c.query(`UPDATE customers SET created_at = now() - interval '1 day' WHERE id = $1`, [id]),
    ).rejects.toThrow(/cannot be changed/);
    // ordinary edits and deactivation work
    await c.query(
      `UPDATE customers SET is_active = false, legal_name = 'Renamed Co', version = version + 1, updated_at = now() WHERE id = $1`,
      [id],
    );
    expect(
      (await c.query(`SELECT is_active, version FROM customers WHERE id = $1`, [id])).rows[0],
    ).toEqual({ is_active: false, version: 2 });
    // an organization that has customers cannot be removed either (foreign key)
    await expect(c.query(`DELETE FROM organizations WHERE id = $1`, [a])).rejects.toThrow();
  });

  it('has a per-organization code counter that cannot go negative', async () => {
    const c = await rawDb();
    const o = await org(c);
    await c.query(
      `INSERT INTO customer_code_counters (organization_id, updated_at) VALUES ($1, now())`,
      [o],
    );
    expect(
      (
        await c.query(
          `SELECT last_number::int AS n FROM customer_code_counters WHERE organization_id = $1`,
          [o],
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(
      c.query(`UPDATE customer_code_counters SET last_number = -1 WHERE organization_id = $1`, [o]),
    ).rejects.toThrow(/customer_code_counters_not_negative/);
    await expect(
      c.query(
        `INSERT INTO customer_code_counters (organization_id, updated_at) VALUES ($1, now())`,
        [o],
      ),
    ).rejects.toThrow();
  });

  it('is forward-only: applying it twice fails instead of silently changing data', async () => {
    const c = await rawDb();
    await expect(c.query(m9)).rejects.toThrow(/already exists/);
  });
});
