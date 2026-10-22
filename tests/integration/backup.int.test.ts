// Task 1.17: encrypted backups and VERIFIED restore against the real Fastify API and real, migrated PostgreSQL databases (the
// verification restores into a real isolated database; the active restore swaps real databases). Fictional data only.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ContainerWriter,
  MANIFEST_ENTRY,
  decryptFile,
  encryptFile,
  exportSnapshot,
  extractContainer,
  manifestBytes,
  manifestFingerprint,
  type BackupManifest,
} from '@commercebill/backup';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ROLE_TEMPLATES } from '../../prisma/seed/reference/index.js';
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
const OTHER_PASS = 'a different long passphrase!';
const migrationsDir = resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');

let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;
let w: BillingWorld;
let logs: string[];
let dir: string;
let backupDir: string;
const pgUrl = (db: string) => {
  const u = new URL(fx.db.url);
  u.pathname = `/${db}`;
  return u.toString();
};
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (r: { json: ApiJson }) => r.json as unknown as Json;
const admin = () => tokens['Administrator']!;
const get = (path: string, token = admin()) => call(app, 'GET', path, { token });
const post = (path: string, b: unknown, token = admin()) =>
  call(app, 'POST', path, { token, body: b });
const control = (
  method: 'PUT' | 'POST',
  path: string,
  b: unknown,
  secret: string | null = CONTROL,
) =>
  app.inject({
    method,
    url: path,
    headers: {
      'x-commercebill-launch-secret': LAUNCH_SECRET,
      ...(secret ? { 'x-commercebill-control-secret': secret } : {}),
    },
    payload: b as object,
  });
