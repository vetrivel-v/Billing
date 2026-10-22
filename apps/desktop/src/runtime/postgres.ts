import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

/**
 * The private PostgreSQL CommerceBill owns (ADR-0029): the same real PostgreSQL the tests use, run from the application's own folder,
 * listening only on 127.0.0.1 on a free port, with a generated password, its data under the user's data folder. CommerceBill starts it
 * when the application starts and stops it when the application closes. No console window is ever shown.
 */
export const PG_USER = 'commercebill_app';
export const PG_DATABASE = 'commercebill';

export class PostgresError extends Error {
  constructor(
    readonly code:
      | 'BINARIES_MISSING'
      | 'INIT_FAILED'
      | 'START_FAILED'
      | 'START_TIMEOUT'
      | 'STOP_FAILED'
      | 'PORT_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

export interface PostgresStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
}

export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

const run = (file: string, args: string[], timeoutMs: number) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1
          : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });

export class PostgresRuntime {
  constructor(
    private readonly o: {
      binDir: string;
      dataDir: string;
      logFile: string;
      tmpDir: string;
      log?: (message: string) => void;
    },
  ) {}

  private exe = (name: string): string => join(this.o.binDir, `${name}.exe`);
  private note = (m: string): void => this.o.log?.(m);

  binariesPresent(): boolean {
    return ['postgres', 'initdb', 'pg_ctl'].every((n) => existsSync(this.exe(n)));
  }

  isInitialised(): boolean {
    return existsSync(join(this.o.dataDir, 'PG_VERSION'));
  }

  /**
   * Creates a brand-new cluster. Only ever called for a data folder that does not exist (or that holds a first-time initialisation that
   * never finished): CommerceBill never re-initialises a cluster that may hold business data.
   */
  async initialise(password: string): Promise<void> {
    if (!this.binariesPresent())
      throw new PostgresError('BINARIES_MISSING', 'The database program files are missing.');
    mkdirSync(this.o.tmpDir, { recursive: true });
    const pwfile = join(this.o.tmpDir, `pw-${process.pid}-${Date.now()}`);
    writeFileSync(pwfile, password, { mode: 0o600 });
    try {
      mkdirSync(join(this.o.dataDir, '..'), { recursive: true });
      const r = await run(
        this.exe('initdb'),
        [
          `--pgdata=${this.o.dataDir}`,
          '--auth=scram-sha-256',
          `--username=${PG_USER}`,
          `--pwfile=${pwfile}`,
          // UTF-8 text (R-035), and text ordering that does not depend on the Windows language settings of the computer
          '--encoding=UTF8',
          '--locale=C',
          '--locale-provider=icu',
          '--icu-locale=en-IN',
        ],
        120_000,
      );
      if (r.code !== 0) {
        this.note(`initdb failed (exit ${String(r.code)}): ${r.stderr.slice(-600)}`);
        throw new PostgresError('INIT_FAILED', 'The local database could not be created.');
      }
    } finally {
      rmSync(pwfile, { force: true });
    }
    // Only the loopback IPv4 address may connect, and only with the password (no "trust" rule, no IPv6, no replication).
    writeFileSync(
      join(this.o.dataDir, 'pg_hba.conf'),
      '# CommerceBill: local connections only, password required.\nhost    all    all    127.0.0.1/32    scram-sha-256\n',
    );
    this.note('database cluster created');
  }

  /** postmaster.pid: line 1 is the process id, line 4 the port. */
  private readPidFile(): { pid: number; port: number } | null {
    try {
      const lines = readFileSync(join(this.o.dataDir, 'postmaster.pid'), 'utf8').split(/\r?\n/);
      const pid = Number(lines[0]);
      const port = Number(lines[3]);
      return Number.isInteger(pid) && Number.isInteger(port) ? { pid, port } : null;
    } catch {
      return null;
    }
  }

  async status(): Promise<PostgresStatus> {
    if (!existsSync(this.exe('pg_ctl'))) return { running: false, pid: null, port: null };
    const r = await run(this.exe('pg_ctl'), ['status', '-D', this.o.dataDir], 20_000);
    const info = this.readPidFile();
    return r.code === 0 && info
      ? { running: true, pid: info.pid, port: info.port }
      : { running: false, pid: null, port: null };
  }

