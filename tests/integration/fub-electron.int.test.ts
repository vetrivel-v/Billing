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
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createFixture, type Fixture } from './auth-fixture.js';
import { pdfText, squash } from '../e2e/pdf-text.js';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const desktopDir = resolve(repoRoot, 'apps', 'desktop');
const E2E = {
  username: 'priya.admin',
  password: 'Velvet anchor orbit 7731',
  passphrase: 'first usable billing passphrase 2026',
};
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
  const built = buildSync({
    entryPoints: [resolve(repoRoot, 'tests', 'e2e', 'driver.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.DEBUG_PRINT_LIMIT': 'undefined',
    },
    logLevel: 'silent',
  });
  bundle = join(tmp, 'driver.js');
  writeFileSync(bundle, built.outputFiles[0]!.text);
}, 600_000);

afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await fx?.close();
});

describe('FIRST USABLE BILLING in the real Electron application', () => {
  it('first launch: setup, sign in, customer, product, opening stock, tax review, DEMO invoice, PDF, payments, dashboard, verified backup', async () => {
    firstRun = await runStage('journey');
    const o = firstRun;
    // the real application, not a page in a test runner
    expect(o.bridgeKeys).toEqual([
      'chooseBackupDestination',
      'chooseRestoreFile',
      'getApiAccess',
      'getAppInfo',
      'printInvoice',
      'saveInvoicePdf',
    ]);
    expect(o.nodeExposed).toBe(false);
    expect(o.controlSecretInApiOutput).toBe(false);
    expect(o.launchSecretInApiOutput).toBe(false);

    // empty database: the setup wizard ran and the administrator signed in
    expect(o.sawSetupWizard).toBe(true);
    expect(o.setupCompleteNotice).toBe(true);
    expect(o.dashboardEmpty.demoFigures).toContain('₹0.00');
    expect(o.dashboardEmpty.realFigures).toBeNull();
    expect(o.dashboardEmpty.readiness).toContain('NOT READY');

    // invoice: place of supply must be confirmed, GST is intra-state, the total is the server's
    expect(o.postDisabledBeforePlaceOfSupply).toBe(true);
    expect(o.previewTaxable).toBe('₹2,000.00');
    expect(o.previewCgst).toBe('₹180.00');
    expect(o.previewSgst).toBe('₹180.00');
    expect(o.previewIgst).toBe('₹0.00');
    expect(o.previewTotal).toBe('₹2,360.00');
    expect(o.invoiceNumber).toMatch(/^DEMO\/\d{4}-\d{2}\/000001$/);
    expect(o.invoicePostedNotice).toBe(true);
    expect(o.invoiceEditControls).toBe(0);
    expect(o.invoiceShowsCustomer).toBe(true);
    expect(o.previewHtmlHasNumber && o.previewHtmlHasCustomer && o.previewHtmlDemo).toBe(true);
    expect(o.pdfSaved).toBe(true);

    // payments: partial, then the rest
    expect(o.balanceBefore).toBe('₹2,360.00');
    expect(o.balanceAfterPartial).toBe('₹1,360.00');
    expect(o.partlyPaidShown).toBe(true);
    expect(o.balanceAfterFull).toBe('₹0.00');
    expect(o.paidShown).toBe(true);

    // dashboard: DEMO figures are labelled DEMO, there are no real figures, nothing is invented
    const d = o.dashboardAfter;
    expect(d.demoFigures).toContain('DEMO sales today');
    expect(d.demoFigures).toContain('₹2,360.00');
    expect(d.realFigures).toBeNull();
    expect(d.recentInvoices).toContain(o.invoiceNumber);
    expect(d.recentInvoices).toContain('DEMO');
    expect(d.recentPayments).toContain('DPAY/');
    expect(d.stock).toContain('1 tracked product');
    expect(d.readiness).toContain('NOT READY');
    expect(d.recovery).toContain('Not verified');
    expect(d.demoFigures + d.recentInvoices).not.toMatch(/profit|margin|cost of goods|COGS/i);

    // backup: created, verified by an isolated restore, readiness updated
    expect(o.backupCreatedAndVerified).toBe(true);
    expect(o.readinessBackupReady).toBe(true);
    expect(o.pageShowsPassphrase).toBe(false);
    expect(o.pageShowsPath).toBe(false);

    // navigation tells the truth: every module is built
    expect(o.comingSoon).toBe(false);
    expect(o.windowWidth).toBeGreaterThanOrEqual(1200); // the real Electron window
    expect(o.overflowPages).toEqual([]); // no page is wider than the window
    for (const item of [
      'Dashboard',
      'Customers',
      'Products',
      'Inventory',
      'Tax',
      'Billing',
      'Payments',
      'Receivables',
      'Settings',
    ])
      expect(o.sidebar).toContain(item);
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
    const t = squash(pdfText(buf));
    const inv = await fx.prisma.salesInvoice.findFirstOrThrow();
    expect(t).toContain(squash(inv.documentNumber));
    expect(t).toContain(squash(inv.customerName));
    expect(t).toContain('2,360.00');
    expect(t).toContain('2,000.00');
    expect(t).toContain(squash('NOT A PRODUCTION TAX INVOICE'));
    expect(t).toContain(squash('DEMO INVOICE'));
  });

  it('second launch (a new process, nothing in memory): sign in and everything is still there', async () => {
    secondRun = await runStage('restart');
    const o = secondRun;
    expect(o.nodeExposed).toBe(false);
    expect(o.sawSetupWizard).toBe(false); // setup stays completed
    expect(o.customerPresent).toBe(true);
    expect(o.productPresent).toBe(true);
    expect(o.inventoryRow).toContain('12');
    expect(o.invoiceNumber).toBe(firstRun.invoiceNumber);
    expect(o.invoiceListRow).toContain('₹2,360.00');
    expect(o.demoPaid).toBe('₹2,360.00');
    expect(o.demoBalance).toBe('₹0.00');
    expect(o.paymentRows).toBe(2);
    expect(o.editControls).toBe(0);
    expect(o.paymentsListed).toBe(2);
    expect(o.realReceivablesEmpty).toBe(true); // DEMO customers never appear in real receivables
    expect(o.receivablesText).toBe(true);
    expect(o.backupHistory).toContain('.cbbackup');
    expect(o.backupHistory).toContain('Verified');
    expect(o.readinessBackupReady).toBe(true);
    expect(o.dashboard.demoFigures).toContain('₹2,360.00');
    expect(o.dashboard.recovery).toContain('Verified');
    expect(o.dashboard.recovery).not.toContain('Not verified');
    // tax reviewed + seller valid + HSN/SAC policy + verified backup: the software's checklist is met, yet the mode is still DEMO
    expect(o.dashboard.readiness).toContain('Overall: READY');
    expect(o.dashboard.readiness).toContain('not a GST or legal certification');
    expect(o.dashboard.readiness).toContain('nothing switches on automatically');
    expect(o.dashboard.demoFigures).toContain('DEMO');
    expect(o.pageShowsPath).toBe(false);
    expect(o.overflowPages).toEqual([]);
  }, 700_000);

  it('cleans up: the temporary PDF and backup are deleted after the run', () => {
    rmSync(tmp, { recursive: true, force: true });
    expect(existsSync(tmp)).toBe(false);
  });
});