const files = () => readdirSync(backupDir).filter((f) => f.endsWith('.cbbackup'));
const newBackup = async (over: Record<string, unknown> = {}) => {
  const r = await post('/backup', {
    passphrase: PASS,
    passphraseConfirm: PASS,
    verifyNow: false,
    ...over,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return j(r);
};
const dbs = async () => {
  const c = new pg.Client({ connectionString: pgUrl('postgres') });
  await c.connect();
  try {
    return (
      await c.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [
        `${fx.db.name}%`,
      ])
    ).rows.map((r) => r.datname);
  } finally {
    await c.end();
  }
};
const strays = async () => {
  const c = new pg.Client({ connectionString: pgUrl('postgres') });
  await c.connect();
  try {
    return (
      await c.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname LIKE 'cb_verify_%' OR datname LIKE 'cb_restore_%'`,
      )
    ).rows.map((r) => r.datname);
  } finally {
    await c.end();
  }
};
/** Run SQL in the live database with triggers off (to build a deliberately inconsistent database). */
const rawSql = async (sql: string) => {
  const c = new pg.Client({ connectionString: fx.db.url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL session_replication_role = 'replica'`);
    await c.query(sql);
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
};
const checksums = async () => {
  const out = mkdtempSync(join(tmpdir(), 'cb-test-'));
  try {
    const s = await exportSnapshot(fx.db.url, out);
    return Object.fromEntries(s.tables.map((t) => [t.name, `${t.rows}:${t.sha256}`]));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cb-bk-test-'));
  backupDir = join(dir, 'backups');
  mkdirSync(backupDir);
  fx = await createFixture(inject('pgAdminUrl'));
  logs = [];
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
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
  // business data: stock, a demo invoice, a demo payment, a customer edit
  const admin0 = await fx.prisma.user.findFirstOrThrow({
    where: { displayName: 'Administrator (test)' },
  });
  await fx.prisma.$executeRaw`SELECT 1`;
  const r = await previewAndPost(
    app,
    admin(),
    body(w, {}, [{ productId: w.products.untracked, quantity: '4' }]),
  );
  expect(r.post.status).toBe(201);
  const invoice = j(r.post).invoice;
  const pay = await post('/payments', {
    mode: 'DEMO',
    invoiceId: invoice.id,
    amount: '500',
    method: 'CASH',
    operationId: randomUUID(),
  });
  expect(pay.status).toBe(201);
  await fx.prisma.stockMovement.create({
    data: {
      organizationId: fx.orgId,
      warehouseId: w.warehouseId,
      productId: w.products.tracked,
      movementType: 'OPENING_STOCK',
      quantityDelta: '12',
      businessDate: new Date(`${w.today}T00:00:00Z`),
      sourceType: 'OPENING',
      sourceRef: 'seed',
      createdBy: admin0.id,
    },
  });
  expect(admin0.id).toBeTruthy();
}, 300_000);

afterAll(async () => {
  // the active-restore tests rename databases; remove whatever they left (the fixture only knows its original name)
  const c = new pg.Client({ connectionString: pgUrl('postgres') });
  await c.connect();
  try {
    for (const name of await dbs())
      if (name !== fx.db.name) await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await c.end();
  }
  await fx?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the backup folder is chosen by the desktop shell only', () => {
  it('42-44. a client cannot register a folder or file: the control routes need the shell secret, paths are validated', async () => {
    expect(
      (await control('PUT', '/internal/backup/destination', { path: backupDir }, null)).statusCode,
    ).toBe(403);
    expect(
      (await control('PUT', '/internal/backup/destination', { path: backupDir }, 'wrong-secret'))
        .statusCode,
    ).toBe(403);
    // the renderer knows the launch secret and a session token, but never the control secret
    const viaSession = await app.inject({
      method: 'PUT',
      url: '/internal/backup/destination',
      headers: {
        'x-commercebill-launch-secret': LAUNCH_SECRET,
        authorization: `Bearer ${admin()}`,
      },
      payload: { path: backupDir },
    });
    expect(viaSession.statusCode).toBe(403);
    expect(
      (await control('PUT', '/internal/backup/destination', { path: join(dir, 'does-not-exist') }))
        .statusCode,
    ).toBe(400);
    expect(
      (await control('PUT', '/internal/backup/destination', { path: backupDir, extra: 1 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await control('PUT', '/internal/backup/destination', { path: `${backupDir}; rm -rf /` }))
        .statusCode,
    ).toBe(400); // just a path that does not exist: never a command
    // no destination yet: creating a backup is refused with a clear message and nothing is written
    const none = await post('/backup', { passphrase: PASS, passphraseConfirm: PASS });
    expect(none.status).toBe(409);
    expect(none.json.error.problems).toEqual([{ field: 'backup', rule: 'no_destination' }]);
    const ok = await control('PUT', '/internal/backup/destination', { path: backupDir });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ label: 'backups' });
    expect(JSON.stringify(j(await get('/backup/status')))).not.toContain(
      backupDir.replace(/\\/g, '\\\\'),
    );
  });
});

describe('creating an encrypted backup', () => {
  let first: Json;
  it('1-3. creates one encrypted file in the chosen folder, recorded in the history, with a correct manifest', async () => {
    const before = await fx.prisma.auditLog.count({ where: { action: 'backup.create' } });
    first = await newBackup();
    const b = first.backup;
    expect(b).toMatchObject({
      kind: 'MANUAL',
      destinationLabel: 'backups',
      fileAvailable: true,
      verification: null,
      backupFormat: 1,
    });
    expect(b.fileName).toMatch(/^CommerceBill-\d{8}-\d{6}-[0-9a-f]{8}\.cbbackup$/);
    expect(b.sizeBytes).toBeGreaterThan(1000);
    expect(files()).toEqual([b.fileName]);
    expect(statSync(join(backupDir, b.fileName)).size).toBe(b.sizeBytes);
    expect(readdirSync(backupDir).filter((f) => f.endsWith('.partial'))).toEqual([]);
    expect(await fx.prisma.auditLog.count({ where: { action: 'backup.create' } })).toBe(before + 1);
    // look inside with the passphrase: the manifest and the data entries
    const tmp = mkdtempSync(join(tmpdir(), 'cb-look-'));
    try {
      await decryptFile(join(backupDir, b.fileName), join(tmp, 'p.bin'), PASS);
      const entries = await extractContainer(join(tmp, 'p.bin'), tmp);
      const manifest = JSON.parse(
        readFileSync(entries.get(MANIFEST_ENTRY)!.path, 'utf8'),
      ) as BackupManifest;
      expect(manifest).toMatchObject({
        format: 'commercebill-backup',
        formatVersion: 1,
        backupId: b.id,
        kind: 'MANUAL',
        organization: { id: fx.orgId, legalName: 'Sample Traders Private Limited' },
        attachments: { present: false },
        excludedTables: ['sessions'],
      });
      expect(manifest.schemaVersion).toBe(
        readdirSync(migrationsDir)
          .filter((n) => /^\d{14}_/.test(n))
          .sort()
          .at(-1),
      );
      const names = manifest.tables.map((t) => t.name);
      for (const t of [
        'organizations',
        'customers',
        'products',
        'stock_movements',
        'stock_balances',
        'tax_categories',
        'tax_rates',
        'tax_configuration_reviews',
        'sales_invoices',
        'sales_invoice_lines',
        'payments',
        'payment_allocations',
        'document_sequences',
        'document_number_allocations',
        'audit_logs',
        'users',
        'roles',
        'role_permissions',
        'backup_records',
      ])
        expect(names, t).toContain(t);
      expect(names).not.toContain('sessions');
      expect(manifest.tables.find((t) => t.name === 'payments')!.rows).toBe(1);
      expect(manifest.tables.find((t) => t.name === 'sales_invoices')!.rows).toBe(1);
      expect(manifest.encryption).toEqual({
        cipher: 'AES-256-GCM (chunked)',
        kdf: 'scrypt',
        logN: 17,
        r: 8,
        p: 1,
      });
      // 11,13: no passphrase, session token or launch/control secret anywhere in the archive
      const all = [...entries.values()].map((e) => readFileSync(e.path, 'utf8')).join('\n');
      for (const secret of [PASS, OTHER_PASS, LAUNCH_SECRET, CONTROL, admin()])
        expect(all, secret.slice(0, 8)).not.toContain(secret);
      expect(all).not.toContain('"token_hash"'); // no session rows
      // one-way password hashes are part of the users table (needed for recovery) but never a plaintext password
      expect(all).not.toContain(PASSWORD);
      expect(all).toContain('"password_hash"');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it('4. every archive has its own salt and nonce: two backups of the same data share no header and no ciphertext', async () => {
    const second = await newBackup();
    const a = readFileSync(join(backupDir, first.backup.fileName));
    const bb = readFileSync(join(backupDir, second.backup.fileName));
    expect(a.subarray(0, 8).toString()).toBe('CBBACKUP');
    expect(a.subarray(14, 30).equals(bb.subarray(14, 30))).toBe(false); // salt
    expect(a.subarray(30, 34).equals(bb.subarray(30, 34))).toBe(false); // nonce prefix
    expect(a.subarray(60, 200).equals(bb.subarray(60, 200))).toBe(false); // ciphertext
    expect(a.includes(Buffer.from('Sample Traders'))).toBe(false); // nothing readable on disk
  }, 120_000);

  it('validates the passphrase and the confirmation without creating anything', async () => {
    const n = files().length;
    const rules = async (b: Record<string, unknown>) =>
      (await post('/backup', b)).json.error?.problems?.map((p: Json) => `${p.field}:${p.rule}`);
    expect(await rules({})).toEqual(['passphrase:required']);
    expect(await rules({ passphrase: 'short', passphraseConfirm: 'short' })).toEqual([
      'passphrase:too_short',
    ]);
    expect(await rules({ passphrase: ' '.repeat(20), passphraseConfirm: ' '.repeat(20) })).toEqual([
      'passphrase:blank',
    ]);
    expect(await rules({ passphrase: PASS, passphraseConfirm: 'something else entirely' })).toEqual(
      ['passphraseConfirm:mismatch'],
    );
    expect(
      await rules({ passphrase: 'x'.repeat(201), passphraseConfirm: 'x'.repeat(201) }),
    ).toEqual(['passphrase:too_long']);
    expect(files()).toHaveLength(n);
  });
});

describe('verified restore', () => {
  let backupId: string;
  it('13-14,28,40. verification restores into an isolated database, passes every check, records PASS and never touches the active database', async () => {
    backupId = (await newBackup()).backup.id;
    const before = await checksums();
    const r = await post(`/backup/${backupId}/verify`, { passphrase: PASS });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const v = j(r).verification;
    if (v.result !== 'PASS')
      console.log(
        'DBGCHECKS',
        JSON.stringify(v.checks.filter((c: Json) => !c.ok)),
        logs
          .filter((l) => l.includes('"level":40'))
          .slice(-3)
          .join('|')
          .slice(0, 1500),
      );
    expect(v.result).toBe('PASS');
    const names = v.checks.map((c: Json) => c.name);
    for (const c of [
      'archive_authenticated',
      'manifest_valid',
      'checksums_match',
      'schema_version',
      'organization_present',
      'administrator_present',
      'foreign_keys',
      'protective_triggers_present',
      'stock_balance_reconciles_to_ledger',
      'stock_projection_matches_backup',
      'tax_configuration_present',
      'document_sequences_consistent',
      'invoice_numbers_issued_by_ledger',
      'payment_numbers_issued_by_ledger',
      'invoice_totals_equal_lines',
      'invoice_dispatch_links',
      'payments_fully_allocated',
      'payment_allocation_links',
      'allocations_within_invoice_totals',
      'demo_production_separation',
      'audit_history_present',
      'restored_content_identical',
    ])
      expect(names, c).toContain(c);
    expect(v.checks.every((c: Json) => c.ok)).toBe(true);
    // the active database changed only by the new verification row and its audit row
    const after = await checksums();
    const changed = Object.keys(after)
      .filter((t) => after[t] !== before[t])
      .sort();
    expect(changed).toEqual(['audit_logs', 'backup_verifications']);
    expect(await strays()).toEqual([]); // the isolated database is gone
    const hist = (await get('/backup/history')).json.backups as Json[];
    expect(hist.find((b: Json) => b.id === backupId)?.verification.result).toBe('PASS');
  }, 240_000);

  it('15-27. the restored isolated database holds the same business data (checked through the archive itself)', async () => {
    const rec = j(await get('/backup/history')).backups.find((b: Json) => b.id === backupId);
    expect(
      rec.verification.checks.find((c: Json) => c.name === 'restored_content_identical').ok,
    ).toBe(true);
  });

  it('wrong passphrase, a changed byte and a truncated file are refused before anything is restored, and record no result', async () => {
    const before = await fx.prisma.backupVerification.count();
    const wrong = await post(`/backup/${backupId}/verify`, { passphrase: OTHER_PASS });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.problems).toEqual([
      { field: 'passphrase', rule: 'wrong_passphrase_or_damaged' },
    ]);
    const rec = await fx.prisma.backupRecord.findUniqueOrThrow({ where: { id: backupId } });
    const file = join(backupDir, rec.fileName);
    const original = readFileSync(file);
    try {
      for (const mutate of [
        (b: Buffer) => {
          b[b.length - 20] = b[b.length - 20]! ^ 0xff;
          return b;
        }, // a byte inside the last chunk
        (b: Buffer) => {
          b[100] = b[100]! ^ 0x01;
          return b;
        }, // a byte inside the first chunk
        (b: Buffer) => {
          b[20] = b[20]! ^ 0x01;
          return b;
        }, // the salt in the header
        (b: Buffer) => b.subarray(0, b.length - 40), // truncated
        (b: Buffer) => Buffer.concat([b, Buffer.alloc(30, 7)]), // appended junk
      ]) {
        writeFileSync(file, mutate(Buffer.from(original)));
        const r = await post(`/backup/${backupId}/verify`, { passphrase: PASS });
        expect(r.status).toBe(400);
        expect(['wrong_passphrase_or_damaged', 'unreadable_backup']).toContain(
          r.json.error.problems![0]!.rule,
        );
      }
    } finally {
      writeFileSync(file, original);
    }
    expect(await fx.prisma.backupVerification.count()).toBe(before);
    expect((await post(`/backup/${backupId}/verify`, { passphrase: PASS })).status).toBe(200);
  }, 240_000);

  it('a missing file is reported plainly', async () => {
    const rec = await fx.prisma.backupRecord.findUniqueOrThrow({ where: { id: backupId } });
    const file = join(backupDir, rec.fileName);
    const original = readFileSync(file);
    rmSync(file);
    const r = await post(`/backup/${backupId}/verify`, { passphrase: PASS });
    expect(r.status).toBe(409);
    expect(r.json.error.problems).toEqual([{ field: 'backup', rule: 'file_missing' }]);
    writeFileSync(file, original);
  });
});

describe('the production gate fact is the recovery record', () => {
  it('29-33. FAIL does not satisfy the gate; a fresh PASS satisfies ONLY the backup part; schema change and age invalidate it', async () => {
    // an inconsistent source database: the stock projection no longer matches the ledger (R-080)
    await rawSql(`UPDATE stock_balances SET quantity_on_hand = quantity_on_hand + 1`);
    const bad = (await newBackup({ verifyNow: true })).verification;
    expect(bad.result).toBe('FAIL');
    expect(bad.checks.filter((c: Json) => !c.ok).map((c: Json) => c.name)).toEqual([
      'stock_projection_matches_backup',
    ]);
    let status = j(await get('/backup/status'));
    expect(status.gate).toMatchObject({ met: false, reason: 'LATEST_VERIFICATION_FAILED' });
    expect(await strays()).toEqual([]);
    // production stays refused: the backup requirement is unmet
    const refused = await post('/tax/billing-mode', { mode: 'PRODUCTION' });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.json.error.problems)).toContain('BACKUP_RESTORE_VERIFIED');
    // repair the projection and verify again
    await rawSql(`UPDATE stock_balances SET quantity_on_hand = quantity_on_hand - 1`);
    const good = (await newBackup({ verifyNow: true })).verification;
    expect(good.result).toBe('PASS');
    status = j(await get('/backup/status'));
    expect(status.gate).toMatchObject({ met: true, reason: 'CURRENT' });
    // 32: the backup part is met, but the tax review is still required: production remains blocked, for the right reason only
    const blocked = await post('/tax/billing-mode', { mode: 'PRODUCTION' });
    expect(blocked.status).toBe(409);
    const unmet = blocked.json.error.problems!.map((p: Json) => p.field);
    expect(unmet).toContain('TAX_REVIEW_CURRENT');
    expect(unmet).not.toContain('BACKUP_RESTORE_VERIFIED');
    const readiness = j(await get('/backup/readiness'));
    expect(readiness).toMatchObject({ mode: 'DEMO', eligible: false });
    expect(readiness.items.find((i: Json) => i.code === 'BACKUP_RESTORE_VERIFIED').met).toBe(true);
    expect(readiness.items.find((i: Json) => i.code === 'TAX_REVIEW_CURRENT').met).toBe(false);
    // 33: a schema change invalidates the record; a business change does not
    await fx.prisma.customer.create({
      data: {
        organizationId: fx.orgId,
        code: 'C-NEW-1',
        customerKind: 'INDIVIDUAL',
        legalName: 'New Fictional Customer',
        gstStatus: 'UNREGISTERED',
        billingAddressLine1: '1 Lane',
        billingStateCode: '27',
        placeOfSupplyStateCode: '27',
      },
    });
    expect(j(await get('/backup/status')).gate.met).toBe(true);
    await fx.prisma
      .$executeRaw`INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES ('fake-migration-row', repeat('0', 64), now(), '99999999999999_fake_future', 1)`;
    expect(j(await get('/backup/status')).gate).toMatchObject({
      met: false,
      reason: 'SCHEMA_CHANGED',
    });
    await fx.prisma.$executeRaw`DELETE FROM _prisma_migrations WHERE id = 'fake-migration-row'`;
    expect(j(await get('/backup/status')).gate.met).toBe(true);
    // age: a record older than the policy is not current
    fx.clock.advance(31 * 86_400_000);
    const relogin = (
      await call(app, 'POST', '/auth/login', {
        body: { username: 'admin.user', password: PASSWORD, organizationId: fx.orgId },
      })
    ).json.token as string;
    expect(j(await get('/backup/status', relogin)).gate).toMatchObject({
      met: false,
      reason: 'VERIFICATION_TOO_OLD',
    });
    tokens['Administrator'] = relogin;
    fx.clock.advance(-31 * 86_400_000);
    tokens['Administrator'] = (
      await call(app, 'POST', '/auth/login', {
        body: { username: 'admin.user', password: PASSWORD, organizationId: fx.orgId },
      })
    ).json.token as string;
    expect(j(await get('/backup/status')).gate.met).toBe(true);
  }, 360_000);
});

describe('logs and audit never carry secrets', () => {
  it('12,20. no passphrase, key or session in the logs or the audit trail; one audit row per verification', async () => {
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(1000);
    for (const secret of [PASS, OTHER_PASS, CONTROL, LAUNCH_SECRET, admin()])
      expect(text, secret.slice(0, 6)).not.toContain(secret);
    const audits = JSON.stringify(
      await fx.prisma.auditLog.findMany({ where: { action: { startsWith: 'backup.' } } }),
    );
    for (const secret of [PASS, OTHER_PASS, 'CBBACKUP']) expect(audits).not.toContain(secret);
    expect(await fx.prisma.auditLog.count({ where: { action: 'backup.verify' } })).toBe(
      await fx.prisma.backupVerification.count(),
    );
  });
});

describe('malformed and hostile archives', () => {
  const craft = async (
    name: string,
    build: (w: ContainerWriter, manifest: BackupManifest) => Promise<void>,
    edit?: (m: BackupManifest) => void,
  ) => {
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
      edit?.(manifest);
      const w2 = await ContainerWriter.create(join(tmp, 'c.bin'));
      for (const t of snap.tables)
        await w2.addFile(`data/${t.name}.ndjson`, snap.files.get(t.name)!, t.bytes);
      await build(w2, manifest);
      await w2.finish();
      const out = join(dir, `${name}.cbbackup`);
      await encryptFile(join(tmp, 'c.bin'), out, PASS, { logN: 10, r: 8, p: 1 });
      return out;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
  const inspectFile = async (path: string, pass = PASS) => {
    const reg = await control('POST', '/internal/backup/restore-source', { path });
    expect(reg.statusCode, reg.body).toBe(200);
    return post('/backup/restore/inspect', {
      sourceId: JSON.parse(reg.body).sourceId,
      passphrase: pass,
    });
  };

  it('10. an entry that tries to leave the extraction folder is rejected, and a raw archive with a traversal name is refused', async () => {
    // the writer itself refuses such a name...
    const tmp = mkdtempSync(join(tmpdir(), 'cb-w-'));
    const w2 = await ContainerWriter.create(join(tmp, 'c.bin'));
    await expect(w2.addBuffer('../../evil.txt', Buffer.from('x'))).rejects.toThrow();
    await expect(w2.addBuffer('data/..\\evil.ndjson', Buffer.from('x'))).rejects.toThrow();
    await w2.abort();
    // ...so write the hostile container bytes by hand
    const name = Buffer.from('../../../evil.txt', 'ascii');
    const head = Buffer.alloc(2 + name.length + 8);
    head.writeUInt16BE(name.length, 0);
    name.copy(head, 2);
    head.writeBigUInt64BE(5n, 2 + name.length);
    writeFileSync(
      join(tmp, 'raw.bin'),
      Buffer.concat([head, Buffer.from('hello'), Buffer.alloc(2)]),
    );
    const out = join(dir, 'traversal.cbbackup');
    await encryptFile(join(tmp, 'raw.bin'), out, PASS, { logN: 10, r: 8, p: 1 });
    const r = await inspectFile(out);
    expect(r.status).toBe(400);
    expect(r.json.error.problems).toEqual([{ field: 'file', rule: 'unreadable_backup' }]);
    expect(existsSync(resolve(dir, '..', 'evil.txt'))).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  }, 120_000);

  it('7-9. a manifest that disagrees with the data, a missing data file and extra entries are all refused', async () => {
    const lie = await craft(
      'lie',
      async (w2, m) => w2.addBuffer(MANIFEST_ENTRY, manifestBytes(m)),
      (m) => {
        m.tables[0]!.sha256 = 'f'.repeat(64);
      },
    );
    expect((await inspectFile(lie)).json.error.problems).toEqual([
      { field: 'file', rule: 'unreadable_backup' },
    ]);
    const missing = await craft(
      'missing',
      async (w2, m) => w2.addBuffer(MANIFEST_ENTRY, manifestBytes(m)),
      (m) => {
        m.tables.push({ name: 'ghost_table', rows: 0, bytes: 0, sha256: '0'.repeat(64) });
      },
    );
    expect((await inspectFile(missing)).status).toBe(400);
    const extra = await craft('extra', async (w2, m) => {
      await w2.addBuffer('data/extra_table.ndjson', Buffer.from('{}\n'));
      await w2.addBuffer(MANIFEST_ENTRY, manifestBytes(m));
    });
    expect((await inspectFile(extra)).status).toBe(400);
    const wrongFormat = await craft(
      'fmt',
      async (w2, m) => w2.addBuffer(MANIFEST_ENTRY, manifestBytes(m)),
      (m) => {
        (m as Json).formatVersion = 2;
      },
    );
    expect((await inspectFile(wrongFormat)).status).toBe(400);
  }, 240_000);

  it('a file that is not a backup is refused when it is chosen; a good one is described without any path', async () => {
    writeFileSync(join(dir, 'notes.cbbackup'), Buffer.alloc(500, 65));
    expect(
      (
        await control('POST', '/internal/backup/restore-source', {
          path: join(dir, 'notes.cbbackup'),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await control('POST', '/internal/backup/restore-source', {
          path: join(dir, 'nope.cbbackup'),
        })
      ).statusCode,
    ).toBe(400);
    const good = await craft('good', async (w2, m) =>
      w2.addBuffer(MANIFEST_ENTRY, manifestBytes(m)),
    );
    const r = await inspectFile(good);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(j(r)).toMatchObject({
      fileName: 'good.cbbackup',
      sameOrganization: true,
      schemaCompatible: true,
      sameDatabase: false,
      kind: 'MANUAL',
      verificationStatus: 'NOT_VERIFIED',
    });
    expect(JSON.stringify(j(r))).not.toContain(dir.replace(/\\/g, '\\\\'));
    expect((await inspectFile(good, OTHER_PASS)).status).toBe(400);
  }, 120_000);
});

describe('authorization, isolation and concurrency', () => {
  const endpoints: [string, string, string, () => unknown][] = [
    ['backup.history.read', 'GET', '/backup/status', () => undefined],
    ['backup.history.read', 'GET', '/backup/history', () => undefined],
    ['backup.history.read', 'GET', '/backup/readiness', () => undefined],
    ['backup.create', 'POST', '/backup', () => ({})],
    ['backup.create', 'POST', `/backup/${randomUUID()}/verify`, () => ({})],
    ['backup.create', 'PUT', '/backup/retention', () => ({})],
    ['backup.restore', 'POST', '/backup/restore/inspect', () => ({})],
    ['backup.restore', 'POST', '/backup/restore', () => ({})],
  ];
  it('each role gets exactly what the catalogue grants; no session means 401', async () => {
    for (const [, method, path, b] of endpoints) {
      expect(
        (await call(app, method as 'GET', path, { ...(b() !== undefined ? { body: b() } : {}) }))
          .status,
        `${method} ${path}`,
      ).toBe(401);
      expect(
        (
          await call(app, method as 'GET', path, {
            token: admin(),
            launch: false,
            ...(b() !== undefined ? { body: b() } : {}),
          })
        ).status,
      ).toBe(401);
    }
    for (const tpl of ROLE_TEMPLATES)
      for (const [key, method, path, b] of endpoints) {
        const r = await call(app, method as 'GET', path, {
          token: tokens[tpl.name]!,
          ...(b() !== undefined ? { body: b() } : {}),
        });
        if (!tpl.grants.includes(key)) expect(r.status, `${tpl.name} ${method} ${path}`).toBe(403);
        else expect(r.status, `${tpl.name} ${method} ${path}`).not.toBe(403);
      }
    const grants = (n: string) => ROLE_TEMPLATES.find((t) => t.name === n)!.grants;
    for (const n of ['Accountant', 'Billing Operator', 'Warehouse Operator', 'Viewer/Auditor']) {
      expect(grants(n), n).not.toContain('backup.create');
      expect(grants(n), n).not.toContain('backup.restore');
    }
  }, 120_000);

  it('41. a second backup while one runs is refused (409), never run twice at once; sequential ones are independent', async () => {
    const [a, b] = await Promise.all([
      post('/backup', { passphrase: PASS, passphraseConfirm: PASS }),
      post('/backup', { passphrase: PASS, passphraseConfirm: PASS }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json.error.problems).toEqual([{ field: 'backup', rule: 'busy' }]);
    expect(readdirSync(backupDir).filter((f) => f.endsWith('.partial'))).toEqual([]);
  }, 240_000);

  it('another organization cannot see or verify these backups', async () => {
    const org = await fx.prisma.organization.create({
      data: { legalName: 'DEMO Other Co (fictional)' },
    });
    const { seedReference } = await import('../../prisma/seed/reference/index.js');
    await seedReference(fx.prisma, { organizationId: org.id });
    await app.authService!.createUser({
      organizationId: org.id,
      username: 'admin.orgb',
      displayName: 'Admin B',
      password: PASSWORD,
      roleNames: ['Administrator'],
    });
    const tokenB = (
      await call(app, 'POST', '/auth/login', {
        body: { username: 'admin.orgb', password: PASSWORD, organizationId: org.id },
      })
    ).json.token as string;
    expect(j(await get('/backup/history', tokenB)).total).toBe(0);
    const some = await fx.prisma.backupRecord.findFirstOrThrow({
      where: { organizationId: fx.orgId },
    });
    expect((await post(`/backup/${some.id}/verify`, { passphrase: PASS }, tokenB)).status).toBe(
      404,
    );
    expect(j(await get('/backup/status', tokenB)).gate.met).toBe(false);
  }, 120_000);
});

describe('retention', () => {
  it('36. keeps the newest N verified backups, never the only verified one, and touches only recognised backup files', async () => {
    // an unrelated file and a look-alike that is not a CommerceBill backup
    writeFileSync(join(backupDir, 'notes.txt'), 'keep me');
    writeFileSync(
      join(backupDir, 'CommerceBill-20200101-000000-deadbeef.cbbackup'),
      Buffer.alloc(300, 1),
    );
    expect(
      (await call(app, 'PUT', '/backup/retention', { token: admin(), body: { retentionKeep: 0 } }))
        .status,
    ).toBe(400);
    expect(
      (await call(app, 'PUT', '/backup/retention', { token: admin(), body: { retentionKeep: 2 } }))
        .status,
    ).toBe(200);
    const verified = async () =>
      await fx.prisma.backupRecord.findMany({
        where: { fileDeletedAt: null, verifications: { some: { result: 'PASS' } } },
        orderBy: { createdAt: 'asc' },
      });
    const before = (await verified()).length;
    expect(before).toBeGreaterThanOrEqual(2);
    const created = (await newBackup({ verifyNow: true })).backup;
    const left = await verified();
    expect(left).toHaveLength(2);
    expect(left.map((r) => r.id)).toContain(created.id);
    for (const r of left) expect(existsSync(join(backupDir, r.fileName))).toBe(true);
    const removed = await fx.prisma.backupRecord.findMany({
      where: { fileDeletedAt: { not: null } },
    });
    expect(removed.length).toBeGreaterThanOrEqual(1);
    for (const r of removed)
      expect(existsSync(join(backupDir, r.fileName)), r.fileName).toBe(false);
    expect(readFileSync(join(backupDir, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(existsSync(join(backupDir, 'CommerceBill-20200101-000000-deadbeef.cbbackup'))).toBe(
      true,
    );
    // keep = 1 still keeps the newest verified one
    await call(app, 'PUT', '/backup/retention', { token: admin(), body: { retentionKeep: 1 } });
    expect((await call(app, 'POST', '/backup/retention/apply', { token: admin() })).status).toBe(
      200,
    );
    const one = await verified();
    expect(one).toHaveLength(1);
    expect(existsSync(join(backupDir, one[0]!.fileName))).toBe(true);
    // the history still lists the removed files, marked unavailable
    const hist = j(await get('/backup/history?limit=100'));
    expect(hist.backups.some((b: Json) => b.fileAvailable === false)).toBe(true);
    // records are append-only apart from the one-time removal mark
    await expect(
      fx.prisma.$executeRaw`UPDATE backup_records SET file_name = 'x.cbbackup'`,
    ).rejects.toThrow();
    await expect(fx.prisma.$executeRaw`DELETE FROM backup_records`).rejects.toThrow();
    await expect(
      fx.prisma.$executeRaw`UPDATE backup_verifications SET result = 'PASS'`,
    ).rejects.toThrow();
    await expect(fx.prisma.$executeRaw`DELETE FROM backup_verifications`).rejects.toThrow();
    await expect(fx.prisma.$executeRaw`TRUNCATE backup_verifications`).rejects.toThrow();
  }, 480_000);

  it('a restore that would not reproduce the backup is a FAIL on content identity, even though every other check passes', async () => {
    // A consistent archive whose rows carry a field the database does not have: it extracts, matches its manifest and loads, but the
    // restored rows re-export differently from what the manifest recorded.
    const created = await newBackup();
    const file = join(backupDir, created.backup.fileName);
    const tmp = mkdtempSync(join(tmpdir(), 'cb-ident-'));
    try {
      await decryptFile(file, join(tmp, 'plain'), PASS);
      mkdirSync(join(tmp, 'x'));
      const entries = await extractContainer(join(tmp, 'plain'), join(tmp, 'x'));
      const manifest = JSON.parse(
        readFileSync(entries.get(MANIFEST_ENTRY)!.path, 'utf8'),
      ) as BackupManifest;
      const target = entries.get('data/customers.ndjson')!;
      const lines = readFileSync(target.path, 'utf8').split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const changed = Buffer.from(
        lines.map((l) => JSON.stringify({ ...JSON.parse(l), not_a_column: 'x' })).join('\n') + '\n',
      );
      writeFileSync(join(tmp, 'customers.ndjson'), changed);
      const sha = (await import('node:crypto')).createHash('sha256').update(changed).digest('hex');
      const t = manifest.tables.find((x) => x.name === 'customers')!;
      t.bytes = changed.length;
      t.sha256 = sha;
      const w2 = await ContainerWriter.create(join(tmp, 'c.bin'));
      for (const m of manifest.tables) {
        const path =
          m.name === 'customers'
            ? join(tmp, 'customers.ndjson')
            : entries.get(`data/${m.name}.ndjson`)!.path;
        await w2.addFile(`data/${m.name}.ndjson`, path, m.bytes);
      }
      await w2.addBuffer(MANIFEST_ENTRY, manifestBytes(manifest));
      await w2.finish();
      rmSync(file);
      await encryptFile(join(tmp, 'c.bin'), file, PASS, { logN: 10, r: 8, p: 1 });
      // The record's fingerprint is made to match the altered manifest, so the ONLY thing left to notice is the content itself.
      await rawSql(
        `UPDATE backup_records SET manifest_sha256 = '${manifestFingerprint(manifestBytes(manifest))}' WHERE id = '${created.backup.id}'`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const r = await post(`/backup/${created.backup.id}/verify`, { passphrase: PASS });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const v = j(r).verification;
    expect(v.result).toBe('FAIL');
    expect(v.checks.filter((c: Json) => !c.ok).map((c: Json) => c.name)).toEqual([
      'restored_content_identical',
    ]);
  }, 240_000);
});
