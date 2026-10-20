// Task 1.13: production-mode invoices (real stock effects), concurrency, rollback by failure injection, and database invariants.
// The production gate's "verified backup and restore" fact is supplied through the approved test seam (AppDeps.backupRestoreVerified);
// the real gate is unchanged and is proven closed in invoices.int.test.ts. Failure injection uses temporary triggers created in this
// isolated test database - there is no test-only branch in the production code. Fictional data only.
import { randomUUID } from 'node:crypto';
import { postStockMovement } from '@commercebill/inventory-engine';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  call,
  createFixture,
  createRoleUsers,
  type ApiJson,
  type Fixture,
} from './auth-fixture.js';
import {
  body,
  previewAndPost,
  setupBillingWorld,
  type BillingWorld,
  type Line,
} from './invoice-fixture.js';

let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;
let w: BillingWorld;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (r: { json: ApiJson }) => r.json as unknown as Json;
const admin = () => tokens['Administrator']!;
const preview = (b: unknown) => call(app, 'POST', '/invoices/preview', { token: admin(), body: b });
const postRaw = (b: unknown) => call(app, 'POST', '/invoices', { token: admin(), body: b });
const L = (productId: string, quantity = '1'): Line => ({ productId, quantity });
const prod = (lines: Line[], over: Record<string, unknown> = {}) =>
  body(w, { mode: 'PRODUCTION', ...over }, lines);

const state = async (productIds: string[] = []) => ({
  invoices: await fx.prisma.salesInvoice.count(),
  lines: await fx.prisma.salesInvoiceLine.count(),
  allocations: await fx.prisma.documentNumberAllocation.count(),
  movements: await fx.prisma.stockMovement.count(),
  dispatches: await fx.prisma.stockMovement.count({ where: { movementType: 'SALES_DISPATCH' } }),
  audit: await fx.prisma.auditLog.count({ where: { action: 'invoice.post' } }),
  invoiceSeq: (
    await fx.prisma.documentSequence.findFirstOrThrow({
      where: { organizationId: fx.orgId, documentType: 'INVOICE' },
    })
  ).lastNumber.toString(),
  demoSeq: (
    await fx.prisma.documentSequence.findFirstOrThrow({
      where: { organizationId: fx.orgId, documentType: 'DEMO_INVOICE' },
    })
  ).lastNumber.toString(),
  stock: await Promise.all(productIds.map((p) => stockOf(p))),
});
const stockOf = async (productId: string) =>
  (
    await fx.prisma.stockBalance.findUnique({
      where: { warehouseId_productId: { warehouseId: w.warehouseId, productId } },
    })
  )?.quantityOnHand.toFixed(4) ?? 'none';
const addStock = async (productId: string, quantity: string) => {
  const r = await call(app, 'POST', '/inventory/opening-stock', {
    token: admin(),
    body: {
      operationId: randomUUID(),
      productId,
      warehouseId: w.warehouseId,
      quantity,
      businessDate: w.today,
    },
  });
  expect(r.status).toBe(201);
};
const newTracked = (sku: string, price = '100.00') =>
  fx.prisma.product
    .create({
      data: {
        organizationId: fx.orgId,
        sku,
        name: sku,
        kind: 'GOODS',
        unitId: w.unit.pcs,
        taxCategoryId: w.taxId.GST_18,
        hsnSacCodeId: w.hsnId,
        sellingPrice: price,
        trackInventory: true,
      },
    })
    .then((p) => p.id);

