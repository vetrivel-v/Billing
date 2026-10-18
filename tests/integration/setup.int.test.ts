import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSetupService, SETUP_DRAFT_KEY, type SetupStep } from '@commercebill/setup';
import type { PrismaClient } from '@commercebill/database';
import { PERMISSIONS, ROLE_TEMPLATES, UNITS, TAX_CATEGORIES } from '@commercebill/reference-data';
import { LAUNCH_SECRET, call, createFixture, login, type Fixture } from './auth-fixture.js';

const ADMIN_PASSWORD = 'gentle river walks at dawn';

/** Fictional business. 27AAPFU0939F1ZV is the published specimen GSTIN (checksum-valid, not asserted real). */
const valid = () => ({
  business: {
    legalName: 'DEMO Traders Pvt Ltd (fictional)',
    tradeName: 'Demo Traders',
    businessType: 'Retail',
    pan: 'AAPFU0939F',
    gstStatus: 'REGISTERED',
    gstin: '27AAPFU0939F1ZV',
    stateCode: '27',
  },
  location: { name: 'Head Office', addressLine1: '12 Demo Road', city: 'Pune', pinCode: '411001' },
  warehouse: { code: 'main', name: 'Main Warehouse' },
  financialYear: { startDate: '2026-04-01' },
  administrator: {
    username: 'shop.owner',
    displayName: 'Shop Owner',
    email: 'owner@example.test',
    password: ADMIN_PASSWORD,
  },
});

async function counts(prisma: PrismaClient) {
  return {
    organizations: await prisma.organization.count(),
    organizationSettings: await prisma.organizationSetting.count(),
    locations: await prisma.businessLocation.count(),
    warehouses: await prisma.warehouse.count(),
    financialYears: await prisma.financialYear.count(),
    users: await prisma.user.count(),
    userRoles: await prisma.userRole.count(),
    roles: await prisma.role.count(),
    permissions: await prisma.permission.count(),
    rolePermissions: await prisma.rolePermission.count(),
    units: await prisma.unit.count(),
    taxCategories: await prisma.taxCategory.count(),
    taxRates: await prisma.taxRate.count(),
    auditLogs: await prisma.auditLog.count(),
    sessions: await prisma.session.count(),
  };
}
const NOTHING = {
  organizations: 0,
  organizationSettings: 0,
  locations: 0,
  warehouses: 0,
  financialYears: 0,
  users: 0,
  userRoles: 0,
  roles: 0,
  permissions: 0,
  rolePermissions: 0,
  units: 0,
  taxCategories: 0,
  taxRates: 0,
  auditLogs: 0,
  sessions: 0,
};

const complete = (app: FastifyInstance, body: unknown, launch = true) =>
  call(app, 'POST', '/setup/complete', { body, launch });
const status = (app: FastifyInstance) => call(app, 'GET', '/setup/status');
const putDraft = (app: FastifyInstance, data: unknown, expectedVersion?: number) =>
  call(app, 'PUT', '/setup/draft', {
    body: expectedVersion === undefined ? { data } : { data, expectedVersion },
  });

