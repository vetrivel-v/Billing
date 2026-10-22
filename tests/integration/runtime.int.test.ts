// Windows packaging: the managed local PostgreSQL lifecycle with the REAL PostgreSQL programs (the same ones the installer ships), in a
// throw-away data folder. Fresh install, restart, an orphaned server, crash recovery, every refusal that must NOT create a new empty
// database, the upgrade with its verified safety backup, a failing migration and a failing safety backup. Fictional data only.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  collectDiagnostics,
  formatDiagnostics,
} from '../../apps/desktop/src/runtime/diagnostics.js';
import { AppLog } from '../../apps/desktop/src/runtime/logger.js';
import {
  resolveDevResources,
  resolveRuntimePaths,
  type RuntimePaths,
} from '../../apps/desktop/src/runtime/paths.js';
import type { SecretCipher } from '../../apps/desktop/src/runtime/secrets.js';
import {
  StartupError,
  startRuntime,
  type RuntimeHandle,
} from '../../apps/desktop/src/runtime/startup.js';

const repo = resolve(import.meta.dirname, '..', '..');
const resources = resolveDevResources(repo);
/** A stand-in for Windows' per-user protection: reversible, and the file never contains the plain text. */
const cipher: SecretCipher = {
  available: () => true,
  encrypt: (p) => Buffer.from(`PROTECTED:${Buffer.from(p).reverse().toString('base64')}`),
  decrypt: (d) =>
    Buffer.from(d.toString().replace('PROTECTED:', ''), 'base64').reverse().toString(),
};

let root: string;
const running: RuntimeHandle[] = [];
const seq = (() => {
  let n = 0;
  return () => `case${String(++n)}`;
})();

function fresh(): {
  paths: RuntimePaths;
  log: AppLog;
  deps: (extra?: Partial<Parameters<typeof startRuntime>[0]>) => Parameters<typeof startRuntime>[0];
} {
  const dir = join(root, seq());
  const paths = resolveRuntimePaths({
    env: { COMMERCEBILL_DATA_DIR: dir },
    localAppData: 'C:\\unused',
  });
  const log = new AppLog(paths.logsDir);
  return {
    paths,
    log,
    deps: (extra = {}) => ({ paths, resources, cipher, appVersion: '0.1.0-test', log, ...extra }),
  };
}

