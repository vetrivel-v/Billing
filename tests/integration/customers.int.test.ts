import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { gstinCheckCharacter } from '../../packages/setup/src/validators.js';
import { ROLE_TEMPLATES, seedReference } from '../../prisma/seed/reference/index.js';
import {
  PASSWORD,
  call,
  createFixture,
  createRoleUsers,
  login,
  type ApiJson,
  type Fixture,
} from './auth-fixture.js';

let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;
let logs: string[];
let seq = 0;

/** A structurally valid GSTIN (format + check character) - fictional, not a real registration. */
function gstin(state: string, pan: string, entity = '1') {
  const first14 = `${state}${pan}${entity}Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
}
const PAN_A = 'ABCDE1234F';
const PAN_B = 'PQRST5678K';
const uniqPan = () => {
  const n = String(++seq).padStart(4, '0');
  return `AAAAA${n}A`;
};

interface Cust {
  id: string;
  code: string;
  version: number;
  isActive: boolean;
  [k: string]: unknown;
}
const cust = (r: { json: ApiJson }) => r.json.customer as unknown as Cust;
const list = (r: { json: ApiJson }) =>
  r.json as unknown as { customers: Cust[]; total: number; limit: number; offset: number };

const b2c = (over: Record<string, unknown> = {}) => ({
  customerKind: 'INDIVIDUAL',
  legalName: 'Walk-in Customer',
  billingAddressLine1: '1 Test Lane',
  billingStateCode: '27',
  gstStatus: 'UNREGISTERED',
  ...over,
});
const b2b = (over: Record<string, unknown> = {}) => {
  const pan = uniqPan();
  return {
    customerKind: 'BUSINESS',
    legalName: `Fictional Buyer ${seq} Pvt Ltd`,
    billingAddressLine1: '22 Example Street',
    billingStateCode: '27',
    gstStatus: 'REGISTERED',
    pan,
    gstin: gstin('27', pan),
    ...over,
  };
};

const admin = () => tokens['Administrator']!;
const post = (body: unknown, token = admin()) => call(app, 'POST', '/customers', { token, body });
const patch = (id: string, body: unknown, token = admin()) =>
  call(app, 'PATCH', `/customers/${id}`, { token, body });
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
}, 120_000);
afterAll(async () => fx?.close());

describe('creating customers', () => {
  it('1. creates a B2C customer with a generated code and sensible defaults', async () => {
    const r = await post(b2c());
    expect(r.status).toBe(201);
    const c = cust(r);
    expect(c.code).toMatch(/^CUS-\d{6,}$/);
    expect(c).toMatchObject({
      customerKind: 'INDIVIDUAL',
      gstStatus: 'UNREGISTERED',
      gstin: null,
      isActive: true,
      version: 1,
      country: 'IN',
      shippingSameAsBilling: true,
      placeOfSupplyStateCode: '27',
      placeOfSupplyStateName: 'Maharashtra',
      billingStateName: 'Maharashtra',
    });
    expect(c.id).not.toBe(c.code); // internal id and display code are different things
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('2. creates a registered B2B customer with a separate shipping address; place of supply follows delivery', async () => {
    const pan = uniqPan();
    const r = await post(
      b2b({
        pan,
        gstin: gstin('27', pan),
        displayName: 'Buyer Trading',
        contactPerson: 'Meera Joshi',
        email: 'Accounts@Example.test',
        phone: '+91 98765 43210',
        alternatePhone: '022-2345 6789',
        shippingSameAsBilling: false,
        shippingAddressLine1: '9 Dock Road',
        shippingCity: 'Bengaluru',
        shippingStateCode: '29',
        shippingPinCode: '560001',
        creditLimit: 50000,
        paymentTermsDays: 30,
        notes: 'Fictional customer for tests',
      }),
    );
    expect(r.status).toBe(201);
    expect(cust(r)).toMatchObject({
      gstStatus: 'REGISTERED',
      shippingSameAsBilling: false,
      shippingStateCode: '29',
      shippingStateName: 'Karnataka',
      placeOfSupplyStateCode: '29', // defaults to the delivery state
      creditLimit: '50000.00',
      paymentTermsDays: 30,
      email: 'Accounts@Example.test',
    });
    const explicit = await post(
      b2b({
        shippingSameAsBilling: false,
        shippingAddressLine1: '1 Dock',
        shippingStateCode: '29',
        placeOfSupplyStateCode: '27',
      }),
    );
    expect(cust(explicit).placeOfSupplyStateCode).toBe('27'); // an explicit choice is kept
  });

  it('3-5. GST rules: registered needs a valid GSTIN; unregistered does not', async () => {
    const problems = (r: { json: ApiJson }) => r.json.error.problems;
    const noGstin = await post(b2b({ gstin: undefined }));
    expect(noGstin.status).toBe(400);
    expect(noGstin.json.error.code).toBe('VAL_0001');
    expect(problems(noGstin)).toEqual([{ field: 'gstin', rule: 'gstin_required' }]);
    expect(noGstin.body).not.toContain('Fictional Buyer'); // value-free

    const malformed = await post(b2b({ gstin: 'NOT-A-GSTIN' }));
    expect(problems(malformed)).toEqual([{ field: 'gstin', rule: 'invalid_gstin_format' }]);

    const g = gstin('27', PAN_A);
    const badCheck = await post(
      b2b({ pan: PAN_A, gstin: g.slice(0, 14) + (g[14] === 'A' ? 'B' : 'A') }),
    );
    expect(problems(badCheck)).toEqual([{ field: 'gstin', rule: 'invalid_gstin_checksum' }]);

    const wrongState = await post(b2b({ billingStateCode: '29' })); // GSTIN is a Maharashtra (27) one
    expect(problems(wrongState)).toEqual([{ field: 'gstin', rule: 'gstin_state_mismatch' }]);

    const wrongPan = await post(b2b({ pan: PAN_B }));
    expect(problems(wrongPan)).toEqual([{ field: 'gstin', rule: 'gstin_pan_mismatch' }]);

    const unregWithGstin = await post(b2b({ gstStatus: 'UNREGISTERED' }));
    expect(problems(unregWithGstin)).toEqual([{ field: 'gstin', rule: 'gstin_not_allowed' }]);

    // The customer kind is independent of GST registration: an individual may be registered (and then needs a GSTIN).
    const individualRegistered = await post(
      b2c({
        gstStatus: 'REGISTERED',
        gstin: gstin('27', uniqPan()),
        legalName: 'Registered Individual',
      }),
    );
    expect(individualRegistered.json.error?.problems).toBeUndefined();
    expect(individualRegistered.status).toBe(201);
    expect(cust(individualRegistered)).toMatchObject({
      customerKind: 'INDIVIDUAL',
      gstStatus: 'REGISTERED',
    });
    const compositionNoGstin = await post(
      b2b({
        gstStatus: 'COMPOSITION',
        gstin: undefined,
        pan: undefined,
        legalName: 'Composition Co',
      }),
    );
    expect(problems(compositionNoGstin)).toEqual([{ field: 'gstin', rule: 'gstin_required' }]);

    const unregB2b = await post(
      b2b({
        gstStatus: 'UNREGISTERED',
        gstin: undefined,
        pan: undefined,
        legalName: 'Unregistered Trader',
      }),
    );
    expect(unregB2b.status).toBe(201); // a business without GST registration needs no GSTIN
    // a composition-scheme customer is registered too: it has a GSTIN (it was optional before Task 1.12)
    const composition = await post(
      b2b({ gstStatus: 'COMPOSITION', legalName: 'Composition Trader' }),
    );
    expect(composition.status).toBe(201);
    expect(cust(composition)).toMatchObject({ gstStatus: 'COMPOSITION' });
  });

  it('validates the other fields with value-free problems and rejects unknown or smuggled fields', async () => {
    const r = await post(
      b2c({
        legalName: '   ',
        email: 'not-an-email',
        phone: 'abc',
        billingStateCode: '98',
        billingPinCode: '012345',
        creditLimit: '-5',
        paymentTermsDays: 400,
        pan: 'bad',
      }),
    );
    expect(r.status).toBe(400);
    const rules = new Map(r.json.error.problems!.map((p) => [p.field, p.rule]));
    expect(rules.get('legalName')).toBe('required');
    expect(rules.get('email')).toBe('invalid_email');
    expect(rules.get('phone')).toBe('invalid_phone');
    expect(rules.get('billingStateCode')).toBe('unknown_state_code');
    expect(rules.get('billingPinCode')).toBe('invalid_pin_code');
    expect(rules.get('creditLimit')).toBe('invalid_amount');
    expect(rules.get('paymentTermsDays')).toBe('out_of_range');
    expect(rules.get('pan')).toBe('invalid_pan_format');
    for (const extra of [
      { organizationId: fx.orgId },
      { id: '00000000-0000-4000-8000-000000000001' },
      { isActive: false },
      { version: 9 },
    ]) {
      const s = await post(b2c(extra));
      expect(s.status).toBe(400);
      expect(s.json.error.problems![0]!.rule).toBe('unknown_field');
    }
    expect((await post([1, 2])).status).toBe(400); // not an object
  });

  it('shipping details are required only when delivery differs from billing', async () => {
    const r = await post(b2c({ shippingSameAsBilling: false }));
    expect(r.json.error.problems).toEqual(
      expect.arrayContaining([
        { field: 'shippingAddressLine1', rule: 'required' },
        { field: 'shippingStateCode', rule: 'required' },
      ]),
    );
    // shipping fields sent alongside "same as billing" are ignored, not stored
    const s = await post(
      b2c({
        shippingSameAsBilling: true,
        shippingAddressLine1: 'ignored',
        shippingStateCode: '29',
      }),
    );
    expect(cust(s)).toMatchObject({ shippingAddressLine1: null, shippingStateCode: null });
  });
});

describe('customer codes and duplicates', () => {
  it('6. generates sequential codes, accepts a manual code (upper-cased), and refuses a duplicate code', async () => {
    const a = cust(await post(b2c({ legalName: 'Seq A' })));
    const b = cust(await post(b2c({ legalName: 'Seq B' })));
    const n = (c: Cust) => Number(c.code.slice(4));
    expect(n(b)).toBe(n(a) + 1);
    const manual = await post(b2c({ legalName: 'Manual', code: 'acme-01' }));
    expect(cust(manual).code).toBe('ACME-01');
    const dup = await post(b2c({ legalName: 'Manual again', code: 'ACME-01' }));
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('BIZ_0001');
    expect(dup.json.error.problems).toEqual([{ field: 'code', rule: 'duplicate_code' }]);
    expect((await post(b2c({ code: 'bad code!' }))).json.error.problems).toEqual([
      { field: 'code', rule: 'invalid_code' },
    ]);
  });

  it('a generated code skips a number that was already typed in by hand', async () => {
    const probe = cust(await post(b2c({ legalName: 'Probe' })));
    const next = `CUS-${String(Number(probe.code.slice(4)) + 1).padStart(6, '0')}`;
    expect(cust(await post(b2c({ legalName: 'Hand typed', code: next }))).code).toBe(next);
    const after = cust(await post(b2c({ legalName: 'After' })));
    expect(Number(after.code.slice(4))).toBe(Number(probe.code.slice(4)) + 2);
  });

  it('concurrent creations get distinct codes', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => post(b2c({ legalName: `Parallel ${i}` }))),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const codes = results.map((r) => cust(r).code);
    expect(new Set(codes).size).toBe(8);
  });

  it('refuses a second customer with the same GSTIN in the organization', async () => {
    const first = b2b();
    expect((await post(first)).status).toBe(201);
    const dup = await post({ ...first, legalName: 'Second record' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.problems).toEqual([{ field: 'gstin', rule: 'duplicate_gstin' }]);
  });
});

describe('listing, search and reading', () => {
  beforeAll(async () => {
    for (let i = 1; i <= 7; i++) {
      await post(
        b2c({ legalName: `Pagetest ${String(i).padStart(2, '0')}`, phone: `98000000${i}0` }),
      );
    }
    await post(
      b2b({
        legalName: 'Pagetest Registered',
        displayName: 'Searchable Display',
        phone: '9111111111',
      }),
    );
  });

  it('8. paginates with stable ordering and reports the total', async () => {
    const page = async (offset: number) =>
      list(
        await call(app, 'GET', `/customers?search=Pagetest&limit=3&offset=${offset}`, {
          token: admin(),
        }),
      );
    const p1 = await page(0);
    const p2 = await page(3);
    const p3 = await page(6);
    expect(p1.total).toBe(8);
    expect([p1.customers.length, p2.customers.length, p3.customers.length]).toEqual([3, 3, 2]);
    const names = [...p1.customers, ...p2.customers, ...p3.customers].map(
      (c) => c.legalName as string,
    );
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(new Set(names).size).toBe(8);
    expect(p1).toMatchObject({ limit: 3, offset: 0 });
    for (const q of ['limit=101', 'limit=0', 'offset=-1', 'isActive=maybe', 'kind=B3']) {
      expect((await call(app, 'GET', `/customers?${q}`, { token: admin() })).status, q).toBe(400);
    }
  });

  it('9. searches code, name, display name, phone and GSTIN against the database', async () => {
    const search = async (q: string) =>
      list(
        await call(app, 'GET', `/customers?search=${encodeURIComponent(q)}`, { token: admin() }),
      );
    expect((await search('pagetest 03')).customers.map((c) => c.legalName)).toEqual([
      'Pagetest 03',
    ]); // case-insensitive
    expect((await search('searchable display')).customers).toHaveLength(1);
    expect((await search('9800000030')).customers.map((c) => c.legalName)).toEqual(['Pagetest 03']); // phone
    const reg = (await search('Pagetest Registered')).customers[0]!;
    expect((await search(String(reg.code).toLowerCase())).customers.map((c) => c.id)).toContain(
      reg.id,
    ); // code
    expect((await search(String(reg.gstin).toLowerCase())).customers.map((c) => c.id)).toEqual([
      reg.id,
    ]); // GSTIN
    expect((await search('no-such-customer-anywhere')).total).toBe(0);
    expect((await search('%')).total).toBe(0); // wildcards are literal text, not a pattern
    expect((await search('_')).total).toBe(0);
    // a literal percent sign in a name is found as text
    const pct = cust(await post(b2c({ legalName: 'Fifty%Off Traders' })));
    expect((await search('50%')).total).toBe(0);
    expect((await search('Fifty%Off')).customers.map((c) => c.id)).toEqual([pct.id]);
    expect((await search("x'; DROP TABLE customers; --")).total).toBe(0); // and the database is intact
    expect((await call(app, 'GET', '/customers', { token: admin() })).status).toBe(200);
  });

  it('filters by type and by active status', async () => {
    const b2bOnly = list(
      await call(app, 'GET', '/customers?kind=BUSINESS&limit=100', { token: admin() }),
    );
    expect(b2bOnly.customers.every((c) => c.customerKind === 'BUSINESS')).toBe(true);
    const victim = cust(await post(b2c({ legalName: 'Filter Victim' })));
    await call(app, 'POST', `/customers/${victim.id}/deactivate`, { token: admin(), body: {} });
    const inactive = list(
      await call(app, 'GET', '/customers?isActive=false&limit=100', { token: admin() }),
    );
    expect(inactive.customers.map((c) => c.id)).toContain(victim.id);
    expect(inactive.customers.every((c) => c.isActive === false)).toBe(true);
    const active = list(
      await call(app, 'GET', '/customers?isActive=true&limit=100&search=Filter%20Victim', {
        token: admin(),
      }),
    );
    expect(active.total).toBe(0);
  });

  it('gets one customer; unknown and malformed ids are 404', async () => {
    const c = cust(await post(b2c({ legalName: 'Get Me' })));
    const r = await call(app, 'GET', `/customers/${c.id}`, { token: admin() });
    expect(r.status).toBe(200);
    expect(cust(r).legalName).toBe('Get Me');
    expect(
      (
        await call(app, 'GET', '/customers/00000000-0000-4000-8000-000000000009', {
          token: admin(),
        })
      ).status,
    ).toBe(404);
    expect((await call(app, 'GET', '/customers/not-a-uuid', { token: admin() })).status).toBe(404);
  });
});

describe('editing, activation and concurrency', () => {
  it('10. edits a customer, bumps the version, and a no-op edit changes nothing', async () => {
    const c = cust(await post(b2c({ legalName: 'Before Edit', phone: '9222222222' })));
    const r = await patch(c.id, {
      expectedVersion: 1,
      legalName: 'After Edit',
      phone: '9333333333',
      creditLimit: '1200.5',
      paymentTermsDays: 15,
    });
    expect(r.status).toBe(200);
    expect(cust(r)).toMatchObject({
      legalName: 'After Edit',
      phone: '9333333333',
      version: 2,
      creditLimit: '1200.50',
      code: c.code,
    });
    const same = await patch(c.id, { expectedVersion: 2, legalName: 'After Edit' });
    expect(cust(same).version).toBe(2); // nothing changed: no new version
    expect(await auditRows('customer.update', c.id)).toHaveLength(1);
    const clear = await patch(c.id, { expectedVersion: 2, phone: null, creditLimit: null });
    expect(cust(clear)).toMatchObject({ phone: null, creditLimit: null, version: 3 });
  });

  it('keeps the whole record valid after a partial edit (rules apply to the merged result)', async () => {
    const b = cust(await post(b2b({ legalName: 'Edit Rules Co' })));
    const toUnregistered = await patch(b.id, { expectedVersion: 1, gstStatus: 'UNREGISTERED' });
    expect(toUnregistered.json.error.problems).toEqual([
      { field: 'gstin', rule: 'gstin_not_allowed' },
    ]);
    const ok = await patch(b.id, {
      expectedVersion: 1,
      gstStatus: 'UNREGISTERED',
      gstin: null,
      pan: null,
    });
    expect(cust(ok)).toMatchObject({ gstStatus: 'UNREGISTERED', gstin: null });
    const toIndividual = await patch(b.id, { expectedVersion: 2, customerKind: 'INDIVIDUAL' });
    expect(toIndividual.status).toBe(200);
    // the kind never constrains the GST status: a registered individual is valid, and a composition customer needs a GSTIN
    const registered = await patch(b.id, {
      expectedVersion: 3,
      gstStatus: 'REGISTERED',
      gstin: gstin('27', uniqPan()),
    });
    expect(registered.status).toBe(200);
    const compositionWithoutGstin = await patch(b.id, {
      expectedVersion: 4,
      gstStatus: 'COMPOSITION',
      gstin: null,
    });
    expect(compositionWithoutGstin.json.error.problems).toEqual([
      { field: 'gstin', rule: 'gstin_required' },
    ]);
  });

  it('the place of supply follows an address change unless set explicitly; the code never changes', async () => {
    const c = cust(await post(b2c({ legalName: 'Move House' })));
    const moved = await patch(c.id, { expectedVersion: 1, billingStateCode: '29' });
    expect(cust(moved)).toMatchObject({ billingStateCode: '29', placeOfSupplyStateCode: '29' });
    const pinned = await patch(c.id, {
      expectedVersion: 2,
      billingStateCode: '07',
      placeOfSupplyStateCode: '27',
    });
    expect(cust(pinned)).toMatchObject({ billingStateCode: '07', placeOfSupplyStateCode: '27' });
    const code = await patch(c.id, { expectedVersion: 3, code: 'NEW-CODE' });
    expect(code.status).toBe(400);
    expect(code.json.error.problems).toEqual([{ field: 'code', rule: 'unknown_field' }]);
    expect((await patch(c.id, { legalName: 'No version' })).status).toBe(400);
    expect((await patch(c.id, { expectedVersion: 'x', legalName: 'Bad version' })).status).toBe(
      400,
    );
    expect(
      (await call(app, 'GET', `/customers/${c.id}`, { token: admin() })).json.customer,
    ).toMatchObject({ code: c.code, version: 3 });
  });

  it('refuses to move a GSTIN onto another customer', async () => {
    const a = cust(await post(b2b()));
    const b = cust(await post(b2b()));
    const r = await patch(b.id, { expectedVersion: 1, pan: a.pan, gstin: a.gstin });
    expect(r.status).toBe(409);
    expect(r.json.error.problems).toEqual([{ field: 'gstin', rule: 'duplicate_gstin' }]);
  });

  it('11-12. deactivates and reactivates idempotently, keeps the record readable and editable, and never deletes', async () => {
    const c = cust(await post(b2c({ legalName: 'Toggle Me' })));
    const off = await call(app, 'POST', `/customers/${c.id}/deactivate`, {
      token: admin(),
      body: {},
    });
    expect(off.status).toBe(200);
    expect(cust(off)).toMatchObject({ isActive: false, version: 2 });
    const again = await call(app, 'POST', `/customers/${c.id}/deactivate`, { token: admin() });
    expect(cust(again).version).toBe(2); // already inactive: unchanged
    expect((await call(app, 'GET', `/customers/${c.id}`, { token: admin() })).status).toBe(200);
    expect((await patch(c.id, { expectedVersion: 2, notes: 'edited while inactive' })).status).toBe(
      200,
    );
    const on = await call(app, 'POST', `/customers/${c.id}/activate`, {
      token: admin(),
      body: { expectedVersion: 3 },
    });
    expect(cust(on)).toMatchObject({ isActive: true, version: 4 });
    expect(await auditRows('customer.deactivate', c.id)).toHaveLength(1);
    expect(await auditRows('customer.activate', c.id)).toHaveLength(1);
    // there is no delete route at all
    const del = await app.inject({
      method: 'DELETE',
      url: `/customers/${c.id}`,
      headers: { 'x-commercebill-launch-secret': 'x', authorization: `Bearer ${admin()}` },
    });
    expect([401, 404, 405]).toContain(del.statusCode);
    expect(await fx.prisma.customer.count({ where: { id: c.id } })).toBe(1);
  });

  it('13. an edit based on an old version is refused (409) and nothing is overwritten', async () => {
    const c = cust(await post(b2c({ legalName: 'Race Co' })));
    const userA = admin();
    const userB = tokens['Accountant']!;
    // both load version 1
    expect(cust(await call(app, 'GET', `/customers/${c.id}`, { token: userA })).version).toBe(1);
    expect(cust(await call(app, 'GET', `/customers/${c.id}`, { token: userB })).version).toBe(1);
    const a = await patch(c.id, { expectedVersion: 1, legalName: 'Edited By A' }, userA);
    expect(cust(a).version).toBe(2);
    const b = await patch(
      c.id,
      { expectedVersion: 1, legalName: 'Edited By B', notes: 'B was here' },
      userB,
    );
    expect(b.status).toBe(409);
    expect(b.json.error.code).toBe('DB_0002');
    expect(b.json.error.message).toMatch(/Reload/);
    const now = cust(await call(app, 'GET', `/customers/${c.id}`, { token: userA }));
    expect(now).toMatchObject({ legalName: 'Edited By A', notes: null, version: 2 });
    // stale activation/deactivation is refused too
    const stale = await call(app, 'POST', `/customers/${c.id}/deactivate`, {
      token: userB,
      body: { expectedVersion: 1 },
    });
    expect(stale.status).toBe(409);
    expect(cust(await call(app, 'GET', `/customers/${c.id}`, { token: userA })).isActive).toBe(
      true,
    );
  });

  it('two simultaneous edits of the same version: exactly one wins', async () => {
    const c = cust(await post(b2c({ legalName: 'Photo Finish' })));
    const [x, y] = await Promise.all([
      patch(c.id, { expectedVersion: 1, legalName: 'Winner X' }),
      patch(c.id, { expectedVersion: 1, legalName: 'Winner Y' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(cust(await call(app, 'GET', `/customers/${c.id}`, { token: admin() })).version).toBe(2);
  });
});

describe('authentication and authorization (exact permission keys)', () => {
  let target: Cust;
  beforeAll(async () => {
    target = cust(await post(b2c({ legalName: 'Authz Target' })));
  });

  const routes = (id: string) => [
    { name: 'list', method: 'GET' as const, url: '/customers', write: false },
    { name: 'get', method: 'GET' as const, url: `/customers/${id}`, write: false },
    {
      name: 'create',
      method: 'POST' as const,
      url: '/customers',
      write: true,
      body: () => b2c({ legalName: `Authz ${++seq}` }),
    },
    {
      name: 'update',
      method: 'PATCH' as const,
      url: `/customers/${id}`,
      write: true,
      body: () => ({ expectedVersion: 1, notes: `n${++seq}` }),
    },
    {
      name: 'activate',
      method: 'POST' as const,
      url: `/customers/${id}/activate`,
      write: true,
      body: () => ({}),
    },
    {
      name: 'deactivate',
      method: 'POST' as const,
      url: `/customers/${id}/deactivate`,
      write: true,
      body: () => ({}),
    },
  ];

  it('14. no session is 401 AUTH_0001 and a missing launch secret is 401, on every route', async () => {
    for (const r of routes(target.id)) {
      const none = await call(app, r.method, r.url, { body: r.body?.() });
      expect(none.status, r.name).toBe(401);
      expect(none.json.error.code).toBe('AUTH_0001');
      const noLaunch = await call(app, r.method, r.url, {
        body: r.body?.(),
        token: admin(),
        launch: false,
      });
      expect(noLaunch.status, r.name).toBe(401);
    }
  });

  it('15-18. every role template gets exactly what its customer.read / customer.write grants allow', async () => {
    for (const template of ROLE_TEMPLATES) {
      const grants = new Set<string>(template.grants);
      const canRead = grants.has('customer.read');
      const canWrite = grants.has('customer.write');
      for (const r of routes(target.id)) {
        const res = await call(app, r.method, r.url, {
          token: tokens[template.name]!,
          body: r.body?.(),
        });
        const allowed = r.write ? canWrite : canRead;
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

  it('the permission catalogue gives the expected shape: Administrator and Billing Operator write, Viewer/Auditor reads only', async () => {
    const byName = new Map(ROLE_TEMPLATES.map((t) => [t.name, new Set<string>(t.grants)]));
    expect(byName.get('Administrator')!.has('customer.write')).toBe(true);
    expect(byName.get('Billing Operator')!.has('customer.write')).toBe(true);
    // the Viewer/Auditor cannot write; whether it can read is decided by the catalogue, and tested above
    expect(byName.get('Viewer/Auditor')!.has('customer.write')).toBe(false);
    const viewerWrite = await post(b2c({ legalName: 'Viewer attempt' }), tokens['Viewer/Auditor']!);
    expect(viewerWrite.status).toBe(403);
    expect(await fx.prisma.customer.count({ where: { legalName: 'Viewer attempt' } })).toBe(0);
  });

  it('authorises by permission key, not by role name', async () => {
    const reader = await fx.prisma.role
      .create({
        data: {
          organizationId: fx.orgId,
          name: 'Custom Reader',
          permissions: { create: [{ permission: { connect: { key: 'customer.read' } } }] },
        },
      })
      .catch(async () => {
        const p = await fx.prisma.permission.findFirstOrThrow({ where: { key: 'customer.read' } });
        return fx.prisma.role.create({
          data: {
            organizationId: fx.orgId,
            name: 'Custom Reader',
            permissions: { create: [{ permissionId: p.id }] },
          },
        });
      });
    expect(reader.name).toBe('Custom Reader');
    const username = `reader.${++seq}`;
    await app.authService!.createUser({
      organizationId: fx.orgId,
      username,
      displayName: 'Reader',
      password: PASSWORD,
      roleNames: ['Custom Reader'],
    });
    const token = (await login(app, username)).json.token as string;
    expect((await call(app, 'GET', '/customers', { token })).status).toBe(200);
    expect((await post(b2c(), token)).status).toBe(403);
    expect(
      (await call(app, 'POST', `/customers/${target.id}/deactivate`, { token, body: {} })).status,
    ).toBe(403);
  });
});

describe('organization isolation', () => {
  let orgB: string;
  let tokenB: string;
  let customerB: Cust;
  let customerA: Cust;

  beforeAll(async () => {
    const org = await fx.prisma.organization.create({
      data: { legalName: 'DEMO Other Co (fictional)' },
    });
    orgB = org.id;
    await seedReference(fx.prisma, { organizationId: orgB });
    await app.authService!.createUser({
      organizationId: orgB,
      username: 'admin.orgb',
      displayName: 'Admin B',
      password: PASSWORD,
      roleNames: ['Administrator'],
    });
    const loginB = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        'x-commercebill-launch-secret': (await import('./auth-fixture.js')).LAUNCH_SECRET,
      },
      payload: { username: 'admin.orgb', password: PASSWORD, organizationId: orgB },
    });
    tokenB = (loginB.json() as { token: string }).token;
    customerB = cust(
      await post(
        b2b({ legalName: 'OrgB Secret Buyer', code: 'CUS-000001', phone: '9444444444' }),
        tokenB,
      ),
    );
    customerA = cust(await post(b2c({ legalName: 'OrgA Visible Buyer' })));
  }, 120_000);

  it('7. the same customer code can exist in two organizations (codes are scoped per organization)', async () => {
    expect(customerB.code).toBe('CUS-000001');
    expect(
      await fx.prisma.customer.count({ where: { code: 'CUS-000001' } }),
    ).toBeGreaterThanOrEqual(2);
    const sameGstin = await post(
      b2b({ legalName: 'Same GSTIN other org', pan: customerB.pan, gstin: customerB.gstin }),
    );
    expect(sameGstin.status).toBe(201); // GSTIN uniqueness is per organization too
  });

  it("19. cannot list or search another organization's customers", async () => {
    const all = list(await call(app, 'GET', '/customers?limit=100', { token: admin() }));
    expect(all.customers.some((c) => c.id === customerB.id)).toBe(false);
    for (const q of ['OrgB Secret', '9444444444', String(customerB.gstin)]) {
      expect(
        list(
          await call(app, 'GET', `/customers?search=${encodeURIComponent(q)}`, { token: admin() }),
        ).customers.map((c) => c.id),
        q,
      ).not.toContain(customerB.id);
    }
    const seenByB = list(await call(app, 'GET', '/customers?limit=100', { token: tokenB }));
    expect(seenByB.customers.some((c) => c.id === customerA.id)).toBe(false);
    expect(seenByB.customers.some((c) => c.id === customerB.id)).toBe(true);
  });

  it("20-21. cannot read, edit, deactivate or reactivate another organization's customer (404, nothing changes)", async () => {
    const before = await fx.prisma.customer.findUniqueOrThrow({ where: { id: customerB.id } });
    expect((await call(app, 'GET', `/customers/${customerB.id}`, { token: admin() })).status).toBe(
      404,
    );
    const edit = await patch(customerB.id, {
      expectedVersion: before.version,
      legalName: 'Hijacked',
    });
    expect(edit.status).toBe(404);
    expect(
      (
        await call(app, 'POST', `/customers/${customerB.id}/deactivate`, {
          token: admin(),
          body: {},
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(app, 'POST', `/customers/${customerB.id}/activate`, { token: admin(), body: {} }))
        .status,
    ).toBe(404);
    const after = await fx.prisma.customer.findUniqueOrThrow({ where: { id: customerB.id } });
    expect(after).toEqual(before);
    // and the reverse direction
    expect((await call(app, 'GET', `/customers/${customerA.id}`, { token: tokenB })).status).toBe(
      404,
    );
    expect(
      (await patch(customerA.id, { expectedVersion: 1, legalName: 'Hijacked' }, tokenB)).status,
    ).toBe(404);
  });

  it('the organization comes from the session: a client-supplied organizationId is refused, not obeyed', async () => {
    const r = await post(b2c({ organizationId: orgB }));
    expect(r.status).toBe(400);
    const q = await call(app, 'GET', `/customers?organizationId=${orgB}`, { token: admin() });
    expect(list(q).customers.some((c) => c.id === customerB.id)).toBe(false);
    expect(await fx.prisma.customer.count({ where: { organizationId: orgB } })).toBe(1);
  });
});

describe('audit and logs', () => {
  it('22-23. writes audit events for create, edit, deactivate and activate, without personal data', async () => {
    const before = await fx.prisma.auditLog.count();
    const c = cust(
      await post(
        b2c({
          legalName: 'Audit Subject Ltd',
          email: 'private.person@example.test',
          phone: '9555555555',
          notes: 'confidential-note-xyz',
        }),
      ),
    );
    const [created] = await auditRows('customer.create', c.id);
    expect(created).toMatchObject({
      category: 'business',
      entityType: 'customer',
      entityId: c.id,
      organizationId: fx.orgId,
    });
    expect(created!.userId).toBeTruthy();
    expect(created!.correlationId).toBeTruthy();
    expect(created!.afterValues).toMatchObject({
      code: c.code,
      customerKind: 'INDIVIDUAL',
      gstStatus: 'UNREGISTERED',
      generatedCode: true,
    });

    await patch(c.id, {
      expectedVersion: 1,
      legalName: 'Audit Subject Renamed',
      phone: '9666666666',
      paymentTermsDays: 45,
    });
    const [edited] = await auditRows('customer.update', c.id);
    expect(edited!.afterValues).toMatchObject({
      changedFields: expect.arrayContaining(['legalName', 'phone', 'paymentTermsDays']),
      version: 2,
      paymentTermsDays: 45,
    });
    expect(edited!.beforeValues).toMatchObject({ paymentTermsDays: null });

    await call(app, 'POST', `/customers/${c.id}/deactivate`, { token: admin(), body: {} });
    await call(app, 'POST', `/customers/${c.id}/activate`, { token: admin(), body: {} });
    const [off] = await auditRows('customer.deactivate', c.id);
    expect(off).toMatchObject({
      beforeValues: { isActive: true },
      afterValues: { isActive: false, version: 3 },
    });
    expect(await auditRows('customer.activate', c.id)).toHaveLength(1);

    // personal data never lands in audit rows
    const rows = JSON.stringify(await fx.prisma.auditLog.findMany({ where: { entityId: c.id } }));
    for (const secret of [
      'private.person',
      '9555555555',
      '9666666666',
      'confidential-note',
      'Audit Subject',
    ]) {
      expect(rows).not.toContain(secret);
    }
    // failed and refused operations leave no audit trail rows behind
    const count = await fx.prisma.auditLog.count();
    await patch(c.id, { expectedVersion: 1, legalName: 'stale' });
    await post(b2c({ legalName: '' }));
    await post(b2c({ legalName: 'Viewer' }), tokens['Viewer/Auditor']!);
    expect(await fx.prisma.auditLog.count()).toBe(count);
    expect(count).toBeGreaterThan(before);
  });

  it('24. no customer personal data, search term or token appears in the server logs', async () => {
    const marker = `Zq${++seq}Marker`;
    const phone = '9777777777';
    const email = `leak.${seq}@example.test`;
    const pan = uniqPan();
    const g = gstin('27', pan);
    const c = cust(
      await post(
        b2b({
          legalName: `${marker} Traders`,
          phone,
          email,
          pan,
          gstin: g,
          notes: `${marker}-note`,
          billingAddressLine1: `${marker} Street`,
        }),
      ),
    );
    await patch(c.id, { expectedVersion: 1, contactPerson: `${marker} Person` });
    for (const q of [marker, phone, email, g])
      await call(app, 'GET', `/customers?search=${encodeURIComponent(q)}`, { token: admin() });
    await call(app, 'GET', `/customers/${c.id}`, { token: admin() });
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(500);
    for (const secret of [marker, phone, email, g, pan, admin()]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain('[query redacted]'); // the path is logged, the query string is not
  });
});