// ---------------------------------------------------------------------------------------------------------
describe('fresh installation, resumable draft and failure handling', () => {
  let fx: Fixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fx = await createFixture(inject('pgAdminUrl'), { bare: true });
    app = await fx.makeApp();
  }, 120_000);
  afterAll(async () => fx?.close());

  it('1. a fresh installation reports that setup is required, and returns nothing else', async () => {
    const r = await status(app);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ setupRequired: true, draftAvailable: false });
    expect(Object.keys(r.json).sort()).toEqual(['draftAvailable', 'setupRequired']);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(await counts(fx.prisma)).toEqual(NOTHING);
  });

  it('2. a valid draft can be saved, is detected, and is returned for resuming', async () => {
    const data = {
      business: { legalName: 'Half finished Co', pan: 'NOT-VALID' },
      financialYear: { startDate: '2026-04-01' },
    };
    const saved = await putDraft(app, data);
    expect(saved.status).toBe(200);
    expect(saved.json.version).toBe(1);
    expect((await status(app)).json).toEqual({ setupRequired: true, draftAvailable: true });
    const got = await call(app, 'GET', '/setup/draft');
    expect(got.status).toBe(200);
    expect(got.json.draft!.data).toEqual(data);
    expect(got.json.draft!.version).toBe(1);
    // A draft is not an organization: nothing business-related exists yet.
    expect((await counts(fx.prisma)).organizations).toBe(0);
  });

  it('draft concurrency: a stale version is a 409, the right version updates', async () => {
    const stale = await putDraft(app, { business: { legalName: 'Other tab' } }, 0);
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('DB_0002');
    const ok = await putDraft(app, { business: { legalName: 'Updated Co' } }, 1);
    expect(ok.status).toBe(200);
    expect(ok.json.version).toBe(2);
    expect((await call(app, 'GET', '/setup/draft')).json.draft!.data.business!.legalName).toBe(
      'Updated Co',
    );
  });

  it('3. the draft never contains a password, hash, token, launch secret, credential or key', async () => {
    const bad = [
      { administrator: { username: 'owner', password: ADMIN_PASSWORD } },
      { administrator: { passwordHash: '$argon2id$v=19$m=1,t=1,p=1$x$y' } },
      { sessionToken: 'abc' },
      { launchSecret: LAUNCH_SECRET },
      { integration: { apiKey: 'k' } },
      { encryptionKey: 'k' },
      { password: ADMIN_PASSWORD },
    ];
    for (const data of bad) {
      const r = await putDraft(app, data);
      expect(r.status, JSON.stringify(Object.keys(data))).toBe(400);
      expect(r.json.error.code).toBe('VAL_0001');
      expect(r.body).not.toContain(ADMIN_PASSWORD);
    }
    // The stored row is still the last good draft and contains no secret-looking material.
    const row = await fx.prisma.applicationSetting.findFirstOrThrow({
      where: { organizationId: null, key: SETUP_DRAFT_KEY },
    });
    const raw = JSON.stringify(row);
    for (const forbidden of [
      ADMIN_PASSWORD,
      'argon2',
      LAUNCH_SECRET,
      'password',
      'token',
      'apiKey',
    ]) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('a failed final submission (password supplied) does not leak the password into the saved draft', async () => {
    const body = valid();
    body.business.gstin = '27AAPFU0939F1XX'; // invalid
    expect((await complete(app, body)).status).toBe(400);
    const row = await fx.prisma.applicationSetting.findFirstOrThrow({
      where: { organizationId: null, key: SETUP_DRAFT_KEY },
    });
    expect(JSON.stringify(row)).not.toContain(ADMIN_PASSWORD);
  });

  it('oversized drafts and bad envelopes are rejected', async () => {
    const huge = {
      business: { legalName: 'x'.repeat(200), tradeName: 'y'.repeat(200) },
      location: { addressLine1: 'z'.repeat(200), addressLine2: 'z'.repeat(200) },
    };
    const current = (await call(app, 'GET', '/setup/draft')).json.draft?.version ?? 0;
    expect((await putDraft(app, huge, current)).status).toBe(200); // within the cap
    expect((await call(app, 'PUT', '/setup/draft', { body: { data: {}, extra: 1 } })).status).toBe(
      400,
    );
    expect(
      (await call(app, 'PUT', '/setup/draft', { body: { data: {}, expectedVersion: -1 } })).status,
    ).toBe(400);
    expect([400, 415]).toContain(
      (await call(app, 'PUT', '/setup/draft', { body: 'nope' as never })).status,
    );
    const tooBig = { data: { business: { legalName: 'x'.repeat(40_000) } } };
    const r = await call(app, 'PUT', '/setup/draft', { body: tooBig });
    expect([400, 413]).toContain(r.status);
  });

  it('4. a corrupted, tampered or incompatible draft is discarded safely and never returned', async () => {
    const bad: unknown[] = [
      'garbage',
      { formatVersion: 99, data: {} }, // future/unknown format version
      { formatVersion: 1, data: { administrator: { password: 'leaked-by-tampering' } } }, // smuggled secret
      { formatVersion: 1, data: { business: { legalName: 123 } } }, // wrong type
      { data: {} }, // missing version
      null,
    ];
    for (const value of bad) {
      await fx.prisma.applicationSetting.deleteMany({
        where: { organizationId: null, key: SETUP_DRAFT_KEY },
      });
      await fx.prisma.applicationSetting.create({
        data: { organizationId: null, key: SETUP_DRAFT_KEY, value: value as never },
      });
      expect((await status(app)).json).toEqual({ setupRequired: true, draftAvailable: false });
      const got = await call(app, 'GET', '/setup/draft');
      expect(got.status).toBe(200);
      expect(got.json).toEqual({ draft: null, discarded: true });
      expect(got.body).not.toContain('leaked-by-tampering');
      expect(
        await fx.prisma.applicationSetting.count({
          where: { organizationId: null, key: SETUP_DRAFT_KEY },
        }),
      ).toBe(0);
    }
    // A corrupt draft can also simply be overwritten by a fresh save.
    await fx.prisma.applicationSetting.create({
      data: { organizationId: null, key: SETUP_DRAFT_KEY, value: 'garbage' },
    });
    expect((await putDraft(app, { business: { legalName: 'Fresh start' } })).status).toBe(200);
  });

  it('15. every setup route rejects a request without the launch secret', async () => {
    for (const [method, url, body] of [
      ['GET', '/setup/status', undefined],
      ['GET', '/setup/draft', undefined],
      ['PUT', '/setup/draft', { data: {} }],
      ['POST', '/setup/complete', valid()],
    ] as const) {
      const r = await call(app, method, url, { body, launch: false });
      expect(r.status, `${method} ${url}`).toBe(401);
      expect(r.json.error.code).toBe('AUTH_0001');
    }
    expect(await counts(fx.prisma)).toEqual({ ...NOTHING });
  });

  it.each([
    [
      'missing business section',
      (v: Record<string, unknown>) => {
        delete v.business;
      },
      'business',
    ],
    [
      'unknown key (token)',
      (v: Record<string, unknown>) => {
        v.token = 'x';
      },
      '(root)',
    ],
    [
      'registered without GSTIN',
      (v: ReturnType<typeof valid>) => {
        delete (v.business as { gstin?: string }).gstin;
      },
      'business.gstin',
    ],
    [
      'bad GSTIN checksum',
      (v: ReturnType<typeof valid>) => {
        v.business.gstin = '27AAPFU0939F1ZW';
      },
      'business.gstin',
    ],
    [
      'GSTIN of another state',
      (v: ReturnType<typeof valid>) => {
        v.business.stateCode = '07';
      },
      'business.gstin',
    ],
    [
      'impossible financial-year date',
      (v: ReturnType<typeof valid>) => {
        v.financialYear.startDate = '2027-02-29';
      },
      'financialYear.startDate',
    ],
    [
      'weak administrator password',
      (v: ReturnType<typeof valid>) => {
        v.administrator.password = 'password123456';
      },
      'administrator.password',
    ],
    [
      'password containing the username',
      (v: ReturnType<typeof valid>) => {
        v.administrator.password = 'the shop.owner password';
      },
      'administrator.password',
    ],
    [
      'invalid administrator username',
      (v: ReturnType<typeof valid>) => {
        v.administrator.username = 'x';
      },
      'administrator.username',
    ],
    [
      'bad PIN code',
      (v: ReturnType<typeof valid>) => {
        v.location.pinCode = '000000';
      },
      'location.pinCode',
    ],
    [
      'wrong types',
      (v: Record<string, unknown>) => {
        v.administrator = 'owner';
      },
      'administrator',
    ],
  ])(
    '16. invalid final input is rejected with 400 and writes nothing: %s',
    async (_name, mutate, field) => {
      const body = valid() as unknown as Record<string, unknown>;
      (mutate as (v: Record<string, unknown>) => void)(body);
      const r = await complete(app, body);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('VAL_0001');
      expect(
        r.json.error.problems?.some((p) => p.field === field || p.field.startsWith(`${field}.`)),
        JSON.stringify(r.json.error.problems),
      ).toBe(true);
      expect(r.body).not.toContain(ADMIN_PASSWORD);
      expect(r.json.error.dataSaved).toBe(false);
      expect(await counts(fx.prisma)).toEqual({ ...NOTHING });
      expect((await status(app)).json.setupRequired).toBe(true);
    },
  );

  it('a non-JSON or missing body is rejected cleanly', async () => {
    expect((await complete(app, undefined)).status).toBe(400);
    expect([400, 415]).toContain((await complete(app, 'text')).status); // text/plain is unsupported (415)
    expect(await counts(fx.prisma)).toEqual({ ...NOTHING });
  });

  const STEPS: SetupStep[] = [
    'lock',
    'organization',
    'settings',
    'location',
    'warehouse',
    'financial_year',
    'reference_data',
    'administrator',
    'draft_cleanup',
    'audit',
    'finalize',
  ];

  it.each(STEPS)(
    '13. a failure after step "%s" rolls back EVERYTHING and setup stays retryable',
    async (failAfter) => {
      await putDraft(app, { business: { legalName: 'Survives failure' } }, undefined).catch(
        () => undefined,
      );
      const svc = createSetupService({
        prisma: fx.prisma,
        auth: app.authService!,
        hooks: {
          afterStep(step) {
            if (step === failAfter) throw new Error('injected failure');
          },
        },
      });
      await expect(svc.complete(valid())).rejects.toThrow('injected failure');
      expect(await counts(fx.prisma)).toEqual({ ...NOTHING }); // no org, admin, role, permission, audit row...
      expect(await svc.isSetupRequired()).toBe(true);
      // The saved draft was not consumed by the failed attempt.
      expect((await status(app)).json.draftAvailable).toBe(true);
    },
  );

  it('13b. a failure injected over HTTP returns a generic 500 with dataSaved=false and no partial state', async () => {
    const failing = await fx.makeApp({
      setup: {
        hooks: {
          afterStep(step) {
            if (step === 'administrator') throw new Error('boom');
          },
        },
      },
    });
    const r = await complete(failing, valid());
    expect(r.status).toBe(500);
    expect(r.json.error.code).toBe('SYS_0500');
    expect(r.json.error.dataSaved).toBe(false);
    expect(r.body).not.toMatch(/boom|argon2|shop\.owner|stack/i);
    expect(await counts(fx.prisma)).toEqual({ ...NOTHING });
    expect((await status(failing)).json.setupRequired).toBe(true);
  });

  it('17. route-specific rate limits apply (completion and draft saves) with AUTH_0003', async () => {
    const limited = await fx.makeApp({
      setup: {
        completeRateLimit: { max: 2, timeWindowMs: 60_000 },
        draftRateLimit: { max: 3, timeWindowMs: 60_000 },
      },
    });
    const invalid = { business: {} };
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await complete(limited, invalid)).status);
    expect(codes).toEqual([400, 400, 429, 429]);
    const draftCodes: number[] = [];
    for (let i = 0; i < 5; i++) draftCodes.push((await putDraft(limited, {})).status);
    // The first three are under the limit (200, or 409 if a draft already exists): never 429.
    expect(draftCodes.slice(0, 3).every((c) => c !== 429)).toBe(true);
    expect(draftCodes.slice(3)).toEqual([429, 429]);
    expect((await complete(limited, invalid)).json.error.code).toBe('AUTH_0003');
    expect(await counts(fx.prisma)).toEqual({ ...NOTHING });
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('successful setup and everything after it', () => {
  let fx: Fixture;
  let app: FastifyInstance;
  let logs: string[];
  let responses: string[];
  let completion: Awaited<ReturnType<typeof complete>>;
  let before: ReturnType<typeof counts> extends Promise<infer T> ? T : never;

  beforeAll(async () => {
    fx = await createFixture(inject('pgAdminUrl'), { bare: true });
    logs = [];
    responses = [];
    app = await fx.makeApp({
      env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
      logStream: { write: (m) => void logs.push(m) },
    });
    before = await counts(fx.prisma);
    // A saved draft exists before completion (to prove it is removed afterwards).
    const d = await putDraft(app, { business: { legalName: 'DEMO Traders Pvt Ltd (fictional)' } });
    responses.push(d.body);
    completion = await complete(app, valid());
    responses.push(completion.body);
  }, 180_000);
  afterAll(async () => fx?.close());

  it('5. a valid setup completes with 201 and creates exactly the expected records', async () => {
    expect(before).toEqual(NOTHING);
    expect(completion.status).toBe(201);
    const after = await counts(fx.prisma);
    expect(after).toMatchObject({
      organizations: 1,
      organizationSettings: 2,
      locations: 1,
      warehouses: 1,
      financialYears: 1,
      users: 1,
      userRoles: 1,
      roles: 5,
      permissions: PERMISSIONS.length,
      units: UNITS.length,
      taxCategories: TAX_CATEGORIES.length,
      taxRates: TAX_CATEGORIES.length,
    });
    expect(after.rolePermissions).toBe(ROLE_TEMPLATES.reduce((n, r) => n + r.grants.length, 0));

    const org = await fx.prisma.organization.findFirstOrThrow();
    expect(org).toMatchObject({
      legalName: 'DEMO Traders Pvt Ltd (fictional)',
      tradeName: 'Demo Traders',
      pan: 'AAPFU0939F',
      gstStatus: 'REGISTERED',
      gstin: '27AAPFU0939F1ZV',
      stateCode: '27',
      country: 'IN',
      baseCurrency: 'INR',
      isDemoData: false,
    });
    expect(org.setupCompletedAt).not.toBeNull();
    const loc = await fx.prisma.businessLocation.findFirstOrThrow();
    expect(loc).toMatchObject({
      isPrimary: true,
      state: 'Maharashtra',
      stateCode: '27',
      pinCode: '411001',
      organizationId: org.id,
    });
    const wh = await fx.prisma.warehouse.findFirstOrThrow();
    expect(wh).toMatchObject({
      isPrimary: true,
      code: 'MAIN',
      locationId: loc.id,
      organizationId: org.id,
    });
    const fy = await fx.prisma.financialYear.findFirstOrThrow();
    expect(fy.label).toBe('2026-27');
    expect(fy.startDate.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(fy.endDate.toISOString().slice(0, 10)).toBe('2027-03-31');
    const settings = Object.fromEntries(
      (await fx.prisma.organizationSetting.findMany()).map((s) => [s.key, s.value]),
    );
    expect(settings.locale).toEqual({ country: 'IN', currency: 'INR', timeZone: 'Asia/Kolkata' });
    expect(completion.json).toEqual({
      organizationId: org.id,
      administratorUsername: 'shop.owner',
      nextStep: 'login',
    });
  });

  it('6. the administrator password is hashed with Argon2id and policy was enforced', async () => {
    const admin = await fx.prisma.user.findFirstOrThrow();
    expect(admin.passwordHash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(admin.passwordHash).not.toContain(ADMIN_PASSWORD);
    expect(admin).toMatchObject({
      username: 'shop.owner',
      isActive: true,
      mustChangePassword: false,
    });
    const roles = await fx.prisma.userRole.findMany({
      where: { userId: admin.id },
      include: { role: true },
    });
    expect(roles.map((r) => r.role.name)).toEqual(['Administrator']); // the seeded role, not a duplicate
    expect(await fx.prisma.role.count({ where: { name: 'Administrator' } })).toBe(1);
  });

  it('7. no password or hash appears in any response, log line, audit record or draft', async () => {
    const admin = await fx.prisma.user.findFirstOrThrow();
    const audit = JSON.stringify(await fx.prisma.auditLog.findMany());
    const settings = JSON.stringify(await fx.prisma.applicationSetting.findMany());
    const hashTail = admin.passwordHash.slice(-30);
    const everything = [...responses, ...logs, audit, settings].join('\n');
    expect(logs.join('').length).toBeGreaterThan(100);
    for (const secret of [ADMIN_PASSWORD, admin.passwordHash, hashTail, LAUNCH_SECRET]) {
      expect(everything).not.toContain(secret);
    }
    expect(completion.body).not.toMatch(/argon2|hash|token|session/i);
  });

  it('8. completion creates no authenticated session and returns no token or cookie', async () => {
    expect(await fx.prisma.session.count()).toBe(0);
    expect(Object.keys(completion.json).sort()).toEqual([
      'administratorUsername',
      'nextStep',
      'organizationId',
    ]);
    expect(completion.headers['set-cookie']).toBeUndefined();
    expect(completion.headers.authorization).toBeUndefined();
    // The new credentials are useless for /auth/me until an explicit login happens.
    expect((await call(app, 'GET', '/auth/me')).status).toBe(401);
  });

  it('9. explicit login works after setup and yields every Administrator permission', async () => {
    const res = await login(app, 'shop.owner', ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    expect(await fx.prisma.session.count()).toBe(1); // created by the login, not by setup
    const me = await call(app, 'GET', '/auth/me', { token: res.json.token });
    expect(me.status).toBe(200);
    expect(me.json.user.organizationId).toBe(completion.json.organizationId);
    expect([...(me.json.permissions as string[])].sort()).toEqual(
      PERMISSIONS.map((p) => p.key).sort(),
    );
    const auditActions = (
      await fx.prisma.auditLog.findMany({ orderBy: { occurredAt: 'asc' } })
    ).map((a) => a.action);
    expect(auditActions).toEqual(
      expect.arrayContaining(['setup.completed', 'user.create', 'auth.login.success']),
    );
  });

  it('bootstrap events are attributed to the system, never to a fabricated user', async () => {
    const setupEvent = await fx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'setup.completed' },
    });
    expect(setupEvent.userId).toBeNull();
    expect(setupEvent.category).toBe('security');
    expect(setupEvent.entityType).toBe('organization');
    expect(setupEvent.correlationId).toBeTruthy();
    const after = setupEvent.afterValues as Record<string, unknown>;
    expect(after.actor).toBe('system:bootstrap');
    expect(after.financialYear).toBe('2026-27');
    const userCreate = await fx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.create' },
    });
    expect(userCreate.userId).toBeNull();
    expect((userCreate.afterValues as Record<string, unknown>).actor).toBe('system:bootstrap');
    // No login/failure noise was produced by setup itself.
    expect(
      await fx.prisma.auditLog.count({
        where: { action: { startsWith: 'auth.login' }, correlationId: setupEvent.correlationId },
      }),
    ).toBe(0);
  });

  it('18. the five roles and all reference data are exactly as seeded in Task 1.1', async () => {
    const roles = await fx.prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
    });
    expect(roles.map((r) => r.name).sort()).toEqual(ROLE_TEMPLATES.map((t) => t.name).sort());
    for (const t of ROLE_TEMPLATES) {
      const role = roles.find((r) => r.name === t.name)!;
      expect(role.isSystem).toBe(true);
      expect(role.permissions.map((p) => p.permission.key).sort()).toEqual([...t.grants].sort());
    }
    const rates = await fx.prisma.taxRate.findMany();
    expect(
      rates.every((r) => r.origin === 'REFERENCE_SEED' && r.reviewStatus === 'UNREVIEWED'),
    ).toBe(true);
    const admin = roles.find((r) => r.name === 'Administrator')!;
    expect(admin.permissions).toHaveLength(PERMISSIONS.length);
  });

  it('10. status reports setup completed and exposes nothing about the business', async () => {
    const r = await status(app);
    expect(r.json).toEqual({ setupRequired: false, draftAvailable: false });
    expect(r.body).not.toMatch(/shop|owner|demo|27AAP|organization/i);
    for (const [method, url, body] of [
      ['GET', '/setup/draft', undefined],
      ['PUT', '/setup/draft', { data: {} }],
    ] as const) {
      const d = await call(app, method, url, { body });
      expect(d.status, url).toBe(409);
      expect(d.json.error.code).toBe('BIZ_0001');
    }
  });

  it('draft was deleted by completion', async () => {
    expect(await fx.prisma.applicationSetting.count({ where: { key: SETUP_DRAFT_KEY } })).toBe(0);
  });

  it('11. a second completion (replay or different data) is rejected and creates nothing', async () => {
    const snapshot = await counts(fx.prisma);
    const replay = await complete(app, valid());
    expect(replay.status).toBe(409);
    expect(replay.json.error.code).toBe('BIZ_0001');
    const other = valid();
    other.business.legalName = 'Second Organization';
    other.administrator.username = 'second.admin';
    expect((await complete(app, other)).status).toBe(409);
    expect(await counts(fx.prisma)).toEqual(snapshot);
    expect(await fx.prisma.user.count()).toBe(1);
  });

  it('12. restarting the API keeps setup completed; the draft is irrelevant to that decision', async () => {
    const restarted = await fx.makeApp(); // brand-new app, services and in-memory state
    expect((await status(restarted)).json).toEqual({ setupRequired: false, draftAvailable: false });
    expect((await complete(restarted, valid())).status).toBe(409);

    // Deleting or corrupting ONLY the draft must not make a completed installation look unconfigured.
    await fx.prisma.applicationSetting.deleteMany({ where: { key: SETUP_DRAFT_KEY } });
    expect((await status(restarted)).json.setupRequired).toBe(false);
    await fx.prisma.applicationSetting.create({
      data: { organizationId: null, key: SETUP_DRAFT_KEY, value: 'corrupt' },
    });
    expect((await status(restarted)).json).toEqual({ setupRequired: false, draftAvailable: false });
    expect((await complete(restarted, valid())).status).toBe(409);
    expect(await fx.prisma.organization.count()).toBe(1);
    await fx.prisma.applicationSetting.deleteMany({ where: { key: SETUP_DRAFT_KEY } });
  });

  it('the database refuses to reopen a completed setup', async () => {
    await expect(
      fx.prisma.$executeRawUnsafe(`UPDATE organizations SET setup_completed_at = NULL`),
    ).rejects.toThrow(/immutable/);
    await expect(
      fx.prisma.$executeRawUnsafe(
        `UPDATE organizations SET setup_completed_at = now() + interval '1 day'`,
      ),
    ).rejects.toThrow(/immutable/);
    // Other columns remain editable.
    await fx.prisma.$executeRawUnsafe(`UPDATE organizations SET trade_name = 'Renamed Trader'`);
    expect((await fx.prisma.organization.findFirstOrThrow()).setupCompletedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('concurrent completion (14)', () => {
  let fx: Fixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fx = await createFixture(inject('pgAdminUrl'), { bare: true });
    app = await fx.makeApp();
  }, 120_000);
  afterAll(async () => fx?.close());

  it('exactly one of many simultaneous submissions succeeds and bootstrap records are not duplicated', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => complete(app, valid())));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    const c = await counts(fx.prisma);
    expect(c).toMatchObject({
      organizations: 1,
      locations: 1,
      warehouses: 1,
      financialYears: 1,
      users: 1,
      userRoles: 1,
      roles: 5,
      sessions: 0,
    });
    expect(await fx.prisma.auditLog.count({ where: { action: 'setup.completed' } })).toBe(1);
    expect(await fx.prisma.auditLog.count({ where: { action: 'user.create' } })).toBe(1);
    expect(await fx.prisma.organization.count({ where: { setupCompletedAt: { not: null } } })).toBe(
      1,
    );
  }, 120_000);
});

