import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { seedReference } from '../../prisma/seed/reference/index.js';
import {
  call,
  createFixture,
  createRoleUsers,
  login,
  PASSWORD,
  type ApiJson,
  type Fixture,
} from './auth-fixture.js';

const NEW_PW = 'Velvet anchor orbit 7731';
const TEMP_PW = 'Temporary lantern 4412 mosaic';

let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;
let seq = 0;
const uniq = (p: string) => `${p}.${++seq}`;

interface UserJson {
  id: string;
  username: string;
  isActive: boolean;
  mustChangePassword: boolean;
  roles: { id: string; name: string }[];
}
const userOf = (r: { json: ApiJson }) => r.json.user as unknown as UserJson;

async function mkRole(orgId: string, name: string, keys: string[]) {
  const perms = await fx.prisma.permission.findMany({ where: { key: { in: keys } } });
  expect(perms).toHaveLength(keys.length);
  return fx.prisma.role.create({
    data: {
      organizationId: orgId,
      name,
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
}

async function mkUser(
  a: FastifyInstance,
  orgId: string,
  roleNames: string[],
  password = PASSWORD,
  username = uniq('u'),
) {
  const u = await a.authService!.createUser({
    organizationId: orgId,
    username,
    displayName: `${username} (test)`,
    password,
    roleNames,
  });
  const l = await login(a, username, password);
  return { id: u.id, username, token: l.json.token as string };
}

async function roleId(a: FastifyInstance, token: string, name: string) {
  const r = await call(a, 'GET', '/roles', { token });
  const found = (r.json.roles as { id: string; name: string }[]).find((x) => x.name === name);
  if (!found) throw new Error(`role ${name} not found`);
  return found.id;
}

const auditCount = (action: string, entityId?: string) =>
  fx.prisma.auditLog.count({ where: { action, ...(entityId ? { entityId } : {}) } });

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  app = await fx.makeApp();
  tokens = await createRoleUsers(app, fx.orgId);
}, 120_000);
afterAll(async () => fx?.close());

const ID = '00000000-0000-4000-8000-000000000001';
const routes: { method: 'GET' | 'POST' | 'PUT'; url: string; body?: unknown; key: string }[] = [
  { method: 'GET', url: '/roles', key: 'security.role.read' },
  { method: 'GET', url: '/users', key: 'security.user.read' },
  { method: 'GET', url: `/users/${ID}`, key: 'security.user.read' },
  {
    method: 'POST',
    url: '/users',
    body: { username: 'x.user', displayName: 'X', password: NEW_PW },
    key: 'security.user.manage',
  },
  { method: 'POST', url: `/users/${ID}/disable`, key: 'security.user.manage' },
  { method: 'POST', url: `/users/${ID}/enable`, key: 'security.user.manage' },
  { method: 'PUT', url: `/users/${ID}/roles`, body: { roleIds: [] }, key: 'security.role.manage' },
  {
    method: 'POST',
    url: `/users/${ID}/reset-password`,
    body: { temporaryPassword: TEMP_PW },
    key: 'security.user.reset_password',
  },
];

describe('route boundary: launch secret, 401 vs 403, exact permission', () => {
  it.each(routes)('$method $url: no session is 401, no launch secret is 401', async (r) => {
    const none = await call(app, r.method, r.url, { body: r.body });
    expect(none.status).toBe(401);
    expect(none.json.error.code).toBe('AUTH_0001');
    const noLaunch = await call(app, r.method, r.url, {
      body: r.body,
      token: tokens['Administrator']!,
      launch: false,
    });
    expect(noLaunch.status).toBe(401);
  });

  it.each(routes)('$method $url: a valid session without $key is 403 AUTH_0002', async (r) => {
    for (const role of ['Accountant', 'Billing Operator', 'Warehouse Operator', 'Viewer/Auditor']) {
      const res = await call(app, r.method, r.url, { body: r.body, token: tokens[role]! });
      expect(res.status, `${role} ${r.url}`).toBe(403);
      expect(res.json.error.code).toBe('AUTH_0002');
    }
  });

  it('a custom role holding only the exact key reaches the route (and nothing broader)', async () => {
    for (const r of routes) {
      const name = `Only ${r.key} ${++seq}`;
      await mkRole(fx.orgId, name, [r.key]);
      const u = await mkUser(app, fx.orgId, [name]);
      const res = await call(app, r.method, r.url, { body: r.body, token: u.token });
      expect(res.status, `${r.url}`).not.toBe(403);
      expect(res.status).not.toBe(401);
    }
  });

  it('GET /auth/me needs a session only', async () => {
    expect((await call(app, 'GET', '/auth/me')).status).toBe(401);
    expect((await call(app, 'GET', '/auth/me', { token: tokens['Viewer/Auditor']! })).status).toBe(
      200,
    );
  });

  it('responses are not cacheable and never carry hashes or session material', async () => {
    const r = await call(app, 'GET', '/users', { token: tokens['Administrator']! });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).not.toMatch(/argon2|passwordHash|password_hash|tokenHash|sessionToken/i);
  });
});

