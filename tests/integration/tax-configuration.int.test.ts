import { createTaxConfigService } from '@commercebill/tax-config';
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
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (r: { json: ApiJson }) => r.json as unknown as Json;
const admin = () => tokens['Administrator']!;

const get = (path: string, token = admin()) => call(app, 'GET', path, { token });
const post = (path: string, body: unknown, token = admin()) =>
  call(app, 'POST', path, { token, body });
const patch = (path: string, body: unknown, token = admin()) =>
  call(app, 'PATCH', path, { token, body });
const put = (path: string, body: unknown, token = admin()) =>
  call(app, 'PUT', path, { token, body });
const config = async (token = admin()) => j(await get('/tax/configuration', token));
const audits = (action: string) =>
  fx.prisma.auditLog.findMany({ where: { action }, orderBy: { occurredAt: 'asc' } });

const reviewBody = async (over: Record<string, unknown> = {}) => {
  const c = await config();
  return {
    capacity: 'Accountant for the business',
    note: 'Checked against our accountant notes',
    acknowledged: true,
    noticeVersion: c.notice.version,
    expectedFingerprint: c.fingerprint,
    ...over,
  };
};

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

describe('reading the tax configuration', () => {
  it('shows categories, effective-dated rates, the jurisdiction rule set, the engine rules and the gate', async () => {
    const r = await get('/tax/configuration');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const c = j(r);
    expect(c.categories.map((x: Json) => x.code)).toEqual(
      expect.arrayContaining([
        'GST_5',
        'GST_12',
        'GST_18',
        'GST_28',
        'GST_0_NIL',
        'GST_EXEMPT',
        'GST_ZERO_RATED',
        'NON_GST',
      ]),
    );
    const gst18 = c.categories.find((x: Json) => x.code === 'GST_18');
    expect(gst18).toMatchObject({
      classification: 'STANDARD',
      origin: 'REFERENCE_SEED',
      reviewStatus: 'UNREVIEWED',
    });
    expect(gst18.rates).toEqual([
      expect.objectContaining({
        ratePercent: '18.0000',
        cessPercent: '0.0000',
        effectiveFrom: '2017-07-01',
        effectiveTo: null,
        reviewStatus: 'UNREVIEWED',
      }),
    ]);
    expect(c.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(c.review).toEqual({ state: 'NONE', latest: null });
    expect(c.engine).toEqual({
      engineVersion: '1.0.0',
      rulesetVersion: 'FUB-GST-1',
      roundingPolicyId: 'HALF_UP_PAISE_V1',
    });
    expect(c.jurisdictions).toMatchObject({
      id: 'FUB-GST-1-JURISDICTIONS',
      version: '1',
      reviewStatus: 'UNREVIEWED',
    });
    expect(c.jurisdictions.entries.length).toBeGreaterThan(38);
    expect(c.jurisdictions.entries).toContainEqual({
      code: '04',
      name: 'Chandigarh',
      kind: 'UT_WITHOUT_LEGISLATURE',
    });
    expect(c.notice.text).toMatch(/not a legal or tax certification/);
    expect(c.hsnPolicy).toEqual({ required: true, reason: null, changedAt: null });
    expect(c.gate.mode).toBe('DEMO');
    expect(c.gate.eligible).toBe(false);
    expect(c.gate.requirements).toEqual([
      { code: 'TAX_REVIEW_CURRENT', met: false },
      { code: 'SELLER_REGISTERED_VALID', met: false },
      { code: 'HSN_SAC_POLICY', met: true },
      { code: 'BACKUP_RESTORE_VERIFIED', met: false },
    ]);
    expect(c.gate.sellerProblems).toContain('SELLER_NOT_SUPPORTED');
  });

  it('the fingerprint is stable between reads', async () => {
    expect((await config()).fingerprint).toBe((await config()).fingerprint);
  });
});

describe('authentication and authorization by exact key', () => {
  const endpoints: [string, string, string, () => unknown][] = [
    ['tax.config.read', 'GET', '/tax/configuration', () => undefined],
    ['tax.config.read', 'GET', '/tax/configuration/reviews', () => undefined],
    ['tax.config.read', 'GET', '/tax/hsn-sac', () => undefined],
    ['tax.config.review', 'POST', '/tax/configuration/reviews', () => ({})],
    ['tax.config.review', 'POST', '/tax/billing-mode', () => ({})],
    ['tax.config.update', 'PUT', '/tax/hsn-requirement', () => ({})],
    ['tax.config.update', 'POST', '/tax/hsn-sac', () => ({})],
  ];
  const req = (method: string, path: string, token: string | undefined, body: unknown) =>
    call(app, method as 'GET', path, {
      ...(token ? { token } : {}),
      ...(body !== undefined ? { body } : {}),
    });

  it('401 without a session, and without the launch secret', async () => {
    for (const [, method, path, body] of endpoints) {
      const r = await req(method, path, undefined, body());
      expect(r.status, `${method} ${path}`).toBe(401);
      const noLaunch = await call(app, method as 'GET', path, {
        token: admin(),
        launch: false,
        ...(body() !== undefined ? { body: body() } : {}),
      });
      expect(noLaunch.status, `${method} ${path} (no launch secret)`).toBe(401);
    }
  });

  it('each role gets exactly what its grants say; review, update and read are three separate keys', async () => {
    for (const tpl of ROLE_TEMPLATES) {
      for (const [key, method, path, body] of endpoints) {
        const r = await req(method, path, tokens[tpl.name], body());
        const allowed = tpl.grants.includes(key);
        if (!allowed) expect(r.status, `${tpl.name} ${method} ${path}`).toBe(403);
        else expect(r.status, `${tpl.name} ${method} ${path}`).not.toBe(403);
      }
    }
    const grants = (n: string) => ROLE_TEMPLATES.find((t) => t.name === n)!.grants;
    expect(grants('Administrator')).toContain('tax.config.review');
    for (const n of ['Accountant', 'Billing Operator', 'Warehouse Operator', 'Viewer/Auditor'])
      expect(grants(n), n).not.toContain('tax.config.review');
    expect(grants('Accountant')).toContain('tax.config.read');
    expect(grants('Accountant')).not.toContain('tax.config.update');
  });

  it('the permission list of a signed-in administrator contains the new key', async () => {
    const me = await get('/auth/me');
    expect(j(me).permissions).toEqual(
      expect.arrayContaining(['tax.config.read', 'tax.config.update', 'tax.config.review']),
    );
  });
});

describe('recording a review (append-only, fingerprint-bound)', () => {
  it('records who, in what capacity, when, which notice and which rules, for exactly the configuration shown', async () => {
    const body = await reviewBody();
    const r = await post('/tax/configuration/reviews', body);
    expect(r.status).toBe(201);
    const review = j(r).review;
    expect(review).toMatchObject({
      fingerprint: body.expectedFingerprint,
      reviewedByName: 'Administrator (test)',
      reviewerCapacity: 'Accountant for the business',
      noticeVersion: 'TAXREV-1',
      note: 'Checked against our accountant notes',
      engineVersion: '1.0.0',
      rulesetVersion: 'FUB-GST-1',
      jurisdictionRulesetVersion: '1',
    });
    expect(review.noticeText).toMatch(/not a legal or tax certification/);
    expect(review.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const row = await fx.prisma.taxConfigurationReview.findFirstOrThrow({
      where: { id: review.id },
    });
    expect(row.organizationId).toBe(fx.orgId);
    const c = await config();
    expect(c.review.state).toBe('CURRENT');
    expect(c.review.latest.id).toBe(review.id);
    expect(c.gate.requirements.find((x: Json) => x.code === 'TAX_REVIEW_CURRENT').met).toBe(true);
    // per-row display marks follow
    const gst18 = c.categories.find((x: Json) => x.code === 'GST_18');
    expect(gst18.reviewStatus).toBe('REVIEWED');
    expect(gst18.rates[0].reviewStatus).toBe('REVIEWED');
    // audit: facts only
    const [row1] = await audits('tax.configuration.review');
    expect(row1).toMatchObject({
      category: 'business',
      entityType: 'tax_configuration_review',
      entityId: review.id,
      organizationId: fx.orgId,
    });
    expect(row1!.afterValues).toMatchObject({
      fingerprint: body.expectedFingerprint,
      noticeVersion: 'TAXREV-1',
      rulesetVersion: 'FUB-GST-1',
    });
    const text = JSON.stringify(row1);
    expect(text).not.toContain('Checked against');
    expect(text).not.toContain('Accountant for the business');
  });

  it('refuses incomplete requests and records nothing', async () => {
    const before = await fx.prisma.taxConfigurationReview.count();
    const bad = async (over: Record<string, unknown>) =>
      (await post('/tax/configuration/reviews', await reviewBody(over))).json.error.problems;
    expect(await bad({ capacity: '' })).toEqual([{ field: 'capacity', rule: 'required' }]);
    expect(await bad({ capacity: 'x' })).toEqual([{ field: 'capacity', rule: 'too_short' }]);
    expect(await bad({ capacity: 'x'.repeat(121) })).toEqual([
      { field: 'capacity', rule: 'too_long' },
    ]);
    expect(await bad({ acknowledged: false })).toEqual([
      { field: 'acknowledged', rule: 'acknowledgement_required' },
    ]);
    expect(await bad({ acknowledged: 'yes' })).toEqual([
      { field: 'acknowledged', rule: 'acknowledgement_required' },
    ]);
    expect(await bad({ note: 'x'.repeat(1001) })).toEqual([{ field: 'note', rule: 'too_long' }]);
    expect(await bad({ noticeVersion: 'OLD' })).toEqual([
      { field: 'noticeVersion', rule: 'notice_outdated' },
    ]);
    expect(await bad({ expectedFingerprint: 'abc' })).toEqual([
      { field: 'expectedFingerprint', rule: 'required' },
    ]);
    expect(await bad({ organizationId: 'x' })).toEqual([
      { field: 'organizationId', rule: 'unknown_field' },
    ]);
    expect(await fx.prisma.taxConfigurationReview.count()).toBe(before);
  });

  it('refuses a review of a configuration that is no longer the one that was shown (409, nothing recorded)', async () => {
    const stale = await reviewBody();
    const cat = await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'GST_5' },
    });
    const originalName = cat.name;
    await fx.prisma.taxCategory.update({
      where: { id: cat.id },
      data: { name: 'GST 5% (renamed)' },
    });
    const before = await fx.prisma.taxConfigurationReview.count();
    const r = await post('/tax/configuration/reviews', stale);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BIZ_0001');
    expect(r.json.error.dataSaved).toBe(false);
    expect(r.json.error.problems).toEqual([
      { field: 'expectedFingerprint', rule: 'configuration_changed' },
    ]);
    expect(await fx.prisma.taxConfigurationReview.count()).toBe(before);
    // and the one that WAS reviewed is now stale
    expect((await config()).review.state).toBe('STALE');
    await fx.prisma.taxCategory.update({ where: { id: cat.id }, data: { name: originalName } });
    expect((await config()).review.state).toBe('CURRENT'); // reverting restores exactly the reviewed configuration
  });

  it('every kind of tax change makes the latest review stale; a fresh review makes it current again', async () => {
    expect((await config()).review.state).toBe('CURRENT');
    const gst18 = await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'GST_18' },
    });
    // a new effective-dated rate (closing the old one first, as the overlap rule requires)
    await fx.prisma.taxRate.updateMany({
      where: { categoryId: gst18.id, effectiveTo: null },
      data: { effectiveTo: new Date('2026-12-31') },
    });
    expect((await config()).review.state).toBe('STALE');
    await fx.prisma.taxRate.create({
      data: {
        organizationId: fx.orgId,
        categoryId: gst18.id,
        ratePercent: '18.0000',
        effectiveFrom: new Date('2027-01-01'),
        origin: 'USER',
      },
    });
    const afterRate = await config();
    expect(afterRate.review.state).toBe('STALE');
    const newRate = afterRate.categories.find((x: Json) => x.code === 'GST_18').rates.at(-1);
    expect(newRate).toMatchObject({
      effectiveFrom: '2027-01-01',
      origin: 'USER',
      reviewStatus: 'UNREVIEWED',
    });
    expect((await post('/tax/configuration/reviews', await reviewBody())).status).toBe(201);
    expect((await config()).review.state).toBe('CURRENT');
    // deactivating a category changes the configuration too
    const nil = await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'GST_0_NIL' },
    });
    await fx.prisma.taxCategory.update({ where: { id: nil.id }, data: { isActive: false } });
    const stale = await config();
    expect(stale.review.state).toBe('STALE');
    expect(stale.categories.find((x: Json) => x.code === 'GST_0_NIL').reviewStatus).toBe(
      'UNREVIEWED',
    ); // the row mark is dropped
    expect((await post('/tax/configuration/reviews', await reviewBody())).status).toBe(201);
  });

  it('lists the history newest first and pages it; reviews cannot be edited or deleted through the database either', async () => {
    const list = j(await get('/tax/configuration/reviews?limit=2&offset=0'));
    expect(list.total).toBeGreaterThanOrEqual(3);
    expect(list.reviews).toHaveLength(2);
    expect(Date.parse(list.reviews[0].reviewedAt)).toBeGreaterThanOrEqual(
      Date.parse(list.reviews[1].reviewedAt),
    );
    expect(
      j(await get('/tax/configuration/reviews?limit=2&offset=2')).reviews.length,
    ).toBeGreaterThan(0);
    expect((await get('/tax/configuration/reviews?limit=1000')).status).toBe(400);
    const id = list.reviews[0].id;
    await expect(
      fx.prisma.taxConfigurationReview.update({ where: { id }, data: { note: 'edited' } }),
    ).rejects.toThrow();
    await expect(fx.prisma.taxConfigurationReview.delete({ where: { id } })).rejects.toThrow();
    await expect(fx.prisma.$executeRaw`TRUNCATE tax_configuration_reviews`).rejects.toThrow();
  });

  it('no request can edit or delete a tax rate or category', async () => {
    const rate = await fx.prisma.taxRate.findFirstOrThrow({ where: { organizationId: fx.orgId } });
    await expect(
      fx.prisma.taxRate.update({ where: { id: rate.id }, data: { ratePercent: '99' } }),
    ).rejects.toThrow();
    await expect(fx.prisma.taxRate.delete({ where: { id: rate.id } })).rejects.toThrow();
    const gst18 = await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'GST_18' },
    });
    await expect(
      fx.prisma.taxRate.create({
        data: {
          organizationId: fx.orgId,
          categoryId: gst18.id,
          ratePercent: '5',
          effectiveFrom: new Date('2027-06-01'),
        },
      }),
    ).rejects.toThrow(); // overlaps the open-ended 2027-01-01 rate
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: `/tax/configuration/reviews/${rate.id}`,
        headers: {
          'x-commercebill-launch-secret': LAUNCH_SECRET,
          authorization: `Bearer ${admin()}`,
        },
      });
      expect([404, 405], method).toContain(res.statusCode);
    }
  });
});

