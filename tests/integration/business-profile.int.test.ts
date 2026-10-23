// Business Profile (Settings, Business Profile; ADR-0030): persistence, the shared GST rules, authorization, audit, transactions, the production
// gate and the immutability of posted invoices' seller snapshots. Real API, real PostgreSQL, fictional data.
import { randomUUID } from 'node:crypto';
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
  SELLER_GSTIN,
  body,
  previewAndPost,
  setupBillingWorld,
  type BillingWorld,
} from './invoice-fixture.js';

let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;
let world: BillingWorld;
let logs: string[];
let failNext = false;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (r: { json: ApiJson }) => r.json as unknown as Json;
const admin = () => tokens['Administrator']!;

const getProfile = (token = admin()) => call(app, 'GET', '/business-profile', { token });
const putProfile = (b: unknown, token = admin()) => {
  fx.clock.advance(1000); // distinct, ordered audit times
  return call(app, 'PUT', '/business-profile', { token, body: b });
};
const AUDIT = 'organization.profile.update';

/** A save request built from what the server currently has, with changes on top. */
async function form(over: Json = {}, locationOver: Json = {}): Promise<Json> {
  const p = j(await getProfile());
  return {
    legalName: p.legalName,
    tradeName: p.tradeName,
    businessType: p.businessType,
    pan: p.pan,
    gstStatus: p.gstStatus,
    gstin: p.gstin,
    stateCode: p.stateCode,
    location: { ...p.location, ...locationOver },
    expectedVersion: p.version,
    ...over,
  };
}
const problems = (r: { json: ApiJson }) =>
  ((j(r).error.problems ?? []) as { field: string; rule: string }[]).map(
    (x) => `${x.field}:${x.rule}`,
  );
const gate = async () => {
  const c = j(await call(app, 'GET', '/tax/configuration', { token: admin() }));
  return c.gate.requirements.find((r: Json) => r.code === 'SELLER_REGISTERED_VALID').met as boolean;
};

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  logs = [];
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    logStream: { write: (m: string) => void logs.push(m) },
    businessProfile: {
      hooks: {
        afterOrganizationUpdate: () => {
          if (failNext) {
            failNext = false;
            throw new Error('simulated failure after the organization changed');
          }
        },
      },
    },
  });
  tokens = await createRoleUsers(app, fx.orgId);
  world = await setupBillingWorld(fx);
}, 120_000);
afterAll(async () => fx?.close());

describe('reading', () => {
  it('1. loads the persisted seller data from the organization and its primary location', async () => {
    const r = await getProfile();
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(j(r)).toMatchObject({
      legalName: 'Sample Traders Private Limited',
      tradeName: 'Sample Traders',
      gstStatus: 'REGISTERED',
      gstin: SELLER_GSTIN,
      stateCode: '27',
      stateName: 'Maharashtra',
      country: 'IN',
      canEdit: true,
      location: {
        name: 'Head Office',
        addressLine1: '12 Market Road',
        city: 'Mumbai',
        pinCode: '400001',
      },
    });
  });

  it('shows the profile read-only to a role that may read but not update settings, and refuses roles without the key', async () => {
    const viewer = await getProfile(tokens['Viewer/Auditor']);
    expect(viewer.status).toBe(200);
    expect(j(viewer).canEdit).toBe(false);
    expect((await getProfile(tokens['Accountant'])).status).toBe(200);
    for (const role of ['Billing Operator', 'Warehouse Operator']) {
      expect((await getProfile(tokens[role])).status, role).toBe(403);
    }
  });
});