async function start(d: ReturnType<typeof fresh>, extra = {}) {
  const h = await startRuntime(d.deps(extra));
  running.push(h);
  return h;
}
const stop = async (h: RuntimeHandle) => {
  await h.stop();
  running.splice(running.indexOf(h), 1);
};
const sql = async <T extends object = Record<string, unknown>>(
  url: string,
  q: string,
  p: unknown[] = [],
) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T & pg.QueryResultRow>(q, p)).rows;
  } finally {
    await c.end();
  }
};
const addBusiness = async (url: string) => {
  const [org] = await sql<{ id: string }>(
    url,
    `INSERT INTO organizations (legal_name, setup_completed_at, updated_at) VALUES ('Fictional Runtime Co', now(), now()) RETURNING id`,
  );
  await sql(
    url,
    `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at) VALUES ($1, 'rt.user', 'Runtime User', '$argon2id$placeholder', now())`,
    [org!.id],
  );
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-runtime-'));
});
afterEach(async () => {
  for (const h of [...running]) await h.stop().catch(() => undefined);
  running.length = 0;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('fresh installation and restart', () => {
  it('creates the data folders, an EMPTY database at the current structure, a loopback-only server and protected credentials', async () => {
    const d = fresh();
    const h = await start(d);
    expect(h.install).toBe('fresh');
    expect(h.migration.state).toBe('current');
    // nothing but structure: no business, no users, no demo transactions
    expect(
      (await sql<{ n: string }>(h.databaseUrl, 'SELECT count(*)::text AS n FROM organizations'))[0]!
        .n,
    ).toBe('0');
    expect(
      (
        await sql<{ n: string }>(h.databaseUrl, 'SELECT count(*)::text AS n FROM sales_invoices')
      )[0]!.n,
    ).toBe('0');
    // loopback only, password required
    const s = await sql<{ name: string; setting: string }>(
      h.databaseUrl,
      `SELECT name, setting FROM pg_settings WHERE name IN ('listen_addresses','password_encryption','port')`,
    );
    expect(Object.fromEntries(s.map((r) => [r.name, r.setting]))).toMatchObject({
      listen_addresses: '127.0.0.1',
      password_encryption: 'scram-sha-256',
      port: String(h.port),
    });
    const bad = new pg.Client({
      host: '127.0.0.1',
      port: h.port,
      user: 'commercebill_app',
      password: 'wrong-password-123',
      database: 'commercebill',
    });
    await expect(bad.connect()).rejects.toThrow(/password authentication failed/);
    expect(readFileSync(join(d.paths.pgData, 'pg_hba.conf'), 'utf8')).not.toMatch(
      /trust|::1|replication/,
    );
    // the password is generated for this installation and is not on disk in the clear
    const password = decodeURIComponent(new URL(h.databaseUrl).password);
    expect(password.length).toBeGreaterThanOrEqual(40);
    for (const f of [d.paths.secretsFile, d.paths.runtimeJson, d.paths.statusFile].filter(
      existsSync,
    ))
      expect(readFileSync(f).toString('latin1')).not.toContain(password);
    expect(readFileSync(d.paths.secretsFile, 'latin1')).toMatch(/^PROTECTED:/);
    // the password never reaches the application log
    expect(readFileSync(join(d.paths.logsDir, 'app.log'), 'utf8')).not.toContain(password);
    await stop(h);
    expect((await h.postgres.status()).running).toBe(false);
    expect(existsSync(d.paths.initMarker)).toBe(false);
  }, 240_000);

  it('a second start finds the same business data (restart), reusing the saved credentials', async () => {
    const d = fresh();
    const h1 = await start(d);
    await addBusiness(h1.databaseUrl);
    await stop(h1);
    const h2 = await start(d);
    expect(h2.install).toBe('existing');
    expect(
      (
        await sql<{ n: string }>(h2.databaseUrl, 'SELECT count(*)::text AS n FROM organizations')
      )[0]!.n,
    ).toBe('1');
    await stop(h2);
  }, 240_000);

  it('finds and reuses a server a crashed application left running', async () => {
    const d = fresh();
    const h1 = await start(d);
    await addBusiness(h1.databaseUrl);
    running.splice(running.indexOf(h1), 1); // the application "dies": nobody stops the server
    const h2 = await start(d);
    expect(h2.reusedRunningDatabase).toBe(true);
    expect(h2.port).toBe(h1.port);
    expect(
      (
        await sql<{ n: string }>(h2.databaseUrl, 'SELECT count(*)::text AS n FROM organizations')
      )[0]!.n,
    ).toBe('1');
    await stop(h2);
  }, 240_000);

  it('recovers after the database process is killed (no clean shutdown): committed data is intact', async () => {
    const d = fresh();
    const h1 = await start(d);
    await addBusiness(h1.databaseUrl);
    const pid = (await h1.postgres.status()).pid!;
    running.splice(running.indexOf(h1), 1);
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
    await new Promise((r) => setTimeout(r, 1500));
    const h2 = await start(d);
    expect(h2.install).toBe('existing');
    expect(
      (await sql<{ n: string }>(h2.databaseUrl, 'SELECT count(*)::text AS n FROM users'))[0]!.n,
    ).toBe('1');
    await stop(h2);
  }, 240_000);

  it('uses another port when the remembered one is taken, and writes diagnostics without any secret', async () => {
    const d = fresh();
    const h1 = await start(d);
    const port = h1.port;
    await stop(h1);
    const { createServer } = await import('node:net');
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(port, '127.0.0.1', ok));
    try {
      const h2 = await start(d);
      expect(h2.port).not.toBe(port);
      const diag = await collectDiagnostics({
        paths: d.paths,
        resources,
        appVersion: '0.1.0-test',
        databaseUrl: h2.databaseUrl,
        databasePort: h2.port,
        install: h2.install,
        apiHealthy: true,
      });
      const text = formatDiagnostics(diag);
      const password = decodeURIComponent(new URL(h2.databaseUrl).password);
      expect(text).not.toContain(password);
      expect(text).not.toMatch(/postgres(ql)?:\/\//);
      expect(diag.schema.state).toBe('current');
      expect(text).toContain('127.0.0.1');
      await stop(h2);
    } finally {
      blocker.close();
    }
  }, 240_000);
});

describe('start-up refuses, and never creates a new empty database over data that cannot be opened', () => {
  async function installed() {
    const d = fresh();
    const h = await start(d);
    await addBusiness(h.databaseUrl);
    await stop(h);
    return d;
  }
  const code = async (d: ReturnType<typeof fresh>) => {
    try {
      await startRuntime(d.deps());
    } catch (e) {
      expect(e).toBeInstanceOf(StartupError);
      return (e as StartupError).code;
    }
    return 'STARTED';
  };

  it('settings present but the database folder gone: DATA_MISSING, nothing created', async () => {
    const d = await installed();
    rmSync(d.paths.pgData, { recursive: true, force: true });
    expect(await code(d)).toBe('DATA_MISSING');
    expect(existsSync(d.paths.pgData)).toBe(false);
  }, 240_000);

  it('credentials missing: CREDENTIALS_MISSING, the cluster is untouched', async () => {
    const d = await installed();
    rmSync(d.paths.secretsFile);
    const before = readdirSync(d.paths.pgData).sort();
    expect(await code(d)).toBe('CREDENTIALS_MISSING');
    expect(readdirSync(d.paths.pgData).sort()).toEqual(before);
  }, 240_000);

  it('database present but settings missing: CONFIG_MISSING', async () => {
    const d = await installed();
    rmSync(d.paths.runtimeJson);
    expect(await code(d)).toBe('CONFIG_MISSING');
  }, 240_000);

  it('credentials that cannot be unprotected (another Windows account): refused with a clear code', async () => {
    const d = await installed();
    writeFileSync(d.paths.secretsFile, 'garbage that is not ours');
    expect(await code(d)).toBe('CREDENTIALS_MISSING');
  }, 240_000);

  it('data written by a NEWER version: DB_NEWER, the data is not changed', async () => {
    const d = await installed();
    const h = await start(d);
    await sql(
      h.databaseUrl,
      `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count) VALUES ('11111111-1111-1111-1111-111111111111', 'x', now(), '29990101000000_from_the_future', 1)`,
    );
    await stop(h);
    expect(await code(d)).toBe('DB_NEWER');
    const h2 = await new (
      await import('../../apps/desktop/src/runtime/postgres.js')
    ).PostgresRuntime({
      binDir: resources.pgBin,
      dataDir: d.paths.pgData,
      logFile: join(d.paths.logsDir, 'postgres.log'),
      tmpDir: d.paths.tmpDir,
    }).status();
    expect(h2.running).toBe(true); // the server was started and is left for the next launch to reuse or stop
    const { PostgresRuntime } = await import('../../apps/desktop/src/runtime/postgres.js');
    await new PostgresRuntime({
      binDir: resources.pgBin,
      dataDir: d.paths.pgData,
      logFile: join(d.paths.logsDir, 'postgres.log'),
      tmpDir: d.paths.tmpDir,
    }).stop();
  }, 240_000);

  it('an unfinished first-time setup (marker present, no settings) is redone from scratch', async () => {
    const d = fresh();
    mkdirSync(d.paths.configDir, { recursive: true });
    mkdirSync(d.paths.pgData, { recursive: true });
    writeFileSync(join(d.paths.pgData, 'PG_VERSION'), '18');
    writeFileSync(d.paths.initMarker, '{}');
    const h = await start(d);
    expect(h.install).toBe('fresh');
    await stop(h);
  }, 240_000);
});

describe('upgrade: a verified safety backup first, then the migrations', () => {
  const allMigrations = readdirSync(resources.migrationsDir)
    .filter((n) => /^\d{14}_/.test(n))
    .sort();

  function oldMigrationsDir(): string {
    const dir = join(root, `old-${seq()}`);
    mkdirSync(dir);
    for (const n of allMigrations.slice(0, -1))
      cpSync(join(resources.migrationsDir, n), join(dir, n), { recursive: true });
    return dir;
  }
  const withResources = (migrationsDir: string) => ({ resources: { ...resources, migrationsDir } });

  it('upgrades an older database: backup made and verified, migrations applied, data intact, report written', async () => {
    const d = fresh();
    const old = await start(d, withResources(oldMigrationsDir()));
    expect(old.migration.current).toBe(allMigrations.at(-2));
    await addBusiness(old.databaseUrl);
    await stop(old);

    const h = await start(d);
    expect(h.upgrade).not.toBeNull();
    expect(h.upgrade!.applied).toEqual([allMigrations.at(-1)]);
    expect(h.upgrade!.safetyBackup).toMatch(/^CommerceBill-pre-upgrade-.*\.cbbackup$/);
    expect(readdirSync(d.paths.preUpgradeDir)).toEqual([h.upgrade!.safetyBackup]);
    expect(h.migration.state).toBe('current');
    expect(
      (await sql<{ n: string }>(h.databaseUrl, 'SELECT count(*)::text AS n FROM users'))[0]!.n,
    ).toBe('1');
    expect(existsSync(d.paths.lastUpgradeFile)).toBe(true);
    const secrets = readFileSync(d.paths.secretsFile, 'latin1');
    const file = readFileSync(join(d.paths.preUpgradeDir, h.upgrade!.safetyBackup!));
    expect(file.subarray(0, 8).toString('latin1')).toBe('CBBACKUP'); // encrypted, not a plain dump
    expect(secrets).toMatch(/^PROTECTED:/);
    await stop(h);
  }, 400_000);

  it('an empty database (no business yet) is upgraded without a safety backup', async () => {
    const d = fresh();
    const old = await start(d, withResources(oldMigrationsDir()));
    await stop(old);
    const h = await start(d);
    expect(h.upgrade!.safetyBackup).toBeNull();
    expect(h.migration.state).toBe('current');
    await stop(h);
  }, 400_000);

  it('a failing migration leaves the database as it was, keeps the verified safety backup, and stops start-up', async () => {
    const d = fresh();
    const old = await start(d, withResources(oldMigrationsDir()));
    await addBusiness(old.databaseUrl);
    await stop(old);
    const bad = join(root, `bad-${seq()}`);
    cpSync(resources.migrationsDir, bad, { recursive: true });
    mkdirSync(join(bad, '20990101000000_broken'));
    writeFileSync(
      join(bad, '20990101000000_broken', 'migration.sql'),
      'CREATE TABLE ok_table (id int); SELECT 1/0;',
    );
    await expect(startRuntime(d.deps(withResources(bad)))).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
    });
    expect(readdirSync(d.paths.preUpgradeDir).filter((f) => f.endsWith('.cbbackup'))).toHaveLength(
      1,
    );
    const { PostgresRuntime } = await import('../../apps/desktop/src/runtime/postgres.js');
    const pgr = new PostgresRuntime({
      binDir: resources.pgBin,
      dataDir: d.paths.pgData,
      logFile: join(d.paths.logsDir, 'postgres.log'),
      tmpDir: d.paths.tmpDir,
    });
    const st = await pgr.status();
    const url = pgr.urlFor(
      st.port!,
      decodeURIComponent(
        new URL(
          `postgresql://u:${await (async () => {
            const { loadSecrets } = await import('../../apps/desktop/src/runtime/secrets.js');
            return encodeURIComponent(loadSecrets(d.paths.secretsFile, cipher).dbPassword);
          })()}@h/x`,
        ).password,
      ),
    );
    expect((await sql<{ n: string }>(url, 'SELECT count(*)::text AS n FROM users'))[0]!.n).toBe(
      '1',
    ); // data untouched
    expect(
      (await sql<{ t: string | null }>(url, `SELECT to_regclass('public.ok_table')::text AS t`))[0]!
        .t,
    ).toBeNull(); // the broken migration rolled back entirely
    expect(
      (
        await sql<{ n: string }>(
          url,
          `SELECT count(*)::text AS n FROM "_prisma_migrations" WHERE migration_name = '20990101000000_broken'`,
        )
      )[0]!.n,
    ).toBe('0');
    await pgr.stop();
  }, 400_000);

  it('a safety backup that cannot be made blocks the upgrade: nothing is changed', async () => {
    const d = fresh();
    const old = await start(d, withResources(oldMigrationsDir()));
    await addBusiness(old.databaseUrl);
    await stop(old);
    mkdirSync(join(d.paths.preUpgradeDir, '..'), { recursive: true });
    writeFileSync(d.paths.preUpgradeDir, 'a file where the folder must be'); // the safety backup folder cannot be created
    await expect(startRuntime(d.deps())).rejects.toMatchObject({
      code: 'PRE_UPGRADE_BACKUP_FAILED',
    });
    const { PostgresRuntime } = await import('../../apps/desktop/src/runtime/postgres.js');
    const { loadSecrets } = await import('../../apps/desktop/src/runtime/secrets.js');
    const pgr = new PostgresRuntime({
      binDir: resources.pgBin,
      dataDir: d.paths.pgData,
      logFile: join(d.paths.logsDir, 'postgres.log'),
      tmpDir: d.paths.tmpDir,
    });
    const st = await pgr.status();
    const url = pgr.urlFor(st.port!, loadSecrets(d.paths.secretsFile, cipher).dbPassword);
    expect(
      (
        await sql<{ t: string | null }>(
          url,
          `SELECT to_regclass('public.backup_records')::text AS t`,
        )
      )[0]!.t,
    ).toBeNull(); // still the old structure
    await pgr.stop();
  }, 400_000);
});
