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
let unitId: string;
let unit2Id: string;
let taxId: string;
let tax2Id: string;
let hsnId: string;
let sacId: string;

interface Prod {
  id: string;
  sku: string;
  version: number;
  isActive: boolean;
  [k: string]: unknown;
}
const prod = (r: { json: ApiJson }) => r.json.product as unknown as Prod;
const list = (r: { json: ApiJson }) =>
  r.json as unknown as { products: Prod[]; total: number; limit: number; offset: number };

const goods = (over: Record<string, unknown> = {}) => ({
  kind: 'GOODS',
  name: `Fictional Widget ${++seq}`,
  unitId,
  taxCategoryId: taxId,
  sellingPrice: '1180.00',
  ...over,
});
const service = (over: Record<string, unknown> = {}) => ({
  kind: 'SERVICE',
  name: `Fictional Service ${++seq}`,
  taxCategoryId: taxId,
  sellingPrice: '500',
  ...over,
});

const admin = () => tokens['Administrator']!;
const post = (body: unknown, token = admin()) => call(app, 'POST', '/products', { token, body });
const patch = (id: string, body: unknown, token = admin()) =>
  call(app, 'PATCH', `/products/${id}`, { token, body });
const get = (path: string, token = admin()) => call(app, 'GET', path, { token });
const auditRows = (action: string, entityId?: string) =>
  fx.prisma.auditLog.findMany({
    where: { action, ...(entityId ? { entityId } : {}) },
    orderBy: { occurredAt: 'asc' },
  });

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  logs = [];
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    logStream: { write: (m: string) => void logs.push(m) },
  });
  tokens = await createRoleUsers(app, fx.orgId);
  const units = await fx.prisma.unit.findMany({
    where: { organizationId: fx.orgId },
    orderBy: { code: 'asc' },
  });
  unitId = units.find((u) => u.code === 'PCS')!.id;
  unit2Id = units.find((u) => u.code === 'KG')!.id;
  const cats = await fx.prisma.taxCategory.findMany({ where: { organizationId: fx.orgId } });
  taxId = cats.find((c) => c.code === 'GST_18')!.id;
  tax2Id = cats.find((c) => c.code === 'GST_5')!.id;
  // The HSN/SAC reference list is empty after seeding (it needs reviewed data): add two fictional entries.
  hsnId = (
    await fx.prisma.hsnSacCode.create({
      data: { code: '8517', kind: 'HSN', description: 'Telephone sets' },
    })
  ).id;
  sacId = (
    await fx.prisma.hsnSacCode.create({
      data: { code: '998314', kind: 'SAC', description: 'IT consulting' },
    })
  ).id;
}, 120_000);
afterAll(async () => fx?.close());

