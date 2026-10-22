// Shared by the FIRST USABLE BILLING end-to-end checks: the one that runs in the repository build (tests/integration/fub-electron) and the
// one that runs in the INSTALLED application (tests/release/packaged-e2e). Same driver, same expectations.
import { expect } from 'vitest';
import { buildSync } from 'esbuild';
import { resolve } from 'node:path';
import { pdfText, squash } from './pdf-text.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const E2E_CREDENTIALS = {
  username: 'priya.admin',
  password: 'Velvet anchor orbit 7731',
  passphrase: 'first usable billing passphrase 2026',
};

/** The browser-side driver as one script (it is run inside the real renderer by the main process). */
export function driverBundle(): string {
  const built = buildSync({
    entryPoints: [resolve(import.meta.dirname, 'driver.ts')],
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
  return built.outputFiles[0]!.text;
}

export function assertFirstLaunch(o: Json): void {
  // the real application, not a page in a test runner
  expect(o.bridgeKeys).toEqual([
    'chooseBackupDestination',
    'chooseRestoreFile',
    'exportDiagnostics',
    'getApiAccess',
    'getAppInfo',
    'getDiagnostics',
    'openLogFolder',
    'printInvoice',
    'saveInvoicePdf',
    'showSafetyPassphrase',
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
}

export function assertRestartLaunch(o: Json, first: Json): void {
  expect(o.nodeExposed).toBe(false);
  expect(o.sawSetupWizard).toBe(false); // setup stays completed
  expect(o.customerPresent).toBe(true);
  expect(o.productPresent).toBe(true);
  expect(o.inventoryRow).toContain('12');
  expect(o.invoiceNumber).toBe(first.invoiceNumber);
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
}

export function assertPdfText(buf: Buffer, documentNumber: string, customerName: string): void {
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const t = squash(pdfText(buf));
  expect(t).toContain(squash(documentNumber));
  expect(t).toContain(squash(customerName));
  expect(t).toContain('2,360.00');
  expect(t).toContain('2,000.00');
  expect(t).toContain(squash('NOT A PRODUCTION TAX INVOICE'));
  expect(t).toContain(squash('DEMO INVOICE'));
}
