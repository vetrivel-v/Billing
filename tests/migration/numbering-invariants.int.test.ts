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
].map(sql);
const m5 = sql('20261020000000_task_1_5_document_numbering');

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
  for (const m of previous) await c.query(m);
  return c;
}

/** Organization + financial year + one sequence (inserted with plain SQL, as older code/tests did). */
async function base(c: pg.Client, seq: Record<string, string | number> = {}) {
  const org = (
    await c.query(
      `INSERT INTO organizations (legal_name, updated_at) VALUES ('DEMO Mig5 Co (fictional)', now()) RETURNING id`,
    )
  ).rows[0].id as string;
  const fy = (
    await c.query(
      `INSERT INTO financial_years (organization_id, label, start_date, end_date, updated_at)
       VALUES ($1, '2026-27', '2026-04-01', '2027-03-31', now()) RETURNING id`,
      [org],
    )
  ).rows[0].id as string;
  const cols: Record<string, string | number> = {
    document_type: 'INVOICE',
    prefix: 'INV/{FY}/',
    ...seq,
  };
  const keys = Object.keys(cols);
  const id = (
    await c.query(
      `INSERT INTO document_sequences (organization_id, financial_year_id, ${keys.join(', ')}, updated_at)
       VALUES ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(', ')}, now()) RETURNING id`,
      [org, fy, ...Object.values(cols)],
    )
  ).rows[0].id as string;
  return { org, fy, id };
}

