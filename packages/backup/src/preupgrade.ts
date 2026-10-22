/**
 * The safety backup the INSTALLED application makes before it changes the database structure (Task: Windows packaging, ADR-0029).
 * It reuses the Task 1.17 archive: the same encrypted, authenticated container and manifest, the same consistent snapshot, the same
 * "migrate, then load" restore. It differs in two ways: it is made before the application's own tables may be touched, so it records no
 * row in them, and it is verified against the schema the data was written with (the backup's own schema version), not the new one.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerError, ContainerWriter, MANIFEST_ENTRY, extractContainer } from './container.js';
import {
  DEFAULT_KDF,
  DecryptError,
  BackupFormatError,
  decryptFile,
  encryptFile,
} from './crypto.js';
import { exportSnapshot, withClient } from './dump.js';
import { foreignKeyViolations } from './integrity.js';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  ManifestError,
  manifestBytes,
  manifestFingerprint,
  parseManifest,
  type BackupManifest,
} from './manifest.js';
import {
  applyMigrations,
  createDatabase,
  dropDatabase,
  isolatedName,
  readMigrations,
  withDatabaseName,
} from './migrations.js';
import { PROJECTION_TABLE, loadSnapshot } from './restore.js';

export interface PreUpgradeBackup {
  file: string;
  fileName: string;
  sizeBytes: number;
  fromSchema: string;
  tables: number;
  rows: number;
  manifestSha256: string;
}

export interface PreUpgradeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

const stamp = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

/** A random passphrase for a safety backup the application makes by itself (the user is not there to type one). */
export function generateSafetyPassphrase(): string {
  const words = randomBytes(12).toString('hex').match(/.{4}/g)!;
  return words.join('-');
}