describe('concurrent completion with DIFFERENT administrators and organizations (14b)', () => {
  let fx: Fixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fx = await createFixture(inject('pgAdminUrl'), { bare: true });
    app = await fx.makeApp();
  }, 120_000);
  afterAll(async () => fx?.close());

  it('still allows only one bootstrap: competing setups cannot create two organizations or two administrators', async () => {
    const bodies = Array.from({ length: 6 }, (_, i) => {
      const b = valid();
      b.business.legalName = `Competing Co ${i}`;
      b.administrator.username = `competitor.${i}`;
      return b;
    });
    const results = await Promise.all(bodies.map((b) => complete(app, b)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await fx.prisma.organization.count()).toBe(1);
    expect(await fx.prisma.user.count()).toBe(1);
    expect(await fx.prisma.businessLocation.count()).toBe(1);
    expect(await fx.prisma.warehouse.count()).toBe(1);
    expect(await fx.prisma.financialYear.count()).toBe(1);
    // The surviving administrator matches the surviving organization.
    const org = await fx.prisma.organization.findFirstOrThrow();
    const user = await fx.prisma.user.findFirstOrThrow();
    expect(user.organizationId).toBe(org.id);
    expect(org.legalName).toBe(`Competing Co ${user.username.split('.')[1]}`);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------
describe('other business shapes', () => {
  let fx: Fixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fx = await createFixture(inject('pgAdminUrl'), { bare: true });
    app = await fx.makeApp();
  }, 120_000);
  afterAll(async () => fx?.close());

  it('an unregistered business with an Indian-language name and a calendar-year start completes', async () => {
    const body = valid();
    body.business.legalName = 'डेमो व्यापार (काल्पनिक) — தமிழ் — ગુજરાતી';
    body.business.gstStatus = 'UNREGISTERED';
    delete (body.business as { gstin?: string }).gstin;
    delete (body.business as { pan?: string }).pan;
    body.financialYear.startDate = '2026-01-01';
    const r = await complete(app, body);
    expect(r.status, r.body).toBe(201);
    const org = await fx.prisma.organization.findFirstOrThrow();
    expect(org.legalName).toBe(body.business.legalName);
    expect(org).toMatchObject({ gstStatus: 'UNREGISTERED', gstin: null, pan: null });
    const fy = await fx.prisma.financialYear.findFirstOrThrow();
    expect([fy.label, fy.endDate.toISOString().slice(0, 10)]).toEqual(['2026', '2026-12-31']);
    expect((await login(app, 'shop.owner', ADMIN_PASSWORD)).status).toBe(200);
  });
});