describe('billing mode and the production gate', () => {
  it('DEMO is the default and production is refused while any requirement is unmet (it can never be met yet)', async () => {
    expect((await config()).gate.mode).toBe('DEMO');
    const r = await post('/tax/billing-mode', { mode: 'PRODUCTION' });
    expect(r.status).toBe(409);
    expect(r.json.error.problems).toEqual(
      expect.arrayContaining([
        { field: 'SELLER_REGISTERED_VALID', rule: 'requirement_not_met' },
        { field: 'BACKUP_RESTORE_VERIFIED', rule: 'requirement_not_met' },
      ]),
    );
    expect((r.json.error.problems ?? []).map((p: Json) => p.field)).not.toContain(
      'TAX_REVIEW_CURRENT',
    ); // the review IS current here
    // even with a valid registered seller and a current review, the verified backup/restore is still missing
    await fx.prisma.organization.update({
      where: { id: fx.orgId },
      data: { gstStatus: 'REGISTERED', gstin: '27AAPFU0939F1ZV', stateCode: '27' },
    });
    const again = await post('/tax/billing-mode', { mode: 'PRODUCTION' });
    expect(again.status).toBe(409);
    expect(again.json.error.problems).toEqual([
      { field: 'BACKUP_RESTORE_VERIFIED', rule: 'requirement_not_met' },
    ]);
    const c = await config();
    expect(c.gate).toMatchObject({ mode: 'DEMO', eligible: false, sellerProblems: [] });
    expect(await fx.prisma.organizationSetting.count({ where: { key: 'billing_mode' } })).toBe(0);
  });

  it('rejects an unknown mode; DEMO can always be set and is audited', async () => {
    expect((await post('/tax/billing-mode', { mode: 'LIVE' })).json.error.problems).toEqual([
      { field: 'mode', rule: 'invalid_value' },
    ]);
    const r = await post('/tax/billing-mode', { mode: 'DEMO' });
    expect(r.status).toBe(200);
    expect(j(r)).toEqual({ mode: 'DEMO' });
    expect((await audits('billing.mode.change')).length).toBe(1);
  });

  it('with a verified backup (injected, as Task 1.17 will provide) the SAME gate lets production be switched on - and a stale review turns it off again', async () => {
    const svc = createTaxConfigService({
      prisma: fx.prisma,
      backupRestoreVerified: async () => true,
    });
    const user = await fx.prisma.user.findFirstOrThrow({
      where: { organizationId: fx.orgId, username: 'admin.user' },
    });
    const ctx = { userId: user.id, organizationId: fx.orgId };
    await expect(svc.setBillingMode(ctx, 'PRODUCTION')).resolves.toEqual({ mode: 'PRODUCTION' });
    expect((await config()).gate.mode).toBe('PRODUCTION');
    // a change to the configuration: the gate is no longer met, and switching on again is refused
    const cat = await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'GST_12' },
    });
    const originalName = cat.name;
    await fx.prisma.taxCategory.update({
      where: { id: cat.id },
      data: { name: 'GST 12% changed' },
    });
    await svc.setBillingMode(ctx, 'DEMO');
    await expect(svc.setBillingMode(ctx, 'PRODUCTION')).rejects.toMatchObject({
      code: 'production_not_eligible',
    });
    await fx.prisma.taxCategory.update({ where: { id: cat.id }, data: { name: originalName } });
    // the application itself (no injected fact) can never reach production
    expect((await post('/tax/billing-mode', { mode: 'PRODUCTION' })).status).toBe(409);
    await post('/tax/billing-mode', { mode: 'DEMO' });
    await fx.prisma.organization.update({
      where: { id: fx.orgId },
      data: { gstStatus: 'UNREGISTERED', gstin: null, stateCode: null },
    });
  });
});