describe('reading users and roles', () => {
  it('lists roles of the organization', async () => {
    const r = await call(app, 'GET', '/roles', { token: tokens['Administrator']! });
    expect(r.status).toBe(200);
    const names = (r.json.roles as { name: string }[]).map((x) => x.name);
    expect(names).toEqual(
      expect.arrayContaining(['Administrator', 'Accountant', 'Viewer/Auditor']),
    );
  });

  it('lists users with paging and an active filter, and rejects bad queries', async () => {
    const t = tokens['Administrator']!;
    const all = await call(app, 'GET', '/users?limit=2&offset=0', { token: t });
    expect(all.status).toBe(200);
    expect((all.json.users as unknown[]).length).toBeLessThanOrEqual(2);
    expect(all.json.total as number).toBeGreaterThanOrEqual(5);
    const inactive = await call(app, 'GET', '/users?isActive=false', { token: t });
    expect((inactive.json.users as UserJson[]).every((u) => !u.isActive)).toBe(true);
    for (const q of ['limit=101', 'limit=0', 'offset=-1', 'isActive=maybe']) {
      expect((await call(app, 'GET', `/users?${q}`, { token: t })).status, q).toBe(400);
    }
  });

  it('gets one user; unknown and malformed ids are 404', async () => {
    const t = tokens['Administrator']!;
    const list = await call(app, 'GET', '/users', { token: t });
    const first = (list.json.users as UserJson[])[0]!;
    const one = await call(app, 'GET', `/users/${first.id}`, { token: t });
    expect(one.status).toBe(200);
    expect(userOf(one).id).toBe(first.id);
    expect((await call(app, 'GET', `/users/${ID}`, { token: t })).status).toBe(404);
    expect((await call(app, 'GET', '/users/not-a-uuid', { token: t })).status).toBe(404);
  });
});

describe('creating users', () => {
  it('administrator creates a user: 201, must change password, audited, no secrets returned', async () => {
    const t = tokens['Administrator']!;
    const accountant = await roleId(app, t, 'Accountant');
    const username = uniq('new');
    const r = await call(app, 'POST', '/users', {
      token: t,
      body: {
        username,
        displayName: 'New Person',
        email: 'n@example.test',
        password: NEW_PW,
        roleIds: [accountant],
      },
    });
    expect(r.status).toBe(201);
    const u = userOf(r);
    expect(u.mustChangePassword).toBe(true);
    expect(u.roles.map((x) => x.name)).toEqual(['Accountant']);
    expect(r.body).not.toContain(NEW_PW);
    expect(await auditCount('user.create', u.id)).toBe(1);
    const rows = JSON.stringify(await fx.prisma.auditLog.findMany({ where: { entityId: u.id } }));
    expect(rows).not.toContain(NEW_PW);
    expect(rows).not.toMatch(/argon2/);
  });

  it('rejects duplicates (409), weak passwords (400, value-free), bad usernames and extra fields', async () => {
    const t = tokens['Administrator']!;
    const dup = await call(app, 'POST', '/users', {
      token: t,
      body: { username: 'viewer.user', displayName: 'D', password: NEW_PW },
    });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('BIZ_0001');
    const weak = await call(app, 'POST', '/users', {
      token: t,
      body: { username: uniq('weak'), displayName: 'W', password: 'short' },
    });
    expect(weak.status).toBe(400);
    expect(weak.json.error.problems?.[0]?.rule).toBe('too_short');
    expect(weak.body).not.toContain('"short"');
    const badName = await call(app, 'POST', '/users', {
      token: t,
      body: { username: 'A B', displayName: 'W', password: NEW_PW },
    });
    expect(badName.status).toBe(400);
    for (const extra of [
      { organizationId: fx.orgId },
      { mustChangePassword: false },
      { isActive: true },
    ]) {
      const r = await call(app, 'POST', '/users', {
        token: t,
        body: { username: uniq('x'), displayName: 'E', password: NEW_PW, ...extra },
      });
      expect(r.status).toBe(400);
    }
  });

  it('ESCALATION: user.manage alone cannot assign roles at creation (403), but can create without roles', async () => {
    await mkRole(fx.orgId, 'User Manager Only', ['security.user.manage']);
    const mgr = await mkUser(app, fx.orgId, ['User Manager Only']);
    const viewer = await roleId(app, tokens['Administrator']!, 'Viewer/Auditor');
    // A role INSIDE the caller's own permissions is still refused: the cause is the missing security.role.manage.
    const inside = (
      await fx.prisma.role.findFirstOrThrow({
        where: { organizationId: fx.orgId, name: 'User Manager Only' },
      })
    ).id;
    const insideCount = await fx.prisma.user.count();
    const insideTry = await call(app, 'POST', '/users', {
      token: mgr.token,
      body: { username: uniq('esc'), displayName: 'E', password: NEW_PW, roleIds: [inside] },
    });
    expect(insideTry.status).toBe(403);
    expect(await fx.prisma.user.count()).toBe(insideCount);
    const before = await fx.prisma.user.count();
    const withRoles = await call(app, 'POST', '/users', {
      token: mgr.token,
      body: { username: uniq('esc'), displayName: 'E', password: NEW_PW, roleIds: [viewer] },
    });
    expect(withRoles.status).toBe(403);
    expect(withRoles.json.error.code).toBe('AUTH_0002');
    expect(await fx.prisma.user.count()).toBe(before); // nothing created
    const without = await call(app, 'POST', '/users', {
      token: mgr.token,
      body: { username: uniq('ok'), displayName: 'E', password: NEW_PW, roleIds: [] },
    });
    expect(without.status).toBe(201);
    expect(userOf(without).roles).toEqual([]);
  });

  it('ESCALATION: assigning a role with permissions the caller lacks is 403 and changes nothing', async () => {
    await mkRole(fx.orgId, 'Role Manager Lite', [
      'security.user.manage',
      'security.role.manage',
      'security.role.read',
      'customer.read',
    ]);
    const mgr = await mkUser(app, fx.orgId, ['Role Manager Lite']);
    const admin = await roleId(app, mgr.token, 'Administrator');
    const acct = await roleId(app, mgr.token, 'Accountant');
    const before = await fx.prisma.user.count();
    for (const id of [admin, acct]) {
      const r = await call(app, 'POST', '/users', {
        token: mgr.token,
        body: { username: uniq('esc'), displayName: 'E', password: NEW_PW, roleIds: [id] },
      });
      expect(r.status).toBe(403);
    }
    expect(await fx.prisma.user.count()).toBe(before);
    const viewer = await roleId(app, mgr.token, 'Role Manager Lite');
    const ok = await call(app, 'POST', '/users', {
      token: mgr.token,
      body: { username: uniq('ok'), displayName: 'E', password: NEW_PW, roleIds: [viewer] },
    });
    expect(ok.status).toBe(201); // a role within the caller's own permissions is allowed
  });

  it('unknown role ids are 400 unknown_role and nothing is created', async () => {
    const t = tokens['Administrator']!;
    const before = await fx.prisma.user.count();
    const r = await call(app, 'POST', '/users', {
      token: t,
      body: { username: uniq('ghost'), displayName: 'G', password: NEW_PW, roleIds: [ID] },
    });
    expect(r.status).toBe(400);
    expect(r.json.error.problems).toEqual([{ field: 'roleIds', rule: 'unknown_role' }]);
    expect(await fx.prisma.user.count()).toBe(before);
    expect(
      (
        await call(app, 'POST', '/users', {
          token: t,
          body: { username: uniq('g'), displayName: 'G', password: NEW_PW, roleIds: ['x'] },
        })
      ).status,
    ).toBe(400);
  });
});

