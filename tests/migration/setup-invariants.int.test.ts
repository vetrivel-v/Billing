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
].map(sql);
const m4 = sql('20261019000000_task_1_4_setup_invariants');

const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const f of cleanup) await f();
});

async function rawDb(applyPrevious = true) {
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
  if (applyPrevious) for (const m of previous) await c.query(m);
  return c;
}

const org = (c: pg.Client, cols: Record<string, string | null>) => {
  const keys = ['legal_name', ...Object.keys(cols)];
  const values = ['DEMO Mig4 Co (fictional)', ...Object.values(cols)];
  const params = values.map((_, i) => `$${i + 1}`).join(', ');
  return c.query(
    `INSERT INTO organizations (${keys.join(', ')}, updated_at) VALUES (${params}, now()) RETURNING id`,
    values,
  );
};

describe('migration 20261019000000_task_1_4_setup_invariants', () => {
  it('upgrades a populated previous-version database without rewriting valid organizations', async () => {
    const c = await rawDb();
    await org(c, { gst_status: 'UNREGISTERED' });
    await org(c, {
      gst_status: 'REGISTERED',
      gstin: '27AAPFU0939F1ZV',
      pan: 'AAPFU0939F',
      state_code: '27',
    });
    await c.query(m4);
    expect((await c.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n).toBe(2);
  });

  it('aborts atomically, leaving the database unchanged, if an existing organization violates a rule', async () => {
    const c = await rawDb();
    await org(c, { gst_status: 'UNREGISTERED', gstin: '27AAPFU0939F1ZV' }); // unregistered but has a GSTIN
    await expect(c.query(m4)).rejects.toThrow(/organizations_gst_status_gstin_chk/);
    expect(
      (
        await c.query(
          `SELECT 1 FROM pg_trigger WHERE tgname = 'organizations_setup_completed_immutable'`,
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await c.query(`SELECT 1 FROM pg_constraint WHERE conname = 'organizations_pan_form_chk'`))
        .rowCount,
    ).toBe(0);
  });

  it.each([
    ['bad PAN format', { pan: 'AAPFU0939' }, /organizations_pan_form_chk/],
    ['lower-case PAN', { pan: 'aapfu0939f' }, /organizations_pan_form_chk/],
    [
      'bad GSTIN format',
      { gst_status: 'REGISTERED', gstin: '27AAPFU0939F1XV' },
      /organizations_gstin_form_chk/,
    ],
    ['bad state code', { state_code: '7' }, /organizations_state_code_form_chk/],
    [
      'registered without GSTIN',
      { gst_status: 'REGISTERED' },
      /organizations_gst_status_gstin_chk/,
    ],
    [
      'unregistered with GSTIN',
      { gst_status: 'UNREGISTERED', gstin: '27AAPFU0939F1ZV' },
      /organizations_gst_status_gstin_chk/,
    ],
    [
      'GSTIN of another state',
      { gst_status: 'REGISTERED', gstin: '27AAPFU0939F1ZV', state_code: '07' },
      /organizations_gstin_state_chk/,
    ],
    [
      'GSTIN embedding another PAN',
      { gst_status: 'REGISTERED', gstin: '27AAPFU0939F1ZV', pan: 'ABCDE1234F', state_code: '27' },
      /organizations_gstin_pan_chk/,
    ],
  ])('enforces the rule at the database: %s', async (_name, cols, message) => {
    const c = await rawDb();
    await c.query(m4);
    await expect(org(c, cols as Record<string, string>)).rejects.toThrow(message);
  });

  it('allows the valid combinations (unregistered with no GSTIN, composition with or without one)', async () => {
    const c = await rawDb();
    await c.query(m4);
    await expect(org(c, { gst_status: 'UNREGISTERED' })).resolves.toBeTruthy();
    await expect(org(c, { gst_status: 'COMPOSITION' })).resolves.toBeTruthy();
    await expect(
      org(c, {
        gst_status: 'COMPOSITION',
        gstin: '27AAPFU0939F1ZV',
        pan: 'AAPFU0939F',
        state_code: '27',
      }),
    ).resolves.toBeTruthy();
  });

  it('setup_completed_at can be set once, then never cleared or changed; other columns stay editable', async () => {
    const c = await rawDb();
    await c.query(m4);
    const id = (await org(c, {})).rows[0].id;
    await c.query(
      `UPDATE organizations SET setup_completed_at = '2026-10-19T00:00:00Z' WHERE id = $1`,
      [id],
    );
    await expect(
      c.query(`UPDATE organizations SET setup_completed_at = NULL WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      c.query(
        `UPDATE organizations SET setup_completed_at = '2027-01-01T00:00:00Z' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/immutable/);
    await c.query(`UPDATE organizations SET trade_name = 'Renamed' WHERE id = $1`, [id]);
    await c.query(
      `UPDATE organizations SET setup_completed_at = setup_completed_at WHERE id = $1`,
      [id],
    ); // no change is fine
    expect(
      (await c.query(`SELECT trade_name FROM organizations WHERE id = $1`, [id])).rows[0]
        .trade_name,
    ).toBe('Renamed');
  });

  it('is forward-only: applying it twice fails instead of silently changing data', async () => {
    const c = await rawDb();
    await c.query(m4);
    await expect(c.query(m4)).rejects.toThrow(/already exists/);
  });
});