  /** Starts the server (or finds the one a previous run left behind) and waits until it accepts the password. */
  async start(
    port: number,
    password: string,
    timeoutMs = 90_000,
  ): Promise<{ port: number; reused: boolean }> {
    const existing = await this.status();
    if (existing.running && existing.port) {
      this.note(
        `database already running (pid ${String(existing.pid)}, port ${String(existing.port)})`,
      );
      await this.waitReady(existing.port, password, timeoutMs);
      return { port: existing.port, reused: true };
    }
    if (!(await isPortFree(port)))
      throw new PostgresError('PORT_UNAVAILABLE', `Port ${String(port)} is in use.`);
    mkdirSync(join(this.o.logFile, '..'), { recursive: true });
    const fd = openSync(this.o.logFile, 'a');
    const child = spawn(
      this.exe('postgres'),
      [
        '-D',
        this.o.dataDir,
        '-p',
        String(port),
        '-c',
        'listen_addresses=127.0.0.1',
        '-c',
        'password_encryption=scram-sha-256',
        '-c',
        'max_connections=60',
        '-c',
        'log_line_prefix=%t [%p] ',
        '-c',
        'log_timezone=UTC',
      ],
      // No console window (CREATE_NO_WINDOW; a detached server would give every one of its worker processes a console of its own). A crash of
      // the application leaves the server running, so the next start can find and reuse it (or stop it cleanly).
      { detached: false, stdio: ['ignore', fd, fd], windowsHide: true },
    );
    child.unref();
    closeSync(fd);
    let exited: number | null = null;
    child.once('exit', (code) => (exited = code ?? -1));
    await this.waitReady(port, password, timeoutMs, () => exited);
    this.note(`database started on 127.0.0.1:${String(port)}`);
    return { port, reused: false };
  }

  private async waitReady(
    port: number,
    password: string,
    timeoutMs: number,
    exitCode: () => number | null = () => null,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      if (exitCode() !== null)
        throw new PostgresError('START_FAILED', 'The local database stopped while starting.');
      const c = new pg.Client({
        host: '127.0.0.1',
        port,
        user: PG_USER,
        password,
        database: 'postgres',
        connectionTimeoutMillis: 3000,
      });
      try {
        await c.connect();
        await c.query('SELECT 1');
        await c.end();
        return;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
        await c.end().catch(() => undefined);
        // a wrong password will not fix itself: report it at once instead of waiting out the timeout
        if (/password authentication failed/i.test(last))
          throw new PostgresError(
            'START_FAILED',
            'The local database refused the stored password.',
          );
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    this.note(`database did not become ready: ${last}`);
    throw new PostgresError('START_TIMEOUT', 'The local database did not become ready in time.');
  }

  /** A clean ("fast") shutdown: connections are closed, a checkpoint is written, nothing needs recovering on the next start. */
  async stop(timeoutMs = 60_000): Promise<void> {
    const s = await this.status();
    if (!s.running) return;
    const r = await run(
      this.exe('pg_ctl'),
      [
        'stop',
        '-D',
        this.o.dataDir,
        '-m',
        'fast',
        '-w',
        '-t',
        String(Math.round(timeoutMs / 1000)),
      ],
      timeoutMs + 15_000,
    );
    if (r.code !== 0) {
      this.note(`pg_ctl stop failed (exit ${String(r.code)}): ${r.stderr.slice(-300)}`);
      throw new PostgresError('STOP_FAILED', 'The local database did not stop cleanly.');
    }
    this.note('database stopped cleanly');
  }

  /** For Windows log-off or shutdown, where there is no time to wait asynchronously. */
  stopSync(timeoutSeconds = 8): void {
    execFileSync(
      this.exe('pg_ctl'),
      ['stop', '-D', this.o.dataDir, '-m', 'fast', '-w', '-t', String(timeoutSeconds)],
      { windowsHide: true, timeout: (timeoutSeconds + 4) * 1000, stdio: 'ignore' },
    );
  }

  urlFor(port: number, password: string, database = PG_DATABASE): string {
    return `postgresql://${PG_USER}:${encodeURIComponent(password)}@127.0.0.1:${String(port)}/${database}`;
  }
}
