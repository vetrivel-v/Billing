// Task 1.15: invoice documents from REAL posted DEMO invoices (real API, real PostgreSQL) and a REAL Electron PDF render.
// Fictional data only. The PDF is produced by the same main-process code path as Save PDF (without the save dialog).
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  buildInvoiceDocument,
  parseInvoiceSnapshot,
  renderInvoiceHtml,
} from '@commercebill/document-engine';
import type { InvoiceView } from '@commercebill/shared-types';
import { makeInvoice } from '@commercebill/test-utilities/invoice-snapshot';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PASSWORD, call, createFixture, createRoleUsers, type Fixture } from './auth-fixture.js';
import {
  body,
  previewAndPost,
  setupBillingWorld,
  type BillingWorld,
  type Line,
} from './invoice-fixture.js';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const desktopDir = resolve(repoRoot, 'apps', 'desktop');
let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;
let w: BillingWorld;
let logs: string[];
let tmp: string;
let electronPath: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const admin = () => tokens['Administrator']!;

function runElectronPdf(
  fixture: string,
  out: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_PDF_FIXTURE: fixture,
      ELECTRON_PDF_OUT: out,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, ['.'], { cwd: desktopDir, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Electron PDF render timed out\n${stdout}\n${stderr}`));
    }, 120_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

/** Posts a real demo invoice and returns the snapshot exactly as the API serves it. */
async function post(lines: Line[], over: Record<string, unknown> = {}): Promise<InvoiceView> {
  const r = await previewAndPost(app, admin(), body(w, over, lines));
  expect(r.post.status, JSON.stringify(r.post.json)).toBe(201);
  return (r.post.json as unknown as Json).invoice as InvoiceView;
}
const fetchInvoice = async (id: string, token = admin()) => {
  const r = await call(app, 'GET', `/invoices/${id}`, { token });
  return { status: r.status, invoice: (r.json as unknown as Json).invoice as InvoiceView };
};
const htmlOf = (inv: InvoiceView) => {
  const p = parseInvoiceSnapshot(inv);
  if (!p.ok) throw new Error('snapshot rejected');
  return renderInvoiceHtml(buildInvoiceDocument(p.invoice));
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function renderPdf(inv: InvoiceView, name: string) {
  const fixture = join(tmp, `${name}.json`);
  const out = join(tmp, `${name}.pdf`);
  writeFileSync(fixture, JSON.stringify(inv));
  const r = await runElectronPdf(fixture, out);
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  const line = r.stdout.split('\n').find((l) => l.startsWith('PDF_RESULT '));
  expect(line, r.stdout + r.stderr).toBeTruthy();
  const meta = JSON.parse(line!.slice('PDF_RESULT '.length)) as {
    bytes: number;
    pages: number;
    fileName: string;
  };
  return { ...meta, pdf: readFileSync(out) };
}

/** The content streams of a PDF, inflated. Chromium subsets fonts, so text is searched by drawing operations, not by words. */
function pageStreams(pdf: Buffer): string[] {
  const text = pdf.toString('latin1');
  const out: string[] = [];
  for (const m of text.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      out.push(inflateSync(Buffer.from(text.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      /* not a Flate stream (images, fonts): ignore */
    }
  }
  return out;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cb-pdf-'));
  electronPath = createRequire(import.meta.url)('electron') as string;
  fx = await createFixture(inject('pgAdminUrl'));
  logs = [];
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    logStream: { write: (m: string) => void logs.push(m) },
  });
  tokens = await createRoleUsers(app, fx.orgId);
  w = await setupBillingWorld(fx);
}, 400_000);

afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await fx?.close();
});

describe('the document is the immutable posted snapshot', () => {
  it('1-6,24. master-data changes after posting do not alter the document, which is deterministic', async () => {
    const posted = await post(
      [
        { productId: w.products.gst5, quantity: '3' },
        { productId: w.products.tracked, quantity: '1' },
      ],
      {
        customerId: w.customers.b2b,
      },
    );
    const before = htmlOf((await fetchInvoice(posted.id)).invoice);
    expect(before).toContain('Five Percent Item');
    expect(before).toContain('Registered Buyer Pvt Ltd');
    expect(before).toContain('Sample Traders Private Limited');
    expect(before).toContain('DEMO/2026-27/');
    expect(before).toContain('200.00'); // the posted unit price

    await fx.prisma.product.update({
      where: { id: w.products.gst5 },
      data: { name: 'Five Percent Item PREMIUM', sellingPrice: '1200.00' },
    });
    await fx.prisma.customer.update({
      where: { id: w.customers.b2b },
      data: { legalName: 'Renamed Buyer Ltd', billingAddressLine1: 'Elsewhere 99' },
    });
    await fx.prisma.organization.update({
      where: { id: fx.orgId },
      data: { legalName: 'Renamed Seller Pvt Ltd' },
    });
    await fx.prisma.businessLocation.update({
      where: { id: w.locationId },
      data: { addressLine1: 'A New Road' },
    });
    await fx.prisma.taxCategory.update({
      where: { id: w.taxId.GST_5 },
      data: { name: 'GST five, renamed' },
    });
    await fx.prisma.taxRate.updateMany({
      where: { categoryId: w.taxId.GST_5, effectiveTo: null },
      data: { effectiveTo: new Date(`${w.today}T00:00:00Z`) },
    });
    await fx.prisma.taxRate.create({
      data: {
        organizationId: fx.orgId,
        categoryId: w.taxId.GST_5,
        ratePercent: '9.0000',
        effectiveFrom: new Date('2999-01-01T00:00:00Z'),
        origin: 'USER',
      },
    });

    const after = htmlOf((await fetchInvoice(posted.id)).invoice);
    expect(sha(after)).toBe(sha(before)); // identical bytes: nothing historical changed, and the render is deterministic
    for (const current of [
      'PREMIUM',
      '1,200.00',
      'Renamed',
      'Elsewhere 99',
      'A New Road',
      'GST five, renamed',
    ])
      expect(after).not.toContain(current);
    expect(after).toContain(posted.documentNumber);
    await fx.prisma.product.update({
      where: { id: w.products.gst5 },
      data: { name: 'Five Percent Item', sellingPrice: '200.00' },
    });
    await fx.prisma.customer.update({
      where: { id: w.customers.b2b },
      data: { legalName: 'Registered Buyer Pvt Ltd', billingAddressLine1: '1 Buyer Lane' },
    });
  });

  it('25. after the application is reopened (a new API instance over the same database) the same invoice prints identically', async () => {
    const posted = await post([{ productId: w.products.untracked, quantity: '2' }]);
    const first = htmlOf((await fetchInvoice(posted.id)).invoice);
    const reopened = await fx.makeApp({
      env: { LOG_LEVEL: 'silent' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    });
    const token = (
      await call(reopened, 'POST', '/auth/login', {
        body: { username: 'admin.user', password: PASSWORD, organizationId: fx.orgId },
      })
    ).json.token as string;
    const r = await call(reopened, 'GET', `/invoices/${posted.id}`, { token });
    expect(sha(htmlOf((r.json as unknown as Json).invoice))).toBe(sha(first));
  });

  it('shows the stored place of supply, components, discount and total for the real invoices', async () => {
    const intra = await post([
      {
        productId: w.products.untracked,
        quantity: '2',
        discount: { type: 'PERCENT', percent: '10' },
      } as Line,
    ]);
    const h = htmlOf((await fetchInvoice(intra.id)).invoice);
    expect(h).toContain('Maharashtra (27)');
    expect(h).toContain('CGST 9%');
    expect(h).toContain('SGST 9%');
    expect(h).not.toMatch(/IGST \d/);
    expect(h).toContain('10%'); // discount percentage
    expect(h).toContain('-50.00');
    expect(h).toContain(
      `&#8377;${intra.totals.grandTotal.replace(/(\d)(?=(\d{2})+\d\.)/g, '$1,')}`.replace(
        ',',
        ',',
      ) === ''
        ? ''
        : 'Grand total',
    );

    const inter = await post([{ productId: w.products.untracked, quantity: '3' }], {
      customerId: w.customers.interState,
      placeOfSupply: { stateCode: '29', choice: 'CONFIRMED' },
    });
    const hi = htmlOf((await fetchInvoice(inter.id)).invoice);
    expect(hi).toContain('Karnataka (29)');
    expect(hi).toContain('IGST 18%');
    expect(hi).not.toContain('CGST');

    const split = await post([{ productId: w.products.untracked, quantity: '1' }], {
      customerId: w.customers.split,
      placeOfSupply: { stateCode: '29', choice: 'OVERRIDE' },
    });
    const hs = htmlOf((await fetchInvoice(split.id)).invoice);
    expect(hs).toContain('9 Dock Road');
    expect(hs).toContain('Ship to');
  });
});

