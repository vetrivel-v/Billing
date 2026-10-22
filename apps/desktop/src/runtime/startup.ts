import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { applyMigrations, migrationStatus, type MigrationStatus } from '@commercebill/backup';
import pg from 'pg';
import type { AppLog } from './logger.js';
import type { ResourceDirs, RuntimePaths } from './paths.js';
import {
  PG_DATABASE,
  PostgresError,
  PostgresRuntime,
  freeLoopbackPort,
  isPortFree,
} from './postgres.js';
import {
  SecretsError,
  generatePassword,
  loadSecrets,
  saveSecrets,
  type RuntimeSecrets,
  type SecretCipher,
} from './secrets.js';
import { UpgradeError, runUpgrade, type UpgradeReport } from './upgrade.js';

export type StartupErrorCode =
  | 'SECRETS_UNAVAILABLE'
  | 'CREDENTIALS_MISSING'
  | 'DATA_MISSING'
  | 'CONFIG_MISSING'
  | 'DB_MISSING'
  | 'BINARIES_MISSING'
  | 'DB_INIT_FAILED'
  | 'DB_START_FAILED'
  | 'DB_START_TIMEOUT'
  | 'DB_NEWER'
  | 'DB_INCONSISTENT'
  | 'PRE_UPGRADE_BACKUP_FAILED'
  | 'MIGRATION_FAILED'
  | 'VALIDATION_FAILED';

/** A start-up failure: a code for support and a message a person can act on. It never carries output from the database or a password. */
export class StartupError extends Error {
  constructor(
    readonly code: StartupErrorCode,
    readonly userMessage: string,
    readonly hint: string,
  ) {
    super(`${code}: ${userMessage}`);
  }
}

interface RuntimeJson {
  formatVersion: 1;
  installId: string;
  clusterId: string;
  createdAt: string;
  pgPort: number;
  lastAppVersion: string;
  lastSchemaVersion: string;
}

export interface RuntimeHandle {
  databaseUrl: string;
  port: number;
  /** `fresh`: this start created the database; `existing`: it was already there. */
  install: 'fresh' | 'existing';
  reusedRunningDatabase: boolean;
  migration: MigrationStatus;
  upgrade: UpgradeReport | null;
  postgres: PostgresRuntime;
  stop(): Promise<void>;
}

export interface StartupDeps {
  paths: RuntimePaths;
  resources: ResourceDirs;
  cipher: SecretCipher;
  appVersion: string;
  log: AppLog;
}

function readRuntimeJson(file: string): RuntimeJson | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<RuntimeJson>;
    return j.formatVersion === 1 && typeof j.pgPort === 'number' ? (j as RuntimeJson) : null;
  } catch {
    return null;
  }
}

const SUPPORT =
  'Close CommerceBill and try again. If it keeps happening, export the diagnostics and send them to whoever supports your installation. Your data has not been changed.';

/**
 * Starts CommerceBill's private database for this Windows user: creates it on a fresh installation, otherwise starts (or finds) the
 * existing one, upgrades its structure when this version needs it (with a verified safety backup first), and hands back the connection
 * URL for the local service. It NEVER creates a new empty database in place of one that cannot be opened: data that is missing,
 * unreadable or newer than this version stops start-up with a message instead.
 */
