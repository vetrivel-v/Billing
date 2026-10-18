import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../apps/api/src/auth-guard.js';
import { PERMISSIONS, ROLE_TEMPLATES } from '../../prisma/seed/reference/index.js';
import { call, createFixture, createRoleUsers, type Fixture } from './auth-fixture.js';

let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;

const path = (key: string) => `/test-only/can/${key}`;

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  app = await fx.makeApp();
  // Test-only protected routes (not part of the product): one per catalogue permission, guarded by the
  // real requirePermission hook, so HTTP status codes prove the server-side decision.
  for (const { key } of PERMISSIONS) {
    app.get(path(key), { preHandler: requirePermission(key) }, async (req) => ({
      allowed: key,
      by: req.auth!.username,
    }));
  }
  app.get(
    '/test-only/unknown-key',
    { preHandler: requirePermission('nonexistent.permission.key') },
    async () => ({ ok: true }),
  );
  tokens = await createRoleUsers(app, fx.orgId);
}, 120_000);
afterAll(async () => fx?.close());

describe('401 versus 403', () => {
  it('401 AUTH_0001 when there is no valid identity (no token, bad token)', async () => {
    for (const token of [undefined, 'A'.repeat(43), 'garbage']) {
      const r = await call(app, 'GET', path('customer.read'), { token });
      expect(r.status).toBe(401);
      expect(r.json.error.code).toBe('AUTH_0001');
    }
  });

  it('403 AUTH_0002 when a valid user lacks the permission - a different code and status', async () => {
    const r = await call(app, 'GET', path('security.user.manage'), {
      token: tokens['Viewer/Auditor']!,
    });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('AUTH_0002');
    expect(r.json.error.dataSaved).toBe(false);
    expect(r.body).not.toContain('security.user.manage'); // the response does not reveal which key was required
  });

  it('the launch secret is a separate layer: a valid session without it still gets 401', async () => {
    const r = await call(app, 'GET', path('customer.read'), {
      token: tokens['Administrator']!,
      launch: false,
    });
    expect(r.status).toBe(401);
  });
});