/** Runs `fn` with a temporary trigger that misbehaves, then removes it whatever happens. */
async function injected<T>(
  table: string,
  kind: 'BEFORE INSERT' | 'DEFERRED',
  whenSql: string,
  bodySql: string,
  fn: () => Promise<T>,
): Promise<T> {
  await fx.prisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION a_inject() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN ${bodySql} RETURN NEW; END $f$`,
  );
  const create =
    kind === 'DEFERRED'
      ? `CREATE CONSTRAINT TRIGGER a_inject AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW ${whenSql ? `WHEN (${whenSql})` : ''} EXECUTE FUNCTION a_inject()`
      : `CREATE TRIGGER a_inject BEFORE INSERT ON ${table} FOR EACH ROW ${whenSql ? `WHEN (${whenSql})` : ''} EXECUTE FUNCTION a_inject()`;
  await fx.prisma.$executeRawUnsafe(create);
  try {
    return await fn();
  } finally {
    await fx.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS a_inject ON ${table}`);
    await fx.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS a_inject()');
  }
}
const RAISE = "RAISE EXCEPTION 'injected failure';";

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'silent', WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    backupRestoreVerified: async () => true,
  });
  tokens = await createRoleUsers(app, fx.orgId);
  w = await setupBillingWorld(fx);
}, 180_000);
afterAll(async () => fx?.close());

describe('demo first, then production', () => {
  it('a demo invoice for a tracked product leaves real stock untouched, so production later sees the original quantity', async () => {
    await addStock(w.products.tracked, '10');
    const demo = await previewAndPost(app, admin(), body(w, {}, [L(w.products.tracked, '8')]));
    expect(demo.post.status).toBe(201);
    expect(j(demo.post).invoice).toMatchObject({ isDemo: true, receivable: null });
    expect(await stockOf(w.products.tracked)).toBe('10.0000');
    expect((await state()).dispatches).toBe(0);
    // stock warnings on a demo invoice are advisory only
    const over = j(await preview(body(w, {}, [L(w.products.tracked, '50')])));
    expect(over.stockWarnings[0]).toMatchObject({ sufficient: false, advisoryOnly: true });
  });

  it('switching the organization to PRODUCTION needs a current review and the (injected) verified backup fact', async () => {
    const cfg = j(await call(app, 'GET', '/tax/configuration', { token: admin() }));
    const review = await call(app, 'POST', '/tax/configuration/reviews', {
      token: admin(),
      body: {
        capacity: 'Accountant for the business',
        note: 'Fictional test review',
        acknowledged: true,
        noticeVersion: cfg.notice.version,
        expectedFingerprint: cfg.fingerprint,
      },
    });
    expect(review.status).toBe(201);
    const sw = await call(app, 'POST', '/tax/billing-mode', {
      token: admin(),
      body: { mode: 'PRODUCTION' },
    });
    expect(sw.status).toBe(200);
  });

  it('a DEMO invoice is now refused as a mode mismatch (the mode is never inferred), and consumes no number', async () => {
    const before = await state();
    const pv = j(await preview(body(w, {}, [L(w.products.untracked)])));
    const r = await postRaw({
      ...body(w, {}, [L(w.products.untracked)]),
      operationId: randomUUID(),
      calculation: pv.identity ?? {
        inputHash: 'a'.repeat(64),
        configurationFingerprint: 'b'.repeat(64),
        grandTotal: '1.00',
      },
    });
    expect(r.status).toBe(409);
    expect(r.json.error.problems).toEqual([{ field: 'mode', rule: 'MODE_MISMATCH' }]);
    expect(await state()).toEqual(before);
  });
});

