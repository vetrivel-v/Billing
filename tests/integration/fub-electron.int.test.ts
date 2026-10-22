// Task 1.18: FIRST USABLE BILLING end-to-end, in the REAL Electron application: real main process, real preload, real renderer served from
// app://, real Fastify API and a real PostgreSQL database that starts EMPTY (migrations only). A driver script operates the real screens
// like a person; the business is created through them (nothing is seeded behind the test). Two launches share one database: the first
// runs the whole journey and ends with a verified backup, the second (a new process) proves everything persisted.
// Real versus replaced: the two NATIVE dialogs (save/print and folder/file choosers) are replaced by hooks that use a throw-away folder,
// and the screens are operated from the main process with executeJavaScript (Playwright is not installed). Security settings are untouched.
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createFixture, type Fixture } from './auth-fixture.js';
import {
  E2E_CREDENTIALS,
  assertFirstLaunch,
  assertPdfText,
  assertRestartLaunch,
  driverBundle,
} from '../e2e/fub-journey.js';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const desktopDir = resolve(repoRoot, 'apps', 'desktop');
const E2E = E2E_CREDENTIALS;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let fx: Fixture;
let tmp: string;
let electronPath: string;
let bundle: string;
let firstRun: Json;
let secondRun: Json;

async function runStage(stage: 'journey' | 'restart'): Promise<Json> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_E2E: '1',
    ELECTRON_E2E_STAGE: stage,
    ELECTRON_E2E_SCRIPT: bundle,
    ELECTRON_E2E_DIR: tmp,
    ELECTRON_E2E_ENV: JSON.stringify(E2E),
    DATABASE_URL: fx.db.url,
    LOG_LEVEL: 'info',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (res, rej) => {
      const c = spawn(electronPath, ['.'], { cwd: desktopDir, env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      c.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      c.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      const t = setTimeout(() => {
        c.kill();
        rej(new Error(`e2e stage ${stage} timed out\n${stdout}\n${stderr}`));
      }, 420_000);
      c.on('close', (status) => {
        clearTimeout(t);
        res({ status, stdout, stderr });
      });
    },
  );
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  const line = r.stdout.split('\n').find((l) => l.startsWith('E2E_RESULT '));
  expect(line, r.stdout + r.stderr).toBeTruthy();
  // the shell's own output carries no secret and no business content
  expect(r.stdout.replace(line!, '') + r.stderr).not.toContain(E2E.passphrase);
  expect(r.stdout.replace(line!, '') + r.stderr).not.toContain(E2E.password);
  return JSON.parse(line!.slice('E2E_RESULT '.length)) as Json;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cb-fub-'));
  mkdirSync(join(tmp, 'pdf'));
  mkdirSync(join(tmp, 'backups'));
  electronPath = createRequire(import.meta.url)('electron') as string;
  // an EMPTY database: migrations only, no organization, no reference data (setup seeds those itself)
  fx = await createFixture(inject('pgAdminUrl'), { bare: true });
  const build = await new Promise<{ status: number | null; out: string }>((res, rej) => {
    const c = spawn(
      'npm run build -w @commercebill/api -w @commercebill/web -w @commercebill/desktop',
      [],
      {
        cwd: repoRoot,
        shell: true,
        windowsHide: true,
      },
    );
    let out = '';
    c.stdout.on('data', (d: Buffer) => (out += d.toString()));
    c.stderr.on('data', (d: Buffer) => (out += d.toString()));
    c.on('error', rej);
    c.on('close', (status) => res({ status, out }));
  });
  expect(build.status, build.out).toBe(0);
  bundle = join(tmp, 'driver.js');
  writeFileSync(bundle, driverBundle());
}, 600_000);

afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await fx?.close();
});

describe('FIRST USABLE BILLING in the real Electron application', () => {
  it('first launch: setup, sign in, customer, product, opening stock, tax review, DEMO invoice, PDF, payments, dashboard, verified backup', async () => {
    firstRun = await runStage('journey');
    assertFirstLaunch(firstRun);
  }, 700_000);

  it('the database holds exactly what the journey created, and a DEMO invoice did not touch real stock', async () => {
    const p = fx.prisma;
    expect(await p.organization.count()).toBe(1);
    expect((await p.organization.findFirstOrThrow()).setupCompletedAt).not.toBeNull();
    expect(await p.customer.count()).toBe(1);
    expect(await p.product.count()).toBe(1);
    // Opening stock = 12; the DEMO invoice must not reduce it, and no other movement exists
    const balances = await p.stockBalance.findMany();
    expect(balances).toHaveLength(1);
    expect(balances[0]!.quantityOnHand.toFixed(4)).toBe('12.0000');
    const movements = await p.stockMovement.findMany();
    expect(movements.map((m) => m.movementType)).toEqual(['OPENING_STOCK']);
    // the invoice is a posted, immutable DEMO document
    const invoices = await p.salesInvoice.findMany();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      isDemo: true,
      status: 'POSTED',
      documentType: 'DEMO_INVOICE',
    });
    expect(invoices[0]!.grandTotal.toFixed(2)).toBe('2360.00');
    expect(invoices[0]!.documentNumber).toBe(firstRun.invoiceNumber);
    await expect(p.$executeRaw`UPDATE sales_invoices SET grand_total = 1`).rejects.toThrow();
    // two DEMO payments, fully allocated, no production payment
    const payments = await p.payment.findMany({
      include: { allocations: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(payments.map((x) => x.amount.toFixed(2))).toEqual(['1000.00', '1360.00']);
    expect(payments.every((x) => x.isDemo && x.documentType === 'DEMO_PAYMENT_RECEIPT')).toBe(true);
    expect(payments.flatMap((x) => x.allocations).reduce((a, x) => a + Number(x.amount), 0)).toBe(
      2360,
    );
    expect(await p.payment.count({ where: { isDemo: false } })).toBe(0);
    expect(await p.salesInvoice.count({ where: { isDemo: false } })).toBe(0);
    // an encrypted backup exists, recorded once and verified PASS
    const records = await p.backupRecord.findMany({ include: { verifications: true } });
    expect(records).toHaveLength(1);
    expect(records[0]!.verifications.map((v) => v.result)).toEqual(['PASS']);
    const files = readdirSync(join(tmp, 'backups')).filter((f) => f.endsWith('.cbbackup'));
    expect(files).toEqual([records[0]!.fileName]);
    expect(
      readFileSync(join(tmp, 'backups', files[0]!))
        .subarray(0, 8)
        .toString('latin1'),
    ).toBe('CBBACKUP');
  });

  it('the saved PDF says what the immutable invoice says, and carries the DEMO marking', async () => {
    const files = readdirSync(join(tmp, 'pdf'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.pdf$/);
    const buf = readFileSync(join(tmp, 'pdf', files[0]!));
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const inv = await fx.prisma.salesInvoice.findFirstOrThrow();
    assertPdfText(buf, inv.documentNumber, inv.customerName);
  });

  it('second launch (a new process, nothing in memory): sign in and everything is still there', async () => {
    secondRun = await runStage('restart');
    assertRestartLaunch(secondRun, firstRun);
  }, 700_000);

  it('cleans up: the temporary PDF and backup are deleted after the run', () => {
    rmSync(tmp, { recursive: true, force: true });
    expect(existsSync(tmp)).toBe(false);
  });
});
