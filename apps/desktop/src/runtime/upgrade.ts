import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyPendingMigrations,
  createPreUpgradeBackup,
  databaseHasBusinessData,
  generateSafetyPassphrase,
  migrationStatus,
  verifyPreUpgradeBackup,
} from '@commercebill/backup';
import type { RuntimeSecrets } from './secrets.js';

export interface UpgradeReport {
  fromSchema: string | null;
  toSchema: string;
  appVersion: string;
  at: string;
  /** Names of the migrations applied. */
  applied: string[];
  /** The verified safety backup made first (file name only), or null when the database held no business yet. */
  safetyBackup: string | null;
}

export class UpgradeError extends Error {
  constructor(
    readonly code: 'PRE_UPGRADE_BACKUP_FAILED' | 'MIGRATION_FAILED' | 'VALIDATION_FAILED',
    message: string,
    readonly safetyBackup: string | null,
  ) {
    super(message);
  }
}

/** How many safety backups are kept: the newest few. Older ones are removed only after a newer one has been verified. */
const KEEP_SAFETY_BACKUPS = 5;

/**
 * Brings the database structure up to date for a newer version of the application (ADR-0029):
 *   1. if the database holds a business, make a safety backup with the Task 1.17 archive and VERIFY it by restoring it into a throw-away
 *      database; if that fails, nothing is changed;
 *   2. apply only the missing migrations, each in its own transaction (a failing migration leaves the database as it was);
 *   3. check the result.
 * The caller stops normal start-up when this throws. It never initialises a new database.
 */
export async function runUpgrade(o: {
  databaseUrl: string;
  migrationsDir: string;
  preUpgradeDir: string;
  lastUpgradeFile: string;
  appVersion: string;
  secrets: RuntimeSecrets;
  persistSecrets: (s: RuntimeSecrets) => void;
  log: (message: string) => void;
}): Promise<UpgradeReport> {
  const before = await migrationStatus(o.databaseUrl, o.migrationsDir);
  let safetyBackup: string | null = null;
  if (await databaseHasBusinessData(o.databaseUrl)) {
    let passphrase = o.secrets.safetyPassphrase;
    if (!passphrase) {
      passphrase = generateSafetyPassphrase();
      o.persistSecrets({ ...o.secrets, safetyPassphrase: passphrase });
    }
    o.log('making a safety backup before changing the database structure');
    let file: string | null = null;
    try {
      const made = await createPreUpgradeBackup({
        databaseUrl: o.databaseUrl,
        destDir: o.preUpgradeDir,
        passphrase,
        appVersion: o.appVersion,
      });
      file = made.file;
      const checked = await verifyPreUpgradeBackup({
        file: made.file,
        passphrase,
        databaseUrl: o.databaseUrl,
        migrationsDir: o.migrationsDir,
      });
      if (!checked.ok) {
        o.log(
          `the safety backup failed verification: ${checked.checks
            .filter((c) => !c.ok)
            .map((c) => c.name)
            .join(', ')}`,
        );
        throw new UpgradeError(
          'PRE_UPGRADE_BACKUP_FAILED',
          'The safety backup could not be verified.',
          null,
        );
      }
      safetyBackup = made.fileName;
      o.log(`safety backup verified: ${made.fileName}`);
    } catch (e) {
      if (file) rmSync(file, { force: true }); // an unverified file is not left looking like a safety net
      if (e instanceof UpgradeError) throw e;
      o.log(`the safety backup could not be made: ${e instanceof Error ? e.message : String(e)}`);
      throw new UpgradeError(
        'PRE_UPGRADE_BACKUP_FAILED',
        'The safety backup could not be made.',
        null,
      );
    }
  }

  let applied: string[];
  try {
    applied = await applyPendingMigrations(o.databaseUrl, o.migrationsDir);
  } catch (e) {
    o.log(
      `a migration failed and was rolled back: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
    );
    throw new UpgradeError(
      'MIGRATION_FAILED',
      'The database structure update failed.',
      safetyBackup,
    );
  }
  const after = await migrationStatus(o.databaseUrl, o.migrationsDir);
  if (after.state !== 'current')
    throw new UpgradeError(
      'VALIDATION_FAILED',
      'The database is not at the expected version after the update.',
      safetyBackup,
    );

  const report: UpgradeReport = {
    fromSchema: before.current,
    toSchema: after.current ?? '',
    appVersion: o.appVersion,
    at: new Date().toISOString(),
    applied,
    safetyBackup,
  };
  writeFileSync(o.lastUpgradeFile, JSON.stringify(report, null, 2));
  pruneSafetyBackups(o.preUpgradeDir, KEEP_SAFETY_BACKUPS);
  return report;
}

export function pruneSafetyBackups(dir: string, keep: number): number {
  let files: { f: string; t: number }[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.cbbackup'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const x of files.slice(keep)) {
    rmSync(join(dir, x.f), { force: true });
    removed++;
  }
  return removed;
}
