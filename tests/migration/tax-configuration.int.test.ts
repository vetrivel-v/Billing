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
  '20261024000000_task_1_11_inventory',
].map(sql);
const m12 = sql('20261025000000_task_1_12_tax_configuration');

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
  // The database is dropped LAST (cleanup runs in reverse): connections are closed first.
  cleanup.push(async () => {
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await a.end();
  });
  const connect = async () => {
    const x = new pg.Client({ connectionString: u.toString() });
    await x.connect();
    cleanup.push(() => x.end());
    return x;
  };
  const c = await connect();
  for (const m of previous) await c.query(m);
  if (applyNew) await c.query(m12);
  return { c, connect };
}

const GSTIN = (n: number) => `27ABCDE${String(1000 + n)}F1Z5`;

interface Org {
  org: string;
  user: string;
  tax: string;
  unit: string;
}
const one = async (c: pg.Client, q: string, p: unknown[] = []) =>
  (await c.query(q, p)).rows[0].id as string;

async function org(c: pg.Client, name: string): Promise<Org> {
  const o = await one(
    c,
    `INSERT INTO organizations (legal_name, setup_completed_at, updated_at) VALUES ($1, now(), now()) RETURNING id`,
    [name],
  );
  return {
    org: o,
    user: await one(
      c,
      `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at)
       VALUES ($1, 'u' || floor(random() * 1000000000)::text, 'A User', '$argon2id$placeholder', now()) RETURNING id`,
      [o],
    ),
    tax: await one(
      c,
      `INSERT INTO tax_categories (organization_id, code, name, classification, updated_at)
       VALUES ($1, 'GST_18', 'GST 18%', 'STANDARD', now()) RETURNING id`,
      [o],
    ),
    unit: await one(
      c,
      `INSERT INTO units (organization_id, code, name, decimal_places, updated_at) VALUES ($1, 'PCS', 'Pieces', 0, now()) RETURNING id`,
      [o],
    ),
  };
}

type Row = Record<string, unknown>;
async function insertRow(c: pg.Client, table: string, row: Row) {
  const cols = Object.keys(row);
  return (
    await c.query(
      `INSERT INTO ${table} (${cols.map((k) => `"${k}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((k) => row[k]),
    )
  ).rows[0].id as string;
}
const customer = (o: Org, over: Row = {}) =>
  ({
    organization_id: o.org,
    code: `C-${Math.random().toString(16).slice(2, 8).toUpperCase()}`,
    legal_name: 'Fictional Buyer',
    billing_address_line1: '1 Test Lane',
    billing_state_code: '27',
    place_of_supply_state_code: '27',
    updated_at: new Date(),
    ...over,
  }) as Row;
const rate = (o: Org, from: string, to: string | null, over: Row = {}) =>
  ({
    organization_id: o.org,
    category_id: o.tax,
    rate_percent: '18',
    effective_from: from,
    effective_to: to,
    updated_at: new Date(),
    ...over,
  }) as Row;
const hsn = (o: Org, code: string, kind = 'HSN') => ({ organization_id: o.org, code, kind }) as Row;

