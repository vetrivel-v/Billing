import { randomUUID } from 'node:crypto';
import {
  access,
  constants,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  readdir,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { Prisma, PrismaClient } from '@commercebill/database';
import type {
  BackupHistoryResponse,
  BackupRecoveryGate,
  BackupStatusResponse,
  BackupView,
  BackupVerificationView,
  RestoreInspectResponse,
  RestoreResultResponse,
} from '@commercebill/shared-types';
import pg from 'pg';
import {
  BackupFormatError,
  DecryptError,
  decryptFile,
  encryptFile,
  parseHeader,
  DEFAULT_KDF,
} from './crypto.js';
import { ContainerError, ContainerWriter, extractContainer, MANIFEST_ENTRY } from './container.js';
import { exportSnapshot, withClient } from './dump.js';
import { allPassed, runIntegrityChecks, type CheckResult } from './integrity.js';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  VERIFICATION_ENGINE_VERSION,
  ManifestError,
  manifestBytes,
  manifestFingerprint,
  parseManifest,
  type BackupManifest,
} from './manifest.js';
import {
  applyMigrations,
  createDatabase,
  databaseNameOf,
  dropDatabase,
  isolatedName,
  readMigrations,
  withDatabaseName,
} from './migrations.js';
import { loadSnapshot, PROJECTION_TABLE, RestoreError } from './restore.js';
import { open } from 'node:fs/promises';

export type BackupErrorCode =
  | 'validation_failed'
  | 'busy'
  | 'no_destination'
  | 'not_found'
  | 'file_missing'
  | 'wrong_passphrase'
  | 'unreadable'
  | 'schema_mismatch'
  | 'organization_mismatch'
  | 'safety_backup_failed'
  | 'restore_failed'
  | 'confirmation_required';

export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    message: string,
    readonly problems: { field: string; rule: string }[] = [],
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface BackupContext {
  userId: string;
  organizationId: string;
  correlationId?: string | null;
}

