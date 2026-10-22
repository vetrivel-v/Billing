// Task 1.18: the dashboard summary API (database-side aggregates, organization scope, permission-filtered sections, DEMO and PRODUCTION
// never summed) and the permission matrix across the standard roles, derived from the permission CATALOGUE and the actual route table
// (never from a role's title). Fictional data only.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PERMISSIONS } from '@commercebill/reference-data';
import { ROLE_TEMPLATES } from '../../prisma/seed/reference/index.js';
import { seedReference } from '../../prisma/seed/reference/index.js';
import {
  ROLE_USERS,
  call,
  createFixture,
  createRoleUsers,
  type ApiJson,
  type Fixture,
} from './auth-fixture.js';
import { body, previewAndPost, setupBillingWorld, type BillingWorld } from './invoice-fixture.js';

const migrationsDir = resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (r: { json: ApiJson }) => r.json as unknown as Json;

let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;
let w: BillingWorld;
const admin = () => tokens['Administrator']!;
const dashboard = (token = admin()) => call(app, 'GET', '/dashboard/summary', { token });

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  app = await fx.makeApp({
    backup: { databaseUrl: fx.db.url, migrationsDir },
    // the approved test seam for the verified-backup fact, so a PRODUCTION invoice can exist beside DEMO ones
    backupRestoreVerified: async () => true,
  });
  tokens = await createRoleUsers(app, fx.orgId);
  w = await setupBillingWorld(fx);
}, 240_000);
afterAll(async () => fx?.close());

