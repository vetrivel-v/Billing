import { isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Where the installed application keeps things (ADR-0029). The application binaries are replaceable; everything mutable lives under ONE
 * data root outside the installation directory, so an upgrade, an uninstall or a reinstall never touches business data.
 *
 *   <data root>                      default: %LOCALAPPDATA%\CommerceBill  (override: COMMERCEBILL_DATA_DIR, an absolute path)
 *     data\pg\                       the PostgreSQL cluster (the business database)
 *     config\runtime.json            non-secret facts about this installation (ids, port, last versions)
 *     config\secrets.bin             database password and safety-backup passphrase, protected by Windows for this user
 *     config\runtime-status.json     what is running now (no secrets)
 *     logs\                          app.log, postgres.log, api.log (size-capped, rotated)
 *     backups\                       a suggested backup folder; backups\pre-upgrade\ holds the safety backups made before an upgrade
 *     tmp\                           temporary files (password file during first initialisation)
 */
export interface RuntimePaths {
  dataRoot: string;
  pgData: string;
  configDir: string;
  logsDir: string;
  tmpDir: string;
  backupsDir: string;
  preUpgradeDir: string;
  runtimeJson: string;
  secretsFile: string;
  statusFile: string;
  initMarker: string;
  lastUpgradeFile: string;
}

export interface ResourceDirs {
  /** Folder holding postgres.exe, initdb.exe, pg_ctl.exe and their DLLs. */
  pgBin: string;
  migrationsDir: string;
  apiEntry: string;
  webRoot: string;
}

export class PathError extends Error {}

/** The override must be an absolute path with no relative parts: it decides where business data is stored. */
export function validateDataDirOverride(value: string): string {
  if (!isAbsolute(value)) throw new PathError('COMMERCEBILL_DATA_DIR must be an absolute path.');
  if (value.split(/[\\/]/).includes('..'))
    throw new PathError('COMMERCEBILL_DATA_DIR must not contain "..".');
  if (/^[\\/]{2}/.test(value))
    throw new PathError('COMMERCEBILL_DATA_DIR must be on a local drive, not a network share.');
  return normalize(value).replace(new RegExp(`\\${sep}+$`), '');
}

export function resolveRuntimePaths(o: {
  env: NodeJS.ProcessEnv;
  localAppData: string;
}): RuntimePaths {
  const override = o.env.COMMERCEBILL_DATA_DIR?.trim();
  const dataRoot = override
    ? validateDataDirOverride(override)
    : join(o.localAppData, 'CommerceBill');
  const configDir = join(dataRoot, 'config');
  const backupsDir = join(dataRoot, 'backups');
  return {
    dataRoot,
    pgData: join(dataRoot, 'data', 'pg'),
    configDir,
    logsDir: join(dataRoot, 'logs'),
    tmpDir: join(dataRoot, 'tmp'),
    backupsDir,
    preUpgradeDir: join(backupsDir, 'pre-upgrade'),
    runtimeJson: join(configDir, 'runtime.json'),
    secretsFile: join(configDir, 'secrets.bin'),
    statusFile: join(configDir, 'runtime-status.json'),
    initMarker: join(configDir, 'init-in-progress.json'),
    lastUpgradeFile: join(configDir, 'last-upgrade.json'),
  };
}

/** Installed layout: everything the application ships sits in the resources folder next to the executable. */
export function resolvePackagedResources(resourcesPath: string): ResourceDirs {
  return {
    pgBin: join(resourcesPath, 'postgres', 'bin'),
    migrationsDir: join(resourcesPath, 'migrations'),
    apiEntry: join(resourcesPath, 'api', 'main.mjs'),
    webRoot: join(resourcesPath, 'web'),
  };
}

/** Development layout (the repository): used by tests and by running the app from the project folder. */
export function resolveDevResources(repoRoot: string): ResourceDirs {
  return {
    pgBin: join(repoRoot, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin'),
    migrationsDir: join(repoRoot, 'prisma', 'migrations'),
    apiEntry: join(repoRoot, 'apps', 'api', 'dist', 'main.js'),
    webRoot: join(repoRoot, 'apps', 'web', 'dist'),
  };
}
