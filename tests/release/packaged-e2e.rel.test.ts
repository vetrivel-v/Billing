// Windows packaging: the FIRST USABLE BILLING journey in the INSTALLED (packaged) application, with the application's OWN managed database:
// a build packaged exactly like the installer (same files, same asar, same resources, app.isPackaged = true) plus ONE marker file that
// lets it accept the end-to-end driver. Two separate launches share one fresh data folder: setup, customer, product, stock, tax review,
// DEMO invoice, PDF, payments, dashboard and a verified backup; then a new process proves everything persisted. Real: Electron, preload,
// renderer, the bundled service, the private PostgreSQL started from the packaged resources, Windows-protected credentials. Replaced: the
// native save/print/folder/file dialogs (hooks) - the release installer does not contain the marker, so it can never run the driver.
import { execFileSync, spawn } from 'node:child_process';
import {
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  E2E_CREDENTIALS,
  assertFirstLaunch,
  assertPdfText,
  assertRestartLaunch,
  driverBundle,
} from '../e2e/fub-journey.js';
import {
  deletionEvidence,
  killAllUnder,
  processesUnder,
  readStatus,
  removeDir,
} from './winhelp.js';

const repo = resolve(import.meta.dirname, '..', '..');
let work: string;
let outDir: string;
let exe: string;
let dataDir: string;
let script: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let first: Json;

async function runStage(stage: 'journey' | 'restart'): Promise<Json> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_E2E: '1',
    ELECTRON_E2E_STAGE: stage,
    ELECTRON_E2E_SCRIPT: script,
    ELECTRON_E2E_DIR: work,
    ELECTRON_E2E_ENV: JSON.stringify(E2E_CREDENTIALS),
    COMMERCEBILL_DATA_DIR: dataDir,
    LOG_LEVEL: 'info',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DATABASE_URL;
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (res, rej) => {
      const c = spawn(exe, [], { env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      c.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      c.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      const t = setTimeout(() => {
        c.kill();
        rej(new Error(`packaged e2e stage ${stage} timed out\n${stdout}\n${stderr}`));
      }, 600_000);
      c.on('close', (status) => {
        clearTimeout(t);
        res({ status, stdout, stderr });
      });
    },
  );
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  const line = r.stdout.split('\n').find((l) => l.startsWith('E2E_RESULT '));
  expect(line, r.stdout + r.stderr).toBeTruthy();
  expect(r.stdout.replace(line!, '') + r.stderr).not.toContain(E2E_CREDENTIALS.passphrase);
  return JSON.parse(line!.slice('E2E_RESULT '.length)) as Json;
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'cb-pkg-e2e-'));
  outDir = join(work, 'build');
  dataDir = join(work, 'cbdata');
  mkdirSync(join(work, 'pdf'));
  mkdirSync(join(work, 'backups'));
  // the packaged application, built the way the installer's contents are built, plus the test marker
  execFileSync('npx', ['tsx', 'scripts/package-win.ts', '--dir', '--e2e', '--out', outDir], {
    cwd: repo,
    stdio: 'inherit',
    shell: true,
  });
  exe = join(outDir, 'win-unpacked', 'CommerceBill.exe');
  script = join(work, 'driver.js');
  writeFileSync(script, driverBundle());
}, 900_000);

afterAll(() => {
  killAllUnder(join(outDir, 'win-unpacked'));
  removeDir(work);
});

describe('the INSTALLED application with its own managed database', () => {
  it('is a packaged build: the release layout, the managed database, no developer tools', () => {
    for (const f of [
      'resources/app.asar',
      'resources/postgres/bin/postgres.exe',
      'resources/api/main.mjs',
      'resources/web/index.html',
      'resources/migrations',
      'resources/e2e-enabled',
    ])
      expect(existsSync(join(outDir, 'win-unpacked', f)), f).toBe(true);
  });

  it('first launch from an EMPTY data folder: setup, sign in, customer, product, stock, tax review, DEMO invoice, PDF, payments, dashboard, verified backup', async () => {
    first = await runStage('journey');
    assertFirstLaunch(first);
    expect(first.controlSecretInApiOutput).toBe(false);
    expect(first.launchSecretInApiOutput).toBe(false);
    // the database belongs to the installation, outside the program folder; the credentials are protected
    for (const f of [
      'data/pg/PG_VERSION',
      'config/runtime.json',
      'config/secrets.bin',
      'logs/app.log',
      'logs/postgres.log',
      'logs/api.log',
    ])
      expect(existsSync(join(dataDir, f)), f).toBe(true);
    expect(
      readdirSync(join(outDir, 'win-unpacked'), { recursive: true, encoding: 'utf8' }).some((f) =>
        /PG_VERSION|\.cbbackup$/.test(f),
      ),
    ).toBe(false);
    const status = readStatus(join(dataDir, 'config', 'runtime-status.json'))!;
    expect(status.state).toBe('stopped');
    expect(readFileSync(join(dataDir, 'logs', 'app.log'), 'utf8')).toContain(
      'database ready (fresh',
    );
    // the saved PDF came from the immutable invoice
    const pdfs = readdirSync(join(work, 'pdf'));
    expect(pdfs).toHaveLength(1);
    expect(first.invoiceNumber).toMatch(/^DEMO\//);
    assertPdfText(
      readFileSync(join(work, 'pdf', pdfs[0]!)),
      first.invoiceNumber,
      'Riverside Traders Pvt Ltd',
    );
    // an encrypted backup was written
    const backups = readdirSync(join(work, 'backups')).filter((f) => f.endsWith('.cbbackup'));
    expect(backups).toHaveLength(1);
    expect(
      readFileSync(join(work, 'backups', backups[0]!))
        .subarray(0, 8)
        .toString('latin1'),
    ).toBe('CBBACKUP');
    // nothing is left running after the application ended
    expect(processesUnder(join(outDir, 'win-unpacked'))).toEqual([]);
  }, 700_000);

  it('second launch (a new process): the same database, everything is still there', async () => {
    const second = await runStage('restart');
    assertRestartLaunch(second, first);
    const status = readStatus(join(dataDir, 'config', 'runtime-status.json'))!;
    expect(status.state).toBe('stopped');
    expect(readFileSync(join(dataDir, 'logs', 'app.log'), 'utf8')).toContain(
      'database ready (existing',
    );
    expect(processesUnder(join(outDir, 'win-unpacked'))).toEqual([]);
  }, 700_000);

  it('cleans up: the temporary PDF, backup, database and program copy are deleted', () => {
    const started = Date.now();
    try {
      removeDir(work);
    } catch (e) {
      throw new Error(
        `${(e as Error).message}
after ${String(Math.round((Date.now() - started) / 1000))} s
${deletionEvidence(work)}`,
        { cause: e },
      );
    }
    expect(existsSync(work)).toBe(false);
    rmSync(work, { recursive: true, force: true });
  });
});
