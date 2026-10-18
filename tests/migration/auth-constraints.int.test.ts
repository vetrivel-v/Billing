import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';

const dir = resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');
const sql = (name: string) => readFileSync(resolve(dir, name, 'migration.sql'), 'utf8');
const m1 = sql('20261016000000_phase0_foundation');
const m2 = sql('20261017000000_task_1_1_tax_reference_markers');
const m3 = sql('20261018000000_task_1_3_auth_constraints');

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

async function org(c: pg.Client, label: string): Promise<string> {
  return (
    await c.query(
      `INSERT INTO organizations (legal_name, updated_at) VALUES ($1, now()) RETURNING id`,
      [label],
    )
  ).rows[0].id;
}

const user = (c: pg.Client, orgId: string, username: string) =>
  c.query(
    `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at)
     VALUES ($1, $2, 'x', '$argon2id$placeholder', now()) RETURNING id`,
    [orgId, username],
  );

describe('migration 20261018000000_task_1_3_auth_constraints', () => {
  it('upgrades a populated previous-version database and folds usernames to canonical form', async () => {
    const c = await rawDb();
    await c.query(m1);
    await c.query(m2);
    const o = await org(c, 'DEMO Mig3 Co (fictional)');
    await user(c, o, '  Admin.User ');
    await user(c, o, 'billing.clerk');
    await c.query(m3);
    const names = (await c.query(`SELECT username FROM users ORDER BY username`)).rows.map(
      (r) => r.username,
    );
    expect(names).toEqual(['admin.user', 'billing.clerk']);
  });

  it('aborts atomically, changing nothing, if folding would create a duplicate', async () => {
    const c = await rawDb();
    await c.query(m1);
    await c.query(m2);
    const o = await org(c, 'DEMO Mig3b Co (fictional)');
    await user(c, o, 'Bob.Smith');
    await user(c, o, 'bob.smith ');
    await expect(c.query(m3)).rejects.toThrow(/duplicate key|users_organization_id_username_key/);
    const names = (await c.query(`SELECT username FROM users ORDER BY username`)).rows.map(
      (r) => r.username,
    );
    expect(names).toEqual(['Bob.Smith', 'bob.smith ']); // original data untouched
    const triggers = (await c.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'users_no_delete'`))
      .rowCount;
    expect(triggers).toBe(0); // nothing from the failed migration was applied
  });

  it('enforces canonical usernames, session-token hash shape, expiry order, and no user deletion', async () => {
    const c = await rawDb();
    await c.query(m1);
    await c.query(m2);
    await c.query(m3);
    const o = await org(c, 'DEMO Mig3c Co (fictional)');
    await expect(user(c, o, 'UPPER.case')).rejects.toThrow(/users_username_form_chk/);
    await expect(user(c, o, ' spaced ')).rejects.toThrow(/users_username_form_chk/);
    await expect(user(c, o, 'ab')).rejects.toThrow(/users_username_form_chk/);
    await expect(user(c, o, 'x'.repeat(65))).rejects.toThrow(/users_username_form_chk/);
    const id = (await user(c, o, 'valid.user')).rows[0].id;

    const session = (hash: string, expires: string) =>
      c.query(
        `INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES ($1, $2, now(), ${expires})`,
        [id, hash],
      );
    await expect(
      session('raw-token-43-chars-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', `now() + interval '1 hour'`),
    ).rejects.toThrow(/sessions_token_hash_form_chk/);
    await expect(session('A'.repeat(64), `now() + interval '1 hour'`)).rejects.toThrow(
      /sessions_token_hash_form_chk/,
    ); // upper-case hex
    await expect(session('a'.repeat(64), `now() - interval '1 hour'`)).rejects.toThrow(
      /sessions_expiry_chk/,
    );
    await expect(session('a'.repeat(64), `now() + interval '1 hour'`)).resolves.toBeTruthy();

    await expect(c.query(`DELETE FROM users WHERE id = $1`, [id])).rejects.toThrow(
      /users cannot be deleted/,
    );
    expect((await c.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(1);
  });

  it('is forward-only: applying it twice fails instead of silently changing data', async () => {
    const c = await rawDb();
    await c.query(m1);
    await c.query(m2);
    await c.query(m3);
    await expect(c.query(m3)).rejects.toThrow(/already exists/);
  });
});
