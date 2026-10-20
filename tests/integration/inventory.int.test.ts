import { randomUUID } from 'node:crypto';
import { reconcileBalances } from '@commercebill/inventory-engine';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ROLE_TEMPLATES, seedReference } from '../../prisma/seed/reference/index.js';
import {
  LAUNCH_SECRET,
  PASSWORD,
  call,
  createFixture,
  createRoleUsers,
  type ApiJson,
  type Fixture,
} from './auth-fixture.js';

let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;
let logs: string[];
let seq = 0;
let warehouseId: string;
let today: string;
const P: Record<'pcs' | 'kg' | 'svc' | 'plain', string> = { pcs: '', kg: '', svc: '', plain: '' };

const admin = () => tokens['Administrator']!;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (r: { json: ApiJson }) => r.json as unknown as Json;

const body = (over: Record<string, unknown> = {}) => ({
  operationId: randomUUID(),
  productId: P.pcs,
  warehouseId,
  quantity: '10',
  businessDate: today,
  ...over,
});
const adjust = (over: Record<string, unknown> = {}) =>
  body({ direction: 'INCREASE', reasonCode: 'COUNT_CORRECTION', ...over });
const post = (path: string, payload: unknown, token = admin()) =>
  call(app, 'POST', path, { token, body: payload });
const opening = (o?: Record<string, unknown>, t?: string) =>
  post('/inventory/opening-stock', body(o), t);
const receipt = (o?: Record<string, unknown>, t?: string) =>
  post('/inventory/receipts', body(o), t);
const adjustment = (o?: Record<string, unknown>, t?: string) =>
  post('/inventory/adjustments', adjust(o), t);
const get = (path: string, token = admin()) => call(app, 'GET', path, { token });

async function newProduct(over: Record<string, unknown>) {
  const units = await fx.prisma.unit.findMany({ where: { organizationId: fx.orgId } });
  const tax = await fx.prisma.taxCategory.findFirstOrThrow({ where: { organizationId: fx.orgId } });
  return (
    await fx.prisma.product.create({
      data: {
        organizationId: fx.orgId,
        sku: `INV-${++seq}`,
        name: `Fictional Item ${seq}`,
        kind: 'GOODS',
        unitId: units.find((u) => u.code === 'PCS')!.id,
        taxCategoryId: tax.id,
        sellingPrice: '10',
        trackInventory: true,
        ...over,
      },
    })
  ).id;
}
const onHand = async (productId = P.pcs) =>
  (
    await fx.prisma.stockBalance.findUnique({
      where: { warehouseId_productId: { warehouseId, productId } },
    })
  )?.quantityOnHand.toFixed(4);
const movementCount = (productId?: string) =>
  fx.prisma.stockMovement.count({ where: productId ? { productId } : {} });
const audits = (action: string) =>
  fx.prisma.auditLog.findMany({ where: { action }, orderBy: { occurredAt: 'asc' } });

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  logs = [];
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    logStream: { write: (m: string) => void logs.push(m) },
  });
  tokens = await createRoleUsers(app, fx.orgId);
  today = fx.clock.now.toISOString().slice(0, 10);
  warehouseId = (
    await fx.prisma.warehouse.create({
      data: { organizationId: fx.orgId, code: 'MAIN', name: 'Main Warehouse', isPrimary: true },
    })
  ).id;
  const units = await fx.prisma.unit.findMany({ where: { organizationId: fx.orgId } });
  P.pcs = await newProduct({ name: 'Fictional Pieces Item' });
  P.kg = await newProduct({
    name: 'Fictional Weighed Item',
    unitId: units.find((u) => u.code === 'KG')!.id,
  });
  P.svc = await newProduct({ kind: 'SERVICE', unitId: null, trackInventory: false });
  P.plain = await newProduct({ trackInventory: false });
}, 120_000);
afterAll(async () => fx?.close());

