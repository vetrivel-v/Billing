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
].map(sql);
const m6 = sql('20261021000000_task_1_6_security_admin_invariant');

const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  // Last in, first out: extra clients are closed before their database is dropped.
  for (const f of cleanup.reverse()) await f();
});

function clientFor(name: string) {
  const u = new URL(inject('pgAdminUrl'));
  u.pathname = `/${name}`;
  return new pg.Client({ connectionString: u.toString() });
}

async function rawDb(applyNew = true) {
  const adminUrl = inject('pgAdminUrl');
  const name = `cb_mig_${Math.random().toString(16).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const c = clientFor(name);
  await c.connect();
  cleanup.push(async () => {
    await c.end();
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await a.end();
  });
  for (const m of previous) await c.query(m);
  if (applyNew) await c.query(m6);
  return {
    c,
    name,
    connect: async () => {
      const x = clientFor(name);
      x.on('error', () => undefined);
      await x.connect();
      cleanup.push(() => x.end());
      return x;
    },
  };
}

interface World {
  org: string;
  adminRole: string;
  userOnlyRole: string;
  admins: string[];
  userKeyId: string;
  roleKeyId: string;
}

/** An organization with two roles and `adminCount` users holding the full administrator role. */
async function world(
  c: pg.Client,
  opts: { completed?: boolean; adminCount?: number } = {},
): Promise<World> {
  const { completed = true, adminCount = 2 } = opts;
  const one = async (q: string, p: unknown[] = []) => (await c.query(q, p)).rows[0].id as string;
  const userKeyId =
    (await c.query(`SELECT id FROM permissions WHERE key = 'security.user.manage'`)).rows[0]?.id ??
    (await one(`INSERT INTO permissions (key) VALUES ('security.user.manage') RETURNING id`));
  const roleKeyId =
    (await c.query(`SELECT id FROM permissions WHERE key = 'security.role.manage'`)).rows[0]?.id ??
    (await one(`INSERT INTO permissions (key) VALUES ('security.role.manage') RETURNING id`));
  const org = await one(
    `INSERT INTO organizations (legal_name, updated_at) VALUES ('DEMO Mig6 Co (fictional)', now()) RETURNING id`,
  );
  const adminRole = await one(
    `INSERT INTO roles (organization_id, name, updated_at) VALUES ($1, 'Administrator', now()) RETURNING id`,
    [org],
  );
  const userOnlyRole = await one(
    `INSERT INTO roles (organization_id, name, updated_at) VALUES ($1, 'User Manager', now()) RETURNING id`,
    [org],
  );
  await c.query(
    `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2), ($1, $3), ($4, $2)`,
    [adminRole, userKeyId, roleKeyId, userOnlyRole],
  );
  const admins: string[] = [];
  for (let i = 0; i < adminCount; i++) {
    const id = await one(
      `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at)
       VALUES ($1, $2, 'x', '$argon2id$placeholder', now()) RETURNING id`,
      [org, `admin.${i}.${Math.random().toString(16).slice(2, 6)}`],
    );
    await c.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [id, adminRole]);
    admins.push(id);
  }
  if (completed)
    await c.query(`UPDATE organizations SET setup_completed_at = now() WHERE id = $1`, [org]);
  return { org, adminRole, userOnlyRole, admins, userKeyId, roleKeyId };
}

const count = async (c: pg.Client, org: string) =>
  (await c.query(`SELECT organization_security_admin_count($1) AS n`, [org])).rows[0].n as number;

describe('migration 20261021000000_task_1_6_security_admin_invariant', () => {
  it('upgrades a populated previous-version database without touching its data', async () => {
    const { c } = await rawDb(false);
    const w = await world(c);
    await c.query(m6);
    expect(await count(c, w.org)).toBe(2);
    expect((await c.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(2);
  });

  it('counts only ACTIVE users who hold BOTH keys through roles of the same organization', async () => {
    const { c } = await rawDb();
    const w = await world(c, { adminCount: 1, completed: false }); // exempt org: lets us deactivate its only admin below
    expect(await count(c, w.org)).toBe(1);
    // A user with only security.user.manage is not an administrator.
    const partial = (
      await c.query(
        `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at) VALUES ($1, 'partial.user', 'x', 'h', now()) RETURNING id`,
        [w.org],
      )
    ).rows[0].id;
    await c.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [
      partial,
      w.userOnlyRole,
    ]);
    expect(await count(c, w.org)).toBe(1);
    // A role from ANOTHER organization named "Administrator" does not count for this one.
    const other = await world(c, { adminCount: 0, completed: false });
    await c.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [
      partial,
      other.adminRole,
    ]);
    expect(await count(c, w.org)).toBe(1);
    // An inactive user is not counted.
    await c.query(`UPDATE users SET is_active = false WHERE id = $1`, [w.admins[0]]);
    expect(await count(c, w.org)).toBe(0);
  });

  it('refuses to disable the last usable administrator, leaving the state unchanged', async () => {
    const { c } = await rawDb();
    const w = await world(c, { adminCount: 2 });
    await c.query(`UPDATE users SET is_active = false WHERE id = $1`, [w.admins[0]]); // one of two: allowed
    await expect(
      c.query(`UPDATE users SET is_active = false WHERE id = $1`, [w.admins[1]]),
    ).rejects.toThrow(/must keep at least one active user/);
    expect(
      (await c.query(`SELECT is_active FROM users WHERE id = $1`, [w.admins[1]])).rows[0].is_active,
    ).toBe(true);
    expect(await count(c, w.org)).toBe(1);
  });

  it('refuses every other path that would leave an organization without an administrator', async () => {
    const { c } = await rawDb();
    const w = await world(c, { adminCount: 1 });
    const admin = w.admins[0]!;
    const state = async () => ({
      n: await count(c, w.org),
      roles: (
        await c.query(`SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1`, [admin])
      ).rows[0].n,
      grants: (
        await c.query(`SELECT count(*)::int AS n FROM role_permissions WHERE role_id = $1`, [
          w.adminRole,
        ])
      ).rows[0].n,
    });
    const before = await state();
    const fail = async (q: string, p: unknown[] = []) =>
      expect(c.query(q, p)).rejects.toThrow(/must keep at least one active user/);

    await fail(`DELETE FROM user_roles WHERE user_id = $1`, [admin]); // remove the role assignment
    await fail(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2`, [
      w.adminRole,
      w.roleKeyId,
    ]); // strip the capability
    await fail(`DELETE FROM role_permissions WHERE role_id = $1`, [w.adminRole]);
    await fail(`UPDATE user_roles SET role_id = $2 WHERE user_id = $1`, [admin, w.userOnlyRole]); // swap to a weaker role
    await fail(`UPDATE permissions SET key = 'security.role.renamed' WHERE id = $1`, [w.roleKeyId]); // rename the capability away
    const otherOrg = await world(c, { adminCount: 0, completed: false });
    await fail(`UPDATE users SET organization_id = $2 WHERE id = $1`, [admin, otherOrg.org]); // move the administrator away
    await fail(
      `UPDATE roles SET organization_id = $2, name = 'Moved Administrator' WHERE id = $1`,
      [w.adminRole, otherOrg.org],
    );
    expect(await state()).toEqual(before); // nothing changed
  });

  it('is checked at commit, so a multi-statement swap that keeps an administrator succeeds', async () => {
    const { c } = await rawDb();
    const w = await world(c, { adminCount: 1 });
    const replacement = (
      await c.query(
        `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at) VALUES ($1, 'replacement.admin', 'x', 'h', now()) RETURNING id`,
        [w.org],
      )
    ).rows[0].id;
    await c.query('BEGIN');
    await c.query(`DELETE FROM user_roles WHERE user_id = $1`, [w.admins[0]]); // momentarily zero administrators...
    await c.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [
      replacement,
      w.adminRole,
    ]); // ...fixed before commit
    await c.query('COMMIT');
    expect(await count(c, w.org)).toBe(1);
    // The same swap WITHOUT the replacement is rejected at COMMIT and rolls back entirely.
    await c.query('BEGIN');
    await c.query(`DELETE FROM user_roles WHERE user_id = $1`, [replacement]);
    await expect(c.query('COMMIT')).rejects.toThrow(/must keep at least one active user/);
    expect(await count(c, w.org)).toBe(1);
  });

  it('applies per organization: another organization is unaffected, and an incomplete setup is exempt', async () => {
    const { c } = await rawDb();
    const a = await world(c, { adminCount: 1 });
    const b = await world(c, { adminCount: 1 });
    await expect(
      c.query(`UPDATE users SET is_active = false WHERE id = $1`, [a.admins[0]]),
    ).rejects.toThrow();
    expect(await count(c, b.org)).toBe(1); // B untouched
    const draft = await world(c, { adminCount: 1, completed: false });
    await c.query(`UPDATE users SET is_active = false WHERE id = $1`, [draft.admins[0]]); // exempt: setup not completed
    expect(await count(c, draft.org)).toBe(0);
  });

  it('two concurrent transactions that each remove a DIFFERENT administrator cannot both commit', async () => {
    const { c, connect } = await rawDb();
    const w = await world(c, { adminCount: 2 });
    const t1 = await connect();
    const t2 = await connect();
    await t1.query('BEGIN');
    await t2.query('BEGIN');
    await t1.query(`UPDATE users SET is_active = false WHERE id = $1`, [w.admins[0]]);
    await t2.query(`UPDATE users SET is_active = false WHERE id = $1`, [w.admins[1]]);
    // Both changes are pending and each transaction still sees the other administrator as active.
    const results = await Promise.allSettled([t1.query('COMMIT'), t2.query('COMMIT')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await count(c, w.org)).toBe(1); // exactly one administrator remains
  });

  it('is forward-only: applying it twice fails instead of silently changing data', async () => {
    const { c } = await rawDb();
    await expect(c.query(m6)).rejects.toThrow(/already exists/);
  });
});
