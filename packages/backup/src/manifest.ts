import { createHash } from 'node:crypto';

export const BACKUP_FORMAT = 'commercebill-backup';
export const BACKUP_FORMAT_VERSION = 1;
/** Bumped when the verification checks change in a way that makes an earlier PASS less meaningful. */
export const VERIFICATION_ENGINE_VERSION = '1.0.0';

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  backupId: string;
  /** PRE_UPGRADE: the safety backup the installed application makes before it changes the database structure (never listed as a recorded backup). */
  kind: 'MANUAL' | 'PRE_RESTORE' | 'PRE_UPGRADE';
  createdAt: string;
  appVersion: string;
  /** The last applied migration of the database the backup came from. */
  schemaVersion: string;
  /** The identity of that database (ADR-0027). */
  databaseId: string;
  organization: { id: string; legalName: string };
  snapshot: { isolation: 'REPEATABLE READ READ ONLY' };
  attachments: { present: false; manifestVersion: 1 };
  excludedTables: string[];
  tables: { name: string; rows: number; bytes: number; sha256: string }[];
  /** Descriptive only: never a key, a passphrase or a salt. */
  encryption: {
    cipher: 'AES-256-GCM (chunked)';
    kdf: 'scrypt';
    logN: number;
    r: number;
    p: number;
  };
}

export const manifestBytes = (m: BackupManifest): Buffer =>
  Buffer.from(JSON.stringify(m, null, 2), 'utf8');
export const manifestFingerprint = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const TABLE = /^[a-z][a-z0-9_]{0,62}$/;

/** Strict structural validation of a manifest read from an (already authenticated) archive. */
export function parseManifest(bytes: Buffer): BackupManifest {
  let m: unknown;
  try {
    m = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ManifestError('The backup manifest is not valid.');
  }
  const o = m as Partial<BackupManifest> | null;
  const bad = (why: string): never => {
    throw new ManifestError(`The backup manifest is not valid (${why}).`);
  };
  if (!o || typeof o !== 'object') return bad('shape');
  if (o.format !== BACKUP_FORMAT) bad('format');
  if (o.formatVersion !== BACKUP_FORMAT_VERSION)
    throw new ManifestError(
      'This backup was made by a different backup format and cannot be restored by this version.',
    );
  if (typeof o.backupId !== 'string' || !UUID.test(o.backupId)) bad('backup id');
  if (o.kind !== 'MANUAL' && o.kind !== 'PRE_RESTORE' && o.kind !== 'PRE_UPGRADE') bad('kind');
  if (typeof o.createdAt !== 'string' || Number.isNaN(Date.parse(o.createdAt))) bad('created time');
  if (typeof o.appVersion !== 'string' || o.appVersion.length > 40) bad('application version');
  if (typeof o.schemaVersion !== 'string' || !/^\d{14}_[a-z0-9_]+$/.test(o.schemaVersion))
    bad('schema version');
  if (typeof o.databaseId !== 'string' || !UUID.test(o.databaseId)) bad('database id');
  if (
    !o.organization ||
    typeof o.organization.id !== 'string' ||
    !UUID.test(o.organization.id) ||
    typeof o.organization.legalName !== 'string'
  )
    bad('organization');
  if (!Array.isArray(o.tables) || o.tables.length === 0 || o.tables.length > 100) bad('tables');
  const seen = new Set<string>();
  for (const t of o.tables ?? []) {
    if (!t || typeof t.name !== 'string' || !TABLE.test(t.name) || seen.has(t.name))
      bad('table name');
    seen.add(t.name);
    if (
      !Number.isInteger(t.rows) ||
      t.rows < 0 ||
      !Number.isInteger(t.bytes) ||
      t.bytes < 0 ||
      typeof t.sha256 !== 'string' ||
      !SHA.test(t.sha256)
    )
      bad('table checksum');
  }
  if (!o.encryption || o.encryption.kdf !== 'scrypt') bad('encryption metadata');
  return o as BackupManifest;
}