describe('migration 20261025000000_task_1_12_tax_configuration - upgrade', () => {
  it('upgrades a populated Task 1.11 database: labels are renamed, GSTINs and everything else are untouched', async () => {
    const { c } = await rawDb(false);
    const o = await org(c, 'Populated Co (fictional)');
    const biz = await insertRow(
      c,
      'customers',
      customer(o, {
        customer_type: 'B2B',
        gst_status: 'REGISTERED',
        gstin: GSTIN(1),
        legal_name: 'Biz',
      }),
    );
    const person = await insertRow(
      c,
      'customers',
      customer(o, { customer_type: 'B2C', gst_status: 'UNREGISTERED', legal_name: 'Person' }),
    );
    const comp = await insertRow(
      c,
      'customers',
      customer(o, {
        customer_type: 'B2B',
        gst_status: 'COMPOSITION',
        gstin: GSTIN(2),
        legal_name: 'Comp',
      }),
    );
    const hsnId = await insertRow(c, 'hsn_sac_codes', {
      code: '8517',
      kind: 'HSN',
      description: 'Telephone sets',
    });
    await insertRow(c, 'hsn_sac_codes', { code: '998314', kind: 'SAC' }); // unused: single organization -> that organization
    await insertRow(c, 'products', {
      organization_id: o.org,
      sku: 'P-1',
      name: 'Widget',
      kind: 'GOODS',
      unit_id: o.unit,
      tax_category_id: o.tax,
      selling_price: 10,
      hsn_sac_code_id: hsnId,
      updated_at: new Date(),
    });
    await insertRow(c, 'tax_rates', rate(o, '2017-07-01', null));
    const tables = ['organizations', 'users', 'units', 'products', 'tax_categories', 'tax_rates'];
    const before: Record<string, unknown[]> = {};
    for (const t of tables) before[t] = (await c.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
    const gstinsBefore = (await c.query(`SELECT id, gstin, gst_status FROM customers ORDER BY id`))
      .rows;

    await c.query(m12);

    for (const t of tables)
      expect((await c.query(`SELECT * FROM ${t} ORDER BY id`)).rows, t).toEqual(before[t]);
    expect((await c.query(`SELECT id, gstin, gst_status FROM customers ORDER BY id`)).rows).toEqual(
      gstinsBefore,
    );
    const kinds = Object.fromEntries(
      (await c.query(`SELECT id, customer_kind FROM customers`)).rows.map((r) => [
        r.id,
        r.customer_kind,
      ]),
    );
    expect(kinds).toEqual({ [biz]: 'BUSINESS', [person]: 'INDIVIDUAL', [comp]: 'BUSINESS' });
    const cols = (
      await c.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'customers'`,
      )
    ).rows.map((r) => r.column_name);
    expect(cols).toContain('customer_kind');
    expect(cols).not.toContain('customer_type');
    const codes = (
      await c.query(
        `SELECT code, organization_id, origin, review_status, is_active FROM hsn_sac_codes ORDER BY code`,
      )
    ).rows;
    expect(codes).toEqual([
      {
        code: '8517',
        organization_id: o.org,
        origin: 'USER',
        review_status: 'UNREVIEWED',
        is_active: true,
      },
      {
        code: '998314',
        organization_id: o.org,
        origin: 'USER',
        review_status: 'UNREVIEWED',
        is_active: true,
      },
    ]);
  });

  it('refuses clearly, and changes NOTHING, when a registered or composition customer has no GSTIN', async () => {
    const { c } = await rawDb(false);
    const o = await org(c, 'Violating Co (fictional)');
    await insertRow(
      c,
      'customers',
      customer(o, {
        customer_type: 'B2B',
        gst_status: 'COMPOSITION',
        gstin: null,
        legal_name: 'Composition without a GSTIN',
      }),
    );
    await expect(c.query(m12)).rejects.toThrow(
      /1 customer\(s\) are REGISTERED or COMPOSITION but have no GSTIN/,
    );
    const cols = (
      await c.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'customers'`,
      )
    ).rows.map((r) => r.column_name);
    expect(cols).toContain('customer_type'); // not renamed
    expect(cols).not.toContain('customer_kind');
    expect((await c.query(`SELECT gstin FROM customers`)).rows).toEqual([{ gstin: null }]); // never fabricated
    const tables = (await c.query(`SELECT to_regclass('tax_configuration_reviews') AS t`)).rows[0]
      .t;
    expect(tables).toBeNull(); // no partial migration
  });

  it('refuses when tax rates of one category overlap, and when HSN/SAC rows cannot be assigned', async () => {
    const a = await rawDb(false);
    const o = await org(a.c, 'Overlap Co (fictional)');
    await insertRow(a.c, 'tax_rates', rate(o, '2017-07-01', null));
    await insertRow(a.c, 'tax_rates', rate(o, '2026-04-01', null));
    await expect(a.c.query(m12)).rejects.toThrow(
      /1 pair\(s\) of tax rates in the same category have overlapping effective dates/,
    );

    const b = await rawDb(false);
    await org(b.c, 'Org One (fictional)');
    await org(b.c, 'Org Two (fictional)');
    await insertRow(b.c, 'hsn_sac_codes', { code: '8517', kind: 'HSN' });
    await expect(b.c.query(m12)).rejects.toThrow(
      /1 HSN\/SAC row\(s\) cannot be assigned to one organization/,
    );
    expect((await b.c.query(`SELECT count(*)::int AS n FROM hsn_sac_codes`)).rows[0].n).toBe(1);
  });
});