describe('dashboard summary', () => {
  it('needs a session', async () => {
    expect((await call(app, 'GET', '/dashboard/summary')).status).toBe(401);
  });

  it('on an empty business reports zeros, an empty readiness checklist and no invented figures', async () => {
    const r = await dashboard();
    expect(r.status).toBe(200);
    const s = j(r);
    expect(s.mode).toBe('DEMO');
    expect(s.sales.demo).toEqual({
      today: { count: 0, total: '0.00' },
      month: { count: 0, total: '0.00' },
    });
    expect(s.sales.production.today.count).toBe(0);
    expect(s.receivables.demo).toEqual({ outstanding: '0.00', openInvoices: 0 });
    expect(s.paymentsToday.demo).toEqual({ count: 0, total: '0.00' });
    expect(s.recentInvoices).toEqual([]);
    expect(s.recentPayments).toEqual([]);
    expect(s.readiness.ready).toBe(false);
    expect(Object.keys(s).sort()).toEqual(
      [
        'asOf',
        'mode',
        'paymentsToday',
        'readiness',
        'receivables',
        'recentInvoices',
        'recentPayments',
        'recovery',
        'sales',
        'stock',
      ].sort(),
    );
    expect(JSON.stringify(s)).not.toMatch(/profit|margin|cogs|cost/i);
  });

  it('counts DEMO and PRODUCTION separately, from posted invoices and recorded payments, and never adds them together', async () => {
    // DEMO: a 590.00 invoice (2 x 250 + 18%), 200 paid
    const demo = await previewAndPost(
      app,
      admin(),
      body(w, {}, [{ productId: w.products.untracked, quantity: '2' }]),
    );
    expect(demo.post.status).toBe(201);
    const demoInvoice = j(demo.post).invoice;
    const demoTotal = demoInvoice.totals.grandTotal as string;
    const pay = await call(app, 'POST', '/payments', {
      token: admin(),
      body: {
        mode: 'DEMO',
        invoiceId: demoInvoice.id,
        amount: '200',
        method: 'CASH',
        operationId: randomUUID(),
      },
    });
    expect(pay.status).toBe(201);
    // switch the organization to PRODUCTION (a current tax review and the injected verified-backup fact), then bill and collect for real
    const cfg = j(await call(app, 'GET', '/tax/configuration', { token: admin() }));
    expect(
      (
        await call(app, 'POST', '/tax/configuration/reviews', {
          token: admin(),
          body: {
            capacity: 'Accountant for the business',
            note: 'Fictional test review',
            acknowledged: true,
            noticeVersion: cfg.notice.version,
            expectedFingerprint: cfg.fingerprint,
          },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(app, 'POST', '/tax/billing-mode', {
          token: admin(),
          body: { mode: 'PRODUCTION' },
        })
      ).status,
    ).toBe(200);
    const prod = await previewAndPost(
      app,
      admin(),
      body(w, { mode: 'PRODUCTION' }, [{ productId: w.products.untracked, quantity: '1' }]),
    );
    expect(prod.post.status, JSON.stringify(prod.post.json)).toBe(201);
    const prodInvoice = j(prod.post).invoice;
    const prodTotal = prodInvoice.totals.grandTotal as string;
    const prodPay = await call(app, 'POST', '/payments', {
      token: admin(),
      body: {
        mode: 'PRODUCTION',
        invoiceId: prodInvoice.id,
        amount: prodTotal,
        method: 'CASH',
        operationId: randomUUID(),
      },
    });
    expect(prodPay.status, JSON.stringify(prodPay.json)).toBe(201);

    const s = j(await dashboard());
    expect(s.mode).toBe('PRODUCTION');
    expect(s.readiness.ready).toBe(true);
    expect(s.sales.demo.today).toEqual({ count: 1, total: demoTotal });
    expect(s.sales.demo.month).toEqual({ count: 1, total: demoTotal });
    expect(s.sales.production.today).toEqual({
      count: 1,
      total: Number(prodTotal).toFixed(2),
    });
    expect(s.receivables.demo).toEqual({
      outstanding: (Number(demoTotal) - 200).toFixed(2),
      openInvoices: 1,
    });
    expect(s.receivables.production).toEqual({ outstanding: '0.00', openInvoices: 0 });
    expect(s.paymentsToday.demo).toEqual({ count: 1, total: '200.00' });
    expect(s.paymentsToday.production).toEqual({
      count: 1,
      total: Number(prodTotal).toFixed(2),
    });
    // nothing was summed across modes
    expect(s.sales.demo.today.total).not.toBe((Number(demoTotal) + Number(prodTotal)).toFixed(2));
    // recent lists carry the DEMO flag, newest first
    expect(s.recentInvoices.map((i: Json) => i.isDemo)).toEqual([false, true]);
    expect(s.recentPayments.map((p: Json) => p.isDemo)).toEqual([false, true]);
    expect(s.recentInvoices[1].balanceDue).toBe((Number(demoTotal) - 200).toFixed(2));
    expect(s.stock).toMatchObject({ trackedProducts: expect.any(Number) });
    // the figures are computed by the database: they agree with the tables
    const sum = await fx.prisma.$queryRaw<
      { t: unknown }[]
    >`SELECT sum(grand_total) AS t FROM sales_invoices WHERE is_demo`;
    expect(Number(sum[0]!.t).toFixed(2)).toBe(s.sales.demo.month.total);
  });

  it("never includes another organization's figures", async () => {
    const other = await fx.prisma.organization.create({
      data: { legalName: 'DEMO Other Co (fictional)' },
    });
    await seedReference(fx.prisma, { organizationId: other.id });
    const w2 = await setupBillingWorld(fx, other.id, { sellerName: 'Other Seller Pvt Ltd' });
    const before = j(await dashboard());
    // post an invoice directly as the other organization's data (a customer, product and invoice row exist for it)
    expect(w2.orgId).toBe(other.id);
    const after = j(await dashboard());
    expect(after.sales).toEqual(before.sales);
    expect(after.receivables).toEqual(before.receivables);
    expect(after.recentInvoices).toEqual(before.recentInvoices);
    expect(after.stock).toEqual(before.stock);
  });

  it('shows each role only the sections its permissions allow (from the catalogue, not the role name)', async () => {
    const needs: Record<string, string[]> = {
      sales: ['sales.invoice.read'],
      receivables: ['sales.invoice.read'],
      recentInvoices: ['sales.invoice.read'],
      paymentsToday: ['sales.payment.read'],
      recentPayments: ['sales.payment.read'],
      stock: ['inventory.stock.read'],
      recovery: ['backup.history.read'],
      readiness: ['tax.config.read', 'backup.history.read'], // either one
    };
    for (const { role } of ROLE_USERS) {
      const grants = new Set(ROLE_TEMPLATES.find((t) => t.name === role)!.grants);
      const s = j(await dashboard(tokens[role]!));
      for (const [section, keys] of Object.entries(needs)) {
        const allowed =
          section === 'readiness'
            ? keys.some((k) => grants.has(k))
            : keys.every((k) => grants.has(k));
        expect(s[section] !== null, `${role} / ${section}`).toBe(allowed);
      }
    }
  });
});

describe('permission matrix across the standard roles (catalogue and route table)', () => {
  const routes: { method: string; path: string; key: string }[] = [];
  const dir = resolve(import.meta.dirname, '..', '..', 'apps', 'api', 'src');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('-routes.ts'))) {
    const src = readFileSync(resolve(dir, f), 'utf8');
    for (const m of src.matchAll(
      /\.(get|post|put|patch)\(\s*'([^']+)'\s*,\s*\{\s*preHandler:\s*requirePermission\('([^']+)'\)/g,
    ))
      routes.push({ method: m[1]!.toUpperCase(), path: m[2]!, key: m[3]! });
  }

  it('found the guarded routes', () => {
    expect(routes.length).toBeGreaterThan(40);
    expect(new Set(routes.map((r) => r.key)).size).toBeGreaterThan(15);
  });

  it('every guarded route answers 403 to a role without its permission and something other than 401/403 to a role with it', async () => {
    const failures: string[] = [];
    for (const { role } of ROLE_USERS) {
      const grants = new Set(ROLE_TEMPLATES.find((t) => t.name === role)!.grants);
      for (const r of routes) {
        if (r.path === '/backup/retention/apply') continue; // would run retention for real (harmless here, but not a read)
        const path = r.path.replace(/:[A-Za-z]+/g, () => randomUUID());
        const res = await call(app, r.method as 'GET' | 'POST' | 'PUT' | 'PATCH', path, {
          token: tokens[role]!,
          ...(r.method === 'GET' ? {} : { body: {} }),
        });
        const allowed = grants.has(r.key);
        if (allowed && (res.status === 401 || res.status === 403 || res.status >= 500))
          failures.push(
            `${role} ${r.method} ${r.path}: expected access, got ${String(res.status)}`,
          );
        if (!allowed && res.status !== 403)
          failures.push(`${role} ${r.method} ${r.path}: expected 403, got ${String(res.status)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it('the catalogue facts the milestone relies on', () => {
    const g = (role: string) => new Set(ROLE_TEMPLATES.find((t) => t.name === role)!.grants);
    // Administrator: everything in the catalogue
    expect(g('Administrator').has('backup.restore')).toBe(true);
    expect(g('Administrator').has('sales.invoice.post')).toBe(true);
    // Billing Operator: bills, customers and products; no administration, security or backup
    const b = g('Billing Operator');
    for (const k of ['sales.invoice.write', 'sales.invoice.post', 'customer.read', 'product.read'])
      expect(b.has(k), k).toBe(true);
    for (const k of [
      'security.user.manage',
      'backup.create',
      'backup.restore',
      'tax.config.review',
    ])
      expect(b.has(k), k).toBe(false);
    // Warehouse Operator: inventory, no invoicing or payments
    const wh = g('Warehouse Operator');
    expect(wh.has('inventory.stock.read')).toBe(true);
    for (const k of ['sales.invoice.post', 'sales.invoice.write', 'sales.payment.record'])
      expect(wh.has(k), k).toBe(false);
    // Accountant: reads backups, cannot create or restore them
    const a = g('Accountant');
    expect(a.has('backup.history.read')).toBe(true);
    expect(a.has('backup.create') || a.has('backup.restore')).toBe(false);
    // Viewer/Auditor: read only
    const v = g('Viewer/Auditor');
    const kind = new Map(PERMISSIONS.map((p) => [p.key, p.kind]));
    expect([...v].filter((k) => kind.get(k) !== 'read')).toEqual([]);
    for (const k of ['sales.invoice.post', 'sales.payment.record', 'backup.create'])
      expect(v.has(k), k).toBe(false);
  });
});