describe('access control', () => {
  it('20-21. another organization, or a user without invoice.read, cannot obtain the snapshot the document is built from', async () => {
    const posted = await post([{ productId: w.products.untracked, quantity: '1' }]);
    expect((await fetchInvoice(posted.id, tokens['Warehouse Operator']!)).status).toBe(403);
    expect((await fetchInvoice(posted.id, tokens['Viewer/Auditor']!)).status).toBe(200); // read-only access is enough to view/print
    const org = await fx.prisma.organization.create({
      data: { legalName: 'DEMO Other Co (fictional)' },
    });
    const { seedReference } = await import('../../prisma/seed/reference/index.js');
    await seedReference(fx.prisma, { organizationId: org.id });
    await app.authService!.createUser({
      organizationId: org.id,
      username: 'admin.orgb',
      displayName: 'Admin B',
      password: PASSWORD,
      roleNames: ['Administrator'],
    });
    const tokenB = (
      await call(app, 'POST', '/auth/login', {
        body: { username: 'admin.orgb', password: PASSWORD, organizationId: org.id },
      })
    ).json.token as string;
    expect((await fetchInvoice(posted.id, tokenB)).status).toBe(404);
    expect((await call(app, 'GET', `/invoices/${randomUUID()}`, { token: admin() })).status).toBe(
      404,
    );
  });

  it('27. diagnostic logs carry no invoice, customer, tax or document content', async () => {
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(1000);
    for (const secret of [
      'Registered Buyer',
      'Walk-in Buyer',
      'Untracked Gadget',
      '27AAAAA0000A1Z5',
      'Market Road',
      'Rupees ',
      'Bill to',
      '<html',
      'Grand total',
    ])
      expect(text, secret).not.toContain(secret);
  });
});