describe('posting a PRODUCTION invoice', () => {
  it('dispatches tracked goods from the real ledger, takes the INVOICE number, records the review and a receivable, and writes one audit row', async () => {
    const before = await state([w.products.tracked]);
    const r = await previewAndPost(
      app,
      admin(),
      prod([L(w.products.tracked, '3'), L(w.products.untracked, '2')]),
    );
    expect(r.preview).toMatchObject({ ok: true, postable: true, mode: 'PRODUCTION' });
    expect(r.post.status).toBe(201);
    const inv = j(r.post).invoice;
    expect(inv).toMatchObject({
      documentType: 'INVOICE',
      isDemo: false,
      documentNumber: `INV/${w.financialYearLabel}/000001`,
    });
    expect(inv.receivable).toEqual({ allocated: '0.00', balanceDue: inv.totals.grandTotal });
    expect(inv.tax.taxReviewId).toBeTruthy();
    expect(inv.lines.map((l: Json) => l.stockEffect)).toEqual(['DISPATCH', 'NONE']); // untracked goods have no stock effect
    const after = await state([w.products.tracked]);
    expect(after.stock).toEqual(['7.0000']);
    expect(after).toMatchObject({
      invoices: before.invoices + 1,
      lines: before.lines + 2,
      dispatches: before.dispatches + 1,
      allocations: before.allocations + 1,
      audit: before.audit + 1,
      invoiceSeq: '1',
      demoSeq: before.demoSeq,
    });
    const mv = await fx.prisma.stockMovement.findFirstOrThrow({
      where: { movementType: 'SALES_DISPATCH' },
    });
    expect(mv).toMatchObject({
      sourceType: 'SALES_INVOICE',
      sourceRef: inv.id,
      productId: w.products.tracked,
      warehouseId: w.warehouseId,
    });
    expect(mv.quantityDelta.toFixed(4)).toBe('-3.0000');
    expect(mv.sourceLineRef).toBe(inv.lines[0].id);
  });

  it('retrying the same operation returns the same invoice and does not dispatch twice', async () => {
    const req = prod([L(w.products.tracked, '1')]);
    const first = await previewAndPost(app, admin(), req);
    const before = await state([w.products.tracked]);
    const retry = await postRaw({
      ...req,
      operationId: first.operationId,
      calculation: first.preview.identity,
    });
    expect(retry.status).toBe(200);
    expect(j(retry).replayed).toBe(true);
    expect(j(retry).invoice.id).toBe(j(first.post).invoice.id);
    expect(await state([w.products.tracked])).toEqual(before);
  });

  it('insufficient stock refuses the whole invoice (multi-line: nothing partially dispatched, no number consumed)', async () => {
    const a = await newTracked('MULTI-A');
    const b = await newTracked('MULTI-B');
    await addStock(a, '5');
    await addStock(b, '1');
    const before = await state([a, b]);
    const r = await previewAndPost(app, admin(), prod([L(a, '2'), L(b, '2')]));
    expect(r.preview.ok).toBe(true); // stock is not a calculation fact; production checks it at posting
    expect(r.post.status).toBe(409);
    expect(r.post.json.error.problems).toEqual([
      expect.objectContaining({ rule: 'INSUFFICIENT_STOCK' }),
    ]);
    expect(await state([a, b])).toEqual(before);
  });

  it('concurrent oversell: stock 5, two invoices of 4 - exactly one posts, one is refused, no number gap', async () => {
    const p = await newTracked('OVERSELL');
    await addStock(p, '5');
    const reqA = prod([L(p, '4')]);
    const reqB = prod([L(p, '4')], { customerId: w.customers.b2b });
    const pa = j(await preview(reqA)).identity;
    const pb = j(await preview(reqB)).identity;
    const before = await state([p]);
    const [ra, rb] = await Promise.all([
      postRaw({ ...reqA, operationId: randomUUID(), calculation: pa }),
      postRaw({ ...reqB, operationId: randomUUID(), calculation: pb }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(loser.json.error.problems).toEqual([
      expect.objectContaining({ rule: 'INSUFFICIENT_STOCK' }),
    ]);
    const after = await state([p]);
    expect(after.stock).toEqual(['1.0000']);
    expect(after).toMatchObject({
      invoices: before.invoices + 1,
      dispatches: before.dispatches + 1,
      allocations: before.allocations + 1,
      audit: before.audit + 1,
      invoiceSeq: String(Number(before.invoiceSeq) + 1),
    });
    const winner = j(ra.status === 201 ? ra : rb).invoice;
    expect(winner.documentNumber).toBe(
      `INV/${w.financialYearLabel}/${String(Number(before.invoiceSeq) + 1).padStart(6, '0')}`,
    );
  });

  it('many concurrent production invoices over one product dispatch exactly what was sold, never below zero', async () => {
    const p = await newTracked('RACE');
    await addStock(p, '10');
    const req = prod([L(p, '3')]);
    const id = j(await preview(req)).identity;
    const rs = await Promise.all(
      Array.from({ length: 6 }, () =>
        postRaw({ ...req, operationId: randomUUID(), calculation: id }),
      ),
    );
    const ok = rs.filter((r) => r.status === 201).length;
    expect(ok).toBe(3);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await stockOf(p)).toBe('1.0000');
  });
});

describe('all-or-nothing: an injected failure at each step rolls back everything', () => {
  const setup = async (name: string) => {
    const p = await newTracked(name);
    await addStock(p, '10');
    const req = prod([L(p, '2')]);
    const identity = j(await preview(req)).identity;
    return {
      p,
      req,
      identity,
      post: () => postRaw({ ...req, operationId: randomUUID(), calculation: identity }),
    };
  };

  it('A. stock movement succeeded, then the invoice insert fails: no movement, balance unchanged, no number, no invoice, no audit', async () => {
    const s = await setup('FAIL-A');
    const before = await state([s.p]);
    const r = await injected('sales_invoices', 'BEFORE INSERT', '', RAISE, s.post);
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await state([s.p])).toEqual(before);
  });

  it('B. number allocated, then the invoice insert fails: the sequence and allocation ledger are unchanged (no gap)', async () => {
    const s = await setup('FAIL-B');
    const before = await state([s.p]);
    const r = await injected('sales_invoices', 'BEFORE INSERT', '', RAISE, s.post);
    expect(r.status).toBeGreaterThanOrEqual(500);
    const after = await state([s.p]);
    expect(after.invoiceSeq).toBe(before.invoiceSeq);
    expect(after.allocations).toBe(before.allocations);
    expect(after).toEqual(before);
    // the very next invoice takes the number the failed one would have had
    const ok = await s.post();
    expect(ok.status).toBe(201);
    expect(j(ok).invoice.documentNumber).toBe(
      `INV/${w.financialYearLabel}/${String(Number(before.invoiceSeq) + 1).padStart(6, '0')}`,
    );
  });

  it('C. header inserted, then a line insert fails: everything is rolled back', async () => {
    const s = await setup('FAIL-C');
    const before = await state([s.p]);
    const r = await injected('sales_invoice_lines', 'BEFORE INSERT', '', RAISE, s.post);
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await state([s.p])).toEqual(before);
  });

  it('D. the audit insert fails: the invoice, number and stock are rolled back too', async () => {
    const s = await setup('FAIL-D');
    const before = await state([s.p]);
    const r = await injected(
      'audit_logs',
      'BEFORE INSERT',
      "NEW.action = 'invoice.post'",
      RAISE,
      s.post,
    );
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await state([s.p])).toEqual(before);
  });

  it('E. a deferred constraint fails at COMMIT: everything is rolled back', async () => {
    const s = await setup('FAIL-E');
    const before = await state([s.p]);
    const r = await injected('sales_invoices', 'DEFERRED', '', RAISE, s.post);
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await state([s.p])).toEqual(before);
  });

  it('F. the second of two stock movements fails after the first succeeded: the first is rolled back as well', async () => {
    const a = await newTracked('FAIL-F1');
    const b = await newTracked('FAIL-F2');
    await addStock(a, '10');
    await addStock(b, '10');
    const req = prod([L(a, '2'), L(b, '2')]);
    const identity = j(await preview(req)).identity;
    const before = await state([a, b]);
    const [first, second] = [a, b].sort(); // movements are posted in product-id order
    const r = await injected(
      'stock_movements',
      'BEFORE INSERT',
      `NEW.movement_type = 'SALES_DISPATCH' AND NEW.product_id = '${second}'`,
      RAISE,
      () => postRaw({ ...req, operationId: randomUUID(), calculation: identity }),
    );
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(first).not.toBe(second);
    expect(await state([a, b])).toEqual(before);
  });
});