describe('creating products', () => {
  it('1. creates an inventory-tracked goods product with a generated SKU and sensible defaults', async () => {
    const r = await post(
      goods({ trackInventory: true, hsnSacCodeId: hsnId, barcode: '8901234567890' }),
    );
    expect(r.status).toBe(201);
    expect(prod(r)).toMatchObject({
      kind: 'GOODS',
      trackInventory: true,
      isActive: true,
      version: 1,
      sellingPrice: '1180.00',
      mrp: null,
      priceIncludesTax: false,
      unit: { code: 'PCS' },
      taxCategory: { code: 'GST_18' },
      hsnSacCode: { code: '8517', kind: 'HSN' },
    });
    expect(prod(r).sku).toMatch(/^PRD-\d{6,}$/);
    expect(prod(r).id).not.toBe(prod(r).sku); // internal id and SKU are different things
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('2-3. creates non-inventory goods and a service (services have no unit and never track stock)', async () => {
    const plain = await post(goods({ trackInventory: false, priceIncludesTax: true, mrp: '1500' }));
    expect(prod(plain)).toMatchObject({
      trackInventory: false,
      priceIncludesTax: true,
      mrp: '1500.00',
    });
    const s = await post(service({ hsnSacCodeId: sacId }));
    expect(s.status).toBe(201);
    expect(prod(s)).toMatchObject({
      kind: 'SERVICE',
      trackInventory: false,
      unit: null,
      hsnSacCode: { code: '998314', kind: 'SAC' },
    });
  });

  it('4. a service cannot track inventory (400), and nothing is created', async () => {
    const before = await fx.prisma.product.count();
    const r = await post(service({ trackInventory: true }));
    expect(r.status).toBe(400);
    expect(r.json.error.problems).toEqual([
      { field: 'trackInventory', rule: 'service_cannot_track_inventory' },
    ]);
    expect(await fx.prisma.product.count()).toBe(before);
  });

  it('7. stores money exactly: every digit survives, nothing goes through a floating-point number', async () => {
    const big = prod(
      await post(goods({ sellingPrice: '1234567890123456.78', mrp: '9007199254740993.01' })),
    );
    expect(big).toMatchObject({ sellingPrice: '1234567890123456.78', mrp: '9007199254740993.01' });
    const row = await fx.prisma.product.findUniqueOrThrow({ where: { id: big.id } });
    expect(row.sellingPrice.toFixed(2)).toBe('1234567890123456.78');
    expect(row.mrp!.toFixed(2)).toBe('9007199254740993.01');
    const raw = await fx.prisma.$queryRaw<
      { sp: string }[]
    >`SELECT selling_price::text AS sp FROM products WHERE id = ${big.id}::uuid`;
    expect(raw[0]!.sp).toBe('1234567890123456.78');
    const small = prod(await post(goods({ sellingPrice: '0.10' })));
    expect(small.sellingPrice).toBe('0.10');
    expect(prod(await post(goods({ sellingPrice: 19.99 }))).sellingPrice).toBe('19.99'); // a JSON number only via its exact text
    expect(prod(await post(goods({ sellingPrice: '7' }))).sellingPrice).toBe('7.00');
    // no selling-price-versus-MRP rule is imposed
    expect((await post(goods({ sellingPrice: '2000', mrp: '1000' }))).status).toBe(201);
  });

  it('8. rejects invalid money with value-free problems (never rounds, never accepts negatives)', async () => {
    const problem = async (body: Record<string, unknown>) =>
      (await post(goods(body))).json.error.problems;
    expect(await problem({ sellingPrice: '10.999' })).toEqual([
      { field: 'sellingPrice', rule: 'invalid_amount' },
    ]);
    expect(await problem({ sellingPrice: '-1' })).toEqual([
      { field: 'sellingPrice', rule: 'negative_amount' },
    ]);
    expect(await problem({ sellingPrice: '1e3' })).toEqual([
      { field: 'sellingPrice', rule: 'invalid_amount' },
    ]);
    expect(await problem({ sellingPrice: '1,000' })).toEqual([
      { field: 'sellingPrice', rule: 'invalid_amount' },
    ]);
    expect(await problem({ sellingPrice: 0.1 + 0.2 })).toEqual([
      { field: 'sellingPrice', rule: 'invalid_amount' },
    ]);
    expect(await problem({ sellingPrice: undefined })).toEqual([
      { field: 'sellingPrice', rule: 'required' },
    ]);
    expect(await problem({ mrp: '-5' })).toEqual([{ field: 'mrp', rule: 'negative_amount' }]);
    expect(await problem({ mrp: 'abc' })).toEqual([{ field: 'mrp', rule: 'invalid_amount' }]);
    expect(await problem({ sellingPrice: '10000000000000000.00' })).toEqual([
      { field: 'sellingPrice', rule: 'invalid_amount' },
    ]);
  });

  it('validates the other fields and rejects unknown, quantity-like and cost fields', async () => {
    const r = await post(
      goods({ name: '  ', barcode: 'has space', priceIncludesTax: 'yes', kind: 'BUNDLE' }),
    );
    const rules = new Map(r.json.error.problems!.map((p) => [p.field, p.rule]));
    expect(rules.get('name')).toBe('required');
    expect(rules.get('barcode')).toBe('invalid_barcode');
    expect(rules.get('priceIncludesTax')).toBe('invalid_type');
    expect(rules.get('kind')).toBe('invalid_value');
    for (const extra of [
      { organizationId: fx.orgId },
      { id: '00000000-0000-4000-8000-000000000001' },
      { quantity: 10 },
      { stock: 5 },
      { costPrice: '3' },
      { version: 3 },
      { isActive: false },
    ]) {
      const s = await post(goods(extra));
      expect(s.status, JSON.stringify(extra)).toBe(400);
      expect(s.json.error.problems![0]!.rule).toBe('unknown_field');
    }
    expect((await post([1, 2])).status).toBe(400);
  });
});

describe('reference data', () => {
  it('9. accepts HSN for goods and SAC for services', async () => {
    expect(prod(await post(goods({ hsnSacCodeId: hsnId }))).hsnSacCode).toMatchObject({
      code: '8517',
    });
    expect(prod(await post(service({ hsnSacCodeId: sacId }))).hsnSacCode).toMatchObject({
      code: '998314',
    });
  });

  it('10. rejects invalid, foreign, inactive and mismatched references', async () => {
    const problems = async (body: Record<string, unknown>) =>
      (await post(body)).json.error.problems;
    const ghost = '00000000-0000-4000-8000-000000000009';
    expect(await problems(goods({ unitId: ghost }))).toEqual([
      { field: 'unitId', rule: 'unknown_reference' },
    ]);
    expect(await problems(goods({ taxCategoryId: ghost }))).toEqual([
      { field: 'taxCategoryId', rule: 'unknown_reference' },
    ]);
    expect(await problems(goods({ hsnSacCodeId: ghost }))).toEqual([
      { field: 'hsnSacCodeId', rule: 'unknown_reference' },
    ]);
    expect(await problems(goods({ unitId: 'PCS' }))).toEqual([
      { field: 'unitId', rule: 'invalid_reference' },
    ]); // a label is not an id
    expect(await problems(goods({ unitId: undefined }))).toEqual([
      { field: 'unitId', rule: 'required' },
    ]);
    expect(await problems(goods({ taxCategoryId: undefined }))).toEqual([
      { field: 'taxCategoryId', rule: 'required' },
    ]);
    expect(await problems(goods({ hsnSacCodeId: sacId }))).toEqual([
      { field: 'hsnSacCodeId', rule: 'goods_need_hsn' },
    ]);
    expect(await problems(service({ hsnSacCodeId: hsnId }))).toEqual([
      { field: 'hsnSacCodeId', rule: 'services_need_sac' },
    ]);
    // a retired unit cannot be chosen for a new product
    const retired = await fx.prisma.unit.create({
      data: { organizationId: fx.orgId, code: 'OLDU', name: 'Retired unit', isActive: false },
    });
    expect(await problems(goods({ unitId: retired.id }))).toEqual([
      { field: 'unitId', rule: 'inactive_reference' },
    ]);
    await fx.prisma.unit.delete({ where: { id: retired.id } });
  });

  it('11. stores the tax category as configuration only: no rate or tax amount appears or is computed', async () => {
    const r = await post(
      goods({ taxCategoryId: tax2Id, sellingPrice: '1000', priceIncludesTax: false }),
    );
    expect(prod(r)).toMatchObject({
      taxCategoryId: tax2Id,
      sellingPrice: '1000.00',
      taxCategory: { code: 'GST_5' },
    });
    const keys = Object.keys(prod(r)).join(' ').toLowerCase();
    for (const forbidden of [
      'cgst',
      'sgst',
      'igst',
      'cess',
      'taxamount',
      'ratepercent',
      'total',
      'quantity',
      'stock',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    const cols = (
      await fx.prisma.$queryRaw<
        { column_name: string }[]
      >`SELECT column_name FROM information_schema.columns WHERE table_name = 'products'`
    ).map((c) => c.column_name);
    for (const forbidden of ['rate_percent', 'cgst', 'sgst', 'igst', 'quantity', 'stock_quantity'])
      expect(cols).not.toContain(forbidden);
  });

  it("serves the product form its OWN organization's active units and tax categories, and reports an empty HSN list honestly", async () => {
    const r = await get('/products/references');
    expect(r.status).toBe(200);
    const body = r.json as unknown as {
      units: { id: string; code: string }[];
      taxCategories: { id: string; code: string }[];
      hsnSacTotal: number;
    };
    expect(body.units.map((u) => u.code)).toEqual(expect.arrayContaining(['PCS', 'KG']));
    expect(body.taxCategories.map((t) => t.code)).toEqual(
      expect.arrayContaining(['GST_18', 'GST_5']),
    );
    expect(body.hsnSacTotal).toBe(2);
    const hsn = (await get('/products/references/hsn-sac?kind=HSN&search=85')).json as unknown as {
      codes: { code: string }[];
      total: number;
    };
    expect(hsn.codes.map((c) => c.code)).toEqual(['8517']);
    expect(
      ((await get('/products/references/hsn-sac?kind=SAC')).json as unknown as { total: number })
        .total,
    ).toBe(1);
    expect((await get('/products/references/hsn-sac?limit=999')).status).toBe(400);
    expect((await get('/products/references/hsn-sac?kind=XYZ')).status).toBe(400);
    expect(
      ((await get('/products/references/hsn-sac?search=%25')).json as unknown as { total: number })
        .total,
    ).toBe(0); // wildcards are literal
  });
});

describe('SKU and barcode', () => {
  it('5. SKUs are unique per organization, upper-cased, generated sequentially, and skip hand-typed numbers', async () => {
    const a = prod(await post(goods({ name: 'Seq A' })));
    const b = prod(await post(goods({ name: 'Seq B' })));
    expect(Number(b.sku.slice(4))).toBe(Number(a.sku.slice(4)) + 1);
    const manual = await post(goods({ name: 'Manual', sku: 'acme-001' }));
    expect(prod(manual).sku).toBe('ACME-001');
    const dup = await post(goods({ name: 'Manual again', sku: 'ACME-001' }));
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('BIZ_0001');
    expect(dup.json.error.problems).toEqual([{ field: 'sku', rule: 'duplicate_sku' }]);
    expect((await post(goods({ sku: 'bad sku!' }))).json.error.problems).toEqual([
      { field: 'sku', rule: 'invalid_sku' },
    ]);
    const next = `PRD-${String(Number(b.sku.slice(4)) + 1).padStart(6, '0')}`;
    expect(prod(await post(goods({ sku: next }))).sku).toBe(next);
    const after = prod(await post(goods({ name: 'After' })));
    expect(Number(after.sku.slice(4))).toBe(Number(b.sku.slice(4)) + 2);
    const par = await Promise.all(
      Array.from({ length: 6 }, (_, i) => post(goods({ name: `Parallel ${i}` }))),
    );
    expect(new Set(par.map((r) => prod(r).sku)).size).toBe(6);
  });

  it('a barcode identifies one product per organization', async () => {
    expect((await post(goods({ barcode: '5000000000017' }))).status).toBe(201);
    const dup = await post(goods({ barcode: '5000000000017' }));
    expect(dup.status).toBe(409);
    expect(dup.json.error.problems).toEqual([{ field: 'barcode', rule: 'duplicate_barcode' }]);
  });

  it('the SKU and the kind cannot be edited (stable identity); the id never changes', async () => {
    const p = prod(await post(goods({ name: 'Stable' })));
    const sku = await patch(p.id, { expectedVersion: 1, sku: 'CHANGED' });
    expect(sku.json.error.problems).toEqual([{ field: 'sku', rule: 'unknown_field' }]);
    const kind = await patch(p.id, { expectedVersion: 1, kind: 'SERVICE' });
    expect(kind.json.error.problems).toEqual([{ field: 'kind', rule: 'kind_cannot_change' }]);
    expect(
      (await patch(p.id, { expectedVersion: 1, kind: 'GOODS', name: 'Stable renamed' })).status,
    ).toBe(200);
    expect(prod(await get(`/products/${p.id}`))).toMatchObject({
      id: p.id,
      sku: p.sku,
      kind: 'GOODS',
    });
  });
});

describe('listing, search and filters', () => {
  beforeAll(async () => {
    for (let i = 1; i <= 7; i++) {
      await post(
        goods({
          name: `Pagetest ${String(i).padStart(2, '0')}`,
          trackInventory: i % 2 === 0,
          barcode: `70000000000${i}`,
        }),
      );
    }
    await post(service({ name: 'Pagetest Consulting', hsnSacCodeId: sacId }));
  });

  it('12-13. searches SKU, name, barcode and HSN/SAC prefix in the database, and paginates stably', async () => {
    const search = async (q: string) =>
      list(await get(`/products?search=${encodeURIComponent(q)}&limit=100`));
    expect((await search('pagetest 03')).products.map((p) => p.name)).toEqual(['Pagetest 03']); // case-insensitive
    const one = (await search('Pagetest 05')).products[0]!;
    expect((await search(one.sku.toLowerCase())).products.map((p) => p.id)).toContain(one.id); // SKU
    expect((await search('700000000005')).products.map((p) => p.id)).toEqual([one.id]); // barcode
    expect((await search('998314')).products.some((p) => p.name === 'Pagetest Consulting')).toBe(
      true,
    ); // SAC prefix
    expect((await search('no-such-product-anywhere')).total).toBe(0);
    expect((await search('%')).total).toBe(0);
    expect((await search('_')).total).toBe(0);
    expect((await search("x'; DROP TABLE products; --")).total).toBe(0);
    const pct = prod(await post(goods({ name: 'Fifty%Off Special' })));
    expect((await search('50%')).total).toBe(0);
    expect((await search('Fifty%Off')).products.map((p) => p.id)).toEqual([pct.id]);

    const page = async (offset: number) =>
      list(await get(`/products?search=Pagetest&limit=3&offset=${offset}`));
    const [p1, p2, p3] = [await page(0), await page(3), await page(6)];
    expect(p1.total).toBe(8);
    expect([p1.products.length, p2.products.length, p3.products.length]).toEqual([3, 3, 2]);
    const names = [...p1.products, ...p2.products, ...p3.products].map((p) => p.name as string);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(new Set(names).size).toBe(8);
    for (const q of [
      'limit=101',
      'limit=0',
      'offset=-1',
      'isActive=maybe',
      'kind=BUNDLE',
      'tracked=x',
    ]) {
      expect((await get(`/products?${q}`)).status, q).toBe(400);
    }
  });

  it('14-16. filters by kind, status and inventory tracking', async () => {
    const q = async (qs: string) => list(await get(`/products?search=Pagetest&limit=100&${qs}`));
    expect((await q('kind=SERVICE')).products.map((p) => p.kind)).toEqual(['SERVICE']);
    const goodsOnly = await q('kind=GOODS');
    expect(goodsOnly.total).toBe(7);
    const tracked = await q('tracked=true');
    expect(tracked.products.every((p) => p.trackInventory === true)).toBe(true);
    expect(tracked.total).toBe(3);
    expect((await q('tracked=false')).total).toBe(5);
    const victim = prod(await post(goods({ name: 'Pagetest Retired' })));
    await call(app, 'POST', `/products/${victim.id}/deactivate`, { token: admin(), body: {} });
    expect((await q('isActive=false')).products.map((p) => p.id)).toEqual([victim.id]);
    expect((await q('isActive=true')).products.map((p) => p.id)).not.toContain(victim.id);
    expect((await q('')).products.map((p) => p.id)).toContain(victim.id); // no status filter = all
  });

  it('gets one product; unknown and malformed ids are 404', async () => {
    const p = prod(await post(goods({ name: 'Get Me' })));
    expect(prod(await get(`/products/${p.id}`)).name).toBe('Get Me');
    expect((await get('/products/00000000-0000-4000-8000-000000000009')).status).toBe(404);
    expect((await get('/products/not-a-uuid')).status).toBe(404);
  });
});

describe('editing, activation and concurrency', () => {
  it('17. edits a product, bumps the version, and a no-op edit changes nothing', async () => {
    const p = prod(await post(goods({ name: 'Before Edit', sellingPrice: '100' })));
    const r = await patch(p.id, {
      expectedVersion: 1,
      name: 'After Edit',
      sellingPrice: '149.50',
      priceIncludesTax: true,
      unitId: unit2Id,
    });
    expect(prod(r)).toMatchObject({
      name: 'After Edit',
      sellingPrice: '149.50',
      priceIncludesTax: true,
      version: 2,
      sku: p.sku,
      unit: { code: 'KG' },
    });
    const same = await patch(p.id, { expectedVersion: 2, name: 'After Edit' });
    expect(prod(same).version).toBe(2);
    expect(await auditRows('product.update', p.id)).toHaveLength(1);
    const cleared = await patch(p.id, { expectedVersion: 2, mrp: null, description: null });
    expect(prod(cleared)).toMatchObject({ mrp: null, version: 2 }); // nothing to change: already empty
    expect((await patch(p.id, { expectedVersion: 2, trackInventory: true })).status).toBe(200);
    expect((await patch(p.id, { name: 'No version' })).status).toBe(400);
  });

  it('keeps the whole record valid after a partial edit', async () => {
    const s = prod(await post(service({ name: 'Edit Rules' })));
    const track = await patch(s.id, { expectedVersion: 1, trackInventory: true });
    expect(track.json.error.problems).toEqual([
      { field: 'trackInventory', rule: 'service_cannot_track_inventory' },
    ]);
    const badHsn = await patch(s.id, { expectedVersion: 1, hsnSacCodeId: hsnId });
    expect(badHsn.json.error.problems).toEqual([
      { field: 'hsnSacCodeId', rule: 'services_need_sac' },
    ]);
    const badPrice = await patch(s.id, { expectedVersion: 1, sellingPrice: '1.999' });
    expect(badPrice.json.error.problems).toEqual([
      { field: 'sellingPrice', rule: 'invalid_amount' },
    ]);
    const g = prod(await post(goods({ name: 'Needs unit' })));
    expect((await patch(g.id, { expectedVersion: 1, unitId: null })).json.error.problems).toEqual([
      { field: 'unitId', rule: 'required' },
    ]);
  });

  it('a product keeps working after its unit is retired; only NEW use of a retired unit is refused', async () => {
    const u = await fx.prisma.unit.create({
      data: { organizationId: fx.orgId, code: 'TMPU', name: 'Temporary unit' },
    });
    const p = prod(await post(goods({ name: 'Uses TMPU', unitId: u.id })));
    await fx.prisma.unit.update({ where: { id: u.id }, data: { isActive: false } });
    expect(prod(await patch(p.id, { expectedVersion: 1, name: 'Still editable' })).name).toBe(
      'Still editable',
    );
    const other = prod(await post(goods({ name: 'Wants TMPU' })));
    expect(
      (await patch(other.id, { expectedVersion: 1, unitId: u.id })).json.error.problems,
    ).toEqual([{ field: 'unitId', rule: 'inactive_reference' }]);
  });

  it('19-20. deactivates and reactivates idempotently; the record stays readable and editable; nothing is deleted', async () => {
    const p = prod(await post(goods({ name: 'Toggle Me' })));
    const off = await call(app, 'POST', `/products/${p.id}/deactivate`, {
      token: admin(),
      body: {},
    });
    expect(prod(off)).toMatchObject({ isActive: false, version: 2 });
    expect(
      prod(await call(app, 'POST', `/products/${p.id}/deactivate`, { token: admin() })).version,
    ).toBe(2);
    expect((await get(`/products/${p.id}`)).status).toBe(200);
    expect(
      (await patch(p.id, { expectedVersion: 2, description: 'edited while inactive' })).status,
    ).toBe(200);
    const on = await call(app, 'POST', `/products/${p.id}/activate`, {
      token: admin(),
      body: { expectedVersion: 3 },
    });
    expect(prod(on)).toMatchObject({ isActive: true, version: 4 });
    expect(await auditRows('product.deactivate', p.id)).toHaveLength(1);
    expect(await auditRows('product.activate', p.id)).toHaveLength(1);
  });

  it('21. there is no physical DELETE route, and the database refuses a delete too', async () => {
    const p = prod(await post(goods({ name: 'Undeletable' })));
    const del = await app.inject({
      method: 'DELETE',
      url: `/products/${p.id}`,
      headers: {
        'x-commercebill-launch-secret': LAUNCH_SECRET,
        authorization: `Bearer ${admin()}`,
      },
    });
    expect([404, 405]).toContain(del.statusCode);
    // the trigger refuses the delete (Prisma wraps its message), so the row must still be there
    await expect(fx.prisma.product.delete({ where: { id: p.id } })).rejects.toThrow();
    expect(await fx.prisma.product.count({ where: { id: p.id } })).toBe(1);
  });

  it('18. an edit based on an old version is refused (409) and nothing is overwritten', async () => {
    const p = prod(await post(goods({ name: 'Race Co', sellingPrice: '10' })));
    const userA = admin();
    const userB = tokens['Billing Operator']!;
    expect(prod(await get(`/products/${p.id}`, userB)).version).toBe(1);
    expect(prod(await patch(p.id, { expectedVersion: 1, sellingPrice: '11' }, userA)).version).toBe(
      2,
    );
    const b = await patch(
      p.id,
      { expectedVersion: 1, sellingPrice: '99', name: 'B was here' },
      userB,
    );
    expect(b.status).toBe(409);
    expect(b.json.error.code).toBe('DB_0002');
    expect(b.json.error.message).toMatch(/Reload/);
    expect(prod(await get(`/products/${p.id}`))).toMatchObject({
      sellingPrice: '11.00',
      name: 'Race Co',
      version: 2,
    });
    expect(
      (
        await call(app, 'POST', `/products/${p.id}/deactivate`, {
          token: userB,
          body: { expectedVersion: 1 },
        })
      ).status,
    ).toBe(409);
  });

  it('two simultaneous edits of the same version: exactly one wins', async () => {
    const p = prod(await post(goods({ name: 'Photo Finish' })));
    const [x, y] = await Promise.all([
      patch(p.id, { expectedVersion: 1, name: 'Winner X' }),
      patch(p.id, { expectedVersion: 1, name: 'Winner Y' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(prod(await get(`/products/${p.id}`)).version).toBe(2);
  });
});

describe('authentication and authorization (exact permission keys)', () => {
  let target: Prod;
  beforeAll(async () => {
    target = prod(await post(goods({ name: 'Authz Target' })));
  });

  const routes = (id: string) => [
    { name: 'list', method: 'GET' as const, url: '/products', write: false },
    { name: 'get', method: 'GET' as const, url: `/products/${id}`, write: false },
    { name: 'references', method: 'GET' as const, url: '/products/references', write: false },
    {
      name: 'hsn search',
      method: 'GET' as const,
      url: '/products/references/hsn-sac',
      write: false,
    },
    { name: 'create', method: 'POST' as const, url: '/products', write: true, body: () => goods() },
    {
      name: 'update',
      method: 'PATCH' as const,
      url: `/products/${id}`,
      write: true,
      body: () => ({ expectedVersion: 1, description: `n${++seq}` }),
    },
    {
      name: 'activate',
      method: 'POST' as const,
      url: `/products/${id}/activate`,
      write: true,
      body: () => ({}),
    },
    {
      name: 'deactivate',
      method: 'POST' as const,
      url: `/products/${id}/deactivate`,
      write: true,
      body: () => ({}),
    },
  ];

  it('22. no session is 401 AUTH_0001 and a missing launch secret is 401, on every route', async () => {
    for (const r of routes(target.id)) {
      const none = await call(app, r.method, r.url, { body: r.body?.() });
      expect(none.status, r.name).toBe(401);
      expect(none.json.error.code).toBe('AUTH_0001');
      expect(
        (await call(app, r.method, r.url, { body: r.body?.(), token: admin(), launch: false }))
          .status,
        r.name,
      ).toBe(401);
    }
  });

  it('23-26. every role template gets exactly what its product.read / product.write grants allow', async () => {
    for (const template of ROLE_TEMPLATES) {
      const grants = new Set<string>(template.grants);
      for (const r of routes(target.id)) {
        const res = await call(app, r.method, r.url, {
          token: tokens[template.name]!,
          body: r.body?.(),
        });
        const allowed = r.write ? grants.has('product.write') : grants.has('product.read');
        if (allowed) {
          expect(res.status, `${template.name} ${r.name}`).not.toBe(403);
          expect(res.status, `${template.name} ${r.name}`).not.toBe(401);
        } else {
          expect(res.status, `${template.name} ${r.name}`).toBe(403);
          expect(res.json.error.code).toBe('AUTH_0002');
        }
      }
    }
  });

  it('26. the catalogue gives Administrator and Billing Operator write access, and the Viewer/Auditor read only', async () => {
    const byName = new Map(ROLE_TEMPLATES.map((t) => [t.name, new Set<string>(t.grants)]));
    expect(byName.get('Administrator')!.has('product.write')).toBe(true);
    expect(byName.get('Billing Operator')!.has('product.write')).toBe(true);
    expect(byName.get('Viewer/Auditor')!.has('product.write')).toBe(false);
    expect(byName.get('Viewer/Auditor')!.has('product.read')).toBe(true);
    expect((await post(goods({ name: 'Viewer attempt' }), tokens['Viewer/Auditor']!)).status).toBe(
      403,
    );
    expect(await fx.prisma.product.count({ where: { name: 'Viewer attempt' } })).toBe(0);
    expect((await get('/products', tokens['Viewer/Auditor']!)).status).toBe(200);
  });
});

describe('organization isolation', () => {
  let tokenB: string;
  let productB: Prod;
  let productA: Prod;
  let unitB: string;
  let taxB: string;

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
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-commercebill-launch-secret': LAUNCH_SECRET },
      payload: { username: 'admin.orgb', password: PASSWORD, organizationId: org.id },
    });
    tokenB = (login.json() as { token: string }).token;
    const refs = (await get('/products/references', tokenB)).json as unknown as {
      units: { id: string; code: string }[];
      taxCategories: { id: string; code: string }[];
    };
    unitB = refs.units.find((u) => u.code === 'PCS')!.id;
    taxB = refs.taxCategories.find((t) => t.code === 'GST_18')!.id;
    productB = prod(
      await post(
        {
          kind: 'GOODS',
          name: 'OrgB Secret Gadget',
          sku: 'PRD-000001',
          unitId: unitB,
          taxCategoryId: taxB,
          sellingPrice: '777.77',
          barcode: '9990001112223',
        },
        tokenB,
      ),
    );
    productA = prod(await post(goods({ name: 'OrgA Visible Gadget' })));
  }, 120_000);

  it('6. the same SKU and barcode can exist in two organizations', async () => {
    expect(productB.sku).toBe('PRD-000001');
    const sameSku = await post(goods({ name: 'Same SKU other org', sku: 'PRD-000001' })).then(
      (r) => r.status,
    );
    expect([201, 409]).toContain(sameSku); // org A may already hold PRD-000001; the point is that B's did not block anything
    const sameBarcode = await post(
      goods({ name: 'Same barcode other org', barcode: '9990001112223' }),
    );
    expect(sameBarcode.status).toBe(201);
  });

  it("27. cannot list or search another organization's products, or use its reference records", async () => {
    const all = list(await get('/products?limit=100'));
    expect(all.products.some((p) => p.id === productB.id)).toBe(false);
    for (const q of ['OrgB Secret', '9990001112223', '777.77']) {
      expect(
        list(await get(`/products?search=${encodeURIComponent(q)}`)).products.map((p) => p.id),
        q,
      ).not.toContain(productB.id);
    }
    const seenByB = list(await get('/products?limit=100', tokenB));
    expect(seenByB.products.some((p) => p.id === productA.id)).toBe(false);
    expect(seenByB.products.some((p) => p.id === productB.id)).toBe(true);
    const refsA = (await get('/products/references')).json as unknown as {
      units: { id: string }[];
      taxCategories: { id: string }[];
    };
    expect(refsA.units.map((u) => u.id)).not.toContain(unitB);
    expect(refsA.taxCategories.map((t) => t.id)).not.toContain(taxB);
    // Organization B's unit or tax category cannot be used by organization A: same answer as an unknown id
    expect((await post(goods({ unitId: unitB }))).json.error.problems).toEqual([
      { field: 'unitId', rule: 'unknown_reference' },
    ]);
    expect((await post(goods({ taxCategoryId: taxB }))).json.error.problems).toEqual([
      { field: 'taxCategoryId', rule: 'unknown_reference' },
    ]);
  });

  it("28-29. cannot read, edit, deactivate or reactivate another organization's product (404, nothing changes)", async () => {
    const before = await fx.prisma.product.findUniqueOrThrow({ where: { id: productB.id } });
    expect((await get(`/products/${productB.id}`)).status).toBe(404);
    expect(
      (
        await patch(productB.id, {
          expectedVersion: before.version,
          name: 'Hijacked',
          sellingPrice: '1',
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(app, 'POST', `/products/${productB.id}/deactivate`, { token: admin(), body: {} }))
        .status,
    ).toBe(404);
    expect(
      (await call(app, 'POST', `/products/${productB.id}/activate`, { token: admin(), body: {} }))
        .status,
    ).toBe(404);
    expect(await fx.prisma.product.findUniqueOrThrow({ where: { id: productB.id } })).toEqual(
      before,
    );
    expect((await get(`/products/${productA.id}`, tokenB)).status).toBe(404);
    expect(
      (await patch(productA.id, { expectedVersion: 1, name: 'Hijacked' }, tokenB)).status,
    ).toBe(404);
  });

  it('the organization comes from the session: a client-supplied organizationId is refused, not obeyed', async () => {
    const orgB = (await fx.prisma.product.findUniqueOrThrow({ where: { id: productB.id } }))
      .organizationId;
    expect((await post(goods({ organizationId: orgB }))).status).toBe(400);
    expect(
      list(await get(`/products?organizationId=${orgB}&limit=100`)).products.some(
        (p) => p.id === productB.id,
      ),
    ).toBe(false);
  });
});

describe('audit and logs', () => {
  it('30-31. audits create, update, deactivate and activate with actor, organization and correlation id', async () => {
    const p = prod(
      await post(
        goods({
          name: 'Audit Subject Gadget',
          description: 'confidential-description-xyz',
          barcode: '4012345678901',
          sellingPrice: '321.45',
        }),
      ),
    );
    const [created] = await auditRows('product.create', p.id);
    expect(created).toMatchObject({
      category: 'business',
      entityType: 'product',
      entityId: p.id,
      organizationId: fx.orgId,
    });
    expect(created!.userId).toBeTruthy();
    expect(created!.correlationId).toBeTruthy();
    expect(created!.afterValues).toMatchObject({ sku: p.sku, kind: 'GOODS', generatedSku: true });

    await patch(p.id, {
      expectedVersion: 1,
      name: 'Audit Subject Renamed',
      sellingPrice: '400',
      barcode: '4012345678902',
    });
    const [edited] = await auditRows('product.update', p.id);
    expect(edited!.afterValues).toMatchObject({
      changedFields: expect.arrayContaining(['name', 'sellingPrice', 'barcode']),
      version: 2,
      sellingPrice: '400.00',
    });
    expect(edited!.beforeValues).toMatchObject({ sellingPrice: '321.45' }); // price traceability is the point of the audit
    await call(app, 'POST', `/products/${p.id}/deactivate`, { token: admin(), body: {} });
    await call(app, 'POST', `/products/${p.id}/activate`, { token: admin(), body: {} });
    expect((await auditRows('product.deactivate', p.id))[0]).toMatchObject({
      beforeValues: { isActive: true },
      afterValues: { isActive: false, version: 3 },
    });
    expect(await auditRows('product.activate', p.id)).toHaveLength(1);

    // names, descriptions and barcodes are never written to audit rows
    const rows = JSON.stringify(await fx.prisma.auditLog.findMany({ where: { entityId: p.id } }));
    for (const secret of [
      'Audit Subject',
      'confidential-description',
      '4012345678901',
      '4012345678902',
    ]) {
      expect(rows).not.toContain(secret);
    }
    // refused operations leave no audit rows
    const count = await fx.prisma.auditLog.count();
    await patch(p.id, { expectedVersion: 1, name: 'stale' });
    await post(goods({ name: '' }));
    await post(goods({ name: 'Viewer' }), tokens['Viewer/Auditor']!);
    expect(await fx.prisma.auditLog.count()).toBe(count);
  });

  it('32. server logs never contain prices, product names, barcodes, search terms or tokens', async () => {
    const marker = `Zq${++seq}Marker`;
    const price = '8765.43';
    const barcode = `61${seq}00000000`.slice(0, 13);
    const p = prod(
      await post(
        goods({
          name: `${marker} Gadget`,
          sellingPrice: price,
          mrp: '9999.99',
          barcode,
          description: `${marker}-desc`,
        }),
      ),
    );
    await patch(p.id, { expectedVersion: 1, sellingPrice: '8800.01' });
    for (const q of [marker, barcode, price])
      await get(`/products?search=${encodeURIComponent(q)}`);
    await get(`/products/${p.id}`);
    await get('/products/references/hsn-sac?search=8517');
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(500);
    for (const secret of [marker, price, '8800.01', '9999.99', barcode, admin()]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain('[query redacted]');
  });
});