describe('opening stock, receipts and adjustments', () => {
  it('1-2. opening stock creates one immutable movement and the balance follows it', async () => {
    const r = await opening({ quantity: '12', reference: 'Count sheet 1', note: 'First count' });
    expect(r.status).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(j(r)).toMatchObject({
      replayed: false,
      onHand: '12',
      movement: {
        movementType: 'OPENING_STOCK',
        quantityDelta: '12',
        productId: P.pcs,
        warehouseId,
        warehouseName: 'Main Warehouse',
        businessDate: today,
        reasonCode: null,
        reference: 'Count sheet 1',
        createdByName: 'Administrator (test)',
        unit: { code: 'PCS', decimalPlaces: 0 },
      },
    });
    expect(await onHand()).toBe('12.0000');
    expect(await movementCount(P.pcs)).toBe(1);
    const row = await fx.prisma.stockMovement.findFirstOrThrow({ where: { productId: P.pcs } });
    expect(row).toMatchObject({ organizationId: fx.orgId, sourceType: 'MANUAL' });
    expect(row.createdBy).toBeTruthy();
  });

  it('3. a second opening stock for the same product and warehouse is refused (use an adjustment)', async () => {
    const before = await movementCount();
    const r = await opening({ quantity: '5' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BIZ_0001');
    expect(r.json.error.problems).toEqual([{ field: 'productId', rule: 'opening_stock_exists' }]);
    expect(await movementCount()).toBe(before);
    expect(await onHand()).toBe('12.0000');
  });

  it('opening stock is also refused once a receipt exists for that stock', async () => {
    const id = await newProduct({});
    expect((await receipt({ productId: id, quantity: '2' })).status).toBe(201);
    const r = await opening({ productId: id });
    expect(r.status).toBe(409);
    expect(r.json.error.problems).toEqual([{ field: 'productId', rule: 'opening_stock_exists' }]);
  });

  it('4. a manual receipt increases stock', async () => {
    const r = await receipt({ quantity: '8', reference: 'Challan 77' });
    expect(r.status).toBe(201);
    expect(j(r)).toMatchObject({
      onHand: '20',
      movement: { movementType: 'STOCK_RECEIPT', quantityDelta: '8', reference: 'Challan 77' },
    });
    expect(await onHand()).toBe('20.0000');
  });

  it('5. an adjustment increase adds stock and needs a reason', async () => {
    const r = await adjustment({ quantity: '3', reasonCode: 'FOUND', note: 'Found behind shelf' });
    expect(r.status).toBe(201);
    expect(j(r)).toMatchObject({
      onHand: '23',
      movement: { movementType: 'ADJUSTMENT_INCREASE', quantityDelta: '3', reasonCode: 'FOUND' },
    });
    const noReason = await post('/inventory/adjustments', {
      ...adjust({ quantity: '1' }),
      reasonCode: undefined,
    });
    expect(noReason.status).toBe(400);
    expect(noReason.json.error.problems).toEqual([{ field: 'reasonCode', rule: 'required' }]);
    const badReason = await adjustment({ reasonCode: 'BECAUSE' });
    expect(badReason.json.error.problems).toEqual([
      { field: 'reasonCode', rule: 'invalid_choice' },
    ]);
    const other = await adjustment({ reasonCode: 'OTHER' });
    expect(other.json.error.problems).toEqual([{ field: 'note', rule: 'required_for_other' }]);
    expect(await onHand()).toBe('23.0000');
  });

  it('6. an adjustment decrease removes stock (stored negative, shown as a decrease)', async () => {
    const r = await adjustment({ direction: 'DECREASE', quantity: '5', reasonCode: 'DAMAGE' });
    expect(r.status).toBe(201);
    expect(j(r)).toMatchObject({
      onHand: '18',
      movement: { movementType: 'ADJUSTMENT_DECREASE', quantityDelta: '-5', reasonCode: 'DAMAGE' },
    });
    expect(await onHand()).toBe('18.0000');
  });

  it('7-8. a decrease below zero is refused and leaves no partial movement, balance or audit row', async () => {
    const [m, a] = [await movementCount(), (await audits('inventory.adjustment')).length];
    const r = await adjustment({ direction: 'DECREASE', quantity: '19', reasonCode: 'LOSS' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BIZ_0001');
    expect(r.json.error.dataSaved).toBe(false);
    expect(r.json.error.problems).toEqual([{ field: 'quantity', rule: 'insufficient_stock' }]);
    expect(await onHand()).toBe('18.0000');
    expect(await movementCount()).toBe(m);
    expect((await audits('inventory.adjustment')).length).toBe(a);
    // exactly to zero is allowed; then nothing more can leave
    const fresh = await newProduct({});
    await receipt({ productId: fresh, quantity: '4' });
    expect(
      (
        await adjustment({
          productId: fresh,
          direction: 'DECREASE',
          quantity: '4',
          reasonCode: 'LOSS',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await adjustment({
          productId: fresh,
          direction: 'DECREASE',
          quantity: '1',
          reasonCode: 'LOSS',
        })
      ).status,
    ).toBe(409);
  });

  it('9-10. services and goods that do not track inventory can never have stock operations', async () => {
    const before = await movementCount();
    for (const id of [P.svc, P.plain]) {
      for (const make of [opening, receipt, adjustment]) {
        const r = await make({ productId: id });
        expect(r.status).toBe(400);
        expect(r.json.error.problems).toEqual([
          { field: 'productId', rule: 'inventory_not_tracked' },
        ]);
      }
    }
    expect(await movementCount()).toBe(before);
    // and they never appear in the stock list
    const ids = (j(await get('/inventory/stock?limit=100')).stock as Json[]).map(
      (s) => s.productId,
    );
    expect(ids).not.toContain(P.svc);
    expect(ids).not.toContain(P.plain);
    expect(ids).toContain(P.pcs);
  });

  it('11-13. an unknown warehouse or product, or an invalid id, is refused', async () => {
    const before = await movementCount();
    const w = await receipt({ warehouseId: randomUUID() });
    expect(w.status).toBe(400);
    expect(w.json.error.problems).toEqual([{ field: 'warehouseId', rule: 'unknown_reference' }]);
    const p = await receipt({ productId: randomUUID() });
    expect(p.json.error.problems).toEqual([{ field: 'productId', rule: 'unknown_reference' }]);
    const bad = await receipt({ productId: 'not-a-uuid', warehouseId: 'x', operationId: 'nope' });
    expect(bad.status).toBe(400);
    expect((bad.json.error.problems ?? []).map((x) => x.rule)).toEqual([
      'invalid_reference',
      'invalid_reference',
      'invalid_reference',
    ]);
    expect(await movementCount()).toBe(before);
  });
});

describe('quantities and precision', () => {
  it('18. stores exact decimals for a unit with three decimal places', async () => {
    const r = await receipt({ productId: P.kg, quantity: '2.505' });
    expect(r.status).toBe(201);
    expect(j(r).movement.quantityDelta).toBe('2.505');
    await receipt({ productId: P.kg, quantity: '0.001' });
    await receipt({ productId: P.kg, quantity: '123456789012.345' });
    const out = await adjustment({
      productId: P.kg,
      direction: 'DECREASE',
      quantity: '0.002',
      reasonCode: 'LOSS',
    });
    expect(j(out).onHand).toBe('123456789014.849');
    expect(await onHand(P.kg)).toBe('123456789014.8490');
    const list = j(await get(`/inventory/stock?productId=${P.kg}`));
    expect(list.stock[0]).toMatchObject({
      onHand: '123456789014.849',
      unit: { code: 'KG', decimalPlaces: 3 },
    });
  });

  it('19. refuses precision the unit or the ledger cannot hold, and anything that is not exact text', async () => {
    const before = await movementCount();
    const cases: [Record<string, unknown>, string][] = [
      [{ productId: P.pcs, quantity: '1.5' }, 'too_many_decimals'],
      // the ledger holds four places, the unit (KG) only three: refused, not rounded to 1.234
      [{ productId: P.kg, quantity: '1.2345' }, 'too_many_decimals'],
      [{ productId: P.kg, quantity: '1.2341' }, 'too_many_decimals'],
      [{ productId: P.kg, quantity: '1.23456' }, 'unsupported_precision'],
      [{ quantity: '0' }, 'quantity_must_be_positive'],
      [{ quantity: '0.0000' }, 'quantity_must_be_positive'],
      [{ quantity: '-3' }, 'quantity_must_be_positive'],
      [{ quantity: 'abc' }, 'invalid_quantity'],
      [{ quantity: '1e3' }, 'invalid_quantity'],
      [{ quantity: '1,000' }, 'invalid_quantity'],
      [{ quantity: 5 }, 'invalid_quantity'],
      [{ quantity: '' }, 'required'],
      [{ quantity: '1234567890123' }, 'quantity_too_large'],
    ];
    for (const [over, rule] of cases) {
      const r = await receipt(over);
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(r.json.error.problems, JSON.stringify(over)).toEqual([{ field: 'quantity', rule }]);
    }
    expect(await movementCount()).toBe(before);
    // "2.0" and "02" are the same exact whole number
    expect(j(await receipt({ quantity: '2.0' })).movement.quantityDelta).toBe('2');
  });

  it('refuses unknown fields (including a client-supplied organization), future dates and bad dates', async () => {
    const before = await movementCount();
    const orgB = randomUUID();
    const unknown = await receipt({ organizationId: orgB, quantityDelta: '5', cost: '10' });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.problems!.map((p) => p.rule)).toEqual([
      'unknown_field',
      'unknown_field',
      'unknown_field',
    ]);
    for (const [date, rule] of [
      ['2999-01-01', 'date_in_future'],
      ['1999-12-31', 'date_too_old'],
      ['2026-02-30', 'invalid_date'],
      ['yesterday', 'invalid_date'],
      ['', 'required'],
    ] as const) {
      const r = await receipt({ businessDate: date });
      expect(r.json.error.problems, date).toEqual([{ field: 'businessDate', rule }]);
    }
    const noOp = await post('/inventory/receipts', { ...body(), operationId: undefined });
    expect(noOp.json.error.problems).toEqual([{ field: 'operationId', rule: 'required' }]);
    expect(await movementCount()).toBe(before);
  });
});

describe('idempotency', () => {
  it('20. a retried request (the response was lost) changes stock once and audits once', async () => {
    const operationId = randomUUID();
    const first = await receipt({ operationId, quantity: '6', productId: P.pcs });
    const before = await onHand();
    const [m, a] = [await movementCount(), (await audits('inventory.receipt')).length];
    const again = await receipt({ operationId, quantity: '6', productId: P.pcs });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(j(again)).toMatchObject({ replayed: true, movement: { id: j(first).movement.id } });
    expect(await onHand()).toBe(before);
    expect(await movementCount()).toBe(m);
    expect((await audits('inventory.receipt')).length).toBe(a);
    expect(j(again).onHand).toBe(j(first).onHand);
  });

  it('reusing an operation id for a DIFFERENT change is refused, not silently replayed', async () => {
    const operationId = randomUUID();
    expect((await receipt({ operationId, quantity: '2' })).status).toBe(201);
    const m = await movementCount();
    for (const other of [
      { quantity: '3' },
      { productId: P.kg, quantity: '2' },
      { businessDate: '2020-01-01' },
    ]) {
      const r = await receipt({ operationId, quantity: '2', ...other });
      expect(r.status).toBe(409);
      expect(r.json.error.problems).toEqual([
        { field: 'operationId', rule: 'operation_id_reused' },
      ]);
    }
    // ... and a different KIND of operation with the same id is a different change too
    const asAdj = await adjustment({ operationId, quantity: '2' });
    expect(asAdj.status).toBe(409);
    expect(await movementCount()).toBe(m);
  });

  it('ten simultaneous retries of one operation record exactly one movement', async () => {
    const operationId = randomUUID();
    const start = await onHand();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => receipt({ operationId, quantity: '1' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(9);
    expect(Number(await onHand()) - Number(start)).toBe(1);
    expect(await fx.prisma.stockMovement.count({ where: { sourceRef: operationId } })).toBe(1);
  });
});

describe('concurrency (real PostgreSQL locking)', () => {
  it('21. forty parallel receipts add up exactly', async () => {
    const id = await newProduct({});
    const rs = await Promise.all(
      Array.from({ length: 40 }, () => receipt({ productId: id, quantity: '1' })),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await onHand(id)).toBe('40.0000');
    expect(await movementCount(id)).toBe(40);
  });

  it('22. two simultaneous decreases of 4 from 5: one succeeds, one fails, stock is 1 (never -3)', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await newProduct({});
      await receipt({ productId: id, quantity: '5' });
      const rs = await Promise.all([
        adjustment({ productId: id, direction: 'DECREASE', quantity: '4', reasonCode: 'LOSS' }),
        adjustment({ productId: id, direction: 'DECREASE', quantity: '4', reasonCode: 'LOSS' }),
      ]);
      expect(rs.map((r) => r.status).sort(), `round ${round}`).toEqual([201, 409]);
      expect(await onHand(id)).toBe('1.0000');
    }
  });

  it('twelve parallel decreases of 1 from 5: exactly five succeed and stock ends at 0', async () => {
    const id = await newProduct({});
    await receipt({ productId: id, quantity: '5' });
    const rs = await Promise.all(
      Array.from({ length: 12 }, () =>
        adjustment({ productId: id, direction: 'DECREASE', quantity: '1', reasonCode: 'LOSS' }),
      ),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(5);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await onHand(id)).toBe('0.0000');
  });

  it('mixed parallel receipts and decreases never leave the balance different from the ledger', async () => {
    const id = await newProduct({});
    await receipt({ productId: id, quantity: '3' });
    const ops = Array.from({ length: 30 }, (_, i) =>
      i % 3 === 0
        ? adjustment({ productId: id, direction: 'DECREASE', quantity: '2', reasonCode: 'LOSS' })
        : receipt({ productId: id, quantity: '1' }),
    );
    await Promise.all(ops);
    expect(Number(await onHand(id))).toBeGreaterThanOrEqual(0);
    expect(await reconcileBalances(fx.prisma, fx.orgId)).toEqual([]);
  });

  it('five simultaneous opening stocks for one product: exactly one is accepted', async () => {
    const id = await newProduct({});
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => opening({ productId: id, quantity: '7' })),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await onHand(id)).toBe('7.0000');
  });
});

describe('ledger integrity', () => {
  it('16-17. a posted movement cannot be updated or deleted, even directly in the database', async () => {
    const id = (await fx.prisma.stockMovement.findFirstOrThrow({ where: { productId: P.pcs } })).id;
    await expect(
      fx.prisma.$executeRaw`UPDATE stock_movements SET quantity_delta = 999 WHERE id = ${id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma.$executeRaw`DELETE FROM stock_movements WHERE id = ${id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma.stockMovement.update({ where: { id }, data: { note: 'edited' } }),
    ).rejects.toThrow();
    await expect(fx.prisma.stockMovement.delete({ where: { id } })).rejects.toThrow();
    await expect(
      fx.prisma.stockBalance.updateMany({ data: { quantityOnHand: 1000 } }),
    ).rejects.toThrow();
    expect(await onHand()).not.toBe('1000.0000');
  });

  it('there is no route to edit or delete a movement', async () => {
    const id = (await fx.prisma.stockMovement.findFirstOrThrow({})).id;
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const r = await app.inject({
        method,
        url: `/inventory/movements/${id}`,
        headers: {
          'x-commercebill-launch-secret': LAUNCH_SECRET,
          authorization: `Bearer ${admin()}`,
        },
        payload: method === 'DELETE' ? undefined : { quantity: '1' },
      });
      expect([404, 405], method).toContain(r.statusCode);
    }
  });

  it('23-24. the balance equals the ledger total, and the integrity check proves it (and notices drift)', async () => {
    const sums = await fx.prisma.$queryRaw<
      { product_id: string; total: string; balance: string }[]
    >`
      SELECT m.product_id::text, m.total::text, b.quantity_on_hand::text AS balance
      FROM (SELECT product_id, SUM(quantity_delta) AS total FROM stock_movements GROUP BY product_id) m
      JOIN stock_balances b ON b.product_id = m.product_id`;
    expect(sums.length).toBeGreaterThan(3);
    for (const s of sums) expect(s.balance).toBe(s.total);
    expect(await reconcileBalances(fx.prisma, fx.orgId)).toEqual([]);

    // Corrupt a balance on purpose (protection switched off for this one statement) and prove the check sees it.
    await fx.prisma.$executeRaw`ALTER TABLE stock_balances DISABLE TRIGGER stock_balances_protect`;
    try {
      await fx.prisma
        .$executeRaw`UPDATE stock_balances SET quantity_on_hand = quantity_on_hand + 1 WHERE product_id = ${P.pcs}::uuid`;
      const drift = await reconcileBalances(fx.prisma, fx.orgId);
      expect(drift).toHaveLength(1);
      expect(drift[0]).toMatchObject({ productId: P.pcs, warehouseId });
      expect(Number(drift[0]!.balance) - Number(drift[0]!.ledger)).toBe(1);
      await fx.prisma
        .$executeRaw`UPDATE stock_balances SET quantity_on_hand = quantity_on_hand - 1 WHERE product_id = ${P.pcs}::uuid`;
    } finally {
      await fx.prisma.$executeRaw`ALTER TABLE stock_balances ENABLE TRIGGER stock_balances_protect`;
    }
    expect(await reconcileBalances(fx.prisma, fx.orgId)).toEqual([]);
  });

  it('a product with stock keeps its unit and inventory tracking (friendly 400)', async () => {
    const units = await fx.prisma.unit.findMany({ where: { organizationId: fx.orgId } });
    const prod = await fx.prisma.product.findUniqueOrThrow({ where: { id: P.pcs } });
    const kg = units.find((u) => u.code === 'KG')!.id;
    const r1 = await call(app, 'PATCH', `/products/${P.pcs}`, {
      token: admin(),
      body: { expectedVersion: prod.version, unitId: kg },
    });
    expect(r1.status).toBe(400);
    expect(r1.json.error.problems).toEqual([{ field: 'unitId', rule: 'unit_has_stock_history' }]);
    const r2 = await call(app, 'PATCH', `/products/${P.pcs}`, {
      token: admin(),
      body: { expectedVersion: prod.version, trackInventory: false },
    });
    expect(r2.json.error.problems).toEqual([
      { field: 'trackInventory', rule: 'tracking_has_stock_history' },
    ]);
    const ok = await call(app, 'PATCH', `/products/${P.pcs}`, {
      token: admin(),
      body: { expectedVersion: prod.version, name: 'Renamed Fictional Pieces Item' },
    });
    expect(ok.status).toBe(200);
  });
});

describe('reading stock', () => {
  it('lists tracked goods of the primary warehouse with on-hand, pagination and exact search', async () => {
    const all = j(await get('/inventory/stock?limit=100'));
    expect(all.warehouse).toMatchObject({ id: warehouseId, code: 'MAIN', name: 'Main Warehouse' });
    expect(all.total).toBe(all.stock.length);
    const row = all.stock.find((s: Json) => s.productId === P.pcs);
    expect(row).toMatchObject({
      sku: expect.stringMatching(/^INV-/),
      hasMovements: true,
      unit: { code: 'PCS' },
    });
    expect(typeof row.onHand).toBe('string');
    const neverMoved = await newProduct({ name: 'Never Moved Item' });
    const nm = j(await get(`/inventory/stock?productId=${neverMoved}`)).stock[0];
    expect(nm).toMatchObject({ onHand: '0', hasMovements: false });

    const page1 = j(await get('/inventory/stock?limit=2&offset=0'));
    const page2 = j(await get('/inventory/stock?limit=2&offset=2'));
    expect(page1.stock).toHaveLength(2);
    expect(page1.stock.map((s: Json) => s.productId)).not.toEqual(
      page2.stock.map((s: Json) => s.productId),
    );
    expect(page1.total).toBe(all.total + 1); // the never-moved item was added after `all` was read

    expect(
      j(await get('/inventory/stock?search=never%20moved')).stock.map((s: Json) => s.productId),
    ).toEqual([neverMoved]);
    expect(j(await get('/inventory/stock?search=%25')).stock).toHaveLength(0); // "%" is a literal character
    expect((await get('/inventory/stock?limit=1000')).status).toBe(400);
    await fx.prisma.product.update({ where: { id: neverMoved }, data: { isActive: false } });
    expect(
      j(await get('/inventory/stock?isActive=true&limit=100')).stock.map((s: Json) => s.productId),
    ).not.toContain(neverMoved);
    expect(
      j(await get('/inventory/stock?isActive=false')).stock.map((s: Json) => s.productId),
    ).toEqual([neverMoved]);
  });

  it('lists the movements of a product newest first, server-side paged, with the actor', async () => {
    const id = await newProduct({});
    for (let i = 1; i <= 7; i++) await receipt({ productId: id, quantity: String(i) });
    const p1 = j(await get(`/inventory/movements?productId=${id}&limit=3&offset=0`));
    const p3 = j(await get(`/inventory/movements?productId=${id}&limit=3&offset=6`));
    expect(p1).toMatchObject({ total: 7, limit: 3, offset: 0 });
    expect(p1.movements).toHaveLength(3);
    expect(p3.movements).toHaveLength(1);
    expect(p1.movements[0]).toMatchObject({
      quantityDelta: '7',
      createdByName: 'Administrator (test)',
      productId: id,
    });
    expect(p3.movements[0].quantityDelta).toBe('1');
    const one = j(await get(`/inventory/movements/${p1.movements[0].id}`));
    expect(one.movement.id).toBe(p1.movements[0].id);
    expect((await get(`/inventory/movements/${randomUUID()}`)).status).toBe(404);
    expect((await get('/inventory/movements/not-a-uuid')).status).toBe(404);
    expect(j(await get('/inventory/movements?limit=5')).movements).toHaveLength(5); // all products
  });

  it('GET /warehouses lists the organization warehouses', async () => {
    const r = await get('/warehouses');
    expect(r.status).toBe(200);
    expect(j(r).warehouses).toEqual([
      { id: warehouseId, code: 'MAIN', name: 'Main Warehouse', isPrimary: true, isActive: true },
    ]);
  });

  it('never exposes cost, margin or price through the inventory endpoints', async () => {
    const texts = [
      (await get('/inventory/stock?limit=100')).body,
      (await get('/inventory/movements?limit=100')).body,
      (await receipt()).body,
    ].join('');
    for (const word of ['cost', 'margin', 'sellingPrice', 'mrp', 'valuation', 'price'])
      expect(texts.toLowerCase(), word).not.toContain(word.toLowerCase());
  });
});

describe('authorization', () => {
  const endpoints: [string, string, (() => unknown) | undefined][] = [
    ['GET', '/inventory/stock', undefined],
    ['GET', '/inventory/movements', undefined],
    ['GET', '/warehouses', undefined],
    ['POST', '/inventory/opening-stock', () => body()],
    ['POST', '/inventory/receipts', () => body()],
    ['POST', '/inventory/adjustments', () => adjust()],
  ];

  it('25. every endpoint answers 401 without a session (and without the launch secret)', async () => {
    for (const [method, path, make] of endpoints) {
      const r = await call(app, method as 'GET', path, { ...(make ? { body: make() } : {}) });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.json.error.code).toBe('AUTH_0001');
      const noLaunch = await call(app, method as 'GET', path, {
        token: admin(),
        launch: false,
        ...(make ? { body: make() } : {}),
      });
      expect(noLaunch.status, `${method} ${path} no launch`).toBe(401);
    }
  });

  it('26. a user without any inventory permission gets 403 on every endpoint and nothing changes', async () => {
    await app.authService!.createUser({
      organizationId: fx.orgId,
      username: 'nobody.user',
      displayName: 'Nobody',
      password: PASSWORD,
      roleNames: [],
    });
    const token = (
      await call(app, 'POST', '/auth/login', {
        body: { username: 'nobody.user', password: PASSWORD },
      })
    ).json.token as string;
    const before = await movementCount();
    for (const [method, path, make] of endpoints) {
      const r = await call(app, method as 'GET', path, {
        token,
        ...(make ? { body: make() } : {}),
      });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json.error.code).toBe('AUTH_0002');
      expect(r.json.error.dataSaved).toBe(false);
    }
    expect(await movementCount()).toBe(before);
  });

  it('27-30. what each role may do follows the permission catalogue, not the role name', async () => {
    for (const tpl of ROLE_TEMPLATES) {
      const token = tokens[tpl.name]!;
      const canRead = tpl.grants.includes('inventory.stock.read');
      const canWrite = tpl.grants.includes('inventory.adjustment.create');
      const canWarehouses = tpl.grants.includes('warehouse.read');
      expect((await get('/inventory/stock', token)).status, `${tpl.name} read`).toBe(
        canRead ? 200 : 403,
      );
      expect((await get('/inventory/movements', token)).status, `${tpl.name} movements`).toBe(
        canRead ? 200 : 403,
      );
      expect((await get('/warehouses', token)).status, `${tpl.name} warehouses`).toBe(
        canWarehouses ? 200 : 403,
      );
      const before = await movementCount();
      for (const make of [opening, receipt, adjustment]) {
        const productId = await newProduct({});
        const r = await make({ productId }, token);
        expect(r.status, `${tpl.name} write`).toBe(canWrite ? 201 : 403);
      }
      expect((await movementCount()) - before, `${tpl.name} movements written`).toBe(
        canWrite ? 3 : 0,
      );
    }
    // the rules this relies on, spelled out for the five seeded templates
    const grants = (n: string) => ROLE_TEMPLATES.find((t) => t.name === n)!.grants;
    expect(grants('Viewer/Auditor')).toContain('inventory.stock.read');
    expect(grants('Viewer/Auditor')).not.toContain('inventory.adjustment.create');
    expect(grants('Warehouse Operator')).toContain('inventory.adjustment.create');
    expect(grants('Billing Operator')).not.toContain('inventory.adjustment.create');
  });
});

describe('organization isolation', () => {
  let tokenB: string;
  let warehouseB: string;
  let productB: string;

  beforeAll(async () => {
    const org = await fx.prisma.organization.create({
      data: { legalName: 'DEMO Other Co (fictional)' },
    });
    await seedReference(fx.prisma, { organizationId: org.id });
    await app.authService!.createUser({
      organizationId: org.id,
      username: 'admin.orgb',
      displayName: 'Admin B',
      password: PASSWORD,
      roleNames: ['Administrator'],
    });
    tokenB = (
      await call(app, 'POST', '/auth/login', {
        body: { username: 'admin.orgb', password: PASSWORD, organizationId: org.id },
      })
    ).json.token as string;
    warehouseB = (
      await fx.prisma.warehouse.create({
        data: { organizationId: org.id, code: 'MAIN', name: 'Org B Warehouse', isPrimary: true },
      })
    ).id;
    const unit = await fx.prisma.unit.findFirstOrThrow({
      where: { organizationId: org.id, code: 'PCS' },
    });
    const tax = await fx.prisma.taxCategory.findFirstOrThrow({ where: { organizationId: org.id } });
    productB = (
      await fx.prisma.product.create({
        data: {
          organizationId: org.id,
          sku: 'ORGB-1',
          name: 'OrgB Secret Item',
          kind: 'GOODS',
          unitId: unit.id,
          taxCategoryId: tax.id,
          sellingPrice: '5',
          trackInventory: true,
        },
      })
    ).id;
    const r = await post(
      '/inventory/receipts',
      body({ productId: productB, warehouseId: warehouseB, quantity: '9' }),
      tokenB,
    );
    expect(r.status).toBe(201);
  }, 120_000);

  it("12-13. organization A cannot post stock to B's product or into B's warehouse (same answer as unknown)", async () => {
    const before = await movementCount();
    const p = await receipt({ productId: productB });
    expect(p.status).toBe(400);
    expect(p.json.error.problems).toEqual([{ field: 'productId', rule: 'unknown_reference' }]);
    const w = await receipt({ warehouseId: warehouseB });
    expect(w.json.error.problems).toEqual([{ field: 'warehouseId', rule: 'unknown_reference' }]);
    for (const make of [opening, adjustment]) {
      expect((await make({ productId: productB })).status).toBe(400);
      expect((await make({ warehouseId: warehouseB })).status).toBe(400);
    }
    // and the other way round
    expect((await receipt({ productId: P.pcs, warehouseId: warehouseB }, tokenB)).status).toBe(400);
    expect((await receipt({ productId: P.pcs, warehouseId }, tokenB)).status).toBe(400);
    expect(await movementCount()).toBe(before);
    expect((await onHand()) !== undefined).toBe(true);
  });

  it("14-15. organization A cannot see B's stock or movements, by list, filter or direct id", async () => {
    const stock = j(await get('/inventory/stock?limit=100'));
    expect(stock.stock.map((s: Json) => s.productId)).not.toContain(productB);
    expect(JSON.stringify(stock)).not.toContain('OrgB');
    expect((await get(`/inventory/stock?warehouseId=${warehouseB}`)).status).toBe(404);
    expect(j(await get(`/inventory/stock?productId=${productB}`)).stock).toEqual([]);
    expect((await get(`/inventory/movements?productId=${productB}`)).status).toBe(404);
    expect((await get(`/inventory/movements?warehouseId=${warehouseB}`)).status).toBe(404);
    const all = j(await get('/inventory/movements?limit=100'));
    expect(all.movements.every((m: Json) => m.productId !== productB)).toBe(true);
    const bMove = (
      await fx.prisma.stockMovement.findFirstOrThrow({ where: { productId: productB } })
    ).id;
    expect((await get(`/inventory/movements/${bMove}`)).status).toBe(404);
    expect((await get(`/inventory/movements/${bMove}`, tokenB)).status).toBe(200);
    const seenByB = j(await get('/inventory/stock?limit=100', tokenB));
    expect(seenByB.warehouse.id).toBe(warehouseB);
    expect(seenByB.stock.map((s: Json) => s.productId)).toEqual([productB]);
    expect((await get('/warehouses', tokenB)).json.warehouses).toHaveLength(1);
  });

  it("the organization comes from the session; B's operation ids do not collide with A's", async () => {
    const operationId = randomUUID();
    expect((await receipt({ operationId })).status).toBe(201);
    const b = await post(
      '/inventory/receipts',
      body({ operationId, productId: productB, warehouseId: warehouseB, quantity: '1' }),
      tokenB,
    );
    expect(b.status).toBe(201);
    expect(j(b).replayed).toBe(false);
  });

  it('the database refuses a cross-organization movement even if application code were wrong', async () => {
    const orgA = fx.orgId;
    const userA = (await fx.prisma.user.findFirstOrThrow({ where: { organizationId: orgA } })).id;
    await expect(
      fx.prisma.stockMovement.create({
        data: {
          organizationId: orgA,
          warehouseId,
          productId: productB,
          movementType: 'STOCK_RECEIPT',
          quantityDelta: '1',
          businessDate: new Date(`${today}T00:00:00Z`),
          sourceType: 'TEST',
          sourceRef: randomUUID(),
          createdBy: userA,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('audit and logs', () => {
  it('31-33. audits opening stock, receipts and adjustments with facts only (no free text)', async () => {
    const id = await newProduct({ name: 'Audit Subject Item' });
    const note = 'confidential-note-xyz';
    const reference = 'secret-ref-123';
    const o = await opening({ productId: id, quantity: '5', note, reference });
    const r = await receipt({ productId: id, quantity: '2', note, reference });
    const a = await adjustment({
      productId: id,
      direction: 'DECREASE',
      quantity: '1',
      reasonCode: 'DAMAGE',
      note,
      reference,
    });
    expect([o.status, r.status, a.status]).toEqual([201, 201, 201]);
    const admin = await fx.prisma.user.findFirstOrThrow({ where: { username: 'admin.user' } });
    for (const [action, res, type, delta] of [
      ['inventory.opening_stock', o, 'OPENING_STOCK', '5'],
      ['inventory.receipt', r, 'STOCK_RECEIPT', '2'],
      ['inventory.adjustment', a, 'ADJUSTMENT_DECREASE', '-1'],
    ] as const) {
      const row = (await audits(action)).find((x) => x.entityId === j(res).movement.id)!;
      expect(row, action).toBeTruthy();
      expect(row).toMatchObject({
        category: 'business',
        entityType: 'stock_movement',
        userId: admin.id,
        organizationId: fx.orgId,
      });
      expect(row.correlationId).toBeTruthy();
      expect(row.afterValues).toMatchObject({
        productId: id,
        warehouseId,
        movementType: type,
        quantityDelta: delta,
        businessDate: today,
      });
      const text = JSON.stringify(row);
      expect(text).not.toContain(note);
      expect(text).not.toContain(reference);
    }
    expect(
      (await audits('inventory.adjustment')).find((x) => x.entityId === j(a).movement.id)!
        .afterValues,
    ).toMatchObject({ reasonCode: 'DAMAGE' });
  });

  it('server logs never contain notes, references, quantities or tokens', async () => {
    const note = 'log-leak-note-qwerty';
    const reference = 'log-leak-ref-asdfgh';
    await receipt({ quantity: '3', note, reference });
    await get('/inventory/stock?search=Fictional%20Pieces');
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(100);
    for (const secret of [
      note,
      reference,
      'Fictional%20Pieces',
      'Fictional Pieces',
      admin(),
      LAUNCH_SECRET,
    ])
      expect(text, secret).not.toContain(secret);
    expect(text).toContain('?[query redacted]');
  });
});