describe('changing your own password', () => {
  it('requires a session and a strict body', async () => {
    expect(
      (
        await call(app, 'POST', '/auth/change-password', {
          body: { currentPassword: 'a', newPassword: 'b' },
        })
      ).status,
    ).toBe(401);
    const u = await mkUser(app, fx.orgId, ['Viewer/Auditor']);
    for (const body of [
      {},
      { currentPassword: PASSWORD },
      { currentPassword: PASSWORD, newPassword: NEW_PW, extra: 1 },
    ]) {
      expect(
        (await call(app, 'POST', '/auth/change-password', { token: u.token, body })).status,
      ).toBe(400);
    }
  });

  it('wrong current password: 400 VAL_0001 current_password_incorrect (not 401), nothing changes, audited', async () => {
    const u = await mkUser(app, fx.orgId, ['Viewer/Auditor']);
    const r = await call(app, 'POST', '/auth/change-password', {
      token: u.token,
      body: { currentPassword: 'definitely wrong password', newPassword: NEW_PW },
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('VAL_0001');
    expect(r.json.error.problems).toEqual([
      { field: 'currentPassword', rule: 'current_password_incorrect' },
    ]);
    expect(r.body).not.toContain('definitely wrong');
    expect((await login(app, u.username, PASSWORD)).status).toBe(200); // old password still works
    expect((await call(app, 'GET', '/auth/me', { token: u.token })).status).toBe(200); // session intact
    expect(await auditCount('user.password.change_failed', u.id)).toBe(1);
    expect(await auditCount('user.password.changed', u.id)).toBe(0);
  });

  it('wrong attempts count toward lockout; a locked account cannot change its password or sign in', async () => {
    const u = await mkUser(app, fx.orgId, ['Viewer/Auditor']);
    for (let i = 0; i < 5; i++) {
      const r = await call(app, 'POST', '/auth/change-password', {
        token: u.token,
        body: { currentPassword: `wrong password ${i} xyz`, newPassword: NEW_PW },
      });
      expect(r.status).toBe(400);
    }
    const row = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.failedLoginCount).toBe(5);
    expect(row.lockedUntil).not.toBeNull();
    const correctButLocked = await call(app, 'POST', '/auth/change-password', {
      token: u.token,
      body: { currentPassword: PASSWORD, newPassword: NEW_PW },
    });
    expect(correctButLocked.status).toBe(400);
    expect((await login(app, u.username, PASSWORD)).status).toBe(401);
    expect((await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).toBe(
      row.passwordHash,
    );
  });

  it('applies the password policy and rejects re-using the current password', async () => {
    const u = await mkUser(app, fx.orgId, ['Viewer/Auditor']);
    const weak = await call(app, 'POST', '/auth/change-password', {
      token: u.token,
      body: { currentPassword: PASSWORD, newPassword: 'short' },
    });
    expect(weak.status).toBe(400);
    expect(weak.json.error.problems?.every((p) => p.field === 'newPassword')).toBe(true);
    expect(weak.json.error.problems?.map((p) => p.rule)).toContain('too_short');
    const contains = await call(app, 'POST', '/auth/change-password', {
      token: u.token,
      body: { currentPassword: PASSWORD, newPassword: `${u.username}-extra-long-pass` },
    });
    expect(contains.status).toBe(400);
    const same = await call(app, 'POST', '/auth/change-password', {
      token: u.token,
      body: { currentPassword: PASSWORD, newPassword: PASSWORD },
    });
    expect(same.status).toBe(400);
    expect(same.json.error.problems).toEqual([{ field: 'newPassword', rule: 'same_as_current' }]);
  });

  it('success: 204, Argon2id hash replaced, other sessions revoked, current session kept, audited without secrets', async () => {
    const u = await mkUser(app, fx.orgId, ['Viewer/Auditor']);
    const second = (await login(app, u.username)).json.token as string;
    const third = (await login(app, u.username)).json.token as string;
    const before = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    const r = await call(app, 'POST', '/auth/change-password', {
      token: u.token,
      body: { currentPassword: PASSWORD, newPassword: NEW_PW },
    });
    expect(r.status).toBe(204);
    expect(r.body).toBe('');
    const after = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(after.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect((await call(app, 'GET', '/auth/me', { token: u.token })).status).toBe(200);
    expect((await call(app, 'GET', '/auth/me', { token: second })).status).toBe(401);
    expect((await call(app, 'GET', '/auth/me', { token: third })).status).toBe(401);
    expect((await login(app, u.username, PASSWORD)).status).toBe(401);
    expect((await login(app, u.username, NEW_PW)).status).toBe(200);
    expect(await auditCount('user.password.changed', u.id)).toBe(1);
    const audit = JSON.stringify(await fx.prisma.auditLog.findMany({ where: { entityId: u.id } }));
    for (const secret of [PASSWORD, NEW_PW, after.passwordHash, before.passwordHash]) {
      expect(audit).not.toContain(secret);
    }
  });

  it('is rate limited per route', async () => {
    const limited = await fx.makeApp({ changePasswordRateLimit: { max: 2, timeWindowMs: 60_000 } });
    const u = await mkUser(limited, fx.orgId, ['Viewer/Auditor']);
    const attempt = () =>
      call(limited, 'POST', '/auth/change-password', {
        token: u.token,
        body: { currentPassword: 'wrong wrong wrong 1', newPassword: NEW_PW },
      });
    expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(400);
    const third = await attempt();
    expect(third.status).toBe(429);
    expect(third.json.error.code).toBe('AUTH_0003');
  });
});

describe('forced password change (AUTH_0004)', () => {
  it('a user with a temporary password may only use me, change-password and logout', async () => {
    const t = tokens['Administrator']!;
    const viewer = await roleId(app, t, 'Viewer/Auditor');
    const username = uniq('forced');
    const created = await call(app, 'POST', '/users', {
      token: t,
      body: { username, displayName: 'F', password: TEMP_PW, roleIds: [viewer] },
    });
    expect(created.status).toBe(201);
    const l = await login(app, username, TEMP_PW);
    expect(l.status).toBe(200);
    expect(l.json.mustChangePassword).toBe(true);
    const token = l.json.token as string;

    for (const [m, url] of [
      ['GET', '/users'],
      ['GET', '/roles'],
      ['GET', `/users/${ID}`],
    ] as const) {
      const r = await call(app, m, url, { token });
      expect(r.status, url).toBe(403);
      expect(r.json.error.code).toBe('AUTH_0004');
    }
    expect((await call(app, 'GET', '/auth/me', { token })).status).toBe(200);
    // 401 still comes first for an invalid session
    expect((await call(app, 'GET', '/users', { token: 'A'.repeat(43) })).json.error.code).toBe(
      'AUTH_0001',
    );

    const change = await call(app, 'POST', '/auth/change-password', {
      token,
      body: { currentPassword: TEMP_PW, newPassword: NEW_PW },
    });
    expect(change.status).toBe(204);
    const me = await call(app, 'GET', '/auth/me', { token });
    expect(me.json.mustChangePassword).toBe(false);
    // with the flag cleared the normal 403 (lacking permission) applies instead of AUTH_0004
    expect((await call(app, 'GET', '/users', { token })).json.error.code).toBe('AUTH_0002');
  });

  it('logout stays available while a change is pending', async () => {
    const u = await mkUser(app, fx.orgId, ['Viewer/Auditor']);
    await fx.prisma.user.update({ where: { id: u.id }, data: { mustChangePassword: true } });
    expect((await call(app, 'POST', '/auth/logout', { token: u.token })).status).toBe(204);
  });
});

describe('administrator password reset', () => {
  it('resets another user: 204, temporary password works once, must change, sessions revoked, lockout cleared', async () => {
    const target = await mkUser(app, fx.orgId, ['Accountant']);
    await fx.prisma.user.update({
      where: { id: target.id },
      data: { failedLoginCount: 4 },
    });
    const r = await call(app, 'POST', `/users/${target.id}/reset-password`, {
      token: tokens['Administrator']!,
      body: { temporaryPassword: TEMP_PW },
    });
    expect(r.status).toBe(204);
    expect(r.body).not.toContain(TEMP_PW);
    expect((await call(app, 'GET', '/auth/me', { token: target.token })).status).toBe(401);
    expect((await login(app, target.username, PASSWORD)).status).toBe(401);
    const l = await login(app, target.username, TEMP_PW);
    expect(l.status).toBe(200);
    expect(l.json.mustChangePassword).toBe(true);
    const row = await fx.prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.failedLoginCount).toBe(0);
    expect(await auditCount('user.password.reset', target.id)).toBe(1);
    const audit = JSON.stringify(
      await fx.prisma.auditLog.findMany({ where: { entityId: target.id } }),
    );
    expect(audit).not.toContain(TEMP_PW);
    expect(audit).not.toContain(row.passwordHash);
  });

  it('cannot reset yourself (409), a weak temporary password (400), or a missing one', async () => {
    const t = tokens['Administrator']!;
    const me = await call(app, 'GET', '/auth/me', { token: t });
    const self = await call(app, 'POST', `/users/${me.json.user.id}/reset-password`, {
      token: t,
      body: { temporaryPassword: TEMP_PW },
    });
    expect(self.status).toBe(409);
    const target = await mkUser(app, fx.orgId, ['Viewer/Auditor']);
    const weak = await call(app, 'POST', `/users/${target.id}/reset-password`, {
      token: t,
      body: { temporaryPassword: 'short' },
    });
    expect(weak.status).toBe(400);
    expect(
      (await call(app, 'POST', `/users/${target.id}/reset-password`, { token: t, body: {} }))
        .status,
    ).toBe(400);
    expect((await login(app, target.username, PASSWORD)).status).toBe(200); // untouched
  });

  it('ESCALATION: a reset-only holder cannot take over a more privileged account (403)', async () => {
    await mkRole(fx.orgId, 'Reset Only', ['security.user.reset_password']);
    const helper = await mkUser(app, fx.orgId, ['Reset Only']);
    const adminId = (
      await fx.prisma.user.findFirstOrThrow({
        where: { username: 'admin.user', organizationId: fx.orgId },
      })
    ).id;
    const r = await call(app, 'POST', `/users/${adminId}/reset-password`, {
      token: helper.token,
      body: { temporaryPassword: TEMP_PW },
    });
    expect(r.status).toBe(403);
    expect((await login(app, 'admin.user', PASSWORD)).status).toBe(200); // password unchanged
    const peer = await mkUser(app, fx.orgId, []);
    expect(
      (
        await call(app, 'POST', `/users/${peer.id}/reset-password`, {
          token: helper.token,
          body: { temporaryPassword: TEMP_PW },
        })
      ).status,
    ).toBe(204); // a user with fewer permissions can be reset
  });
});

describe('disable and enable', () => {
  it('disable: revokes every session, blocks login, is idempotent and audited once', async () => {
    const t = tokens['Administrator']!;
    const target = await mkUser(app, fx.orgId, ['Accountant']);
    const second = (await login(app, target.username)).json.token as string;
    const r = await call(app, 'POST', `/users/${target.id}/disable`, { token: t });
    expect(r.status).toBe(200);
    expect(userOf(r).isActive).toBe(false);
    for (const tok of [target.token, second]) {
      expect((await call(app, 'GET', '/auth/me', { token: tok })).status).toBe(401);
    }
    expect((await login(app, target.username)).status).toBe(401);
    const again = await call(app, 'POST', `/users/${target.id}/disable`, { token: t });
    expect(again.status).toBe(200);
    expect(await auditCount('user.disable', target.id)).toBe(1);
  });

  it('enable restores sign-in and clears lockout; idempotent', async () => {
    const t = tokens['Administrator']!;
    const target = await mkUser(app, fx.orgId, ['Accountant']);
    await call(app, 'POST', `/users/${target.id}/disable`, { token: t });
    await fx.prisma.user.update({
      where: { id: target.id },
      data: { failedLoginCount: 5, lockedUntil: new Date(fx.clock.now.getTime() + 600_000) },
    });
    const r = await call(app, 'POST', `/users/${target.id}/enable`, { token: t });
    expect(r.status).toBe(200);
    expect(userOf(r).isActive).toBe(true);
    expect((await login(app, target.username)).status).toBe(200);
    expect((await call(app, 'POST', `/users/${target.id}/enable`, { token: t })).status).toBe(200);
    expect(await auditCount('user.enable', target.id)).toBe(1);
  });

  it('cannot disable yourself (409) and unknown targets are 404', async () => {
    const t = tokens['Administrator']!;
    const me = await call(app, 'GET', '/auth/me', { token: t });
    const r = await call(app, 'POST', `/users/${me.json.user.id}/disable`, { token: t });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BIZ_0001');
    expect((await call(app, 'GET', '/auth/me', { token: t })).status).toBe(200);
    for (const a of ['disable', 'enable']) {
      expect((await call(app, 'POST', `/users/${ID}/${a}`, { token: t })).status).toBe(404);
    }
  });
});

describe('role assignment', () => {
  it("replaces a user's roles, audits before/after, and does not audit a no-op", async () => {
    const t = tokens['Administrator']!;
    const target = await mkUser(app, fx.orgId, ['Viewer/Auditor']);
    const bill = await roleId(app, t, 'Billing Operator');
    const beforePerms = (await call(app, 'GET', '/auth/me', { token: target.token })).json
      .permissions;
    const r = await call(app, 'PUT', `/users/${target.id}/roles`, {
      token: t,
      body: { roleIds: [bill] },
    });
    expect(r.status).toBe(200);
    expect(userOf(r).roles.map((x) => x.name)).toEqual(['Billing Operator']);
    expect(await auditCount('user.roles.changed', target.id)).toBe(1);
    const row = JSON.stringify(
      await fx.prisma.auditLog.findMany({
        where: { action: 'user.roles.changed', entityId: target.id },
      }),
    );
    expect(row).toContain('Viewer/Auditor');
    expect(row).toContain('Billing Operator');
    // permissions follow immediately, without a new login
    const nowPerms = (await call(app, 'GET', '/auth/me', { token: target.token })).json.permissions;
    expect(nowPerms).not.toEqual(beforePerms);
    const same = await call(app, 'PUT', `/users/${target.id}/roles`, {
      token: t,
      body: { roleIds: [bill, bill] },
    });
    expect(same.status).toBe(200);
    expect(await auditCount('user.roles.changed', target.id)).toBe(1);
    const cleared = await call(app, 'PUT', `/users/${target.id}/roles`, {
      token: t,
      body: { roleIds: [] },
    });
    expect(userOf(cleared).roles).toEqual([]);
  });

  it('rejects unknown roles, malformed bodies and unknown users', async () => {
    const t = tokens['Administrator']!;
    const target = await mkUser(app, fx.orgId, ['Viewer/Auditor']);
    const unknown = await call(app, 'PUT', `/users/${target.id}/roles`, {
      token: t,
      body: { roleIds: [ID] },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.problems).toEqual([{ field: 'roleIds', rule: 'unknown_role' }]);
    for (const body of [
      {},
      { roleIds: 'x' },
      { roleIds: ['nope'] },
      { roleIds: [], permissions: ['security.user.manage'] },
    ]) {
      expect((await call(app, 'PUT', `/users/${target.id}/roles`, { token: t, body })).status).toBe(
        400,
      );
    }
    expect(
      (await call(app, 'PUT', `/users/${ID}/roles`, { token: t, body: { roleIds: [] } })).status,
    ).toBe(404);
    expect(
      userOf((await call(app, 'GET', `/users/${target.id}`, { token: t })) as never).roles.map(
        (x) => x.name,
      ),
    ).toEqual(['Viewer/Auditor']);
  });

  it('ESCALATION: callers cannot change their own roles', async () => {
    const t = tokens['Administrator']!;
    const me = (await call(app, 'GET', '/auth/me', { token: t })).json.user.id;
    const viewer = await roleId(app, t, 'Viewer/Auditor');
    const admin = await roleId(app, t, 'Administrator');
    for (const roleIds of [[viewer], [admin], []]) {
      const r = await call(app, 'PUT', `/users/${me}/roles`, { token: t, body: { roleIds } });
      expect(r.status).toBe(403);
    }
    const mine = await call(app, 'GET', `/users/${me}`, { token: t });
    expect(userOf(mine).roles.map((x) => x.name)).toEqual(['Administrator']);
  });

  it('ESCALATION: roles above the caller can be neither granted nor revoked', async () => {
    await mkRole(fx.orgId, 'Role Manager Only', ['security.role.manage', 'security.role.read']);
    const mgr = await mkUser(app, fx.orgId, ['Role Manager Only']);
    const adminId = await roleId(app, mgr.token, 'Administrator');
    const target = await mkUser(app, fx.orgId, ['Viewer/Auditor']);
    const grant = await call(app, 'PUT', `/users/${target.id}/roles`, {
      token: mgr.token,
      body: { roleIds: [adminId] },
    });
    expect(grant.status).toBe(403);
    // another administrator: removing its Administrator role is above the caller too
    const peerAdmin = await mkUser(app, fx.orgId, ['Administrator']);
    const revoke = await call(app, 'PUT', `/users/${peerAdmin.id}/roles`, {
      token: mgr.token,
      body: { roleIds: [] },
    });
    expect(revoke.status).toBe(403);
    const after = await call(app, 'GET', `/users/${peerAdmin.id}`, {
      token: tokens['Administrator']!,
    });
    expect(userOf(after).roles.map((x) => x.name)).toEqual(['Administrator']);
    const targetAfter = await call(app, 'GET', `/users/${target.id}`, {
      token: tokens['Administrator']!,
    });
    expect(userOf(targetAfter).roles.map((x) => x.name)).toEqual(['Viewer/Auditor']);
  });
});

describe('last usable administrator', () => {
  let lx: Fixture;
  let lapp: FastifyInstance;
  beforeAll(async () => {
    lx = await createFixture(inject('pgAdminUrl'));
    lapp = await lx.makeApp();
    // setup is complete, so the database-level invariant applies to this organization
    await lx.prisma.organization.update({
      where: { id: lx.orgId },
      data: { setupCompletedAt: new Date() },
    });
  }, 120_000);
  afterAll(async () => lx?.close());

  async function make(roleNames: string[], extra: string[] = []) {
    if (extra.length) {
      const perms = await lx.prisma.permission.findMany({ where: { key: { in: extra } } });
      await lx.prisma.role.create({
        data: {
          organizationId: lx.orgId,
          name: roleNames[0]!,
          permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
        },
      });
    }
    const username = uniq('la');
    const u = await lapp.authService!.createUser({
      organizationId: lx.orgId,
      username,
      displayName: username,
      password: PASSWORD,
      roleNames,
    });
    const l = await login(lapp, username);
    return { id: u.id, token: l.json.token as string };
  }

  it('disabling the only usable administrator is 409 BIZ_0001 and leaves everything unchanged', async () => {
    const sole = await make(['Administrator']);
    const mgr = await make(['Disable Capable'], ['security.user.manage']);
    const r = await call(lapp, 'POST', `/users/${sole.id}/disable`, { token: mgr.token });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BIZ_0001');
    const row = await lx.prisma.user.findUniqueOrThrow({
      where: { id: sole.id },
      include: { roles: true },
    });
    expect(row.isActive).toBe(true);
    expect(row.roles).toHaveLength(1);
    expect((await call(lapp, 'GET', '/auth/me', { token: sole.token })).status).toBe(200); // session not revoked
    expect(
      await lx.prisma.auditLog.count({ where: { action: 'user.disable', entityId: sole.id } }),
    ).toBe(0);
    // with a second administrator, the same operation is allowed
    const second = await make(['Administrator']);
    expect(
      (await call(lapp, 'POST', `/users/${second.id}/disable`, { token: mgr.token })).status,
    ).toBe(200);
    expect(
      (await call(lapp, 'POST', `/users/${sole.id}/disable`, { token: mgr.token })).status,
    ).toBe(409);
  });

  it('removing the administrator role from the last administrator is refused (DB-level, every path)', async () => {
    const users = await lx.prisma.user.findMany({
      where: {
        organizationId: lx.orgId,
        isActive: true,
        roles: { some: { role: { name: 'Administrator' } } },
      },
    });
    expect(users.length).toBeGreaterThanOrEqual(1);
    const keep = users[0]!;
    for (const other of users.slice(1)) {
      await lx.prisma.user.update({ where: { id: other.id }, data: { isActive: false } });
    }
    await expect(lx.prisma.userRole.deleteMany({ where: { userId: keep.id } })).rejects.toThrow();
    await expect(
      lx.prisma.user.update({ where: { id: keep.id }, data: { isActive: false } }),
    ).rejects.toThrow();
    const row = await lx.prisma.user.findUniqueOrThrow({
      where: { id: keep.id },
      include: { roles: true },
    });
    expect(row.isActive).toBe(true);
    expect(row.roles).toHaveLength(1);
  });

  it('two administrators disabling each other concurrently cannot both succeed', async () => {
    const cx = await createFixture(inject('pgAdminUrl'));
    try {
      const capp = await cx.makeApp();
      await cx.prisma.organization.update({
        where: { id: cx.orgId },
        data: { setupCompletedAt: new Date() },
      });
      const mk = async () => {
        const username = uniq('cc');
        const u = await capp.authService!.createUser({
          organizationId: cx.orgId,
          username,
          displayName: username,
          password: PASSWORD,
          roleNames: ['Administrator'],
        });
        return { id: u.id, token: (await login(capp, username)).json.token as string };
      };
      const a = await mk();
      const b = await mk();
      const results = await Promise.all([
        call(capp, 'POST', `/users/${b.id}/disable`, { token: a.token }),
        call(capp, 'POST', `/users/${a.id}/disable`, { token: b.token }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 200)).toHaveLength(1);
      const active = await cx.prisma.user.count({
        where: { organizationId: cx.orgId, isActive: true },
      });
      expect(active).toBe(1);
    } finally {
      await cx.close();
    }
  });
});

describe('organization isolation', () => {
  let orgB: string;
  let userB: { id: string; username: string };
  let roleB: string;
  let adminA: string;

  beforeAll(async () => {
    const org = await fx.prisma.organization.create({
      data: { legalName: 'DEMO Other Co (fictional)' },
    });
    orgB = org.id;
    await seedReference(fx.prisma, { organizationId: orgB });
    const username = uniq('orgb');
    const u = await app.authService!.createUser({
      organizationId: orgB,
      username,
      displayName: 'B User',
      password: PASSWORD,
      roleNames: ['Accountant'],
    });
    userB = { id: u.id, username };
    roleB = (
      await fx.prisma.role.findFirstOrThrow({ where: { organizationId: orgB, name: 'Accountant' } })
    ).id;
    adminA = tokens['Administrator']!;
  }, 120_000);

  it('does not list or read users and roles of another organization', async () => {
    const users = await call(app, 'GET', '/users?limit=100', { token: adminA });
    expect((users.json.users as UserJson[]).some((u) => u.id === userB.id)).toBe(false);
    expect((await call(app, 'GET', `/users/${userB.id}`, { token: adminA })).status).toBe(404);
    const roles = await call(app, 'GET', '/roles', { token: adminA });
    expect((roles.json.roles as { id: string }[]).some((r) => r.id === roleB)).toBe(false);
  });

  it("cannot modify, disable, enable, reset or re-role another organization's user (404) and nothing changes", async () => {
    const before = await fx.prisma.user.findUniqueOrThrow({
      where: { id: userB.id },
      include: { roles: true },
    });
    const attempts = [
      call(app, 'POST', `/users/${userB.id}/disable`, { token: adminA }),
      call(app, 'POST', `/users/${userB.id}/enable`, { token: adminA }),
      call(app, 'POST', `/users/${userB.id}/reset-password`, {
        token: adminA,
        body: { temporaryPassword: TEMP_PW },
      }),
      call(app, 'PUT', `/users/${userB.id}/roles`, { token: adminA, body: { roleIds: [] } }),
    ];
    for (const r of await Promise.all(attempts)) expect(r.status).toBe(404);
    const after = await fx.prisma.user.findUniqueOrThrow({
      where: { id: userB.id },
      include: { roles: true },
    });
    expect(after.isActive).toBe(before.isActive);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.roles.map((r) => r.roleId)).toEqual(before.roles.map((r) => r.roleId));
  });

  it('ESCALATION: a role from another organization cannot be assigned or used at creation (same 400 as unknown)', async () => {
    const target = await mkUser(app, fx.orgId, ['Viewer/Auditor']);
    const assign = await call(app, 'PUT', `/users/${target.id}/roles`, {
      token: adminA,
      body: { roleIds: [roleB] },
    });
    expect(assign.status).toBe(400);
    expect(assign.json.error.problems).toEqual([{ field: 'roleIds', rule: 'unknown_role' }]);
    const create = await call(app, 'POST', '/users', {
      token: adminA,
      body: { username: uniq('xo'), displayName: 'X', password: NEW_PW, roleIds: [roleB] },
    });
    expect(create.status).toBe(400);
    expect(create.json.error.problems).toEqual([{ field: 'roleIds', rule: 'unknown_role' }]);
    const unknown = await call(app, 'PUT', `/users/${target.id}/roles`, {
      token: adminA,
      body: { roleIds: [ID] },
    });
    expect(unknown.json.error).toEqual({
      ...assign.json.error,
      correlationId: unknown.json.error.correlationId,
    });
  });

  it("a client-supplied organization cannot widen scope: created users always belong to the caller's organization", async () => {
    const r = await call(app, 'POST', '/users', {
      token: adminA,
      body: { username: uniq('scope'), displayName: 'S', password: NEW_PW },
    });
    expect(r.status).toBe(201);
    const row = await fx.prisma.user.findUniqueOrThrow({ where: { id: userOf(r).id } });
    expect(row.organizationId).toBe(fx.orgId);
  });
});

describe('no secrets in audit rows or logs', () => {
  it('audit rows written by Task 1.6 never hold passwords, hashes or tokens', async () => {
    const rows = JSON.stringify(
      await fx.prisma.auditLog.findMany({ where: { action: { startsWith: 'user.' } } }),
    );
    for (const secret of [PASSWORD, NEW_PW, TEMP_PW]) expect(rows).not.toContain(secret);
    expect(rows).not.toMatch(/\$argon2/);
    expect(rows).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });
});