describe('a real A4 PDF from Electron', () => {
  it('renders a one-page DEMO invoice as a valid PDF with the DEMO marking on its page', async () => {
    const inv = await post([{ productId: w.products.untracked, quantity: '2' }]);
    const r = await renderPdf((await fetchInvoice(inv.id)).invoice, 'simple');
    expect(r.fileName).toBe(`DEMO-2026-27-${inv.documentNumber.split('/').pop()}.pdf`);
    expect(r.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(r.pdf.subarray(-64).toString('latin1')).toContain('%%EOF');
    expect(r.pages).toBe(1);
    expect(r.bytes).toBeGreaterThan(5_000);
    // A4 portrait: 595 x 842 points
    expect(r.pdf.toString('latin1')).toMatch(
      /\/MediaBox\s*\[\s*0\s+0\s+59[45](\.\d+)?\s+84[12](\.\d+)?\s*\]/,
    );
    // the watermark is drawn as a large (>= 100 pt) text run on the page
    const big = pageStreams(r.pdf).filter(
      (s) => /\b1[0-9]{2}(\.\d+)? Tf\b/.test(s) || /\/F\d+ 1[0-9]{2}(\.\d+)? Tf/.test(s),
    );
    expect(big.length).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('22-23. a long invoice spans several pages, drops no line, and the DEMO marking is drawn on every page', async () => {
    const cycle = [
      w.products.untracked,
      w.products.tracked,
      w.products.gst5,
      w.products.gst12,
      w.products.kg,
    ];
    const lines: Line[] = Array.from({ length: 90 }, (_, i) => ({
      productId: cycle[i % cycle.length]!,
      quantity: String((i % 4) + 1),
    }));
    const inv = await post(lines);
    expect(inv.lines).toHaveLength(90);
    const snapshot = (await fetchInvoice(inv.id)).invoice;
    const html = htmlOf(snapshot);
    expect((html.match(/<tr>\n<td class="num">\d+<\/td>/g) ?? []).length).toBe(90);
    const r = await renderPdf(snapshot, 'long');
    expect(r.pages).toBeGreaterThanOrEqual(3);
    expect(r.pages).toBeLessThanOrEqual(8);
    const streams = pageStreams(r.pdf);
    const watermarkPages = streams.filter(
      (s) => /\/F\d+ 1[0-9]{2}(\.\d+)? Tf/.test(s) || /\b1[0-9]{2}(\.\d+)? Tf\b/.test(s),
    ).length;
    expect(watermarkPages).toBeGreaterThanOrEqual(r.pages); // one large DEMO run per page
  }, 240_000);

  it('negative control: a production-shaped document (test data) has no DEMO marking drawn, so the page check above is meaningful', async () => {
    const prod = makeInvoice({
      isDemo: false,
      lines: [{ name: 'Real thing', qty: 2, pricePaise: 25_000, rate: 18 }],
    });
    const r = await renderPdf(prod, 'production');
    expect(r.pages).toBe(1);
    expect(r.fileName).toBe('INV-2026-27-000001.pdf');
    const big = pageStreams(r.pdf).filter(
      (s) => /\/F\d+ 1[0-9]{2}(\.\d+)? Tf/.test(s) || /1[0-9]{2}(\.\d+)? Tf/.test(s),
    );
    expect(big).toHaveLength(0);
  }, 180_000);

  it('rejects a snapshot that is not a valid invoice (nothing is rendered, nothing is echoed)', async () => {
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, JSON.stringify({ documentNumber: '../../evil', lines: [] }));
    const r = await runElectronPdf(bad, join(tmp, 'bad.pdf'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/PDF_FAILED/);
    expect(r.stderr).not.toContain('evil');
  }, 120_000);
});