describe('role matrix enforced over HTTP, by stable permission key', () => {
  for (const template of ROLE_TEMPLATES) {
    it(`${template.name}: allowed exactly on its ${template.grants.length} granted permissions, 403 on the rest`, async () => {
      const granted = new Set(template.grants);
      const wrong: string[] = [];
      for (const { key } of PERMISSIONS) {
        const r = await call(app, 'GET', path(key), { token: tokens[template.name]! });
        const expected = granted.has(key) ? 200 : 403;
        if (r.status !== expected) wrong.push(`${key}: expected ${expected}, got ${r.status}`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it('Administrator obtains every permission defined by the reference catalogue', async () => {
    const me = await call(app, 'GET', '/auth/me', { token: tokens['Administrator']! });
    expect([...me.json.permissions].sort()).toEqual(PERMISSIONS.map((p) => p.key).sort());
  });

  it('Warehouse Operator is denied cost, margin, valuation and accounting over HTTP', async () => {
    for (const key of [
      'product.cost.read',
      'product.margin.read',
      'inventory.valuation.read',
      'report.financial.read',
      'accounting.ledger.read',
      'accounting.journal.post',
      'purchase.read',
      'expense.read',
    ]) {
      expect(
        (await call(app, 'GET', path(key), { token: tokens['Warehouse Operator']! })).status,
        key,
      ).toBe(403);
    }
    expect(
      (await call(app, 'GET', path('inventory.pick'), { token: tokens['Warehouse Operator']! }))
        .status,
    ).toBe(200);
  });

  it('Billing Operator is denied period unlock, posted-document deletion and integration credentials', async () => {
    for (const key of [
      'accounting.period.unlock',
      'sales.document.delete_posted',
      'integration.credentials.manage',
    ]) {
      expect(
        (await call(app, 'GET', path(key), { token: tokens['Billing Operator']! })).status,
        key,
      ).toBe(403);
    }
    expect(
      (await call(app, 'GET', path('sales.invoice.post'), { token: tokens['Billing Operator']! }))
        .status,
    ).toBe(200);
  });

  it('Viewer/Auditor gets no write, admin or export capability - the server refuses, not the UI', async () => {
    for (const p of PERMISSIONS.filter((x) => x.kind !== 'read')) {
      expect(
        (await call(app, 'GET', path(p.key), { token: tokens['Viewer/Auditor']! })).status,
        p.key,
      ).toBe(403);
    }
    expect(
      (await call(app, 'GET', path('sales.invoice.read'), { token: tokens['Viewer/Auditor']! }))
        .status,
    ).toBe(200);
  });

  it('Accountant is denied every security.* permission, and period unlock', async () => {
    for (const p of PERMISSIONS.filter(
      (x) => x.key.startsWith('security.') || x.key === 'accounting.period.unlock',
    )) {
      expect(
        (await call(app, 'GET', path(p.key), { token: tokens['Accountant']! })).status,
        p.key,
      ).toBe(403);
    }
    expect(
      (await call(app, 'GET', path('accounting.journal.post'), { token: tokens['Accountant']! }))
        .status,
    ).toBe(200);
  });
});

describe('no hidden administrator bypass', () => {
  it('an unknown permission key is denied even to the Administrator', async () => {
    const r = await call(app, 'GET', '/test-only/unknown-key', { token: tokens['Administrator']! });
    expect(r.status).toBe(403);
  });

  it('removing a grant from the Administrator role denies that permission immediately', async () => {
    const own = await createFixture(inject('pgAdminUrl'));
    try {
      const a = await own.makeApp();
      a.get(
        path('tax.config.update'),
        { preHandler: requirePermission('tax.config.update') },
        async () => ({ ok: true }),
      );
      const t = await createRoleUsers(a, own.orgId);
      expect(
        (await call(a, 'GET', path('tax.config.update'), { token: t['Administrator']! })).status,
      ).toBe(200);
      await own.prisma.rolePermission.deleteMany({
        where: { role: { name: 'Administrator' }, permission: { key: 'tax.config.update' } },
      });
      expect(
        (await call(a, 'GET', path('tax.config.update'), { token: t['Administrator']! })).status,
      ).toBe(403);
    } finally {
      await own.close();
    }
  });
});

describe('permissions are resolved from the database on every request', () => {
  it('removing a role from a user takes effect on their existing session', async () => {
    const own = await createFixture(inject('pgAdminUrl'));
    try {
      const a = await own.makeApp();
      a.get(
        path('customer.write'),
        { preHandler: requirePermission('customer.write') },
        async () => ({ ok: true }),
      );
      const t = await createRoleUsers(a, own.orgId);
      expect(
        (await call(a, 'GET', path('customer.write'), { token: t['Billing Operator']! })).status,
      ).toBe(200);
      await own.prisma.userRole.deleteMany({ where: { user: { username: 'billing.user' } } });
      expect(
        (await call(a, 'GET', path('customer.write'), { token: t['Billing Operator']! })).status,
      ).toBe(403);
    } finally {
      await own.close();
    }
  });

  it('a role in another organization never grants permissions (organization isolation)', async () => {
    const own = await createFixture(inject('pgAdminUrl'));
    try {
      const a = await own.makeApp();
      a.get(
        path('security.user.manage'),
        { preHandler: requirePermission('security.user.manage') },
        async () => ({ ok: true }),
      );
      const t = await createRoleUsers(a, own.orgId);
      // A second organization with its own Administrator role.
      const other = await own.prisma.organization.create({
        data: { legalName: 'DEMO Other Co (fictional)' },
      });
      const foreignRole = await own.prisma.role.create({
        data: { organizationId: other.id, name: 'Administrator' },
      });
      const perm = await own.prisma.permission.findUniqueOrThrow({
        where: { key: 'security.user.manage' },
      });
      await own.prisma.rolePermission.create({
        data: { roleId: foreignRole.id, permissionId: perm.id },
      });
      // Attach that foreign role to a Viewer in the first organization (mis-assignment).
      const viewer = await own.prisma.user.findFirstOrThrow({ where: { username: 'viewer.user' } });
      await own.prisma.userRole.create({ data: { userId: viewer.id, roleId: foreignRole.id } });
      expect(
        (await call(a, 'GET', path('security.user.manage'), { token: t['Viewer/Auditor']! }))
          .status,
      ).toBe(403);
    } finally {
      await own.close();
    }
  });
});

describe('guard configuration safety', () => {
  it('rejects malformed permission keys at registration time', () => {
    expect(() => requirePermission('Customer Read')).toThrow(/Invalid permission key/);
    expect(() => requirePermission('')).toThrow();
    expect(() => requirePermission('nodots')).toThrow();
  });

  it('answers 503 (not 200) from a guard when the API has no database', async () => {
    const { buildApp } = await import('../../apps/api/src/app.js');
    const bare = await buildApp({
      env: { LOG_LEVEL: 'silent', WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    });
    bare.get('/guarded', { preHandler: requirePermission('customer.read') }, async () => ({
      ok: true,
    }));
    const r = await bare.inject({
      method: 'GET',
      url: '/guarded',
      headers: { authorization: `Bearer ${'A'.repeat(43)}` },
    });
    expect(r.statusCode).toBe(503);
    await bare.close();
  });
});