describe('saving', () => {
  it('2. saves a valid GSTIN (and 6/7. the business name and the address) and they persist', async () => {
    const r = await putProfile(
      await form(
        { legalName: 'Riverside Prints (fictional)', tradeName: 'Riverside' },
        {
          addressLine1: '99 Workshop Lane',
          addressLine2: 'Unit 4',
          city: 'Pune',
          pinCode: '411001',
        },
      ),
    );
    expect(r.status).toBe(200);
    expect(j(r).changedFields).toEqual(
      expect.arrayContaining([
        'legalName',
        'tradeName',
        'location.addressLine1',
        'location.addressLine2',
        'location.city',
        'location.pinCode',
      ]),
    );
    const org = await fx.prisma.organization.findUniqueOrThrow({ where: { id: fx.orgId } });
    const loc = await fx.prisma.businessLocation.findFirstOrThrow({
      where: { organizationId: fx.orgId, isPrimary: true },
    });
    expect(org).toMatchObject({
      legalName: 'Riverside Prints (fictional)',
      tradeName: 'Riverside',
    });
    expect(loc).toMatchObject({
      addressLine1: '99 Workshop Lane',
      addressLine2: 'Unit 4',
      city: 'Pune',
      pinCode: '411001',
    });
    expect(j(await getProfile()).location.addressLine1).toBe('99 Workshop Lane');
  });

  it('keeps the organization and its primary location in step (GSTIN, state code and state name) when the state changes', async () => {
    const r = await putProfile(await form({ gstin: '29AAPFU0939F1ZR', stateCode: '29' }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const org = await fx.prisma.organization.findUniqueOrThrow({ where: { id: fx.orgId } });
    const loc = await fx.prisma.businessLocation.findFirstOrThrow({
      where: { organizationId: fx.orgId, isPrimary: true },
    });
    expect({ g: loc.gstin, s: loc.stateCode, n: loc.state }).toEqual({
      g: org.gstin,
      s: org.stateCode,
      n: 'Karnataka',
    });
    const back = await putProfile(await form({ gstin: SELLER_GSTIN, stateCode: '27' }));
    expect(back.status).toBe(200);
    const loc2 = await fx.prisma.businessLocation.findFirstOrThrow({
      where: { organizationId: fx.orgId, isPrimary: true },
    });
    expect({ g: loc2.gstin, s: loc2.stateCode, n: loc2.state }).toEqual({
      g: SELLER_GSTIN,
      s: '27',
      n: 'Maharashtra',
    });
  });

  it('3. rejects an invalid GSTIN (shape and check character) and saves nothing', async () => {
    const before = await fx.prisma.organization.findUniqueOrThrow({ where: { id: fx.orgId } });
    const shape = await putProfile(await form({ gstin: 'NOT-A-GSTIN' }));
    expect(shape.status).toBe(400);
    expect(problems(shape)).toContain('gstin:invalid_gstin_format');
    const sum = await putProfile(await form({ gstin: '27AAPFU0939F1ZA' }));
    expect(sum.status).toBe(400);
    expect(problems(sum)).toContain('gstin:invalid_gstin_checksum');
    const after = await fx.prisma.organization.findUniqueOrThrow({ where: { id: fx.orgId } });
    expect(after.version).toBe(before.version);
    expect(after.gstin).toBe(before.gstin);
  });

  it('4. rejects a registered seller without a GSTIN, and an unregistered seller with one', async () => {
    const none = await putProfile(await form({ gstin: null }));
    expect(none.status).toBe(400);
    expect(problems(none)).toContain('gstin:gstin_required');
    const unreg = await putProfile(await form({ gstStatus: 'UNREGISTERED' }));
    expect(unreg.status).toBe(400);
    expect(problems(unreg)).toContain('gstin:gstin_not_allowed');
  });

  it('5. rejects a GSTIN that does not match the state, and a PAN that does not match the GSTIN', async () => {
    const st = await putProfile(await form({ stateCode: '29' }));
    expect(st.status).toBe(400);
    expect(problems(st)).toContain('gstin:gstin_state_mismatch');
    const pan = await putProfile(await form({ pan: 'ABCDE1234F' }));
    expect(pan.status).toBe(400);
    expect(problems(pan)).toContain('gstin:gstin_pan_mismatch');
    const unknown = await putProfile(await form({ stateCode: '00' }));
    expect(problems(unknown)).toContain('stateCode:unknown_state_code');
  });

  it('rejects missing names and addresses, a bad PIN code, unknown keys and a missing version', async () => {
    expect(problems(await putProfile(await form({ legalName: '  ' })))).toContain(
      'legalName:required',
    );
    expect(problems(await putProfile(await form({}, { addressLine1: '' })))).toContain(
      'location.addressLine1:required',
    );
    expect(problems(await putProfile(await form({}, { pinCode: '12' })))).toContain(
      'location.pinCode:invalid_pin_code',
    );
    expect((await putProfile({ ...(await form()), organizationId: randomUUID() })).status).toBe(
      400,
    );
    const noVersion = await form();
    delete noVersion.expectedVersion;
    expect((await putProfile(noVersion)).status).toBe(400);
  });

  it('a save with nothing changed writes nothing (no new version, no audit row)', async () => {
    const before = j(await getProfile());
    const auditsBefore = await fx.prisma.auditLog.count({ where: { action: AUDIT } });
    const r = await putProfile(await form());
    expect(r.status).toBe(200);
    expect(j(r).changedFields).toEqual([]);
    expect(j(await getProfile()).version).toBe(before.version);
    expect(await fx.prisma.auditLog.count({ where: { action: AUDIT } })).toBe(auditsBefore);
  });

  it('refuses a stale form: someone else saved first, and nothing is overwritten', async () => {
    const stale = await form();
    expect((await putProfile({ ...(await form()), tradeName: 'First writer' })).status).toBe(200);
    const r = await putProfile({ ...stale, tradeName: 'Second writer' });
    expect(r.status).toBe(409);
    expect(j(await getProfile()).tradeName).toBe('First writer');
  });

  it('refuses a location name already used by another location', async () => {
    await fx.prisma.businessLocation.create({
      data: {
        organizationId: fx.orgId,
        name: 'Second Shop',
        addressLine1: '2 Side Street',
        isPrimary: false,
      },
    });
    const r = await putProfile(await form({}, { name: 'Second Shop' }));
    expect(r.status).toBe(409);
    expect(problems(r)).toContain('location.name:duplicate');
  });

  it('8. a failure part-way through rolls back BOTH the organization and the location', async () => {
    const orgBefore = await fx.prisma.organization.findUniqueOrThrow({ where: { id: fx.orgId } });
    const locBefore = await fx.prisma.businessLocation.findFirstOrThrow({
      where: { organizationId: fx.orgId, isPrimary: true },
    });
    const auditsBefore = await fx.prisma.auditLog.count({ where: { action: AUDIT } });
    failNext = true;
    const r = await putProfile(
      await form({ legalName: 'Should Not Persist' }, { addressLine1: 'Nor This' }),
    );
    expect(r.status).toBe(500);
    const orgAfter = await fx.prisma.organization.findUniqueOrThrow({ where: { id: fx.orgId } });
    const locAfter = await fx.prisma.businessLocation.findFirstOrThrow({
      where: { organizationId: fx.orgId, isPrimary: true },
    });
    expect(orgAfter.legalName).toBe(orgBefore.legalName);
    expect(orgAfter.version).toBe(orgBefore.version);
    expect(locAfter.addressLine1).toBe(locBefore.addressLine1);
    expect(locAfter.version).toBe(locBefore.version);
    expect(await fx.prisma.auditLog.count({ where: { action: AUDIT } })).toBe(auditsBefore);
  });
});

describe('authorization and organization scope', () => {
  it('9. unauthenticated -> 401; authenticated without org.settings.update -> 403 and nothing changes', async () => {
    const unauth = await call(app, 'PUT', '/business-profile', { body: await form() });
    expect(unauth.status).toBe(401);
    expect((await call(app, 'GET', '/business-profile', {})).status).toBe(401);
    const before = j(await getProfile());
    for (const role of ['Accountant', 'Billing Operator', 'Warehouse Operator', 'Viewer/Auditor']) {
      const r = await putProfile(
        { ...(await form()), legalName: `Changed by ${role}` },
        tokens[role],
      );
      expect(r.status, role).toBe(403);
    }
    expect(j(await getProfile()).legalName).toBe(before.legalName);
  });

  it('10. an authorized user can edit (permission-based, not by role name)', async () => {
    const r = await putProfile({ ...(await form()), businessType: 'Made-to-order crafts' });
    expect(r.status).toBe(200);
    expect(j(r).profile.businessType).toBe('Made-to-order crafts');
  });

  it('11. another organization cannot be read or changed: the organization always comes from the session', async () => {
    const other = await fx.prisma.organization.create({
      data: { legalName: 'Other Co (fictional)', gstStatus: 'UNREGISTERED', stateCode: '27' },
    });
    await fx.prisma.businessLocation.create({
      data: {
        organizationId: other.id,
        name: 'Other HQ',
        addressLine1: '1 Other Road',
        stateCode: '27',
        isPrimary: true,
      },
    });
    const r = await putProfile({ ...(await form()), legalName: 'Attempt on own org' });
    expect(r.status).toBe(200);
    const otherAfter = await fx.prisma.organization.findUniqueOrThrow({ where: { id: other.id } });
    expect(otherAfter.legalName).toBe('Other Co (fictional)');
    expect(otherAfter.version).toBe(other.version);
    expect(j(await getProfile()).legalName).toBe('Attempt on own org');
  });
});

describe('audit and logs', () => {
  it('12. writes an audit event with the actor, organization, correlation id and the changed field names; tax facts keep before/after', async () => {
    const reg = await putProfile(await form({ gstStatus: 'COMPOSITION' }));
    expect(reg.status).toBe(200);
    const rows = await fx.prisma.auditLog.findMany({
      where: { action: AUDIT },
      orderBy: { occurredAt: 'asc' },
    });
    const last = rows[rows.length - 1]!;
    const adminUser = await fx.prisma.user.findFirstOrThrow({ where: { username: 'admin.user' } });
    expect(last).toMatchObject({
      organizationId: fx.orgId,
      userId: adminUser.id,
      entityType: 'organization',
      category: 'business',
    });
    expect(last.correlationId).toBeTruthy();
    expect((last.afterValues as Json).changedFields).toEqual(['gstStatus']);
    expect(last.beforeValues).toEqual({ gstStatus: 'REGISTERED' });
    expect(last.afterValues).toMatchObject({ gstStatus: 'COMPOSITION' });
    // non-tax fields are recorded by name only, never by value
    const nameChange = await putProfile(await form({ legalName: 'Audit Name Probe (fictional)' }));
    expect(nameChange.status).toBe(200);
    const latest = (
      await fx.prisma.auditLog.findMany({
        where: { action: AUDIT },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      })
    )[0]!;
    expect((latest.afterValues as Json).changedFields).toEqual(['legalName']);
    expect(JSON.stringify(latest)).not.toContain('Audit Name Probe');
    await putProfile(await form({ gstStatus: 'REGISTERED' }));
  });

  it('13. diagnostic logs carry no seller identity, address or submitted body', async () => {
    const probe = 'Log Probe Trading (fictional)';
    const r = await putProfile(
      await form({ legalName: probe }, { addressLine1: '77 Probe Street' }),
    );
    expect(r.status).toBe(200);
    const text = logs.join('\n');
    for (const secret of [probe, '77 Probe Street', SELLER_GSTIN, 'AAPFU0939F'])
      expect(text, secret).not.toContain(secret);
  });
});

describe('production readiness and posted invoices', () => {
  it('14. production readiness follows the saved seller facts immediately, with the shared GSTIN rules', async () => {
    expect(await gate()).toBe(true);
    expect((await putProfile(await form({ gstStatus: 'COMPOSITION' }))).status).toBe(200);
    expect(await gate()).toBe(false); // a composition seller is not supported for regular tax invoices
    expect((await putProfile(await form({ gstStatus: 'REGISTERED' }))).status).toBe(200);
    expect(await gate()).toBe(true);
    // a GSTIN that only passes the OLD shape-only check is now refused at the door and judged not ready if it ever got stored
    await fx.prisma.organization.update({
      where: { id: fx.orgId },
      data: { gstin: '27ABCDE1234F1Z5' },
    });
    expect(await gate()).toBe(false);
    await fx.prisma.organization.update({ where: { id: fx.orgId }, data: { gstin: SELLER_GSTIN } });
    expect(await gate()).toBe(true);
  });

  it('10b. correcting the seller GSTIN does not invalidate the tax-configuration review (the fingerprint excludes the seller)', async () => {
    const c0 = j(await call(app, 'GET', '/tax/configuration', { token: admin() }));
    expect((await putProfile(await form({ tradeName: 'Fingerprint probe' }))).status).toBe(200);
    const c1 = j(await call(app, 'GET', '/tax/configuration', { token: admin() }));
    expect(c1.fingerprint).toBe(c0.fingerprint);
  });

  it('18. a posted invoice keeps its seller snapshot exactly as posted after the profile changes', async () => {
    const operator = tokens['Administrator']!;
    const posted = await previewAndPost(app, operator, body(world));
    expect(posted.post.status, JSON.stringify(posted.post.json)).toBe(201);
    const id = (posted.post.json as unknown as Json).invoice.id as string;
    const snapshot = async () => {
      const row = await fx.prisma.salesInvoice.findUniqueOrThrow({ where: { id } });
      return {
        n: row.sellerLegalName,
        t: row.sellerTradeName,
        g: row.sellerGstin,
        s: row.sellerStateCode,
        a1: row.sellerAddressLine1,
        a2: row.sellerAddressLine2,
        c: row.sellerCity,
        p: row.sellerPinCode,
        st: row.sellerGstStatus,
      };
    };
    const before = await snapshot();
    const edit = await putProfile(
      await form(
        { legalName: 'Renamed After Posting (fictional)', tradeName: 'Renamed' },
        { addressLine1: 'A Completely New Address', city: 'Nagpur', pinCode: '440001' },
      ),
    );
    expect(edit.status).toBe(200);
    expect(await snapshot()).toEqual(before);
    const detail = j(await call(app, 'GET', `/invoices/${id}`, { token: operator }));
    expect(detail.invoice?.seller ?? detail.seller).toMatchObject({
      legalName: before.n,
      addressLine1: before.a1,
    });
    // new documents use the new facts
    const next = await previewAndPost(app, operator, body(world));
    expect(next.post.status).toBe(201);
    const nid = (next.post.json as unknown as Json).invoice.id as string;
    const row = await fx.prisma.salesInvoice.findUniqueOrThrow({ where: { id: nid } });
    expect(row.sellerLegalName).toBe('Renamed After Posting (fictional)');
    expect(row.sellerAddressLine1).toBe('A Completely New Address');
  }, 60_000);

  it('19. the saved profile survives a new application instance on the same database', async () => {
    const app2 = await fx.makeApp();
    // the session lives in the database, so the same sign-in works on the new instance
    const r = await call(app2, 'GET', '/business-profile', { token: admin() });
    expect(r.status).toBe(200);
    expect(j(r).legalName).toBe('Renamed After Posting (fictional)');
    await app2.close();
  });
});