describe('migration 20261020000000_task_1_5_document_numbering', () => {
  it('upgrades a populated previous-version database, keeping existing sequences with safe defaults', async () => {
    const c = await rawDb();
    const { id } = await base(c, { prefix: 'INV/2026-27/"Ω"', last_number: '9007199254740993' });
    await c.query(m5);
    const row = (
      await c.query(
        `SELECT reset_policy, is_active, prefix, last_number::text AS n FROM document_sequences WHERE id = $1`,
        [id],
      )
    ).rows[0];
    expect(row).toEqual({
      reset_policy: 'FINANCIAL_YEAR',
      is_active: true,
      prefix: 'INV/2026-27/"Ω"',
      n: '9007199254740993',
    });
    expect(
      (await c.query(`SELECT count(*)::int AS n FROM document_number_allocations`)).rows[0].n,
    ).toBe(0);
  });

  it('aborts atomically, changing nothing, if an existing sequence violates a new rule', async () => {
    const c = await rawDb();
    await base(c, { document_type: 'invoice' }); // lower-case type is not a stable code
    await expect(c.query(m5)).rejects.toThrow(/document_sequences_type_form_chk/);
    expect(
      (await c.query(`SELECT to_regclass('document_number_allocations') AS t`)).rows[0].t,
    ).toBeNull();
    expect(
      (
        await c.query(
          `SELECT 1 FROM information_schema.columns WHERE table_name = 'document_sequences' AND column_name = 'reset_policy'`,
        )
      ).rowCount,
    ).toBe(0);
  });

  it.each([
    ['lower-case document type', { document_type: 'invoice' }, /document_sequences_type_form_chk/],
    ['display label as type', { document_type: 'Tax invoice' }, /document_sequences_type_form_chk/],
    ['unknown reset policy', { reset_policy: 'MONTHLY' }, /document_sequences_reset_chk/],
    ['over-long prefix', { prefix: 'x'.repeat(41) }, /document_sequences_affix_len_chk/],
    [
      'start number wider than the width',
      { start_number: 1000, numeric_length: 3 },
      /document_sequences_start_fits_chk/,
    ],
  ])('enforces at the database: %s', async (_name, over, message) => {
    const c = await rawDb();
    await c.query(m5);
    await expect(base(c, over as Record<string, string | number>)).rejects.toThrow(message);
  });

  it('the counter advances by exactly one, starting at the start number', async () => {
    const c = await rawDb();
    await c.query(m5);
    const { id } = await base(c, { start_number: 100 });
    const set = (n: number) =>
      c.query(`UPDATE document_sequences SET last_number = $2 WHERE id = $1`, [id, n]);
    await expect(set(1)).rejects.toThrow(/exactly one/); // first number must be the start number (100)
    await expect(set(101)).rejects.toThrow(/exactly one/);
    await set(100);
    await expect(set(102)).rejects.toThrow(/exactly one/); // skip
    await expect(set(99)).rejects.toThrow(/exactly one/); // rewind
    await set(101);
    await set(101); // no change is allowed
    expect(
      (await c.query(`SELECT last_number::int AS n FROM document_sequences WHERE id = $1`, [id]))
        .rows[0].n,
    ).toBe(101);
  });

  it('freezes identity and the start number, allows other configuration, and forbids deletion', async () => {
    const c = await rawDb();
    await c.query(m5);
    const { id, org } = await base(c);
    const other = (
      await c.query(
        `INSERT INTO organizations (legal_name, updated_at) VALUES ('Other (fictional)', now()) RETURNING id`,
      )
    ).rows[0].id;
    await expect(
      c.query(`UPDATE document_sequences SET organization_id = $2 WHERE id = $1`, [id, other]),
    ).rejects.toThrow(/immutable/);
    await expect(
      c.query(`UPDATE document_sequences SET document_type = 'CREDIT_NOTE' WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    await c.query(
      `UPDATE document_sequences SET start_number = 50, prefix = 'NEW/{FY}/', is_active = false WHERE id = $1`,
      [id],
    ); // allowed before use
    await c.query(
      `UPDATE document_sequences SET is_active = true, last_number = 50 WHERE id = $1`,
      [id],
    );
    await expect(
      c.query(`UPDATE document_sequences SET start_number = 1 WHERE id = $1`, [id]),
    ).rejects.toThrow(/start number cannot change/);
    await c.query(`UPDATE document_sequences SET prefix = 'LATER/{FY}/' WHERE id = $1`, [id]); // prefix may change later
    await expect(c.query(`DELETE FROM document_sequences WHERE id = $1`, [id])).rejects.toThrow(
      /cannot be deleted/,
    );
    expect(org).toBeTruthy();
  });

  it('ledger rows must match the sequence, are unique per number/text/document, and are append-only', async () => {
    const c = await rawDb();
    await c.query(m5);
    const { id, org } = await base(c);
    await c.query(`UPDATE document_sequences SET last_number = 1 WHERE id = $1`, [id]);
    const ins = (over: { n?: number; text?: string; ref?: string; type?: string } = {}) =>
      c.query(
        `INSERT INTO document_number_allocations (organization_id, sequence_id, document_type, sequence_number, formatted_number, document_ref)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          org,
          id,
          over.type ?? 'INVOICE',
          over.n ?? 1,
          over.text ?? 'INV/000001',
          over.ref ?? 'doc-1',
        ],
      );
    await expect(ins({ n: 2 })).rejects.toThrow(/does not match its sequence/); // counter has not reached 2
    await expect(ins({ type: 'CREDIT_NOTE' })).rejects.toThrow(/does not match its sequence/);
    await expect(ins({ n: 0 })).rejects.toThrow(
      /document_number_allocations_number_chk|does not match/,
    );
    await ins();
    await expect(ins({ text: 'OTHER', ref: 'doc-2' })).rejects.toThrow(
      /sequence_id_sequence_number/,
    ); // same number
    await c.query(`UPDATE document_sequences SET last_number = 2 WHERE id = $1`, [id]);
    await expect(ins({ n: 2, text: 'INV/000001', ref: 'doc-2' })).rejects.toThrow(
      /formatted|document_type_f_key/,
    ); // same text
    await expect(ins({ n: 2, text: 'INV/000002', ref: 'doc-1' })).rejects.toThrow(
      /document_ref|document_type_d_key/,
    ); // same document
    await c.query(`UPDATE document_sequences SET last_number = 3 WHERE id = $1`, [id]);
    await ins({ n: 3, text: 'INV/000003', ref: 'doc-3' });
    await expect(
      c.query(`UPDATE document_number_allocations SET formatted_number = 'X'`),
    ).rejects.toThrow(/append-only/);
    await expect(c.query(`DELETE FROM document_number_allocations`)).rejects.toThrow(/append-only/);
    await expect(c.query(`TRUNCATE document_number_allocations`)).rejects.toThrow(/append-only/);
  });

  it('is forward-only: applying it twice fails instead of silently changing data', async () => {
    const c = await rawDb();
    await c.query(m5);
    await expect(c.query(m5)).rejects.toThrow(/already exists/);
  });
});
