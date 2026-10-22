// Task 1.18: a MODEST representative-data smoke test. Synthetic, fictional records; real PostgreSQL; the real API. It records what was
// measured (printed as FUB_PERF) and asserts only correctness and a very generous sanity bound, so it cannot be mistaken for a benchmark or
// for a statement of any scale limit: nothing larger than the volumes below was tried.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  call,
  createFixture,
  createRoleUsers,
  type ApiJson,
  type Fixture,
} from './auth-fixture.js';
import { body, previewAndPost, setupBillingWorld, type BillingWorld } from './invoice-fixture.js';

const CUSTOMERS = 2_000;
const PRODUCTS = 2_000;
const STOCKED = 150;
const INVOICES = 120;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (r: { json: ApiJson }) => r.json as unknown as Json;

let fx: Fixture;
let app: FastifyInstance;
let token: string;
let w: BillingWorld;
const volumes: Record<string, number> = {};
const timings: Record<string, { medianMs: number; maxMs: number }> = {};

async function time(name: string, path: string, check: (r: Json) => void, runs = 9): Promise<void> {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const r = await call(app, 'GET', path, { token });
    ms.push(performance.now() - t);
    expect(r.status, `${name}: ${JSON.stringify(r.json).slice(0, 200)}`).toBe(200);
    check(j(r));
  }
  ms.sort((a, b) => a - b);
  timings[name] = {
    medianMs: Math.round(ms[Math.floor(ms.length / 2)]!),
    maxMs: Math.round(ms[ms.length - 1]!),
  };
  expect(ms[ms.length - 1]!, `${name} sanity bound`).toBeLessThan(10_000);
}

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  app = await fx.makeApp();
  token = (await createRoleUsers(app, fx.orgId))['Administrator']!;
  w = await setupBillingWorld(fx);
  await fx.prisma.customer.createMany({
    data: Array.from({ length: CUSTOMERS }, (_, i) => ({
      organizationId: fx.orgId,
      code: `PERF-C-${String(i).padStart(5, '0')}`,
      customerKind: 'BUSINESS',
      legalName: `Fictional Perf Customer ${String(i).padStart(5, '0')}`,
      gstStatus: 'UNREGISTERED',
      billingAddressLine1: '1 Perf Lane',
      billingCity: 'Pune',
      billingStateCode: '27',
      placeOfSupplyStateCode: '27',
    })) as never,
  });
  await fx.prisma.product.createMany({
    data: Array.from({ length: PRODUCTS }, (_, i) => ({
      organizationId: fx.orgId,
      sku: `PERF-P-${String(i).padStart(5, '0')}`,
      name: `Fictional Perf Product ${String(i).padStart(5, '0')}`,
      kind: 'GOODS',
      unitId: w.unit.pcs,
      taxCategoryId: w.taxId.GST_18,
      hsnSacCodeId: w.hsnId,
      sellingPrice: '100.00',
      trackInventory: i < STOCKED,
    })),
  });
  const tracked = await fx.prisma.product.findMany({
    where: { sku: { startsWith: 'PERF-P-' }, trackInventory: true },
    select: { id: true },
  });
  for (const p of tracked) {
    const r = await call(app, 'POST', '/inventory/opening-stock', {
      token,
      body: {
        operationId: randomUUID(),
        productId: p.id,
        warehouseId: w.warehouseId,
        quantity: '50',
        businessDate: w.today,
      },
    });
    expect(r.status).toBe(201);
  }
  const first = await fx.prisma.customer.findFirstOrThrow({ where: { code: 'PERF-C-00000' } });
  const target = tracked[0]!.id;
  for (let i = 0; i < INVOICES; i++) {
    const r = await previewAndPost(
      app,
      token,
      body(w, { customerId: first.id }, [{ productId: target, quantity: '1' }]),
    );
    expect(r.post.status, JSON.stringify(r.post.json)).toBe(201);
    if (i % 2 === 0) {
      const p = await call(app, 'POST', '/payments', {
        token,
        body: {
          mode: 'DEMO',
          invoiceId: j(r.post).invoice.id,
          amount: '50',
          method: 'CASH',
          operationId: randomUUID(),
        },
      });
      expect(p.status).toBe(201);
    }
  }
  volumes.customers = CUSTOMERS;
  volumes.products = PRODUCTS + 0;
  volumes.trackedProductsWithStock = STOCKED;
  volumes.demoInvoices = INVOICES;
  volumes.demoPayments = INVOICES / 2;
}, 900_000);

afterAll(async () => {
  const report = JSON.stringify({ volumes, timings });
  console.log(`FUB_PERF ${report}`);
  if (process.env.FUB_PERF_OUT) writeFileSync(process.env.FUB_PERF_OUT, report);
  await fx?.close();
});

describe('representative-data smoke (fictional, modest volumes)', () => {
  it('lists, searches, pages and summarizes correctly at these volumes', async () => {
    await time('customers list (25 of 2000)', '/customers?limit=25', (r) => {
      expect(r.customers).toHaveLength(25);
      expect(r.total).toBeGreaterThanOrEqual(CUSTOMERS);
    });
    await time('customers search', '/customers?limit=25&search=Perf%20Customer%2001999', (r) =>
      expect(r.customers.length).toBeGreaterThanOrEqual(1),
    );
    await time('products list (25 of 2000)', '/products?limit=25', (r) => {
      expect(r.products).toHaveLength(25);
      expect(r.total).toBeGreaterThanOrEqual(PRODUCTS);
    });
    await time('products search', '/products?limit=25&search=Perf%20Product%2000777', (r) =>
      expect(r.products.length).toBeGreaterThanOrEqual(1),
    );
    await time('inventory stock list', '/inventory/stock?limit=25', (r) => {
      expect(r.items?.length ?? r.stock?.length ?? 0).toBeGreaterThan(0);
    });
    await time('invoices list (25 of 120)', '/invoices?limit=25', (r) => {
      expect(r.invoices).toHaveLength(25);
      expect(r.total).toBe(INVOICES);
    });
    await time('payments list', '/payments?limit=25', (r) => expect(r.total).toBe(INVOICES / 2));
    await time('receivables (demo)', '/receivables?isDemo=true&limit=25', (r) => {
      expect(r.customers?.length ?? r.rows?.length ?? 0).toBeGreaterThan(0);
    });
    await time('dashboard summary', '/dashboard/summary', (r) => {
      expect(r.sales.demo.month.count).toBe(INVOICES);
      expect(r.paymentsToday.demo.count).toBe(INVOICES / 2);
      expect(r.receivables.demo.openInvoices).toBe(INVOICES); // 50 against ~118 leaves every invoice open
      expect(r.stock.trackedProducts).toBe(STOCKED + 2); // plus the two tracked products of the billing world
    });
  }, 300_000);
});