/** True when the database holds a business (an organization): only then is there anything to protect. */
export async function databaseHasBusinessData(url: string): Promise<boolean> {
  return withClient(url, async (c) => {
    const t = (
      await c.query<{ t: string | null }>(`SELECT to_regclass('public.organizations')::text AS t`)
    ).rows[0]!.t;
    if (!t) return false;
    return (
      Number(
        (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM organizations`)).rows[0]!.n,
      ) > 0
    );
  });
}

export async function createPreUpgradeBackup(o: {
  databaseUrl: string;
  destDir: string;
  passphrase: string;
  appVersion: string;
  clock?: () => Date;
}): Promise<PreUpgradeBackup> {
  const now = (o.clock ?? (() => new Date()))();
  await mkdir(o.destDir, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'cb-preupgrade-'));
  try {
    const org = await withClient(
      o.databaseUrl,
      async (c) =>
        (
          await c.query<{ id: string; legal_name: string }>(
            `SELECT id, legal_name FROM organizations ORDER BY created_at LIMIT 1`,
          )
        ).rows[0],
    );
    if (!org) throw new Error('There is no business in the database to back up.');
    const identity = await withClient(o.databaseUrl, async (c) => {
      const has = (
        await c.query<{ t: string | null }>(
          `SELECT to_regclass('public.organization_settings')::text AS t`,
        )
      ).rows[0]!.t;
      if (!has) return randomUUID();
      const r = await c.query<{ id: string }>(
        `SELECT value->>'id' AS id FROM organization_settings WHERE organization_id = $1 AND key = 'recovery.database_identity'`,
        [org.id],
      );
      return r.rows[0]?.id && /^[0-9a-f-]{36}$/.test(r.rows[0].id) ? r.rows[0].id : randomUUID();
    });
    const dataDir = join(work, 'data');
    await mkdir(dataDir);
    const snapshot = await exportSnapshot(o.databaseUrl, dataDir);
    const backupId = randomUUID();
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      backupId,
      kind: 'PRE_UPGRADE',
      createdAt: now.toISOString(),
      appVersion: o.appVersion,
      schemaVersion: snapshot.schemaVersion,
      databaseId: identity,
      organization: { id: org.id, legalName: org.legal_name },
      snapshot: { isolation: 'REPEATABLE READ READ ONLY' },
      attachments: { present: false, manifestVersion: 1 },
      excludedTables: ['sessions'],
      tables: snapshot.tables,
      encryption: { cipher: 'AES-256-GCM (chunked)', kdf: 'scrypt', ...DEFAULT_KDF },
    };
    const bytes = manifestBytes(manifest);
    const containerPath = join(work, 'container.bin');
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
    const fileName = `CommerceBill-pre-upgrade-${snapshot.schemaVersion.slice(0, 14)}-${stamp(now)}-${backupId.slice(0, 8)}.cbbackup`;
    const finalPath = join(o.destDir, fileName);
    const partial = `${finalPath}.partial`;
    try {
      const { bytes: size } = await encryptFile(containerPath, partial, o.passphrase);
      await rename(partial, finalPath); // the file has its final name only once it is complete
      return {
        file: finalPath,
        fileName,
        sizeBytes: size,
        fromSchema: snapshot.schemaVersion,
        tables: snapshot.tables.length,
        rows: snapshot.tables.reduce((n, t) => n + t.rows, 0),
        manifestSha256: manifestFingerprint(bytes),
      };
    } finally {
      await rm(partial, { force: true });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Restores the safety backup into a throw-away database built with the migrations up to the backup's own schema, then checks it. It proves
 * the file can be decrypted, is intact, loads into the structure it was written with, keeps every link between records and reproduces the
 * data exactly. The throw-away database is always removed.
 */
export async function verifyPreUpgradeBackup(o: {
  file: string;
  passphrase: string;
  databaseUrl: string;
  migrationsDir: string;
}): Promise<{ ok: boolean; checks: PreUpgradeCheck[]; manifest?: BackupManifest }> {
  const checks: PreUpgradeCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const work = await mkdtemp(join(tmpdir(), 'cb-preupgrade-verify-'));
  const adminUrl = withDatabaseName(o.databaseUrl, 'postgres');
  let isolated: string | null = null;
  try {
    let manifest: BackupManifest;
    const files = new Map<string, string>();
    try {
      const plain = join(work, 'payload.bin');
      await decryptFile(o.file, plain, o.passphrase);
      const entries = await extractContainer(plain, work);
      await rm(plain, { force: true });
      const m = entries.get(MANIFEST_ENTRY);
      if (!m) throw new ManifestError('no manifest');
      manifest = parseManifest(await readFile(m.path));
      for (const t of manifest.tables) {
        const e = entries.get(`data/${t.name}.ndjson`);
        if (!e || e.sha256 !== t.sha256 || e.size !== t.bytes)
          throw new ContainerError('Data does not match the manifest.', 'MALFORMED');
        files.set(t.name, e.path);
      }
      add('archive_authentic', true);
      add('checksums_match', true);
    } catch (e) {
      add(
        e instanceof DecryptError ? 'archive_authentic' : 'archive_readable',
        false,
        e instanceof BackupFormatError || e instanceof ContainerError || e instanceof ManifestError
          ? 'damaged'
          : 'error',
      );
      return { ok: false, checks };
    }
    const known = (await readMigrations(o.migrationsDir)).some(
      (m) => m.name === manifest.schemaVersion,
    );
    add(
      'schema_known',
      known,
      known ? 'the backup structure is one this application can rebuild' : 'unknown structure',
    );
    if (!known) return { ok: false, checks, manifest };
    isolated = isolatedName('cb_preupg');
    await createDatabase(adminUrl, isolated);
    const url = withDatabaseName(o.databaseUrl, isolated);
    await applyMigrations(url, o.migrationsDir, { upTo: manifest.schemaVersion });
    try {
      await withClient(url, (c) => loadSnapshot(c, files));
      add('restore_load', true);
    } catch {
      add('restore_load', false, 'the data could not be loaded');
      return { ok: false, checks, manifest };
    }
    await withClient(url, async (c) => add('foreign_keys', (await foreignKeyViolations(c)) === 0));
    const againDir = join(work, 'again');
    await mkdir(againDir);
    const again = await exportSnapshot(url, againDir);
    const bad: string[] = [];
    for (const t of manifest.tables) {
      const r = again.tables.find((x) => x.name === t.name);
      if (t.name === PROJECTION_TABLE) {
        if (!r || r.rows !== t.rows) bad.push(t.name); // rebuilt from the ledger on restore: compared by size here
        continue;
      }
      if (!r || r.rows !== t.rows || r.sha256 !== t.sha256) bad.push(t.name);
    }
    add(
      'restored_content_identical',
      bad.length === 0,
      bad.length === 0
        ? `${again.tables.length} tables identical`
        : `${bad.length} table(s) differ`,
    );
    return { ok: checks.every((c) => c.ok), checks, manifest };
  } finally {
    if (isolated) await dropDatabase(adminUrl, isolated).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
