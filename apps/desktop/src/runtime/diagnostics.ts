import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { arch, release, version as osVersion } from 'node:os';
import { join } from 'node:path';
import { migrationStatus } from '@commercebill/backup';
import type { Diagnostics } from '@commercebill/shared-types';
import pg from 'pg';
import type { ResourceDirs, RuntimePaths } from './paths.js';

const safeJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

export async function collectDiagnostics(o: {
  paths: RuntimePaths;
  resources: ResourceDirs;
  appVersion: string;
  databaseUrl: string | null;
  databasePort: number | null;
  install: 'fresh' | 'existing' | 'unknown';
  apiHealthy: boolean | null;
  startupProblem?: { code: string; message: string } | null;
  managedDatabase?: boolean;
}): Promise<Diagnostics> {
  let schema: Diagnostics['schema'] = {
    current: null,
    expected: null,
    state: 'database not running',
  };
  let backup: Diagnostics['backup'] = { lastVerificationResult: null, lastVerifiedAt: null };
  let running = false;
  if (o.databaseUrl) {
    try {
      const m = await migrationStatus(o.databaseUrl, o.resources.migrationsDir);
      schema = { current: m.current, expected: m.expected, state: m.state };
      running = true;
      const c = new pg.Client({ connectionString: o.databaseUrl, connectionTimeoutMillis: 3000 });
      await c.connect();
      try {
        const t = (
          await c.query<{ t: string | null }>(
            `SELECT to_regclass('public.backup_verifications')::text AS t`,
          )
        ).rows[0]!.t;
        if (t) {
          const r = await c.query<{ result: string; verified_at: Date }>(
            `SELECT result, verified_at FROM backup_verifications ORDER BY seq DESC LIMIT 1`,
          );
          if (r.rows[0])
            backup = {
              lastVerificationResult: r.rows[0].result,
              lastVerifiedAt: r.rows[0].verified_at.toISOString(),
            };
        }
      } finally {
        await c.end();
      }
    } catch {
      schema = { current: null, expected: null, state: 'could not be read' };
    }
  }
  const last = safeJson<{
    fromSchema: string | null;
    toSchema: string;
    at: string;
    safetyBackup: string | null;
  }>(o.paths.lastUpgradeFile);
  let free: number | null;
  try {
    const s = statfsSync(o.paths.dataRoot);
    free = Math.round((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    free = null;
  }
  let logs: Diagnostics['logs'];
  try {
    logs = readdirSync(o.paths.logsDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({
        name: f,
        kilobytes: Math.round(statSync(join(o.paths.logsDir, f)).size / 1024),
      }));
  } catch {
    logs = [];
  }
  return {
    generatedAt: new Date().toISOString(),
    application: { name: 'CommerceBill Desktop', version: o.appVersion },
    windows: { version: osVersion(), release: release(), arch: arch() },
    database: { running, port: running ? o.databasePort : null, install: o.install },
    schema,
    api: { health: o.apiHealthy === null ? 'unknown' : o.apiHealthy ? 'ok' : 'not running' },
    backup,
    lastUpgrade: last
      ? { from: last.fromSchema, to: last.toSchema, at: last.at, safetyBackup: last.safetyBackup }
      : null,
    storage: { dataFolder: o.paths.dataRoot, logFolder: o.paths.logsDir, freeMegabytes: free },
    logs,
    startupProblem: o.startupProblem ?? null,
    managedDatabase: o.managedDatabase ?? true,
  };
}

export type { Diagnostics };

export function formatDiagnostics(d: Diagnostics): string {
  const L: string[] = [];
  L.push('CommerceBill diagnostics', `Created: ${d.generatedAt}`, '');
  L.push(`Application: ${d.application.name} ${d.application.version}`);
  L.push(`Windows: ${d.windows.version} (${d.windows.release}, ${d.windows.arch})`, '');
  L.push(
    `Database: ${d.database.running ? `running on 127.0.0.1:${String(d.database.port)} (this computer only)` : 'NOT running'} (${d.database.install})`,
  );
  L.push(
    `Database structure: ${d.schema.current ?? 'unknown'} (this version expects ${d.schema.expected ?? 'unknown'}; status: ${d.schema.state})`,
  );
  L.push(`Local service: ${d.api.health}`);
  L.push(
    `Last backup verification: ${d.backup.lastVerificationResult ?? 'none'}${d.backup.lastVerifiedAt ? ` at ${d.backup.lastVerifiedAt}` : ''}`,
  );
  if (d.lastUpgrade)
    L.push(
      `Last update: ${d.lastUpgrade.from ?? 'new'} -> ${d.lastUpgrade.to} at ${d.lastUpgrade.at}; safety backup: ${d.lastUpgrade.safetyBackup ?? 'none (no business data yet)'}`,
    );
  if (d.startupProblem)
    L.push('', `Start-up problem: ${d.startupProblem.code}: ${d.startupProblem.message}`);
  L.push(
    '',
    `Data folder: ${d.storage.dataFolder}`,
    `Log folder: ${d.storage.logFolder}`,
    `Free disk space: ${d.storage.freeMegabytes === null ? 'unknown' : `${String(d.storage.freeMegabytes)} MB`}`,
  );
  for (const f of d.logs) L.push(`  ${f.name}: ${String(f.kilobytes)} KB`);
  L.push('', 'This report contains no passwords, passphrases, tokens or business data.');
  return L.join('\r\n');
}

/** What is running now, for support and for the installer smoke test. No secrets. */
export function writeRuntimeStatus(
  paths: RuntimePaths,
  status: Record<string, string | number | boolean | null>,
): void {
  try {
    writeFileSync(
      paths.statusFile,
      JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2),
    );
  } catch {
    // never fatal
  }
}

export const statusFileExists = (paths: RuntimePaths): boolean => existsSync(paths.statusFile);
