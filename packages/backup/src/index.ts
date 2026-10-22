export {
  BackupError,
  DEFAULT_MAX_VERIFICATION_AGE_DAYS,
  createBackupService,
  validatePassphrase,
  type BackupContext,
  type BackupErrorCode,
  type BackupService,
  type BackupServiceOptions,
} from './service.js';
export {
  BackupFormatError,
  CHUNK_SIZE,
  DEFAULT_KDF,
  DecryptError,
  decryptFile,
  encryptFile,
  parseHeader,
  readEncryptionInfo,
} from './crypto.js';
export {
  ContainerError,
  ContainerWriter,
  MANIFEST_ENTRY,
  extractContainer,
  isAllowedEntryName,
  sha256OfFile,
} from './container.js';
export {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  VERIFICATION_ENGINE_VERSION,
  ManifestError,
  manifestBytes,
  manifestFingerprint,
  parseManifest,
  type BackupManifest,
} from './manifest.js';
export { EXCLUDED_TABLES, exportSnapshot, type SnapshotExport, type TableDump } from './dump.js';
export { PROJECTION_TABLE, RestoreError, loadSnapshot } from './restore.js';
export { allPassed, expectedTriggers, runIntegrityChecks, type CheckResult } from './integrity.js';
export {
  applyMigrations,
  applyPendingMigrations,
  migrationStatus,
  type MigrationState,
  type MigrationStatus,
  createDatabase,
  databaseNameOf,
  dropDatabase,
  expectedSchemaVersion,
  readMigrations,
  withDatabaseName,
} from './migrations.js';
export {
  createPreUpgradeBackup,
  databaseHasBusinessData,
  generateSafetyPassphrase,
  verifyPreUpgradeBackup,
  type PreUpgradeBackup,
  type PreUpgradeCheck,
} from './preupgrade.js';
