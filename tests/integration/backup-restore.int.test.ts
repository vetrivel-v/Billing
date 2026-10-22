// Task 1.17: the ACTIVE restore (replace the live business with a backup) against real PostgreSQL databases: the real production gate
// (no injected fact) is satisfied by a real verified restore, production data is backed up, damaged, and restored; failures at each
// stage leave the business untouched. Fictional data only.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ContainerWriter,
  MANIFEST_ENTRY,
  encryptFile,
  exportSnapshot,
  manifestBytes,
  sha256OfFile,
  type BackupManifest,
} from '@commercebill/backup';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  LAUNCH_SECRET,
  PASSWORD,
  call,
  createFixture,
  createRoleUsers,
  type ApiJson,
  type Fixture,
} from './auth-fixture.js';
import { body, previewAndPost, setupBillingWorld, type BillingWorld } from './invoice-fixture.js';

const CONTROL = 'control-secret-for-tests-'.padEnd(64, 'y');
const PASS = 'correct horse battery 2026';
const migrationsDir = resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');

let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;
let w: BillingWorld;
let dir: string;
let backupDir: string;
const logs: string[] = [];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (r: { json: ApiJson }) => r.json as unknown as Json;
const admin = () => tokens['Administrator']!;
const get = (path: string, token = admin()) => call(app, 'GET', path, { token });
const post = (path: string, b: unknown, token = admin()) =>
  call(app, 'POST', path, { token, body: b });
const control = (method: 'PUT' | 'POST', path: string, b: unknown) =>
  app.inject({
    method,
    url: path,
    headers: {
      'x-commercebill-launch-secret': LAUNCH_SECRET,
      'x-commercebill-control-secret': CONTROL,
    },
    payload: b as object,
  });
const pgUrl = (db: string) => {
  const u = new URL(fx.db.url);
  u.pathname = `/${db}`;
  return u.toString();
};
const adminQuery = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
  const c = new pg.Client({ connectionString: pgUrl('postgres') });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const siblings = async () =>
  (
    await adminQuery<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [
      `${fx.db.name}%`,
    ])
  ).map((r) => r.datname);