describe('customers after the migration', () => {
  it('kind is independent of GST registration; a GSTIN is required for registered and composition customers', async () => {
    const { c } = await rawDb();
    const o = await org(c, 'Kind Co (fictional)');
    const ok = (over: Row) => insertRow(c, 'customers', customer(o, over));
    await ok({ customer_kind: 'INDIVIDUAL', gst_status: 'REGISTERED', gstin: GSTIN(11) }); // a registered individual
    await ok({ customer_kind: 'BUSINESS', gst_status: 'UNREGISTERED' }); // an unregistered business
    await ok({ customer_kind: 'BUSINESS', gst_status: 'COMPOSITION', gstin: GSTIN(12) });
    await expect(
      ok({ customer_kind: 'BUSINESS', gst_status: 'COMPOSITION', gstin: null }),
    ).rejects.toThrow(/customers_gstin_by_status/);
    await expect(
      ok({ customer_kind: 'BUSINESS', gst_status: 'REGISTERED', gstin: null }),
    ).rejects.toThrow(/customers_gstin_by_status/);
    await expect(
      ok({ customer_kind: 'BUSINESS', gst_status: 'UNREGISTERED', gstin: GSTIN(13) }),
    ).rejects.toThrow(/customers_gstin_by_status/);
    await expect(ok({ customer_kind: 'B2B', gst_status: 'UNREGISTERED' })).rejects.toThrow(
      /customers_kind_valid/,
    );
    await expect(ok({ customer_kind: 'MARKETPLACE', gst_status: 'UNREGISTERED' })).rejects.toThrow(
      /customers_kind_valid/,
    );
  });
});