describe('HSN/SAC policy', () => {
  it('requires HSN/SAC by default; turning it off needs permission, acknowledgement and a reason, and is audited', async () => {
    const bad = async (body: Record<string, unknown>) =>
      (await put('/tax/hsn-requirement', body)).json.error.problems;
    expect(await bad({ required: false })).toEqual([
      { field: 'acknowledged', rule: 'acknowledgement_required' },
      { field: 'reason', rule: 'required' },
    ]);
    expect(await bad({ required: false, acknowledged: true, reason: 'x' })).toEqual([
      { field: 'reason', rule: 'too_short' },
    ]);
    expect(
      await bad({ required: false, acknowledged: false, reason: 'Small shop, no codes yet' }),
    ).toEqual([{ field: 'acknowledged', rule: 'acknowledgement_required' }]);
    expect(await bad({ required: 'no' })).toEqual([{ field: 'required', rule: 'invalid_type' }]);
    expect((await config()).hsnPolicy.required).toBe(true);

    const off = await put('/tax/hsn-requirement', {
      required: false,
      acknowledged: true,
      reason: 'Small shop, no codes yet',
    });
    expect(off.status).toBe(200);
    expect(j(off).hsnPolicy).toMatchObject({ required: false, reason: 'Small shop, no codes yet' });
    expect((await config()).hsnPolicy).toMatchObject({
      required: false,
      reason: 'Small shop, no codes yet',
    });
    const [a] = await audits('tax.hsn_requirement.change');
    expect(a).toMatchObject({
      category: 'business',
      entityType: 'organization_setting',
      userId: expect.any(String),
    });
    expect(a!.afterValues).toMatchObject({
      required: false,
      reason: 'Small shop, no codes yet',
      acknowledged: true,
    });
    expect(a!.beforeValues).toMatchObject({ required: true });

    const on = await put('/tax/hsn-requirement', { required: true });
    expect(on.status).toBe(200);
    expect((await config()).hsnPolicy).toMatchObject({ required: true, reason: null });
    expect(
      (
        await put('/tax/hsn-requirement', {
          required: false,
          acknowledged: true,
          reason: 'Fine',
          mystery: 1,
        })
      ).status,
    ).toBe(400);
  });
});

