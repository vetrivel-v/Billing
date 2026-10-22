import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createIsolatedDatabase, type IsolatedDatabase } from '@commercebill/test-utilities';

/**
 * End-to-end check of requirement P1-SEC-01: the real Electron shell starts the real built API with a
 * per-launch secret, and the real renderer reaches it through the preload bridge.
 */
const repoRoot = resolve(import.meta.dirname, '..', '..');
const desktopDir = resolve(repoRoot, 'apps', 'desktop');
let db: IsolatedDatabase;
let electronPath: string;

interface SmokeResult {
  origin: string;
  title: string;
  bridge: { name: string; version: string; platform: string };
  bridgeKeys: string[];
  badSavePayload: string;
  badPrintPayload: string;
  nodeExposed: boolean;
  secretLength: number;
  baseUrlIsLoopback: boolean;
  authorisedDb: { status: number; code: string | null; db: string | null };
  unauthorisedDb: { status: number; code: string | null; db: string | null };
  livenessWithoutSecret: { status: number };
  ui: { screen: string | null };
  secretInApiOutput: boolean;
  secretFingerprint: string | null;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async (non-blocking) process runner: keeps the test worker's event loop responsive. */
function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; shell?: boolean; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out running ${command}\n${stdout}\n${stderr}`));
    }, options.timeoutMs);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function runShell(env: NodeJS.ProcessEnv): Promise<RunResult> {
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  return run(electronPath, ['.'], { cwd: desktopDir, env: cleanEnv, timeoutMs: 120_000 });
}

beforeAll(async () => {
  // The shell loads the built bundles, so build exactly what it needs (fixed command, no shell input).
  const build = await run(
    'npm run build -w @commercebill/api -w @commercebill/web -w @commercebill/desktop',
    [],
    { cwd: repoRoot, shell: true, timeoutMs: 300_000 },
  );
  if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);
  // The electron package exports the path of its binary; require it directly (no vite transform).
  electronPath = createRequire(import.meta.url)('electron') as string;
  db = await createIsolatedDatabase(inject('pgAdminUrl'));
}, 400_000);

afterAll(async () => {
  await db?.drop();
});

describe('Electron shell supplies the launch secret to the API (P1-SEC-01)', () => {
  it('authorises renderer calls, rejects calls without the secret, and never logs the secret', async () => {
    const r = await runShell({ ELECTRON_SMOKE: '1', DATABASE_URL: db.url, LOG_LEVEL: 'info' });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const line = r.stdout.split('\n').find((l) => l.startsWith('SMOKE_RESULT '));
    expect(line, r.stdout).toBeTruthy();
    const result = JSON.parse(line!.slice('SMOKE_RESULT '.length)) as SmokeResult;

    // Renderer is served from the privileged custom origin, isolated from Node.
    expect(result.origin).toBe('app://commercebill');
    expect(result.nodeExposed).toBe(false);
    expect(result.bridge.name).toBe('CommerceBill Desktop');

    // Task 1.15: the bridge is exactly these four methods (no fs, shell, path or navigation capability), and the document
    // channels reject an invalid payload from the real renderer (no dialog, no file, no echo).
    expect(result.bridgeKeys).toEqual([
      'chooseBackupDestination',
      'chooseRestoreFile',
      'getApiAccess',
      'getAppInfo',
      'printInvoice',
      'saveInvoicePdf',
    ]);
    expect(result.badSavePayload).toBe('rejected');
    expect(result.badPrintPayload).toBe('rejected');

    // Per-launch secret: 32 random bytes hex, delivered with a loopback URL.
    expect(result.secretLength).toBe(64);
    expect(result.baseUrlIsLoopback).toBe(true);

    // Authorised call succeeds against the real database; unauthorised is rejected with the stable code.
    expect(result.authorisedDb).toMatchObject({ status: 200, db: 'ok' });
    expect(result.unauthorisedDb).toMatchObject({ status: 401, code: 'AUTH_0001' });
    expect(result.livenessWithoutSecret.status).toBe(200);

    // The React app itself reached the API using the shell-supplied secret: its first screen is chosen from a
    // launch-secret-protected call (/setup/status). This database has no organization, so the app shows the setup wizard ("CommerceBill setup");
    // without a working secret it would show "CommerceBill is not ready" instead.
    expect(result.ui).toEqual({ screen: 'CommerceBill setup' });

    // The API's captured output never contains the secret.
    expect(result.secretInApiOutput).toBe(false);
    // And neither does the shell's own stdout/stderr.
    expect(r.stdout + r.stderr).not.toMatch(/[0-9a-f]{64}/);
  });

  it('generates a different secret for every launch (compared by one-way fingerprint only)', async () => {
    const launch = async () => {
      const r = await runShell({ ELECTRON_SMOKE: '1', DATABASE_URL: db.url, LOG_LEVEL: 'info' });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      const line = r.stdout.split('\n').find((l) => l.startsWith('SMOKE_RESULT '));
      return JSON.parse(line!.slice('SMOKE_RESULT '.length)) as SmokeResult;
    };
    const first = await launch();
    const second = await launch();
    expect(first.secretFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(second.secretFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(second.secretFingerprint).not.toBe(first.secretFingerprint);
  });

  it('fails fast with a clear message (variable name only) when DATABASE_URL is missing', async () => {
    const r = await runShell({ ELECTRON_SMOKE: '1', DATABASE_URL: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SMOKE_FAILED could not start the local service/);
    expect(r.stderr).toMatch(/DATABASE_URL/);
  });
});

describe('built API refuses to start unsafely where protection is required (P1-SEC-01)', () => {
  const apiEntry = resolve(repoRoot, 'apps', 'api', 'dist', 'main.js');
  const baseEnv = {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    NODE_ENV: 'production',
    API_PORT: '45999',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  };
  const startApi = (env: NodeJS.ProcessEnv) =>
    run(process.execPath, [apiEntry], { cwd: repoRoot, env, timeoutMs: 30_000 });

  it('exits 1 in production without LAUNCH_SECRET', async () => {
    const r = await startApi(baseEnv);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/LAUNCH_SECRET is required when NODE_ENV=production/);
  });

  it('exits 1 for a too-short secret and does not echo it', async () => {
    const r = await startApi({ ...baseEnv, LAUNCH_SECRET: 'short-but-sensitive-value' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/at least 32/);
    expect(r.stderr + r.stdout).not.toContain('short-but-sensitive-value');
  });

  it('exits 1 for a non-loopback bind even with a valid secret', async () => {
    const r = await startApi({ ...baseEnv, LAUNCH_SECRET: 'a'.repeat(64), API_HOST: '0.0.0.0' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/loopback/);
  });
});