export async function startRuntime(deps: StartupDeps): Promise<RuntimeHandle> {
  const { paths, resources, cipher, log } = deps;
  for (const d of [paths.configDir, paths.logsDir, paths.tmpDir, paths.backupsDir])
    mkdirSync(d, { recursive: true });
  const postgres = new PostgresRuntime({
    binDir: resources.pgBin,
    dataDir: paths.pgData,
    logFile: `${paths.logsDir}\\postgres.log`,
    tmpDir: paths.tmpDir,
    log: (m) => log.info(`postgres: ${m}`),
  });
  if (!postgres.binariesPresent())
    throw new StartupError(
      'BINARIES_MISSING',
      "CommerceBill couldn't find its database program files.",
      'The installation looks incomplete. Reinstall CommerceBill (your data is kept).',
    );

  const hasCluster = postgres.isInitialised();
  const runtime = readRuntimeJson(paths.runtimeJson);
  const hasConfig = runtime !== null;
  const hasSecrets = existsSync(paths.secretsFile);
  const interrupted = existsSync(paths.initMarker);

  let install: 'fresh' | 'existing';
  let secrets: RuntimeSecrets;
  if (interrupted && !hasConfig) {
    // A first-time setup that never finished: no database was ever created, so nothing of the business can be here.
    log.warn('removing an unfinished first-time database setup');
    rmSync(paths.pgData, { recursive: true, force: true });
    rmSync(paths.secretsFile, { force: true });
    install = 'fresh';
  } else if (!hasCluster && !hasConfig) {
    install = 'fresh';
  } else if (hasCluster && hasConfig && hasSecrets) {
    install = 'existing';
  } else if (hasConfig && !hasCluster) {
    throw new StartupError(
      'DATA_MISSING',
      'CommerceBill found its settings but not its database.',
      'The data folder may have been moved or deleted. CommerceBill did not create a new empty database. Restore the data folder or a backup; see the troubleshooting guide.',
    );
  } else if (hasCluster && !hasConfig) {
    throw new StartupError(
      'CONFIG_MISSING',
      'CommerceBill found a database but not its settings.',
      'CommerceBill did not touch it. See the troubleshooting guide, "Database found but settings missing".',
    );
  } else {
    throw new StartupError(
      'CREDENTIALS_MISSING',
      "CommerceBill can't open its database because the stored credentials are missing.",
      'CommerceBill did not touch the data. See the troubleshooting guide, "Database credentials".',
    );
  }

  try {
    if (install === 'fresh') {
      writeFileSync(paths.initMarker, JSON.stringify({ startedAt: new Date().toISOString() }));
      secrets = { dbPassword: generatePassword(), safetyPassphrase: generatePassword() };
      saveSecrets(paths.secretsFile, secrets, cipher); // saved BEFORE the database exists, so a password can never be lost
      log.addSecret(secrets.dbPassword);
      log.addSecret(secrets.safetyPassphrase ?? '');
      await postgres.initialise(secrets.dbPassword);
    } else {
      secrets = loadSecrets(paths.secretsFile, cipher);
      log.addSecret(secrets.dbPassword);
      log.addSecret(secrets.safetyPassphrase ?? '');
    }

    const wanted =
      runtime?.pgPort && (await isPortFree(runtime.pgPort))
        ? runtime.pgPort
        : await freeLoopbackPort();
    const started = await postgres.start(wanted, secrets.dbPassword);
    const adminUrl = postgres.urlFor(started.port, secrets.dbPassword, 'postgres');
    const databaseUrl = postgres.urlFor(started.port, secrets.dbPassword);

    // the business database
    const exists = await databaseExists(adminUrl, PG_DATABASE);
    if (!exists) {
      if (install !== 'fresh')
        throw new StartupError(
          'DB_MISSING',
          'CommerceBill started its database program, but the business database is not in it.',
          'CommerceBill did not create a new empty database. Restore a backup; see the troubleshooting guide.',
        );
      await createDatabase(adminUrl, PG_DATABASE);
    }

    let migration = await migrationStatus(databaseUrl, resources.migrationsDir);
    let upgrade: UpgradeReport | null = null;
    if (migration.state === 'empty') {
      if (await databaseHasAnyTable(databaseUrl))
        throw new StartupError(
          'DB_INCONSISTENT',
          'The business database has tables but no upgrade history.',
          SUPPORT,
        );
      await applyMigrations(databaseUrl, resources.migrationsDir);
    } else if (migration.state === 'pending') {
      upgrade = await runUpgrade({
        databaseUrl,
        migrationsDir: resources.migrationsDir,
        preUpgradeDir: paths.preUpgradeDir,
        lastUpgradeFile: paths.lastUpgradeFile,
        appVersion: deps.appVersion,
        secrets,
        persistSecrets: (s) => saveSecrets(paths.secretsFile, s, cipher),
        log: (m) => log.info(`upgrade: ${m}`),
      });
    } else if (migration.state === 'ahead') {
      throw new StartupError(
        'DB_NEWER',
        'This data was written by a newer version of CommerceBill.',
        'Install the newer CommerceBill. CommerceBill did not change your data.',
      );
    } else if (migration.state !== 'current') {
      throw new StartupError(
        'DB_INCONSISTENT',
        'The database structure does not match this version of CommerceBill.',
        SUPPORT,
      );
    }
    migration = await migrationStatus(databaseUrl, resources.migrationsDir);
    if (migration.state !== 'current')
      throw new StartupError(
        'VALIDATION_FAILED',
        'The database could not be brought up to date.',
        SUPPORT,
      );

    const next: RuntimeJson = {
      formatVersion: 1,
      installId: runtime?.installId ?? randomUUID(),
      clusterId: runtime?.clusterId ?? randomUUID(),
      createdAt: runtime?.createdAt ?? new Date().toISOString(),
      pgPort: started.port,
      lastAppVersion: deps.appVersion,
      lastSchemaVersion: migration.current ?? '',
    };
    writeFileSync(paths.runtimeJson, JSON.stringify(next, null, 2));
    rmSync(paths.initMarker, { force: true });
    log.info(
      `database ready (${install}, schema ${next.lastSchemaVersion}, port ${String(started.port)})`,
    );
    return {
      databaseUrl,
      port: started.port,
      install,
      reusedRunningDatabase: started.reused,
      migration,
      upgrade,
      postgres,
      stop: () => postgres.stop(),
    };
  } catch (e) {
    if (e instanceof StartupError) throw e;
    if (e instanceof UpgradeError) {
      log.error(`upgrade stopped: ${e.code}`);
      throw e.code === 'PRE_UPGRADE_BACKUP_FAILED'
        ? new StartupError(
            'PRE_UPGRADE_BACKUP_FAILED',
            "CommerceBill couldn't make its safety backup before updating your data, so it did not update.",
            'Your data is unchanged. Free some disk space and try again, or reinstall the previous version. See the troubleshooting guide.',
          )
        : new StartupError(
            e.code === 'MIGRATION_FAILED' ? 'MIGRATION_FAILED' : 'VALIDATION_FAILED',
            "CommerceBill couldn't update your data for this version.",
            `Your data is unchanged${e.safetyBackup ? ` and a verified safety backup (${e.safetyBackup}) was kept` : ''}. Do not delete anything. Reinstall the previous version and see the troubleshooting guide, "Update failed".`,
          );
    }
    if (e instanceof SecretsError)
      throw new StartupError(
        e.code === 'UNAVAILABLE' ? 'SECRETS_UNAVAILABLE' : 'CREDENTIALS_MISSING',
        "CommerceBill can't open its database credentials.",
        e.code === 'UNREADABLE'
          ? 'They belong to a different Windows account. Sign in to Windows as the account that installed CommerceBill. CommerceBill did not touch the data.'
          : SUPPORT,
      );
    if (e instanceof PostgresError) {
      log.error(`database error ${e.code}: ${e.message}`);
      const map = {
        BINARIES_MISSING: 'BINARIES_MISSING',
        INIT_FAILED: 'DB_INIT_FAILED',
        START_FAILED: 'DB_START_FAILED',
        START_TIMEOUT: 'DB_START_TIMEOUT',
        STOP_FAILED: 'DB_START_FAILED',
        PORT_UNAVAILABLE: 'DB_START_FAILED',
      } as const;
      throw new StartupError(
        map[e.code],
        "CommerceBill couldn't start its local database.",
        SUPPORT,
      );
    }
    log.error(`unexpected start-up error: ${e instanceof Error ? e.message : String(e)}`);
    throw new StartupError(
      'DB_START_FAILED',
      "CommerceBill couldn't start its local database.",
      SUPPORT,
    );
  }
}

async function databaseExists(adminUrl: string, name: string): Promise<boolean> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;
  } finally {
    await c.end();
  }
}

async function createDatabase(adminUrl: string, name: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(`CREATE DATABASE "${name.replace(/"/g, '""')}" ENCODING 'UTF8'`);
  } finally {
    await c.end();
  }
}

async function databaseHasAnyTable(url: string): Promise<boolean> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (
      (
        await c.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' LIMIT 1`,
        )
      ).rowCount === 1
    );
  } finally {
    await c.end();
  }
}