describe('HSN/SAC maintenance', () => {
  let entry: Json;
  const create = (body: Record<string, unknown>, token = admin()) =>
    post('/tax/hsn-sac', body, token);

  it('creates an entry typed in by a person: UNREVIEWED, origin USER, audited', async () => {
    const r = await create({ code: '8517', kind: 'HSN', description: 'Telephone sets' });
    expect(r.status).toBe(201);
    entry = j(r).entry;
    expect(entry).toMatchObject({
      code: '8517',
      kind: 'HSN',
      description: 'Telephone sets',
      isActive: true,
      origin: 'USER',
      reviewStatus: 'UNREVIEWED',
      reviewedByName: null,
      version: 1,
    });
    const [a] = await audits('hsn_sac.create');
    expect(a).toMatchObject({
      entityType: 'hsn_sac_code',
      entityId: entry.id,
      organizationId: fx.orgId,
    });
    expect(a!.afterValues).toEqual({ code: '8517', kind: 'HSN', origin: 'USER' });
    expect(JSON.stringify(a)).not.toContain('Telephone');
    expect((await create({ code: '998314', kind: 'SAC' })).status).toBe(201);
  });

  it('validates input and refuses duplicates in the same organization', async () => {
    const problems = async (body: Record<string, unknown>) =>
      (await create(body)).json.error.problems;
    expect(await problems({ code: '8517', kind: 'HSN' })).toEqual([
      { field: 'code', rule: 'duplicate_code' },
    ]);
    expect((await create({ code: '8517', kind: 'SAC' })).status).toBe(409); // one code, one entry
    expect(await problems({ code: '85', kind: 'XYZ' })).toEqual([
      { field: 'kind', rule: 'invalid_value' },
    ]);
    expect(await problems({ code: '8', kind: 'HSN' })).toEqual([
      { field: 'code', rule: 'invalid_code' },
    ]);
    expect(await problems({ code: '85A7', kind: 'HSN' })).toEqual([
      { field: 'code', rule: 'invalid_code' },
    ]);
    expect(await problems({ code: '123456789', kind: 'HSN' })).toEqual([
      { field: 'code', rule: 'invalid_code' },
    ]);
    expect(await problems({ kind: 'HSN' })).toEqual([{ field: 'code', rule: 'required' }]);
    expect(await problems({ code: '8518', kind: 'HSN', description: 'x'.repeat(301) })).toEqual([
      { field: 'description', rule: 'too_long' },
    ]);
    expect(
      await problems({ code: '8518', kind: 'HSN', organizationId: 'x', origin: 'IMPORT' }),
    ).toEqual([
      { field: 'organizationId', rule: 'unknown_field' },
      { field: 'origin', rule: 'unknown_field' },
    ]);
  });

  it('edits only description and active flag; code and kind never change; a stale version is a 409', async () => {
    const e = await patch(`/tax/hsn-sac/${entry.id}`, {
      expectedVersion: 1,
      description: 'Telephone sets and parts',
    });
    expect(e.status).toBe(200);
    expect(j(e).entry).toMatchObject({
      description: 'Telephone sets and parts',
      version: 2,
      reviewStatus: 'UNREVIEWED',
    });
    const immutable = await patch(`/tax/hsn-sac/${entry.id}`, { expectedVersion: 2, code: '8518' });
    expect(immutable.json.error.problems).toEqual([{ field: 'code', rule: 'immutable_field' }]);
    expect(
      (await patch(`/tax/hsn-sac/${entry.id}`, { expectedVersion: 2, kind: 'SAC' })).json.error
        .problems,
    ).toEqual([{ field: 'kind', rule: 'immutable_field' }]);
    const stale = await patch(`/tax/hsn-sac/${entry.id}`, {
      expectedVersion: 1,
      description: 'Late edit',
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('DB_0002');
    expect((await patch(`/tax/hsn-sac/${entry.id}`, { description: 'no version' })).status).toBe(
      400,
    );
    const same = await patch(`/tax/hsn-sac/${entry.id}`, {
      expectedVersion: 2,
      description: 'Telephone sets and parts',
    });
    expect(j(same).entry.version).toBe(2); // nothing changed: no new version
    const [, upd] = await audits('hsn_sac.update');
    expect(upd).toBeUndefined();
    const [u1] = await audits('hsn_sac.update');
    expect(u1!.afterValues).toMatchObject({ changedFields: ['description'], version: 2 });
    expect(JSON.stringify(u1)).not.toContain('Telephone');
  });

  it('a person confirms an entry; editing it afterwards removes the confirmation; only the review permission may confirm', async () => {
    expect(
      (await post(`/tax/hsn-sac/${entry.id}/review`, { expectedVersion: 2 }, tokens['Accountant']!))
        .status,
    ).toBe(403);
    const r = await post(`/tax/hsn-sac/${entry.id}/review`, { expectedVersion: 2 });
    expect(r.status).toBe(200);
    expect(j(r).entry).toMatchObject({
      reviewStatus: 'REVIEWED',
      reviewedByName: 'Administrator (test)',
      version: 3,
    });
    expect(j(r).entry.reviewedAt).toBeTruthy();
    const again = await post(`/tax/hsn-sac/${entry.id}/review`, { expectedVersion: 3 });
    expect(j(again).entry.version).toBe(3); // already confirmed: nothing changes
    const edit = await patch(`/tax/hsn-sac/${entry.id}`, {
      expectedVersion: 3,
      description: 'Telephone sets, parts and accessories',
    });
    expect(j(edit).entry).toMatchObject({ reviewStatus: 'UNREVIEWED', reviewedByName: null });
    expect((await audits('hsn_sac.review')).length).toBe(1);
  });

  it('deactivates and reactivates (nothing is deleted); lists with search, filters and paging', async () => {
    const off = await patch(`/tax/hsn-sac/${entry.id}`, { expectedVersion: 4, isActive: false });
    expect(j(off).entry.isActive).toBe(false);
    expect(j(await get('/tax/hsn-sac')).entries.map((x: Json) => x.code)).toEqual(
      expect.arrayContaining(['8517', '998314']),
    ); // no default status filter in the API
    expect(j(await get('/tax/hsn-sac?isActive=false')).entries.map((x: Json) => x.code)).toEqual([
      '8517',
    ]);
    await patch(`/tax/hsn-sac/${entry.id}`, { expectedVersion: 5, isActive: true });
    for (let i = 0; i < 30; i++)
      await create({
        code: String(200000 + i),
        kind: 'SAC',
        description: `Fictional service ${i}`,
      });
    const all = j(await get('/tax/hsn-sac?limit=10&offset=0'));
    expect(all).toMatchObject({ total: 32, limit: 10, offset: 0 });
    expect(all.entries).toHaveLength(10);
    expect(j(await get('/tax/hsn-sac?limit=10&offset=30')).entries).toHaveLength(2);
    expect(j(await get('/tax/hsn-sac?kind=HSN')).total).toBe(1);
    expect(j(await get('/tax/hsn-sac?search=8517')).entries.map((x: Json) => x.code)).toEqual([
      '8517',
    ]);
    expect(
      j(await get('/tax/hsn-sac?search=fictional%20service%207')).entries.map((x: Json) => x.code),
    ).toEqual(['200007']);
    expect(j(await get('/tax/hsn-sac?search=%25')).total).toBe(0); // "%" is a literal character
    expect((await get('/tax/hsn-sac?limit=1000')).status).toBe(400);
    await expect(fx.prisma.hsnSacCode.delete({ where: { id: entry.id } })).rejects.toThrow();
  });

  it('is organization-scoped: another organization neither sees nor edits these entries and may reuse the codes', async () => {
    const orgB = await fx.prisma.organization.create({
      data: { legalName: 'DEMO Other Co (fictional)' },
    });
    await seedReference(fx.prisma, { organizationId: orgB.id });
    await app.authService!.createUser({
      organizationId: orgB.id,
      username: 'admin.orgb',
      displayName: 'Admin B',
      password: PASSWORD,
      roleNames: ['Administrator'],
    });
    const tokenB = (
      await call(app, 'POST', '/auth/login', {
        body: { username: 'admin.orgb', password: PASSWORD, organizationId: orgB.id },
      })
    ).json.token as string;
    expect(j(await get('/tax/hsn-sac', tokenB)).total).toBe(0);
    expect(
      (
        await patch(
          `/tax/hsn-sac/${entry.id}`,
          { expectedVersion: 5, description: 'Hijack' },
          tokenB,
        )
      ).status,
    ).toBe(404);
    expect(
      (await post(`/tax/hsn-sac/${entry.id}/review`, { expectedVersion: 5 }, tokenB)).status,
    ).toBe(404);
    expect(
      (await create({ code: '8517', kind: 'HSN', description: 'B own entry' }, tokenB)).status,
    ).toBe(201); // same code, other organization
    expect(j(await get('/tax/hsn-sac?search=B%20own', admin())).total).toBe(0);
    expect(
      (await fx.prisma.hsnSacCode.findUniqueOrThrow({ where: { id: entry.id } })).description,
    ).not.toBe('Hijack');
    // the tax configuration and its reviews are separate too
    const cb = await config(tokenB);
    expect(cb.review).toEqual({ state: 'NONE', latest: null });
    expect(cb.categories.every((c: Json) => c.id !== undefined)).toBe(true);
    const ca = await config();
    expect(cb.categories.map((c: Json) => c.id)).not.toEqual(
      expect.arrayContaining(ca.categories.map((c: Json) => c.id)),
    );
    expect(j(await get('/tax/configuration/reviews', tokenB)).total).toBe(0);
    const stolen = await post(
      '/tax/configuration/reviews',
      {
        capacity: 'Owner',
        acknowledged: true,
        noticeVersion: 'TAXREV-1',
        expectedFingerprint: ca.fingerprint,
      },
      tokenB,
    );
    expect(stolen.status).toBe(409); // A's fingerprint is not B's configuration
    expect(
      await fx.prisma.taxConfigurationReview.count({ where: { organizationId: orgB.id } }),
    ).toBe(0);
    // a product cannot use another organization's entry
    const unit = await fx.prisma.unit.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'PCS' },
    });
    const tax = await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'GST_18' },
    });
    const bEntry = await fx.prisma.hsnSacCode.findFirstOrThrow({
      where: { organizationId: orgB.id },
    });
    const p = await post('/products', {
      kind: 'GOODS',
      name: 'Cross org HSN',
      unitId: unit.id,
      taxCategoryId: tax.id,
      sellingPrice: '10',
      hsnSacCodeId: bEntry.id,
    });
    expect(p.json.error.problems).toEqual([{ field: 'hsnSacCodeId', rule: 'unknown_reference' }]);
  });

  it('products use the organization own list: inactive entries are refused for new use, and the product picker lists only active ones', async () => {
    const unit = await fx.prisma.unit.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'PCS' },
    });
    const tax = await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'GST_18' },
    });
    const ok = await post('/products', {
      kind: 'GOODS',
      name: 'Uses own HSN',
      unitId: unit.id,
      taxCategoryId: tax.id,
      sellingPrice: '10',
      hsnSacCodeId: entry.id,
    });
    expect(ok.status).toBe(201);
    const refs = j(await get('/products/references'));
    expect(refs.hsnSacTotal).toBeGreaterThan(30);
    const picker = j(await get('/products/references/hsn-sac?kind=HSN&search=85'));
    expect(picker.codes.map((c: Json) => c.code)).toEqual(['8517']);
    await patch(`/tax/hsn-sac/${entry.id}`, {
      expectedVersion: (await fx.prisma.hsnSacCode.findUniqueOrThrow({ where: { id: entry.id } }))
        .version,
      isActive: false,
    });
    expect(j(await get('/products/references/hsn-sac?kind=HSN&search=85')).codes).toEqual([]);
    const refused = await post('/products', {
      kind: 'GOODS',
      name: 'Uses inactive HSN',
      unitId: unit.id,
      taxCategoryId: tax.id,
      sellingPrice: '10',
      hsnSacCodeId: entry.id,
    });
    expect(refused.json.error.problems).toEqual([
      { field: 'hsnSacCodeId', rule: 'inactive_reference' },
    ]);
    const existing = j(ok).product;
    const keep = await patch(`/products/${existing.id}`, {
      expectedVersion: 1,
      description: 'still fine',
    });
    expect(keep.status).toBe(200); // an existing product keeps working after its code is retired
  });
});

describe('logs', () => {
  it('never contain review notes, capacities, reasons, descriptions or search terms', async () => {
    await put('/tax/hsn-requirement', {
      required: false,
      acknowledged: true,
      reason: 'secret-reason-zzz',
    });
    await put('/tax/hsn-requirement', { required: true });
    await post(
      '/tax/configuration/reviews',
      await reviewBody({ capacity: 'secret-capacity-qqq', note: 'secret-note-www' }),
    );
    await get('/tax/hsn-sac?search=secret-search-rrr');
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(100);
    for (const secret of [
      'secret-reason-zzz',
      'secret-capacity-qqq',
      'secret-note-www',
      'secret-search-rrr',
      'Fictional service',
      admin(),
      LAUNCH_SECRET,
    ])
      expect(text, secret).not.toContain(secret);
    expect(text).toContain('?[query redacted]');
  });
});