describe('tax rates and categories after the migration', () => {
  it('forbids overlapping effective dates but allows adjacent and open-ended successors', async () => {
    const { c } = await rawDb();
    const o = await org(c, 'Rates Co (fictional)');
    const r1 = await insertRow(c, 'tax_rates', rate(o, '2017-07-01', '2026-09-30'));
    await insertRow(c, 'tax_rates', rate(o, '2026-10-01', null, { rate_percent: '12' })); // adjacent: fine
    await expect(insertRow(c, 'tax_rates', rate(o, '2026-09-15', '2026-12-31'))).rejects.toThrow(
      /effective dates overlap/,
    );
    await expect(insertRow(c, 'tax_rates', rate(o, '2030-01-01', null))).rejects.toThrow(
      /effective dates overlap/,
    ); // inside the open-ended one
    await expect(insertRow(c, 'tax_rates', rate(o, '2016-01-01', '2017-07-01'))).rejects.toThrow(
      /effective dates overlap/,
    ); // touches the first day
    await insertRow(c, 'tax_rates', rate(o, '2016-01-01', '2017-06-30', { rate_percent: '5' }));
    expect(r1).toBeTruthy();
    // another category (or organization) is independent
    const other = await org(c, 'Other Rates Co (fictional)');
    await insertRow(c, 'tax_rates', rate(other, '2017-07-01', null));
    // a rate may only point at a category of its own organization
    await expect(
      insertRow(c, 'tax_rates', { ...rate(other, '2040-01-01', null), category_id: o.tax }),
    ).rejects.toThrow(/belongs to another organization/);
  });

  it('two simultaneous overlapping inserts: exactly one wins', async () => {
    const { c, connect } = await rawDb();
    const o = await org(c, 'Race Co (fictional)');
    const c2 = await connect();
    await c.query('BEGIN');
    await c2.query('BEGIN');
    await insertRow(c, 'tax_rates', rate(o, '2030-01-01', '2030-12-31'));
    const second = insertRow(c2, 'tax_rates', rate(o, '2030-06-01', '2031-06-30')).then(
      () => 'ok',
      (e: Error) => e.message,
    );
    await new Promise((r) => setTimeout(r, 400));
    await c.query('COMMIT');
    expect(await second).toMatch(/effective dates overlap/);
    await c2.query('ROLLBACK');
    expect(
      (
        await c.query(
          `SELECT count(*)::int AS n FROM tax_rates WHERE effective_from >= '2030-01-01'`,
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('a rate never changes and is never deleted; the only edit is closing an open one, once', async () => {
    const { c } = await rawDb();
    const o = await org(c, 'Immutable Co (fictional)');
    const id = await insertRow(c, 'tax_rates', rate(o, '2017-07-01', null));
    for (const set of [
      'rate_percent = 28',
      'cess_percent = 1',
      "effective_from = '2018-01-01'",
      "origin = 'REFERENCE_SEED'",
    ]) {
      await expect(c.query(`UPDATE tax_rates SET ${set} WHERE id = $1`, [id])).rejects.toThrow(
        /cannot be changed/,
      );
    }
    await expect(c.query(`DELETE FROM tax_rates WHERE id = $1`, [id])).rejects.toThrow(
      /cannot be deleted/,
    );
    await c.query(
      `UPDATE tax_rates SET review_status = 'REVIEWED', review_note = 'checked' WHERE id = $1`,
      [id],
    ); // marks may change
    await c.query(`UPDATE tax_rates SET effective_to = '2026-09-30' WHERE id = $1`, [id]); // closing is allowed ...
    await expect(
      c.query(`UPDATE tax_rates SET effective_to = '2027-01-01' WHERE id = $1`, [id]),
    ).rejects.toThrow(/closed tax rate/); // ... once
    await expect(
      c.query(`UPDATE tax_rates SET effective_to = NULL WHERE id = $1`, [id]),
    ).rejects.toThrow(/closed tax rate/);
    // closing before the start is still refused by the existing check
    const id2 = await insertRow(
      c,
      'tax_rates',
      rate(o, '2026-10-01', null, { rate_percent: '12' }),
    );
    await expect(
      c.query(`UPDATE tax_rates SET effective_to = '2026-09-01' WHERE id = $1`, [id2]),
    ).rejects.toThrow(/tax_rates_effective_chk/);
  });

  it('the idempotent seed insert (ON CONFLICT DO NOTHING) still works next to user-added rows', async () => {
    const { c } = await rawDb();
    const o = await org(c, 'Seed Co (fictional)');
    await insertRow(
      c,
      'tax_rates',
      rate(o, '2017-07-01', '2027-03-31', { origin: 'REFERENCE_SEED' }),
    );
    await insertRow(c, 'tax_rates', rate(o, '2027-04-01', null));
    const r = await c.query(
      `INSERT INTO tax_rates (organization_id, category_id, rate_percent, effective_from, origin, updated_at)
       VALUES ($1, $2, 18, '2017-07-01', 'REFERENCE_SEED', now()) ON CONFLICT DO NOTHING`,
      [o.org, o.tax],
    );
    expect(r.rowCount).toBe(0);
    expect((await c.query(`SELECT count(*)::int AS n FROM tax_rates`)).rows[0].n).toBe(2);
  });

  it('a category keeps its code and classification, is never deleted, and loses its review mark when it changes', async () => {
    const { c } = await rawDb();
    const o = await org(c, 'Category Co (fictional)');
    for (const set of ["code = 'X'", "classification = 'EXEMPT'", "origin = 'REFERENCE_SEED'"]) {
      await expect(
        c.query(`UPDATE tax_categories SET ${set} WHERE id = $1`, [o.tax]),
      ).rejects.toThrow(/cannot be changed/);
    }
    await expect(c.query(`DELETE FROM tax_categories WHERE id = $1`, [o.tax])).rejects.toThrow(
      /cannot be deleted/,
    );
    await c.query(`UPDATE tax_categories SET review_status = 'REVIEWED' WHERE id = $1`, [o.tax]);
    const status = async () =>
      (await c.query(`SELECT review_status FROM tax_categories WHERE id = $1`, [o.tax])).rows[0]
        .review_status;
    expect(await status()).toBe('REVIEWED');
    await c.query(`UPDATE tax_categories SET name = 'GST eighteen' WHERE id = $1`, [o.tax]);
    expect(await status()).toBe('UNREVIEWED'); // a change drops the mark
    await c.query(`UPDATE tax_categories SET review_status = 'REVIEWED' WHERE id = $1`, [o.tax]);
    await c.query(`UPDATE tax_categories SET is_active = false WHERE id = $1`, [o.tax]);
    expect(await status()).toBe('UNREVIEWED');
  });
});

describe('tax configuration reviews', () => {
  const review = (o: Org, over: Row = {}) =>
    ({
      organization_id: o.org,
      fingerprint: 'a'.repeat(64),
      reviewed_by: o.user,
      reviewer_capacity: 'Accountant',
      notice_version: 'TAXREV-1',
      notice_text: 'I confirm...',
      engine_version: '1.0.0',
      ruleset_version: 'FUB-GST-1',
      jurisdiction_ruleset_version: '1',
      ...over,
    }) as Row;

  it('are append-only: no UPDATE, DELETE or TRUNCATE for anybody', async () => {
    const { c } = await rawDb();
    const o = await org(c, 'Review Co (fictional)');
    const id = await insertRow(c, 'tax_configuration_reviews', review(o));
    for (const set of [
      "fingerprint = '" + 'b'.repeat(64) + "'",
      "reviewer_capacity = 'Owner'",
      "note = 'x'",
    ]) {
      await expect(
        c.query(`UPDATE tax_configuration_reviews SET ${set} WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
    }
    await expect(
      c.query(`DELETE FROM tax_configuration_reviews WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(c.query(`TRUNCATE tax_configuration_reviews`)).rejects.toThrow(/append-only/);
  });

  it('require a well-formed fingerprint, a stated capacity, the notice text and a reviewer of the same organization', async () => {
    const { c } = await rawDb();
    const o = await org(c, 'Review Rules Co (fictional)');
    const other = await org(c, 'Another Co (fictional)');
    await expect(
      insertRow(c, 'tax_configuration_reviews', review(o, { fingerprint: 'short' })),
    ).rejects.toThrow(/tax_review_fingerprint_format/);
    await expect(
      insertRow(c, 'tax_configuration_reviews', review(o, { fingerprint: 'A'.repeat(64) })),
    ).rejects.toThrow(/tax_review_fingerprint_format/);
    await expect(
      insertRow(c, 'tax_configuration_reviews', review(o, { reviewer_capacity: ' ' })),
    ).rejects.toThrow(/tax_review_capacity_length/);
    await expect(
      insertRow(c, 'tax_configuration_reviews', review(o, { notice_text: '' })),
    ).rejects.toThrow(/tax_review_notice_present/);
    await expect(
      insertRow(c, 'tax_configuration_reviews', review(o, { note: 'x'.repeat(1001) })),
    ).rejects.toThrow(/tax_review_note_length/);
    await expect(
      insertRow(c, 'tax_configuration_reviews', review(o, { engine_version: '' })),
    ).rejects.toThrow(/tax_review_versions_present/);
    await expect(
      insertRow(c, 'tax_configuration_reviews', review(o, { reviewed_by: other.user })),
    ).rejects.toThrow(/reviewer belongs to another organization/);
  });
});

describe('HSN/SAC after the migration', () => {
  it('is organization-scoped: the same code may exist in two organizations, once in each', async () => {
    const { c } = await rawDb();
    const a = await org(c, 'Org A (fictional)');
    const b = await org(c, 'Org B (fictional)');
    await insertRow(c, 'hsn_sac_codes', hsn(a, '8517'));
    await insertRow(c, 'hsn_sac_codes', hsn(b, '8517'));
    await expect(insertRow(c, 'hsn_sac_codes', hsn(a, '8517', 'SAC'))).rejects.toThrow(
      /hsn_sac_codes_organization_id_code_key/,
    );
  });

  it('validates the format, origin and review consistency', async () => {
    const { c } = await rawDb();
    const o = await org(c, 'Format Co (fictional)');
    await expect(insertRow(c, 'hsn_sac_codes', hsn(o, '8'))).rejects.toThrow(/hsn_sac_code_format/);
    await expect(insertRow(c, 'hsn_sac_codes', hsn(o, '85A7'))).rejects.toThrow(
      /hsn_sac_code_format/,
    );
    await expect(insertRow(c, 'hsn_sac_codes', hsn(o, '123456789'))).rejects.toThrow(); // longer than the column
    await expect(insertRow(c, 'hsn_sac_codes', hsn(o, '8517', 'XYZ'))).rejects.toThrow(
      /hsn_sac_kind_chk/,
    );
    await expect(
      insertRow(c, 'hsn_sac_codes', { ...hsn(o, '8517'), origin: 'WEB' }),
    ).rejects.toThrow(/hsn_sac_origin_valid/);
    await expect(
      insertRow(c, 'hsn_sac_codes', { ...hsn(o, '8517'), review_status: 'REVIEWED' }),
    ).rejects.toThrow(/hsn_sac_review_consistent/);
    await insertRow(c, 'hsn_sac_codes', {
      ...hsn(o, '8517'),
      review_status: 'REVIEWED',
      reviewed_by: o.user,
      reviewed_at: new Date(),
    });
  });

  it('is never deleted, keeps code/kind/organization, and editing drops the review mark', async () => {
    const { c } = await rawDb();
    const o = await org(c, 'Protect Co (fictional)');
    const id = await insertRow(c, 'hsn_sac_codes', hsn(o, '8517'));
    await expect(c.query(`DELETE FROM hsn_sac_codes WHERE id = $1`, [id])).rejects.toThrow(
      /cannot be deleted/,
    );
    for (const set of [
      "code = '8518'",
      "kind = 'SAC'",
      `organization_id = '${(await org(c, 'Elsewhere (fictional)')).org}'`,
    ]) {
      await expect(c.query(`UPDATE hsn_sac_codes SET ${set} WHERE id = $1`, [id])).rejects.toThrow(
        /cannot be changed/,
      );
    }
    await c.query(
      `UPDATE hsn_sac_codes SET review_status = 'REVIEWED', reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
      [id, o.user],
    );
    await c.query(`UPDATE hsn_sac_codes SET description = 'Telephone sets' WHERE id = $1`, [id]);
    expect(
      (await c.query(`SELECT review_status, reviewed_by FROM hsn_sac_codes WHERE id = $1`, [id]))
        .rows[0],
    ).toEqual({ review_status: 'UNREVIEWED', reviewed_by: null });
    const other = await org(c, 'Reviewer Elsewhere (fictional)');
    await expect(
      c.query(
        `UPDATE hsn_sac_codes SET review_status = 'REVIEWED', reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
        [id, other.user],
      ),
    ).rejects.toThrow(/reviewer belongs to another organization/);
  });

  it('a product can only use an HSN/SAC entry of its own organization', async () => {
    const { c } = await rawDb();
    const a = await org(c, 'Product Org A (fictional)');
    const b = await org(c, 'Product Org B (fictional)');
    const hsnA = await insertRow(c, 'hsn_sac_codes', hsn(a, '8517'));
    const hsnB = await insertRow(c, 'hsn_sac_codes', hsn(b, '8517'));
    const product = (hsnId: string, sku: string) =>
      insertRow(c, 'products', {
        organization_id: a.org,
        sku,
        name: sku,
        kind: 'GOODS',
        unit_id: a.unit,
        tax_category_id: a.tax,
        selling_price: 1,
        hsn_sac_code_id: hsnId,
        updated_at: new Date(),
      });
    await product(hsnA, 'OK-1');
    await expect(product(hsnB, 'BAD-1')).rejects.toThrow(
      /HSN\/SAC entry belongs to another organization/,
    );
  });
});