describe('database invariants refuse a bad write even from inside the application transaction', () => {
  const attempt = async (
    table: string,
    whenSql: string,
    bodySql: string,
    kind: 'BEFORE INSERT' | 'DEFERRED' = 'BEFORE INSERT',
  ) => {
    const p = await newTracked(`INV-${randomUUID().slice(0, 6).toUpperCase()}`);
    await addStock(p, '10');
    const req = prod([L(p, '1')]);
    const identity = j(await preview(req)).identity;
    const before = await state([p]);
    const r = await injected(table, kind, whenSql, bodySql, () =>
      postRaw({ ...req, operationId: randomUUID(), calculation: identity }),
    );
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await state([p])).toEqual(before);
  };

  it('a production line claiming DISPATCH with no matching movement is refused at commit', async () => {
    const untrackedReq = prod([L(w.products.untracked, '1')]);
    const identity = j(await preview(untrackedReq)).identity;
    const before = await state();
    const r = await injected(
      'sales_invoice_lines',
      'BEFORE INSERT',
      '',
      "NEW.stock_effect := 'DISPATCH';",
      () => postRaw({ ...untrackedReq, operationId: randomUUID(), calculation: identity }),
    );
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await state()).toEqual(before);
  });

  it('a tracked production line recorded with stock effect NONE (a skipped dispatch) is refused', async () => {
    await attempt('sales_invoice_lines', '', "NEW.stock_effect := 'NONE';");
  });

  it('a fabricated document number that the allocation ledger did not issue is refused', async () => {
    await attempt('sales_invoices', '', "NEW.document_number := 'FAKE/1';");
  });

  it('header totals that disagree with the lines are refused', async () => {
    await attempt('sales_invoices', '', 'NEW.grand_total := NEW.grand_total + 1;');
  });

  it('a production invoice without a tax review is refused', async () => {
    await attempt('sales_invoices', '', 'NEW.tax_review_id := NULL;');
  });

  it('an orphan SALES_DISPATCH movement with no invoice line is refused at commit', async () => {
    const p = await newTracked('ORPHAN');
    await addStock(p, '5');
    const user = await fx.prisma.user.findFirstOrThrow({ where: { organizationId: fx.orgId } });
    const before = await state([p]);
    await expect(
      fx.prisma.$transaction((tx) =>
        postStockMovement(tx, {
          organizationId: fx.orgId,
          warehouseId: w.warehouseId,
          productId: p,
          movementType: 'SALES_DISPATCH',
          quantity: '1',
          businessDate: w.today,
          source: { type: 'SALES_INVOICE', ref: randomUUID(), lineRef: randomUUID() },
          createdBy: user.id,
        }),
      ),
    ).rejects.toThrow();
    expect(await state([p])).toEqual(before);
  });

  it('a SALES_DISPATCH cannot be recorded through the ordinary stock APIs (it exists only for posted invoices)', async () => {
    const r = await call(app, 'POST', '/inventory/adjustments', {
      token: admin(),
      body: {
        operationId: randomUUID(),
        productId: w.products.tracked,
        warehouseId: w.warehouseId,
        direction: 'DECREASE',
        quantity: '1',
        reasonCode: 'LOSS',
        businessDate: w.today,
        movementType: 'SALES_DISPATCH',
      },
    });
    expect(r.status).toBe(400);
  });
});

describe('reports and views', () => {
  it('production_sales_invoices holds production invoices only; demo invoices are excluded by flag', async () => {
    const v = await fx.prisma.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM production_sales_invoices`;
    const real = await fx.prisma.salesInvoice.count({ where: { isDemo: false } });
    expect(Number(v[0]!.n)).toBe(real);
    expect(real).toBeGreaterThan(0);
    const list = j(await call(app, 'GET', '/invoices?isDemo=false&limit=100', { token: admin() }));
    expect(list.invoices.every((i: Json) => i.isDemo === false && i.receivable !== null)).toBe(
      true,
    );
    const demo = j(await call(app, 'GET', '/invoices?isDemo=true&limit=100', { token: admin() }));
    expect(demo.total).toBeGreaterThan(0);
  });
});