const strays = async () =>
  (
    await adminQuery<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'cb_verify_%' OR datname LIKE 'cb_restore_%'`,
    )
  ).map((r) => r.datname);
const login = async () => {
  tokens['Administrator'] = (
    await call(app, 'POST', '/auth/login', {
      body: { username: 'admin.user', password: PASSWORD, organizationId: fx.orgId },
    })
  ).json.token as string;
};
const counts = async () => ({
  invoices: await fx.prisma.salesInvoice.count(),
  payments: await fx.prisma.payment.count(),
  allocations: await fx.prisma.paymentAllocation.count(),
  customers: await fx.prisma.customer.count(),
  movements: await fx.prisma.stockMovement.count(),
  balance: (
    await fx.prisma.stockBalance.findMany({ where: { productId: w.products.tracked } })
  ).map((b) => b.quantityOnHand.toFixed(4)),
  demoSeq: String(
    (await fx.prisma.documentSequence.findFirstOrThrow({ where: { documentType: 'DEMO_INVOICE' } }))
      .lastNumber,
  ),
  invoiceSeq: String(
    (await fx.prisma.documentSequence.findFirstOrThrow({ where: { documentType: 'INVOICE' } }))
      .lastNumber,
  ),
});
const business = async () => {
  const out = mkdtempSync(join(tmpdir(), 'cb-biz-'));
  try {
    const s = await exportSnapshot(fx.db.url, out);
    return Object.fromEntries(
      s.tables
        .filter(
          (t) =>
            ![
              'audit_logs',
              'backup_records',
              'backup_verifications',
              'sessions',
              'organization_settings',
              'stock_balances',
            ].includes(t.name),
        )
        .map((t) => [t.name, t.sha256]),
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};
/** Settings other than the two a restore deliberately changes (a new database identity; the backup folder is kept as chosen). */
const settings = async () =>
  JSON.stringify(
    await fx.prisma
      .$queryRaw`SELECT organization_id, key, value FROM organization_settings WHERE key NOT IN ('recovery.database_identity', 'backup.destination') ORDER BY organization_id, key`,
  );
const verifiedBackup = async () => {
  const r = await post('/backup', { passphrase: PASS, passphraseConfirm: PASS, verifyNow: true });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  expect(j(r).verification.result).toBe('PASS');
  return j(r).backup as Json;
};
const source = async (file: string) => {
  const reg = await control('POST', '/internal/backup/restore-source', { path: file });
  expect(reg.statusCode, reg.body).toBe(200);
  return JSON.parse(reg.body).sourceId as string;
};
const restore = (sourceId: string, over: Record<string, unknown> = {}) =>
  post('/backup/restore', { sourceId, passphrase: PASS, confirmation: 'RESTORE', ...over });
const newCustomer = (code: string) =>
  fx.prisma.customer.create({
    data: {
      organizationId: fx.orgId,
      code,
      customerKind: 'INDIVIDUAL',
      legalName: `Fictional ${code}`,
      gstStatus: 'UNREGISTERED',
      billingAddressLine1: '1 Lane',
      billingStateCode: '27',
      placeOfSupplyStateCode: '27',
    },
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cb-rs-test-'));
  backupDir = join(dir, 'backups');
  mkdirSync(backupDir);
  fx = await createFixture(inject('pgAdminUrl'));
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'warn' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    logStream: { write: (m: string) => void logs.push(m) },
    backup: { databaseUrl: fx.db.url, migrationsDir, controlSecret: CONTROL },
    auth: {
      allowWeakHashingForTests: true,
      config: { argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 } },
      clock: () => fx.clock.now,
    },
  });
  tokens = await createRoleUsers(app, fx.orgId);
  w = await setupBillingWorld(fx);
  expect(
    (await control('PUT', '/internal/backup/destination', { path: backupDir })).statusCode,
  ).toBe(200);
}, 300_000);

afterAll(async () => {
  for (const name of await siblings())
    if (name !== fx.db.name) await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await fx?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('production becomes possible only through a real verified restore', () => {
  it('31. no injected fact: a verified backup plus a tax review lets the organization switch to PRODUCTION; production data is then recorded', async () => {
    // before any verified backup the gate refuses
    const refused = await post('/tax/billing-mode', { mode: 'PRODUCTION' });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.json.error.problems)).toContain('BACKUP_RESTORE_VERIFIED');
    await verifiedBackup();
    expect(j(await get('/backup/status')).gate).toMatchObject({ met: true, reason: 'CURRENT' });
    const cfg = j(await get('/tax/configuration'));
    expect(
      (
        await post('/tax/configuration/reviews', {
          capacity: 'Accountant for the business',
          note: 'Fictional test review',
          acknowledged: true,
          noticeVersion: cfg.notice.version,
          expectedFingerprint: cfg.fingerprint,
        })
      ).status,
    ).toBe(201);
    expect((await post('/tax/billing-mode', { mode: 'PRODUCTION' })).status).toBe(200);
    // production data: stock, a production invoice that dispatches stock, a payment
    const user = await fx.prisma.user.findFirstOrThrow({
      where: { displayName: 'Administrator (test)' },
    });
    await fx.prisma.stockMovement.create({
      data: {
        organizationId: fx.orgId,
        warehouseId: w.warehouseId,
        productId: w.products.tracked,
        movementType: 'OPENING_STOCK',
        quantityDelta: '10',
        businessDate: new Date(`${w.today}T00:00:00Z`),
        sourceType: 'OPENING',
        sourceRef: 'seed',
        createdBy: user.id,
      },
    });
    const inv = await previewAndPost(
      app,
      admin(),
      body(w, { mode: 'PRODUCTION' }, [{ productId: w.products.tracked, quantity: '3' }]),
    );
    expect(inv.post.status, JSON.stringify(inv.post.json)).toBe(201);
    expect(
      (
        await post('/payments', {
          mode: 'PRODUCTION',
          invoiceId: j(inv.post).invoice.id,
          amount: '200',
          method: 'CASH',
          operationId: randomUUID(),
        })
      ).status,
    ).toBe(201);
  }, 300_000);
});

describe('restoring the active business', () => {
  let b1: Json;
  let atB1: Awaited<ReturnType<typeof counts>>;
  let bizAtB1: Awaited<ReturnType<typeof business>>;
  let settingsAtB1: string;

  it('15-27. a verified backup of production data restores into an isolated database with every business invariant intact', async () => {
    b1 = await verifiedBackup();
    atB1 = await counts();
    bizAtB1 = await business();
    settingsAtB1 = await settings();
    expect(atB1).toMatchObject({
      invoices: 1,
      payments: 1,
      allocations: 1,
      balance: ['7.0000'],
      invoiceSeq: '1',
    });
    const rec = j(await get('/backup/history')).backups.find((b: Json) => b.id === b1.id);
    expect(rec.verification.checks.every((c: Json) => c.ok)).toBe(true);
    expect(rec.verification.checks.map((c: Json) => c.name)).toEqual(
      expect.arrayContaining([
        'invoice_dispatch_links',
        'stock_balance_reconciles_to_ledger',
        'payments_fully_allocated',
        'allocations_within_invoice_totals',
        'demo_production_separation',
      ]),
    );
  }, 300_000);

  it('the business then changes: a new customer, a new production invoice and a payment', async () => {
    await newCustomer('C-AFTER-1');
    const inv = await previewAndPost(
      app,
      admin(),
      body(w, { mode: 'PRODUCTION' }, [{ productId: w.products.tracked, quantity: '2' }]),
    );
    expect(inv.post.status).toBe(201);
    expect(
      (
        await post('/payments', {
          mode: 'PRODUCTION',
          invoiceId: j(inv.post).invoice.id,
          amount: '100',
          method: 'CASH',
          operationId: randomUUID(),
        })
      ).status,
    ).toBe(201);
    expect(await counts()).toMatchObject({
      invoices: 2,
      payments: 2,
      customers: atB1.customers + 1,
      balance: ['5.0000'],
    });
  }, 120_000);

  it('refused before anything is touched: no confirmation, a wrong passphrase, another business, another schema version', async () => {
    const file = join(backupDir, b1.fileName);
    const sourceId = await source(file);
    const before = {
      business: await business(),
      records: await fx.prisma.backupRecord.count(),
      dbs: await siblings(),
    };
    const noConfirm = await restore(sourceId, { confirmation: 'yes' });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.json.error.problems).toEqual([{ field: 'confirmation', rule: 'required' }]);
    const wrong = await restore(sourceId, { passphrase: 'not the right passphrase at all' });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.problems).toEqual([
      { field: 'passphrase', rule: 'wrong_passphrase_or_damaged' },
    ]);
    // crafted archives (valid and authenticated, but for another business / another schema)
    const craft = async (name: string, edit: (m: BackupManifest) => void) => {
      const tmp = mkdtempSync(join(tmpdir(), 'cb-craft-'));
      try {
        const snap = await exportSnapshot(fx.db.url, tmp);
        const manifest: BackupManifest = {
          format: 'commercebill-backup',
          formatVersion: 1,
          backupId: randomUUID(),
          kind: 'MANUAL',
          createdAt: new Date().toISOString(),
          appVersion: '0.0.1',
          schemaVersion: snap.schemaVersion,
          databaseId: randomUUID(),
          organization: { id: fx.orgId, legalName: 'X' },
          snapshot: { isolation: 'REPEATABLE READ READ ONLY' },
          attachments: { present: false, manifestVersion: 1 },
          excludedTables: ['sessions'],
          tables: snap.tables.map((t) => ({ ...t })),
          encryption: { cipher: 'AES-256-GCM (chunked)', kdf: 'scrypt', logN: 10, r: 8, p: 1 },
        };
        edit(manifest);
        const cw = await ContainerWriter.create(join(tmp, 'c.bin'));
        for (const t of snap.tables)
          await cw.addFile(`data/${t.name}.ndjson`, snap.files.get(t.name)!, t.bytes);
        await cw.addBuffer(MANIFEST_ENTRY, manifestBytes(manifest));
        await cw.finish();
        const out = join(dir, `${name}.cbbackup`);
        await encryptFile(join(tmp, 'c.bin'), out, PASS, { logN: 10, r: 8, p: 1 });
        return out;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };
    const otherOrg = await restore(
      await source(
        await craft('otherorg', (m) => {
          m.organization.id = randomUUID();
        }),
      ),
    );
    expect(otherOrg.status).toBe(409);
    expect(otherOrg.json.error.problems).toEqual([
      { field: 'backup', rule: 'organization_mismatch' },
    ]);
    const oldSchema = await restore(
      await source(
        await craft('oldschema', (m) => {
          m.schemaVersion = '20200101000000_old_schema';
        }),
      ),
    );
    expect(oldSchema.status).toBe(409);
    expect(oldSchema.json.error.problems).toEqual([{ field: 'backup', rule: 'schema_mismatch' }]);
    // nothing changed: no safety backup was made, no database was swapped or left behind
    expect(await business()).toEqual(before.business);
    expect(await fx.prisma.backupRecord.count()).toBe(before.records);
    expect(await siblings()).toEqual(before.dbs);
    expect(await strays()).toEqual([]);
  }, 300_000);

  it('39-40. a backup that cannot be loaded fails AFTER the safety backup: the business is untouched, the safety backup and the source are preserved', async () => {
    // an authenticated archive whose data violates a database rule (a negative payment amount), with correct checksums
    const tmp = mkdtempSync(join(tmpdir(), 'cb-bad-'));
    let badFile: string;
    try {
      const snap = await exportSnapshot(fx.db.url, tmp);
      const payments = snap.files.get('payments')!;
      writeFileSync(
        payments,
        readFileSync(payments, 'utf8').replace('"amount":200.00', '"amount":-5.00'),
      );
      const sha = await sha256OfFile(payments);
      const size = readFileSync(payments).length;
      const tables = snap.tables.map((t) =>
        t.name === 'payments' ? { ...t, sha256: sha, bytes: size } : { ...t },
      );
      const manifest: BackupManifest = {
        format: 'commercebill-backup',
        formatVersion: 1,
        backupId: randomUUID(),
        kind: 'MANUAL',
        createdAt: new Date().toISOString(),
        appVersion: '0.0.1',
        schemaVersion: snap.schemaVersion,
        databaseId: randomUUID(),
        organization: { id: fx.orgId, legalName: 'X' },
        snapshot: { isolation: 'REPEATABLE READ READ ONLY' },
        attachments: { present: false, manifestVersion: 1 },
        excludedTables: ['sessions'],
        tables,
        encryption: { cipher: 'AES-256-GCM (chunked)', kdf: 'scrypt', logN: 10, r: 8, p: 1 },
      };
      const cw = await ContainerWriter.create(join(tmp, 'c.bin'));
      for (const t of tables)
        await cw.addFile(`data/${t.name}.ndjson`, snap.files.get(t.name)!, t.bytes);
      await cw.addBuffer(MANIFEST_ENTRY, manifestBytes(manifest));
      await cw.finish();
      badFile = join(dir, 'unloadable.cbbackup');
      await encryptFile(join(tmp, 'c.bin'), badFile, PASS, { logN: 10, r: 8, p: 1 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const before = { business: await business(), dbs: await siblings(), counts: await counts() };
    const records = await fx.prisma.backupRecord.count({ where: { kind: 'PRE_RESTORE' } });
    const r = await restore(await source(badFile));
    expect(r.status).toBe(409);
    expect(r.json.error.problems).toEqual([{ field: 'backup', rule: 'restore_failed' }]);
    expect(await business()).toEqual(before.business);
    expect(await counts()).toEqual(before.counts);
    expect(await siblings()).toEqual(before.dbs);
    expect(await strays()).toEqual([]);
    // the safety point was made and verified before the attempt, and is kept
    const safety = await fx.prisma.backupRecord.findMany({
      where: { kind: 'PRE_RESTORE' },
      include: { verifications: true },
    });
    expect(safety).toHaveLength(records + 1);
    expect(safety.at(-1)!.verifications[0]!.result).toBe('PASS');
    expect(existsSync(join(backupDir, safety.at(-1)!.fileName))).toBe(true);
    expect(existsSync(badFile)).toBe(true);
    // maintenance mode ended: writes work again
    expect(
      (
        await post('/payments', {
          mode: 'DEMO',
          invoiceId: randomUUID(),
          amount: '1',
          method: 'CASH',
          operationId: randomUUID(),
        })
      ).status,
    ).toBe(400); // a normal validation answer, not 503
    expect(
      await fx.prisma.auditLog.count({ where: { action: 'backup.restore_failed' } }),
    ).toBeGreaterThanOrEqual(1);
  }, 400_000);

  it('37-38,45. the restore creates a verified pre-restore backup, replaces the business with the backup, and keeps the previous database', async () => {
    const sourceId = await source(join(backupDir, b1.fileName));
    const inspect = await post('/backup/restore/inspect', { sourceId, passphrase: PASS });
    expect(inspect.status).toBe(200);
    expect(j(inspect)).toMatchObject({
      sameOrganization: true,
      schemaCompatible: true,
      sameDatabase: true,
      kind: 'MANUAL',
      verificationStatus: 'PASS',
      organizationName: 'Sample Traders Private Limited',
    });
    const safetyBefore = await fx.prisma.backupRecord.count({ where: { kind: 'PRE_RESTORE' } });
    const dbsBefore = await siblings();
    // writes during the restore are refused (503), never half-applied
    const attempts: number[] = [];
    let stop = false;
    const hammer = (async () => {
      while (!stop) {
        const r = await post('/customers', {
          legalName: 'Written During Restore',
          customerKind: 'INDIVIDUAL',
        }).catch(() => null);
        if (r) attempts.push(r.status);
        await new Promise((res) => setTimeout(res, 60));
      }
    })();
    const r = await restore(sourceId);
    stop = true;
    await hammer;
    if (r.status !== 200)
      console.log(
        'DBGLOG',
        logs
          .filter((l) => /"level":(40|50)/.test(l))
          .slice(-4)
          .map((l) => l.slice(0, 1400))
          .join(' || '),
      );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(j(r)).toMatchObject({
      status: 'RESTORED',
      restoredBackupId: b1.id,
      productionGateMet: false,
    });
    expect(attempts.includes(503)).toBe(true);
    expect(attempts.filter((s) => s >= 500 && s !== 503)).toEqual([]);

    // the business is exactly what it was at the backup
    expect(await counts()).toEqual(atB1);
    expect(await business()).toEqual(bizAtB1);
    expect(await settings()).toBe(settingsAtB1);
    expect(await fx.prisma.customer.count({ where: { legalName: 'Written During Restore' } })).toBe(
      0,
    );
    expect(await fx.prisma.customer.count({ where: { code: 'C-AFTER-1' } })).toBe(0);
    // the previous database is kept (renamed), the safety backup is in the history and verified, files are intact
    const dbsAfter = await siblings();
    expect(dbsAfter.length).toBe(dbsBefore.length + 1);
    expect(dbsAfter.some((n) => n.includes('_pre_restore_'))).toBe(true);
    const safety = await fx.prisma.backupRecord.findMany({
      where: { kind: 'PRE_RESTORE' },
      include: { verifications: true },
      orderBy: { seq: 'asc' },
    });
    expect(safety.length).toBe(safetyBefore + 1);
    expect(safety.at(-1)!.verifications.some((v) => v.result === 'PASS')).toBe(true);
    expect(existsSync(join(backupDir, safety.at(-1)!.fileName))).toBe(true);
    expect(existsSync(join(backupDir, b1.fileName))).toBe(true);
    expect(await strays()).toEqual([]);
    expect(await fx.prisma.auditLog.count({ where: { action: 'backup.restore_completed' } })).toBe(
      1,
    );

    // sessions were not in the backup: everyone signs in again. Then the new database identity means NO verification applies yet.
    expect((await get('/customers')).status).toBe(401);
    await login();
    expect((await get('/customers')).status).toBe(200);
    expect(j(await get('/backup/status')).gate).toMatchObject({
      met: false,
      reason: 'DATABASE_CHANGED',
    });
    // the production gate follows: production posting is refused until a new verified backup exists
    const refused = await previewAndPost(
      app,
      admin(),
      body(w, { mode: 'PRODUCTION' }, [{ productId: w.products.untracked, quantity: '1' }]),
    );
    expect(refused.preview.ok).toBe(false);
    expect(JSON.stringify(refused.preview.errors)).toContain('PRODUCTION_GATE_NOT_MET');
    const forced = await post('/invoices', {
      ...body(w, { mode: 'PRODUCTION' }, [{ productId: w.products.untracked, quantity: '1' }]),
      operationId: randomUUID(),
      calculation: {
        inputHash: 'a'.repeat(64),
        configurationFingerprint: 'b'.repeat(64),
        grandTotal: '1.00',
      },
    });
    expect(forced.status).toBe(409);
    expect(JSON.stringify(forced.json.error.problems)).toContain('PRODUCTION_GATE_NOT_MET');
    // history survives (close/reopen = a new app instance over the same database)
    const reopened = await fx.makeApp({
      env: { LOG_LEVEL: 'silent' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
      backup: { databaseUrl: fx.db.url, migrationsDir, controlSecret: CONTROL },
      auth: {
        allowWeakHashingForTests: true,
        config: { argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 } },
        clock: () => fx.clock.now,
      },
    });
    const token = (
      await call(reopened, 'POST', '/auth/login', {
        body: { username: 'admin.user', password: PASSWORD, organizationId: fx.orgId },
      })
    ).json.token as string;
    const hist = j(await call(reopened, 'GET', '/backup/history?limit=100', { token }));
    expect(hist.backups.some((b: Json) => b.id === b1.id)).toBe(true);
    expect(hist.backups.some((b: Json) => b.kind === 'PRE_RESTORE')).toBe(true);
    // a new verified backup makes the gate current again and production posting works with the restored data
    await verifiedBackup();
    expect(j(await get('/backup/status')).gate).toMatchObject({ met: true, reason: 'CURRENT' });
    const ok = await previewAndPost(
      app,
      admin(),
      body(w, { mode: 'PRODUCTION' }, [{ productId: w.products.untracked, quantity: '1' }]),
    );
    expect(ok.post.status, JSON.stringify(ok.post.json)).toBe(201);
    expect(j(ok.post).invoice.documentNumber).toBe(`INV/${w.financialYearLabel}/000002`); // the sequence continues exactly from the backup
  }, 600_000);
});