export interface BackupServiceOptions {
  prisma: PrismaClient;
  /** Connection string of the live application database. Never sent to a client. */
  databaseUrl: string;
  /** The directory holding the application's migrations (the schema of every restored database comes from here). */
  migrationsDir: string;
  appVersion: string;
  clock?: () => Date;
  /** A recovery record is "current" for this many days after it was verified (ADR-0027). */
  maxVerificationAgeDays?: number;
  /** Called with true while an active restore blocks business writes, and false afterwards. */
  onMaintenance?: (on: boolean) => void;
  /** Called after the live database was replaced, so the connection pool re-resolves the database. */
  reconnect?: () => Promise<void>;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export const DEFAULT_MAX_VERIFICATION_AGE_DAYS = 30;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.cbbackup$/;
const MIN_PASSPHRASE = 12;
const MAX_PASSPHRASE = 200;
const IDENTITY_KEY = 'recovery.database_identity';
const DESTINATION_KEY = 'backup.destination';
const RETENTION_KEY = 'backup.retention_keep';

const stamp = (d: Date) =>
  d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const sizeNumber = (b: bigint): number => Number(b);

export function validatePassphrase(
  p: unknown,
  confirm?: unknown,
  requireConfirm = false,
): { field: string; rule: string }[] {
  const problems: { field: string; rule: string }[] = [];
  if (typeof p !== 'string' || p === '') problems.push({ field: 'passphrase', rule: 'required' });
  else if (p.trim() === '') problems.push({ field: 'passphrase', rule: 'blank' });
  else if (p.length < MIN_PASSPHRASE) problems.push({ field: 'passphrase', rule: 'too_short' });
  else if (p.length > MAX_PASSPHRASE) problems.push({ field: 'passphrase', rule: 'too_long' });
  if (requireConfirm && problems.length === 0 && confirm !== p)
    problems.push({ field: 'passphraseConfirm', rule: 'mismatch' });
  return problems;
}

type RecordRow = Prisma.BackupRecordGetPayload<{ include: { verifications: true } }>;

export function createBackupService(options: BackupServiceOptions) {
  const { prisma, databaseUrl, migrationsDir, appVersion } = options;
  const clock = options.clock ?? (() => new Date());
  const maxAgeMs =
    (options.maxVerificationAgeDays ?? DEFAULT_MAX_VERIFICATION_AGE_DAYS) * 86_400_000;
  const adminUrl = withDatabaseName(databaseUrl, 'postgres');
  const liveName = databaseNameOf(databaseUrl);
  /** Registered by the desktop shell only (never from a client request): where a restore file was chosen. */
  const restoreSources = new Map<string, { path: string; fileName: string; expires: number }>();

  // ------------------------------------------------------------------------------------------ small helpers
  const settingValue = async <T>(organizationId: string, key: string): Promise<T | null> =>
    ((
      await prisma.organizationSetting.findUnique({
        where: { organizationId_key: { organizationId, key } },
      })
    )?.value as T | undefined) ?? null;
  const setSetting = async (organizationId: string, key: string, value: Prisma.InputJsonValue) => {
    await prisma.organizationSetting.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, value },
      update: { value },
    });
  };

  async function schemaVersionNow(): Promise<string> {
    const r = await prisma.$queryRaw<
      { migration_name: string }[]
    >`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1`;
    return r[0]!.migration_name;
  }

  /** The identity of this database. Created on first use; replaced after a restore (so an old verification no longer applies). */
  async function ensureIdentity(organizationId: string): Promise<string> {
    const existing = await settingValue<{ id: string }>(organizationId, IDENTITY_KEY);
    if (existing?.id) return existing.id;
    await prisma.organizationSetting.createMany({
      data: [{ organizationId, key: IDENTITY_KEY, value: { id: randomUUID() } }],
      skipDuplicates: true,
    });
    return (await settingValue<{ id: string }>(organizationId, IDENTITY_KEY))!.id;
  }

  async function audit(
    ctx: Omit<BackupContext, 'userId'> & { userId: string | null },
    action: string,
    entityId: string | null,
    after: Prisma.InputJsonValue,
    db: Prisma.TransactionClient | PrismaClient = prisma,
  ) {
    await db.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        category: 'business',
        action,
        entityType: 'backup',
        entityId,
        afterValues: after,
        appVersion,
        correlationId: ctx.correlationId ?? null,
        occurredAt: clock(),
      },
    });
  }

  /** One backup/verify/restore at a time, across processes (a session advisory lock on a dedicated connection). */
  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const c = new pg.Client({
      connectionString: databaseUrl,
      application_name: 'commercebill-backup-lock',
    });
    c.on('error', () => undefined); // the connection may be terminated deliberately by an active restore
    await c.connect();
    try {
      const got = (
        await c.query<{ ok: boolean }>(
          `SELECT pg_try_advisory_lock(hashtextextended('commercebill.backup', 0)) AS ok`,
        )
      ).rows[0]?.ok;
      if (!got)
        throw new BackupError(
          'busy',
          'Another backup, verification or restore is already running. Try again when it has finished.',
        );
      try {
        return await fn();
      } finally {
        await c
          .query(`SELECT pg_advisory_unlock(hashtextextended('commercebill.backup', 0))`)
          .catch(() => undefined);
      }
    } finally {
      await c.end().catch(() => undefined);
    }
  }

  async function destinationOf(
    organizationId: string,
  ): Promise<{ path: string; label: string } | null> {
    return settingValue<{ path: string; label: string }>(organizationId, DESTINATION_KEY);
  }

  /** The path of a recorded backup file: only ever INSIDE the registered destination, only for a recognized file name. */
  async function resolveBackupFile(organizationId: string, fileName: string): Promise<string> {
    const dest = await destinationOf(organizationId);
    if (!dest || !FILE_NAME.test(fileName))
      throw new BackupError('file_missing', 'The backup file is not available.');
    const root = await realpath(dest.path).catch(() => null);
    if (!root) throw new BackupError('file_missing', 'The backup folder is not available.');
    const full = resolve(root, fileName);
    if (!full.startsWith(root + sep))
      throw new BackupError('file_missing', 'The backup file is not available.');
    try {
      await access(full, constants.R_OK);
    } catch {
      throw new BackupError(
        'file_missing',
        'The backup file is not available in the backup folder.',
      );
    }
    return full;
  }

  // ------------------------------------------------------------------------------------------ views
  const verificationView = (v: RecordRow['verifications'][number]): BackupVerificationView => ({
    id: v.id,
    result: v.result as 'PASS' | 'FAIL',
    verifiedAt: v.verifiedAt.toISOString(),
    engineVersion: v.engineVersion,
    checks: ((v.details as { checks?: CheckResult[] } | null)?.checks ?? []).map((c) => ({
      name: c.name,
      ok: c.ok,
    })),
  });
  const backupView = (r: RecordRow): BackupView => {
    const sorted = [...r.verifications].sort((a, b) =>
      a.seq < b.seq ? 1 : a.seq > b.seq ? -1 : 0,
    );
    return {
      id: r.id,
      kind: r.kind as 'MANUAL' | 'PRE_RESTORE',
      fileName: r.fileName,
      destinationLabel: r.destinationLabel,
      sizeBytes: sizeNumber(r.sizeBytes),
      createdAt: r.createdAt.toISOString(),
      appVersion: r.appVersion,
      schemaVersion: r.schemaVersion,
      backupFormat: r.backupFormat,
      fileAvailable: r.fileDeletedAt === null,
      verification: sorted[0] ? verificationView(sorted[0]) : null,
    };
  };

  // ------------------------------------------------------------------------------------------ the production gate fact
  async function recoveryGate(organizationId: string): Promise<BackupRecoveryGate> {
    const latest = await prisma.backupVerification.findFirst({
      where: { organizationId },
      orderBy: { seq: 'desc' },
    });
    if (!latest)
      return { met: false, reason: 'NO_VERIFIED_BACKUP', verifiedAt: null, expiresAt: null };
    const base = {
      verifiedAt: latest.verifiedAt.toISOString(),
      expiresAt: new Date(latest.verifiedAt.getTime() + maxAgeMs).toISOString(),
    };
    if (latest.result !== 'PASS')
      return { met: false, reason: 'LATEST_VERIFICATION_FAILED', ...base };
    if (latest.engineVersion !== VERIFICATION_ENGINE_VERSION)
      return { met: false, reason: 'VERIFICATION_ENGINE_CHANGED', ...base };
    if (latest.schemaVersion !== (await schemaVersionNow()))
      return { met: false, reason: 'SCHEMA_CHANGED', ...base };
    const identity = await settingValue<{ id: string }>(organizationId, IDENTITY_KEY);
    if (!identity || latest.databaseId !== identity.id)
      return { met: false, reason: 'DATABASE_CHANGED', ...base };
    if (clock().getTime() - latest.verifiedAt.getTime() > maxAgeMs)
      return { met: false, reason: 'VERIFICATION_TOO_OLD', ...base };
    return { met: true, reason: 'CURRENT', ...base };
  }

  // ------------------------------------------------------------------------------------------ control (desktop shell only)
  async function registerDestination(
    organizationId: string,
    folder: string,
  ): Promise<{ label: string }> {
    const root = await realpath(resolve(folder)).catch(() => null);
    const info = root ? await stat(root).catch(() => null) : null;
    if (!root || !info?.isDirectory())
      throw new BackupError('validation_failed', 'The chosen backup folder does not exist.', [
        { field: 'destination', rule: 'not_a_folder' },
      ]);
    try {
      await access(root, constants.W_OK);
    } catch {
      throw new BackupError('validation_failed', 'The chosen backup folder cannot be written to.', [
        { field: 'destination', rule: 'not_writable' },
      ]);
    }
    const label = basename(root).slice(0, 80) || 'Backup folder';
    await setSetting(organizationId, DESTINATION_KEY, { path: root, label });
    return { label };
  }

  async function registerRestoreSource(
    file: string,
  ): Promise<{ sourceId: string; fileName: string }> {
    const full = await realpath(resolve(file)).catch(() => null);
    const info = full ? await stat(full).catch(() => null) : null;
    if (!full || !info?.isFile() || info.size < 58)
      throw new BackupError('validation_failed', 'The chosen file is not a backup.', [
        { field: 'file', rule: 'not_a_backup' },
      ]);
    const fh = await open(full, 'r');
    try {
      const head = Buffer.alloc(64);
      await fh.read(head, 0, 64, 0);
      parseHeader(head);
    } catch (e) {
      if (e instanceof BackupFormatError)
        throw new BackupError('unreadable', e.message, [{ field: 'file', rule: 'not_a_backup' }]);
      throw e;
    } finally {
      await fh.close();
    }
    const sourceId = randomUUID();
    const now = Date.now();
    for (const [k, v] of restoreSources) if (v.expires < now) restoreSources.delete(k);
    restoreSources.set(sourceId, {
      path: full,
      fileName: basename(full).slice(0, 120),
      expires: now + 15 * 60_000,
    });
    return { sourceId, fileName: basename(full).slice(0, 120) };
  }

  // ------------------------------------------------------------------------------------------ opening an archive
  interface Opened {
    manifest: BackupManifest;
    manifestSha: string;
    files: Map<string, string>;
    dir: string;
  }

  /** Decrypts and validates an archive into `dir`: authentication, container, manifest and every checksum. */
  async function openArchive(file: string, passphrase: string, dir: string): Promise<Opened> {
    const plain = join(dir, 'payload.bin');
    try {
      await decryptFile(file, plain, passphrase);
    } catch (e) {
      if (e instanceof DecryptError) throw new BackupError('wrong_passphrase', e.message);
      if (e instanceof BackupFormatError) throw new BackupError('unreadable', e.message);
      throw e;
    }
    let entries;
    try {
      entries = await extractContainer(plain, dir);
    } catch (e) {
      if (e instanceof ContainerError)
        throw new BackupError('unreadable', 'The backup archive is damaged or not valid.');
      throw e;
    } finally {
      await rm(plain, { force: true });
    }
    const m = entries.get(MANIFEST_ENTRY);
    if (!m) throw new BackupError('unreadable', 'The backup has no manifest.');
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(m.path);
    let manifest: BackupManifest;
    try {
      manifest = parseManifest(bytes);
    } catch (e) {
      if (e instanceof ManifestError) throw new BackupError('unreadable', e.message);
      throw e;
    }
    const files = new Map<string, string>();
    for (const t of manifest.tables) {
      const e = entries.get(`data/${t.name}.ndjson`);
      if (!e || e.sha256 !== t.sha256 || e.size !== t.bytes)
        throw new BackupError(
          'unreadable',
          'The backup data does not match its manifest: the backup is damaged or has been changed.',
        );
      files.set(t.name, e.path);
    }
    for (const name of entries.keys())
      if (name !== MANIFEST_ENTRY && !manifest.tables.some((t) => `data/${t.name}.ndjson` === name))
        throw new BackupError(
          'unreadable',
          'The backup contains data that its manifest does not list.',
        );
    return { manifest, manifestSha: manifestFingerprint(bytes), files, dir };
  }

  // ------------------------------------------------------------------------------------------ restore into an isolated database
  async function restoreToIsolated(
    opened: Opened,
    prefix: string,
  ): Promise<{ name: string; url: string; checks: CheckResult[]; loadError?: string }> {
    const name = isolatedName(prefix);
    const url = withDatabaseName(databaseUrl, name);
    await createDatabase(adminUrl, name);
    const migrations = await readMigrations(migrationsDir);
    const expected = migrations.at(-1)!.name;
    try {
      await applyMigrations(url, migrationsDir);
      if (opened.manifest.schemaVersion !== expected)
        return {
          name,
          url,
          checks: [
            {
              name: 'schema_version',
              ok: false,
              detail: 'backup and application schema versions differ',
            },
          ],
        };
      try {
        await withClient(url, (c) => loadSnapshot(c, opened.files));
      } catch (e) {
        options.logger?.warn(
          { err: e instanceof Error ? e.message : String(e) },
          'backup restore load failed',
        );
        const detail = e instanceof RestoreError ? e.code : 'LOAD_FAILED';
        return { name, url, checks: [{ name: 'restore_load', ok: false, detail }] };
      }
      const checks = await runIntegrityChecks(url, {
        manifest: opened.manifest,
        expectedSchemaVersion: expected,
        migrationSql: migrations.map((m) => m.sql),
        dumpedBalancesFile: opened.files.get(PROJECTION_TABLE),
      });
      return { name, url, checks };
    } catch (e) {
      await dropDatabase(adminUrl, name).catch(() => undefined);
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------ create
  async function createInner(
    ctx: BackupContext,
    input: { passphrase: string; kind: 'MANUAL' | 'PRE_RESTORE'; verifyNow: boolean },
  ): Promise<{ record: BackupView; verification: BackupVerificationView | null }> {
    const dest = await destinationOf(ctx.organizationId);
    if (!dest) throw new BackupError('no_destination', 'Choose a backup folder first.');
    const root = await realpath(dest.path).catch(() => null);
    if (!root)
      throw new BackupError(
        'no_destination',
        'The backup folder is not available. Choose it again.',
      );
    const dir = await mkdtemp(join(tmpdir(), 'cb-backup-'));
    const backupId = randomUUID();
    const createdAt = clock();
    const fileName = `CommerceBill-${stamp(createdAt)}-${backupId.slice(0, 8)}.cbbackup`;
    const finalPath = join(root, fileName);
    const partial = `${finalPath}.partial`;
    let finalised = false;
    let recorded = false;
    try {
      const identity = await ensureIdentity(ctx.organizationId);
      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: ctx.organizationId },
        select: { id: true, legalName: true },
      });
      const dataDir = join(dir, 'data');
      await mkdir(dataDir, { mode: 0o700 });
      const snapshot = await exportSnapshot(databaseUrl, dataDir);
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        backupId,
        kind: input.kind,
        createdAt: createdAt.toISOString(),
        appVersion,
        schemaVersion: snapshot.schemaVersion,
        databaseId: identity,
        organization: { id: org.id, legalName: org.legalName },
        snapshot: { isolation: 'REPEATABLE READ READ ONLY' },
        attachments: { present: false, manifestVersion: 1 },
        excludedTables: ['sessions'],
        tables: snapshot.tables,
        encryption: { cipher: 'AES-256-GCM (chunked)', kdf: 'scrypt', ...DEFAULT_KDF },
      };
      const bytes = manifestBytes(manifest);
      const containerPath = join(dir, 'container.bin');
      const w = await ContainerWriter.create(containerPath);
      try {
        for (const t of snapshot.tables)
          await w.addFile(`data/${t.name}.ndjson`, snapshot.files.get(t.name)!, t.bytes);
        await w.addBuffer(MANIFEST_ENTRY, bytes);
        await w.finish();
      } catch (e) {
        await w.abort();
        throw e;
      }
      const { bytes: size } = await encryptFile(containerPath, partial, input.passphrase);
      await rename(partial, finalPath); // the file appears under its final name only once it is complete
      finalised = true;
      await rm(containerPath, { force: true });
      await rm(dataDir, { recursive: true, force: true });

      // The finished archive must decrypt, parse and match its own checksums before it is recorded as a backup.
      const checkDir = await mkdtemp(join(tmpdir(), 'cb-check-'));
      try {
        const reopened = await openArchive(finalPath, input.passphrase, checkDir);
        if (reopened.manifestSha !== manifestFingerprint(bytes))
          throw new BackupError(
            'unreadable',
            'The finished backup does not match what was written.',
          );
      } finally {
        await rm(checkDir, { recursive: true, force: true });
      }

      await prisma.backupRecord.create({
        data: {
          id: backupId,
          organizationId: ctx.organizationId,
          kind: input.kind,
          fileName,
          destinationLabel: dest.label,
          sizeBytes: BigInt(size),
          appVersion,
          schemaVersion: snapshot.schemaVersion,
          backupFormat: BACKUP_FORMAT_VERSION,
          databaseId: identity,
          manifestSha256: manifestFingerprint(bytes),
          createdBy: ctx.userId,
          createdAt,
          correlationId: ctx.correlationId ?? null,
        },
      });
      recorded = true;
      await audit(ctx, 'backup.create', backupId, {
        backupId,
        kind: input.kind,
        sizeBytes: size,
        schemaVersion: snapshot.schemaVersion,
        tables: snapshot.tables.length,
      });
      let verification: BackupVerificationView | null = null;
      if (input.verifyNow) verification = await verifyInner(ctx, backupId, input.passphrase);
      const row = await prisma.backupRecord.findUniqueOrThrow({
        where: { id: backupId },
        include: { verifications: true },
      });
      return { record: backupView(row), verification };
    } catch (e) {
      await rm(partial, { force: true }).catch(() => undefined);
      if (finalised && !recorded) await unlink(finalPath).catch(() => undefined); // an unrecorded file is not left behind
      await audit(ctx, 'backup.create_failed', null, {
        kind: input.kind,
        reason: e instanceof BackupError ? e.code : 'error',
      }).catch(() => undefined);
      throw e;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function createBackup(
    ctx: BackupContext,
    raw: { passphrase?: unknown; passphraseConfirm?: unknown; verifyNow?: unknown },
  ) {
    const problems = validatePassphrase(raw.passphrase, raw.passphraseConfirm, true);
    if (problems.length > 0)
      throw new BackupError('validation_failed', 'The passphrase is not valid.', problems);
    const out = await exclusive(() =>
      createInner(ctx, {
        passphrase: raw.passphrase as string,
        kind: 'MANUAL',
        verifyNow: raw.verifyNow === true,
      }),
    );
    if (out.verification?.result === 'PASS') await applyRetentionInner(ctx).catch(() => undefined);
    return out;
  }

  // ------------------------------------------------------------------------------------------ verify
  async function verifyInner(
    ctx: BackupContext,
    backupId: string,
    passphrase: string,
  ): Promise<BackupVerificationView> {
    const record = await prisma.backupRecord.findFirst({
      where: { id: backupId, organizationId: ctx.organizationId },
    });
    if (!record) throw new BackupError('not_found', 'Backup not found.');
    const file = await resolveBackupFile(ctx.organizationId, record.fileName);
    const dir = await mkdtemp(join(tmpdir(), 'cb-verify-'));
    let isolated: string | null = null;
    const started = Date.now();
    try {
      let checks: CheckResult[];
      let tables = 0;
      let rows = 0;
      try {
        const opened = await openArchive(file, passphrase, dir);
        const sound: CheckResult[] = [
          { name: 'archive_authenticated', ok: true },
          {
            name: 'manifest_valid',
            ok:
              opened.manifest.backupId === record.id &&
              opened.manifestSha === record.manifestSha256,
            detail: 'matches the recorded backup',
          },
          { name: 'checksums_match', ok: true },
        ];
        tables = opened.manifest.tables.length;
        rows = opened.manifest.tables.reduce((n, t) => n + t.rows, 0);
        if (!sound[1]!.ok) checks = sound;
        else {
          const restored = await restoreToIsolated(opened, 'cb_verify');
          isolated = restored.name;
          checks = [...sound, ...restored.checks];
        }
      } catch (e) {
        // A wrong passphrase or damaged file is reported to the user but is not a verification RESULT. A backup whose
        // contents do not match its manifest IS a failed verification.
        if (
          e instanceof BackupError &&
          (e.code === 'wrong_passphrase' || e.code === 'file_missing')
        )
          throw e;
        if (!(e instanceof BackupError))
          options.logger?.warn(
            { err: e instanceof Error ? e.message : String(e) },
            'backup verification error',
          );
        checks = [
          {
            name: 'archive_readable',
            ok: false,
            detail: e instanceof BackupError ? e.code : 'error',
          },
        ];
      }
      const pass = allPassed(checks);
      const row = await prisma.backupVerification.create({
        data: {
          organizationId: ctx.organizationId,
          backupId: record.id,
          result: pass ? 'PASS' : 'FAIL',
          engineVersion: VERIFICATION_ENGINE_VERSION,
          schemaVersion: record.schemaVersion,
          databaseId: record.databaseId,
          verifiedAt: clock(),
          details: {
            checks,
            tables,
            rows,
            durationMs: Date.now() - started,
          } as unknown as Prisma.InputJsonValue,
          verifiedBy: ctx.userId,
        },
      });
      await audit(ctx, 'backup.verify', record.id, {
        backupId: record.id,
        result: row.result,
        failedChecks: checks.filter((c) => !c.ok).map((c) => c.name),
      });
      return verificationView({
        ...row,
        backupId: row.backupId,
      } as RecordRow['verifications'][number]);
    } finally {
      // The result is persisted first; only then is the isolated database removed, and every temporary file with it.
      if (isolated)
        await dropDatabase(adminUrl, isolated).catch((e) =>
          options.logger?.warn(
            { err: String(e) },
            'could not drop the isolated verification database',
          ),
        );
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function verifyBackup(ctx: BackupContext, backupId: string, raw: { passphrase?: unknown }) {
    const problems = validatePassphrase(raw.passphrase);
    if (problems.length > 0)
      throw new BackupError('validation_failed', 'The passphrase is not valid.', problems);
    return exclusive(() => verifyInner(ctx, backupId, raw.passphrase as string));
  }

  // ------------------------------------------------------------------------------------------ reading
  async function status(organizationId: string): Promise<BackupStatusResponse> {
    const [dest, keep, last, gate, schema, lastVerified] = await Promise.all([
      destinationOf(organizationId),
      settingValue<{ keep: number }>(organizationId, RETENTION_KEY),
      prisma.backupRecord.findFirst({
        where: { organizationId },
        orderBy: { seq: 'desc' },
        include: { verifications: true },
      }),
      recoveryGate(organizationId),
      schemaVersionNow(),
      prisma.backupVerification.findFirst({
        where: { organizationId, result: 'PASS' },
        orderBy: { seq: 'desc' },
      }),
    ]);
    return {
      destination: dest ? { label: dest.label } : null,
      retentionKeep: keep?.keep ?? null,
      lastBackup: last ? backupView(last) : null,
      lastVerifiedAt: lastVerified?.verifiedAt.toISOString() ?? null,
      gate,
      schemaVersion: schema,
      appVersion,
      maxVerificationAgeDays: Math.round(maxAgeMs / 86_400_000),
    };
  }

  async function history(
    organizationId: string,
    o: { limit: number; offset: number },
  ): Promise<BackupHistoryResponse> {
    const [rows, total] = await Promise.all([
      prisma.backupRecord.findMany({
        where: { organizationId },
        orderBy: { seq: 'desc' },
        take: o.limit,
        skip: o.offset,
        include: { verifications: true },
      }),
      prisma.backupRecord.count({ where: { organizationId } }),
    ]);
    return { backups: rows.map(backupView), total, limit: o.limit, offset: o.offset };
  }

  // ------------------------------------------------------------------------------------------ retention
  async function setRetention(
    ctx: BackupContext,
    keep: unknown,
  ): Promise<{ retentionKeep: number | null }> {
    if (
      keep !== null &&
      (!Number.isInteger(keep) || (keep as number) < 1 || (keep as number) > 365)
    )
      throw new BackupError('validation_failed', 'Keep between 1 and 365 verified backups.', [
        { field: 'retentionKeep', rule: 'out_of_range' },
      ]);
    await setSetting(ctx.organizationId, RETENTION_KEY, { keep: keep as number | null });
    await audit(ctx, 'backup.retention_changed', null, { retentionKeep: keep as number | null });
    return { retentionKeep: (keep as number | null) ?? null };
  }

  /**
   * Keeps the newest N VERIFIED backups (N from the setting) and removes the files of older verified manual backups. It only ever
   * touches recorded backup files inside the registered destination, never the newest verified one, and never any other file.
   */
  async function applyRetentionInner(ctx: BackupContext): Promise<{ removed: number }> {
    const keep = (await settingValue<{ keep: number | null }>(ctx.organizationId, RETENTION_KEY))
      ?.keep;
    if (!keep || keep < 1) return { removed: 0 };
    const rows = await prisma.backupRecord.findMany({
      where: {
        organizationId: ctx.organizationId,
        kind: 'MANUAL',
        fileDeletedAt: null,
        verifications: { some: { result: 'PASS' } },
      },
      orderBy: { seq: 'desc' },
    });
    let removed = 0;
    for (const r of rows.slice(keep)) {
      const file = await resolveBackupFile(ctx.organizationId, r.fileName).catch(() => null);
      if (file) {
        // Only a genuine CommerceBill backup file is ever removed.
        const fh = await open(file, 'r');
        try {
          const head = Buffer.alloc(64);
          await fh.read(head, 0, 64, 0);
          parseHeader(head);
        } catch {
          continue;
        } finally {
          await fh.close();
        }
        await unlink(file).catch(() => undefined);
      }
      await prisma.backupRecord.update({ where: { id: r.id }, data: { fileDeletedAt: clock() } });
      removed++;
    }
    if (removed > 0) await audit(ctx, 'backup.retention_applied', null, { removed, keep });
    return { removed };
  }

  async function applyRetention(ctx: BackupContext) {
    return exclusive(() => applyRetentionInner(ctx));
  }

  // ------------------------------------------------------------------------------------------ inspect and active restore
  async function inspect(
    ctx: BackupContext,
    raw: { sourceId?: unknown; passphrase?: unknown },
  ): Promise<RestoreInspectResponse> {
    const problems = validatePassphrase(raw.passphrase);
    if (problems.length > 0 || typeof raw.sourceId !== 'string')
      throw new BackupError('validation_failed', 'The request is not valid.', problems);
    const src = restoreSources.get(raw.sourceId);
    if (!src || src.expires < Date.now())
      throw new BackupError('not_found', 'Choose the backup file again.');
    const dir = await mkdtemp(join(tmpdir(), 'cb-inspect-'));
    try {
      const o = await openArchive(src.path, raw.passphrase as string, dir);
      const identity = await settingValue<{ id: string }>(ctx.organizationId, IDENTITY_KEY);
      const known = await prisma.backupVerification.findFirst({
        where: { organizationId: ctx.organizationId, backupId: o.manifest.backupId },
        orderBy: { seq: 'desc' },
      });
      const expected = (await readMigrations(migrationsDir)).at(-1)!.name;
      return {
        fileName: src.fileName,
        createdAt: o.manifest.createdAt,
        organizationName: o.manifest.organization.legalName,
        sameOrganization: o.manifest.organization.id === ctx.organizationId,
        appVersion: o.manifest.appVersion,
        schemaVersion: o.manifest.schemaVersion,
        schemaCompatible: o.manifest.schemaVersion === expected,
        sameDatabase: identity?.id === o.manifest.databaseId,
        kind: o.manifest.kind,
        tables: o.manifest.tables.length,
        rows: o.manifest.tables.reduce((n, t) => n + t.rows, 0),
        verificationStatus: known ? (known.result as 'PASS' | 'FAIL') : 'NOT_VERIFIED',
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Replaces the active business database with a backup. The live database is never overwritten in place:
   *  1. writes are blocked; 2. a PRE-RESTORE safety backup of the current business is created AND verified (or nothing happens);
   *  3. the backup is restored into a NEW database and passes every integrity check; 4. only then are the two databases swapped by
   *  renaming, and the previous one is kept (renamed) as a further safety copy. Any failure before the swap leaves the live database
   *  exactly as it was.
   */
  async function restoreActive(
    ctx: BackupContext,
    raw: { sourceId?: unknown; passphrase?: unknown; confirmation?: unknown },
  ): Promise<RestoreResultResponse> {
    const problems = validatePassphrase(raw.passphrase);
    if (problems.length > 0 || typeof raw.sourceId !== 'string')
      throw new BackupError('validation_failed', 'The request is not valid.', problems);
    if (raw.confirmation !== 'RESTORE')
      throw new BackupError('confirmation_required', 'Type RESTORE to confirm.', [
        { field: 'confirmation', rule: 'required' },
      ]);
    const src = restoreSources.get(raw.sourceId);
    if (!src || src.expires < Date.now())
      throw new BackupError('not_found', 'Choose the backup file again.');
    const passphrase = raw.passphrase as string;

    return exclusive(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cb-restore-'));
      let restoredName: string | null = null;
      let swapped = false;
      await audit(ctx, 'backup.restore_attempted', null, { fileName: src.fileName });
      options.onMaintenance?.(true);
      try {
        // Validate everything about the source BEFORE touching anything.
        const opened = await openArchive(src.path, passphrase, dir);
        const expected = (await readMigrations(migrationsDir)).at(-1)!.name;
        if (opened.manifest.schemaVersion !== expected)
          throw new BackupError(
            'schema_mismatch',
            'This backup was made by a different version of CommerceBill and cannot be restored by this version.',
          );
        if (opened.manifest.organization.id !== ctx.organizationId)
          throw new BackupError(
            'organization_mismatch',
            'This backup belongs to a different business and cannot replace this one.',
          );
        await quiesce();

        // The safety point: a verified backup of the current business, made first.
        const safety = await createInner(ctx, { passphrase, kind: 'PRE_RESTORE', verifyNow: true });
        if (safety.verification?.result !== 'PASS')
          throw new BackupError(
            'safety_backup_failed',
            'A safety backup of the current business could not be verified, so nothing was restored.',
          );
        const destBefore = await destinationOf(ctx.organizationId);
        // The whole backup history of the live database (every record, verification and removed-file mark, including the
        // safety backup just made): it is carried into the restored database so the history never loses an entry.
        const history = await prisma.backupRecord.findMany({
          where: { organizationId: ctx.organizationId },
          include: { verifications: true },
          orderBy: { seq: 'asc' },
        });

        // Restore into a new database and verify it completely.
        const restored = await restoreToIsolated(opened, 'cb_restore');
        restoredName = restored.name;
        if (!allPassed(restored.checks))
          throw new BackupError(
            'restore_failed',
            'The backup was restored into a test database but failed the integrity checks, so the current business was left unchanged.',
          );

        // Swap by renaming. All connections to either database are closed first; the pool reconnects afterwards.
        const oldName =
          `${liveName}_pre_restore_${stamp(clock()).replace('-', '')}_${randomUUID().slice(0, 4)}`.slice(
            0,
            63,
          );
        await options.reconnect?.();
        await withClient(adminUrl, async (c) => {
          await c.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND pid <> pg_backend_pid()`,
            [[liveName, restoredName]],
          );
          await c.query(`ALTER DATABASE "${liveName.replace(/"/g, '""')}" RENAME TO "${oldName}"`);
          try {
            await c.query(
              `ALTER DATABASE "${restoredName!.replace(/"/g, '""')}" RENAME TO "${liveName.replace(/"/g, '""')}"`,
            );
          } catch (e) {
            await c.query(
              `ALTER DATABASE "${oldName}" RENAME TO "${liveName.replace(/"/g, '""')}"`,
            );
            throw e;
          }
        });
        swapped = true;
        restoredName = null; // it is the live database now
        await options.reconnect?.();

        // In the restored database: a new identity (older verifications no longer apply), the safety backup in the history,
        // the folder the user chose, and the audit trail of the restore itself.
        await prisma.$executeRaw`UPDATE organization_settings SET value = jsonb_build_object('id', gen_random_uuid()::text) WHERE key = ${IDENTITY_KEY}`;
        // The restored database knows only the users that existed when the backup was made. History written by anyone else (for example
        // the administrator who is restoring now, created after the backup) keeps no author here: "unknown", never a guess.
        let historyCarried = true;
        const known = new Set(
          (await prisma.user.findMany({ select: { id: true } })).map((u) => u.id),
        );
        const author = (id: string | null): string | null => (id && known.has(id) ? id : null);
        try {
          await prisma.backupRecord.createMany({
            data: history.map((r) => ({
              id: r.id,
              organizationId: r.organizationId,
              kind: r.kind,
              fileName: r.fileName,
              destinationLabel: r.destinationLabel,
              sizeBytes: r.sizeBytes,
              appVersion: r.appVersion,
              schemaVersion: r.schemaVersion,
              backupFormat: r.backupFormat,
              databaseId: r.databaseId,
              manifestSha256: r.manifestSha256,
              createdBy: author(r.createdBy),
              createdAt: r.createdAt,
              correlationId: r.correlationId,
              fileDeletedAt: r.fileDeletedAt,
            })),
            skipDuplicates: true,
          });
          for (const r of history)
            if (r.fileDeletedAt)
              await prisma.$executeRaw`UPDATE backup_records SET file_deleted_at = ${r.fileDeletedAt} WHERE id = ${r.id}::uuid AND file_deleted_at IS NULL`;
          for (const v of history
            .flatMap((r) => r.verifications)
            .sort((x, y) => (x.seq < y.seq ? -1 : 1)))
            await prisma.backupVerification.createMany({
              data: [
                {
                  id: v.id,
                  organizationId: v.organizationId,
                  backupId: v.backupId,
                  result: v.result,
                  engineVersion: v.engineVersion,
                  schemaVersion: v.schemaVersion,
                  databaseId: v.databaseId,
                  verifiedAt: v.verifiedAt,
                  details: v.details as Prisma.InputJsonValue,
                  verifiedBy: author(v.verifiedBy),
                },
              ],
              skipDuplicates: true,
            });
        } catch (e) {
          historyCarried = false;
          options.logger?.warn(
            { err: e instanceof Error ? e.message.slice(0, 600) : String(e) },
            'backup history could not be carried into the restored database',
          );
        }
        if (destBefore) await setSetting(ctx.organizationId, DESTINATION_KEY, destBefore);
        await audit(
          { ...ctx, userId: author(ctx.userId) },
          'backup.restore_completed',
          manifestBackupId(opened),
          {
            restoredBackupId: manifestBackupId(opened),
            safetyBackupId: safety.record.id,
            restoredCreatedAt: opened.manifest.createdAt,
            historyCarried,
          },
        );
        return {
          status: 'RESTORED',
          restoredBackupId: manifestBackupId(opened),
          restoredFromCreatedAt: opened.manifest.createdAt,
          safetyBackupId: safety.record.id,
          productionGateMet: (await recoveryGate(ctx.organizationId)).met,
          historyCarried,
        };
      } catch (e) {
        options.logger?.warn(
          {
            code: e instanceof BackupError ? e.code : 'error',
            swapped,
            err: e instanceof Error ? e.message.slice(0, 600) : String(e),
          },
          'backup restore failed',
        );
        if (!swapped) {
          await audit(ctx, 'backup.restore_failed', null, {
            reason: e instanceof BackupError ? e.code : 'error',
          }).catch(() => undefined);
        }
        throw e;
      } finally {
        if (restoredName) await dropDatabase(adminUrl, restoredName).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
        options.onMaintenance?.(false);
      }
    });
  }

  const manifestBackupId = (o: Opened) => o.manifest.backupId;

  /** Waits (up to ten seconds) for in-flight statements of the live database to finish. */
  async function quiesce(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const r = await prisma.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid() AND application_name NOT LIKE 'commercebill-backup%'`;
      if (Number(r[0]?.n ?? 0) === 0) return;
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  /** Lists recognised backup files in the registered destination (used by tests and the admin guide; no file content). */
  async function listFolder(organizationId: string): Promise<string[]> {
    const dest = await destinationOf(organizationId);
    if (!dest) return [];
    return (await readdir(dest.path)).filter((n) => FILE_NAME.test(n));
  }

  return {
    status,
    history,
    createBackup,
    verifyBackup,
    inspect,
    restoreActive,
    setRetention,
    applyRetention,
    recoveryGate,
    registerDestination,
    registerRestoreSource,
    listFolder,
  };
}

export type BackupService = ReturnType<typeof createBackupService>;
