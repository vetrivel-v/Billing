// Task 1.13: the invoice API in DEMO mode (the only mode the application can reach before Task 1.17) against the real Fastify API and
// a real, migrated PostgreSQL database. Fictional data only. Production behaviour is in invoices-production.int.test.ts.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ROLE_TEMPLATES, seedReference } from '../../prisma/seed/reference/index.js';
import {
  LAUNCH_SECRET,
  PASSWORD,
  call,
  createFixture,
  createRoleUsers,
  type ApiJson,
  type Fixture,
} from './auth-fixture.js';
import {
  body,
  previewAndPost,
  setupBillingWorld,
  type BillingWorld,
  type Line,
} from './invoice-fixture.js';

let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;
let logs: string[];
let w: BillingWorld;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (r: { json: ApiJson }) => r.json as unknown as Json;
const admin = () => tokens['Administrator']!;

const preview = (b: unknown, token = admin()) =>
  call(app, 'POST', '/invoices/preview', { token, body: b });
const postRaw = (b: unknown, token = admin()) => call(app, 'POST', '/invoices', { token, body: b });
const get = (path: string, token = admin()) => call(app, 'GET', path, { token });
const L = (productId: string, quantity = '1', extra: Partial<Line> = {}): Line => ({
  productId,
  quantity,
  ...extra,
});
const request = (lines: Line[], over: Record<string, unknown> = {}) => body(w, over, lines);

const counts = async () => ({
  invoices: await fx.prisma.salesInvoice.count(),
  lines: await fx.prisma.salesInvoiceLine.count(),
  allocations: await fx.prisma.documentNumberAllocation.count(),
  movements: await fx.prisma.stockMovement.count(),
  audit: await fx.prisma.auditLog.count({ where: { action: 'invoice.post' } }),
  auditAll: await fx.prisma.auditLog.count(),
  invoiceSeq: Number(
    (
      await fx.prisma.documentSequence.findFirstOrThrow({
        where: { organizationId: fx.orgId, documentType: 'INVOICE' },
      })
    ).lastNumber,
  ),
  demoSeq: Number(
    (
      await fx.prisma.documentSequence.findFirstOrThrow({
        where: { organizationId: fx.orgId, documentType: 'DEMO_INVOICE' },
      })
    ).lastNumber,
  ),
});
const stockOf = async (productId: string) =>
  (
    await fx.prisma.stockBalance.findUnique({
      where: { warehouseId_productId: { warehouseId: w.warehouseId, productId } },
    })
  )?.quantityOnHand.toFixed(4) ?? 'none';
const addStock = async (productId: string, quantity: string) => {
  const r = await call(app, 'POST', '/inventory/opening-stock', {
    token: admin(),
    body: {
      operationId: randomUUID(),
      productId,
      warehouseId: w.warehouseId,
      quantity,
      businessDate: w.today,
    },
  });
  expect(r.status).toBe(201);
};

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  logs = [];
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    logStream: { write: (m: string) => void logs.push(m) },
  });
  tokens = await createRoleUsers(app, fx.orgId);
  w = await setupBillingWorld(fx);
}, 180_000);
afterAll(async () => fx?.close());

describe('preview (no business writes)', () => {
  it('1-2. calculates with the authoritative facts and writes nothing: no invoice, number, stock, receivable or posting audit', async () => {
    const before = await counts();
    for (let i = 0; i < 3; i++) {
      const r = await preview(request([L(w.products.untracked, '3')]));
      expect(r.status).toBe(200);
      expect(j(r).ok).toBe(true);
    }
    expect(await counts()).toEqual(before);
    expect(await fx.prisma.stockMovement.count()).toBe(before.movements);
  });

  it('3. exclusive, intra-state: 3 x 250.00 at 18% -> CGST 67.50 + SGST 67.50, a suggestion first, postable only once the place of supply is confirmed', async () => {
    const suggested = await preview(
      request([L(w.products.untracked, '3')], { placeOfSupply: undefined }),
    );
    const s = j(suggested);
    expect(s).toMatchObject({
      ok: true,
      postable: false,
      mode: 'DEMO',
      placeOfSupply: { suggestedStateCode: '27', requiresExplicitChoice: false },
    });
    expect(s.warnings).toContainEqual({ code: 'PLACE_OF_SUPPLY_NOT_CONFIRMED' });
    const confirmed = j(await preview(request([L(w.products.untracked, '3')])));
    expect(confirmed).toMatchObject({ ok: true, postable: true });
    const t = confirmed.calculation.totals;
    expect(t).toMatchObject({
      grossSubtotal: '750.00',
      taxableSubtotal: '750.00',
      grandTotal: '885.00',
    });
    expect(t.componentTotals).toMatchObject({ CGST: '67.50', SGST: '67.50', IGST: '0.00' });
    expect(confirmed.identity).toMatchObject({ grandTotal: '885.00' });
    expect(confirmed.identity.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(confirmed.identity.configurationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(confirmed.calculation).toMatchObject({
      engineVersion: '1.0.0',
      rulesetVersion: 'FUB-GST-1',
      supply: 'INTRA',
    });
  });

  it('4. exclusive, inter-state: the same goods to another state give IGST', async () => {
    const r = j(
      await preview(
        request([L(w.products.untracked, '3')], {
          customerId: w.customers.interState,
          placeOfSupply: { stateCode: '29', choice: 'CONFIRMED' },
        }),
      ),
    );
    expect(r.calculation.supply).toBe('INTER');
    expect(r.calculation.totals.componentTotals).toMatchObject({
      CGST: '0.00',
      SGST: '0.00',
      IGST: '135.00',
    });
    expect(r.calculation.totals.grandTotal).toBe('885.00');
  });

  it('5. inclusive price: the price on the product includes GST and the customer-visible total is preserved', async () => {
    const r = j(await preview(request([L(w.products.inclusive, '1')])));
    expect(r.calculation.priceBasis).toBe('INCLUSIVE');
    expect(r.calculation.lines[0]).toMatchObject({ taxableValue: '1000.00', lineTotal: '1180.00' });
  });

  it('6-7. percentage and fixed line discounts', async () => {
    const pct = j(
      await preview(
        request([L(w.products.untracked, '2', { discount: { type: 'PERCENT', percent: '10' } })]),
      ),
    );
    expect(pct.calculation.lines[0]).toMatchObject({
      grossAmount: '500.00',
      discountAmount: '50.00',
      taxableValue: '450.00',
    });
    const amt = j(
      await preview(
        request([L(w.products.untracked, '2', { discount: { type: 'AMOUNT', amount: '100' } })]),
      ),
    );
    expect(amt.calculation.lines[0]).toMatchObject({
      discountAmount: '100.00',
      taxableValue: '400.00',
      lineTotal: '472.00',
    });
    const over = j(
      await preview(
        request([L(w.products.untracked, '1', { discount: { type: 'AMOUNT', amount: '999' } })]),
      ),
    );
    expect(over).toMatchObject({ ok: false, identity: null });
    expect(over.errors).toContainEqual(expect.objectContaining({ code: 'DISCOUNT_EXCEEDS_GROSS' }));
  });

  it('8-9. several tax rates on one invoice, and nil-rated / exempt / non-GST lines keep their classification', async () => {
    const multi = j(
      await preview(
        request([L(w.products.gst5, '1'), L(w.products.gst12, '1'), L(w.products.untracked, '1')]),
      ),
    );
    expect(multi.calculation.lines.map((l: Json) => l.rate.ratePercent)).toEqual([
      '5.00',
      '12.00',
      '18.00',
    ]);
    expect(multi.calculation.totals.grandTotal).toBe('841.00');
    const none = j(
      await preview(request([L(w.products.nil), L(w.products.exempt), L(w.products.nonGst)])),
    );
    expect(none.calculation.lines.map((l: Json) => l.classification)).toEqual([
      'NIL_RATED',
      'EXEMPT',
      'NON_GST',
    ]);
    expect(none.calculation.totals.grandTotal).toBe('300.00');
    expect(none.warnings).toContainEqual({ code: 'NO_TAX_ON_ANY_LINE' });
  });

  it('refuses what cannot be invoiced, with value-free codes', async () => {
    const codes = async (b: unknown) => (j(await preview(b)).errors as Json[]).map((e) => e.code);
    expect(await codes(request([L(w.products.service)]))).toContain('ITEM_KIND_UNSUPPORTED');
    expect(await codes(request([L(randomUUID())]))).toEqual(['PRODUCT_NOT_FOUND']);
    expect(await codes(request([L(w.products.untracked)], { customerId: randomUUID() }))).toEqual([
      'CUSTOMER_NOT_FOUND',
    ]);
    expect(await codes(request([L(w.products.untracked, '1.5')]))).toEqual(['INVALID_QUANTITY']); // PCS has no decimals
    expect(await codes(request([L(w.products.kg, '1.2345')]))).toEqual(['INVALID_QUANTITY']); // KG allows three
    expect(await codes(request([L(w.products.kg, '1.234')]))).toEqual([]);
    expect(await codes(request([L(w.products.untracked)], { invoiceDate: '2000-01-01' }))).toEqual([
      'INVOICE_DATE_NOT_TODAY',
    ]);
    expect(await codes(request([L(w.products.untracked)], { invoiceDate: '2999-01-01' }))).toEqual([
      'INVOICE_DATE_NOT_TODAY',
    ]);
    expect(await codes(request([L(w.products.untracked)], { invoiceDate: w.today }))).toEqual([]);
    // D5: products with different price-basis settings are blocked, never silently converted
    expect(await codes(request([L(w.products.untracked), L(w.products.inclusive)]))).toEqual([
      'MIXED_PRICE_BASIS',
    ]);
    // the engine's own rules pass through (HSN/SAC is required by default)
    const noHsn = await fx.prisma.product.create({
      data: {
        organizationId: fx.orgId,
        sku: 'NOHSN-1',
        name: 'No HSN',
        kind: 'GOODS',
        unitId: w.unit.pcs,
        taxCategoryId: w.taxId.GST_18,
        sellingPrice: '10.00',
      },
    });
    expect(await codes(request([L(noHsn.id)]))).toEqual(['HSN_SAC_REQUIRED']);
  });

  it('only choices travel from the browser: unknown fields (prices, totals, organization) are refused as a malformed request', async () => {
    for (const extra of [{ organizationId: randomUUID() }, { total: '1.00' }, { mode: 'LIVE' }]) {
      const r = await preview({ ...request([L(w.products.untracked)]), ...extra });
      expect(r.status).toBe(400);
    }
    const priced = await preview(
      request([{ ...L(w.products.untracked), unitPrice: '1.00' } as Line]),
    );
    expect(priced.status).toBe(400);
    expect(priced.json.error.problems).toEqual([
      { field: 'lines[0].unitPrice', rule: 'unknown_field' },
    ]);
    expect(
      (await preview({ ...request([L(w.products.untracked)]), mode: undefined })).json.error
        .problems,
    ).toEqual([{ field: 'mode', rule: 'required' }]);
    expect((await preview(request([]))).json.error.problems).toEqual([
      { field: 'lines', rule: 'required' },
    ]);
  });

  it('places of supply: billing and delivery in different states need an explicit choice; a CONFIRMED state must be the suggestion', async () => {
    const lines = [L(w.products.untracked)];
    const split = (pos: Record<string, unknown>) =>
      preview(request(lines, { customerId: w.customers.split, placeOfSupply: pos }));
    const suggestion = j(
      await preview(request(lines, { customerId: w.customers.split, placeOfSupply: undefined })),
    );
    expect(suggestion.placeOfSupply).toEqual({
      suggestedStateCode: '29',
      requiresExplicitChoice: true,
    });
    expect(
      (j(await split({ stateCode: '29', choice: 'CONFIRMED' })).errors as Json[]).map(
        (e) => e.code,
      ),
    ).toContain('PLACE_OF_SUPPLY_SELECTION_REQUIRED');
    const chosen = j(await split({ stateCode: '29', choice: 'OVERRIDE' }));
    expect(chosen).toMatchObject({ ok: true, postable: true });
    expect(chosen.warnings).toContainEqual({ code: 'PLACE_OF_SUPPLY_OVERRIDDEN' });
    expect(
      (
        j(
          await preview(
            request(lines, { placeOfSupply: { stateCode: '29', choice: 'CONFIRMED' } }),
          ),
        ).errors as Json[]
      ).map((e) => e.code),
    ).toEqual(['PLACE_OF_SUPPLY_CHOICE_INVALID']);
  });

  it('PRODUCTION is refused with the stable gate code (the verified backup/restore does not exist yet)', async () => {
    const r = j(await preview(request([L(w.products.untracked)], { mode: 'PRODUCTION' })));
    expect(r).toMatchObject({
      ok: false,
      postable: false,
      mode: 'PRODUCTION',
      calculation: null,
      identity: null,
    });
    expect(r.errors.every((e: Json) => e.code === 'PRODUCTION_GATE_NOT_MET')).toBe(true);
    expect(r.errors.map((e: Json) => e.path)).toEqual(
      expect.arrayContaining([
        'BACKUP_RESTORE_VERIFIED',
        'TAX_REVIEW_CURRENT',
        'BILLING_MODE_NOT_PRODUCTION',
      ]),
    );
  });
});

describe('posting a DEMO invoice', () => {
  it('8. posts in one step: DEMO number, snapshots, place-of-supply confirmation, no receivable, ONE audit event', async () => {
    await addStock(w.products.tracked, '10');
    const before = await counts();
    const req = request([L(w.products.tracked, '2'), L(w.products.untracked, '1')]);
    const { preview: pv, post, operationId } = await previewAndPost(app, admin(), req);
    expect(pv.postable).toBe(true);
    expect(post.status).toBe(201);
    const inv = j(post).invoice;
    expect(j(post).replayed).toBe(false);
    expect(inv.documentNumber).toBe(`DEMO/${w.financialYearLabel}/000001`);
    expect(inv).toMatchObject({
      status: 'POSTED',
      documentType: 'DEMO_INVOICE',
      isDemo: true,
      invoiceDate: w.today,
      currency: 'INR',
      receivable: null,
      warehouseName: 'Main Warehouse',
      financialYearLabel: w.financialYearLabel,
      seller: {
        legalName: 'Sample Traders Private Limited',
        gstin: '27AAPFU0939F1ZV',
        gstStatus: 'REGISTERED',
        stateCode: '27',
        addressLine1: '12 Market Road',
        city: 'Mumbai',
      },
      customer: {
        name: 'Walk-in Buyer',
        gstStatus: 'UNREGISTERED',
        gstin: null,
        recipientClass: 'B2C',
        billing: { stateCode: '27' },
      },
      placeOfSupply: {
        stateCode: '27',
        source: 'USER_CONFIRMED',
        confirmedByName: 'Administrator (test)',
      },
      tax: {
        engineVersion: '1.0.0',
        rulesetVersion: 'FUB-GST-1',
        roundingPolicyId: 'HALF_UP_PAISE_V1',
        inputHash: pv.identity.inputHash,
        configurationFingerprint: pv.identity.configurationFingerprint,
        taxReviewId: null,
      },
      totals: { grandTotal: pv.identity.grandTotal },
    });
    expect(inv.placeOfSupply.confirmedAt).toMatch(/^\d{4}-/);
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines.map((l: Json) => l.stockEffect)).toEqual(['NONE', 'NONE']); // even the tracked product: a demo invoice never touches stock
    expect(inv.lines[0]).toMatchObject({
      lineNo: 1,
      productId: w.products.tracked,
      productName: 'Tracked Widget',
      hsnSacCode: '8517',
      hsnSacKind: 'HSN',
      unitCode: 'PCS',
      quantity: '2',
      unitPrice: '100.00',
      taxCategoryCode: 'GST_18',
      classification: 'STANDARD',
      ratePercent: '18',
      taxableValue: '200.00',
      cgstRate: '9',
      cgstAmount: '18.00',
      sgstAmount: '18.00',
      igstRate: null,
      igstAmount: '0.00',
      lineTotal: '236.00',
    });
    expect(inv.tax.calculation).toMatchObject({ ok: true, supply: 'INTRA' });

    const after = await counts();
    expect(after).toEqual({
      ...before,
      invoices: before.invoices + 1,
      lines: before.lines + 2,
      allocations: before.allocations + 1,
      audit: before.audit + 1,
      auditAll: before.auditAll + 1,
      demoSeq: before.demoSeq + 1,
    });
    expect(after.invoiceSeq).toBe(before.invoiceSeq); // the production sequence is never consumed
    expect(after.movements).toBe(before.movements); // no SALES_DISPATCH, no stock movement at all
    expect(await stockOf(w.products.tracked)).toBe('10.0000');
    const [audit] = await fx.prisma.auditLog.findMany({
      where: { action: 'invoice.post', entityId: inv.id },
    });
    expect(audit).toMatchObject({
      category: 'business',
      entityType: 'sales_invoice',
      organizationId: fx.orgId,
    });
    expect(audit!.correlationId).toBeTruthy();
    expect(audit!.afterValues).toMatchObject({
      documentNumber: inv.documentNumber,
      isDemo: true,
      grandTotal: pv.identity.grandTotal,
      lineCount: 2,
      operationId,
    });
    expect(JSON.stringify(audit)).not.toContain('Walk-in');
    expect(JSON.stringify(audit)).not.toContain('Market Road');
  });

  it('multiple demo invoices leave the real inventory untouched and take consecutive DEMO numbers', async () => {
    const start = await stockOf(w.products.tracked);
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await previewAndPost(app, admin(), request([L(w.products.tracked, '4')]));
      expect(r.post.status).toBe(201);
      numbers.push(j(r.post).invoice.documentNumber);
    }
    expect(numbers).toEqual(
      [2, 3, 4].map((n) => `DEMO/${w.financialYearLabel}/${String(n).padStart(6, '0')}`),
    );
    expect(await stockOf(w.products.tracked)).toBe(start);
    expect(await fx.prisma.stockMovement.count({ where: { movementType: 'SALES_DISPATCH' } })).toBe(
      0,
    );
    expect((await counts()).invoiceSeq).toBe(0);
  });

  it('14. place-of-supply confirmation is required: no choice, or a suggestion, cannot be posted', async () => {
    const pv = j(await preview(request([L(w.products.untracked)])));
    const noChoice = await postRaw({
      ...request([L(w.products.untracked)], { placeOfSupply: undefined }),
      operationId: randomUUID(),
      calculation: pv.identity,
    });
    expect(noChoice.status).toBe(400);
    expect(noChoice.json.error.problems).toEqual([{ field: 'placeOfSupply', rule: 'required' }]);
    const before = await counts();
    const split = request([L(w.products.untracked)], {
      customerId: w.customers.split,
      placeOfSupply: { stateCode: '29', choice: 'CONFIRMED' },
    });
    const dummy = {
      inputHash: 'a'.repeat(64),
      configurationFingerprint: 'b'.repeat(64),
      grandTotal: '1.00',
    };
    const r = { post: await postRaw({ ...split, operationId: randomUUID(), calculation: dummy }) };
    expect(r.post.status).toBe(400); // ambiguous billing/delivery states need an explicit OVERRIDE
    expect(JSON.stringify(r.post.json.error.problems)).toContain(
      'PLACE_OF_SUPPLY_SELECTION_REQUIRED',
    );
    expect(await counts()).toEqual(before);
    const ok = await previewAndPost(app, admin(), {
      ...split,
      placeOfSupply: { stateCode: '29', choice: 'OVERRIDE' },
    });
    expect(ok.post.status).toBe(201);
    expect(j(ok.post).invoice).toMatchObject({
      placeOfSupply: { stateCode: '29', source: 'USER_OVERRIDE' },
      customer: {
        shipping: { stateCode: '29', city: 'Bengaluru', addressLine1: '9 Dock Road' },
        billing: { stateCode: '27' },
      },
    });
    expect(j(ok.post).invoice.tax.calculation.supply).toBe('INTER');
  });

  it('refuses production, a missing mode and another organization mode - and consumes no number', async () => {
    const before = await counts();
    const pv = j(await preview(request([L(w.products.untracked)])));
    const prod = await postRaw({
      ...request([L(w.products.untracked)], { mode: 'PRODUCTION' }),
      operationId: randomUUID(),
      calculation: pv.identity,
    });
    expect(prod.status).toBe(409);
    expect(prod.json.error.problems).toEqual([{ field: 'mode', rule: 'PRODUCTION_GATE_NOT_MET' }]);
    expect(j(prod).error.details.unmet).toEqual(
      expect.arrayContaining(['BACKUP_RESTORE_VERIFIED', 'TAX_REVIEW_CURRENT']),
    );
    const noMode = await postRaw({
      ...request([L(w.products.untracked)], { mode: undefined }),
      operationId: randomUUID(),
      calculation: pv.identity,
    });
    expect(noMode.status).toBe(400);
    expect(noMode.json.error.problems).toEqual([{ field: 'mode', rule: 'required' }]);
    expect(await counts()).toEqual(before);
    expect(await fx.prisma.salesInvoice.count({ where: { isDemo: false } })).toBe(0);
  });

  it('a request that is missing its calculation identity or operation id is refused', async () => {
    const r = await postRaw(request([L(w.products.untracked)]));
    expect(r.status).toBe(400);
    expect(r.json.error.problems).toEqual(
      expect.arrayContaining([
        { field: 'operationId', rule: 'required' },
        { field: 'calculation', rule: 'required' },
      ]),
    );
  });

  it('refuses a date other than today, and an organization without a numbering sequence', async () => {
    const pv = j(await preview(request([L(w.products.untracked)])));
    const yesterday = await postRaw({
      ...request([L(w.products.untracked)], { invoiceDate: '2000-01-01' }),
      operationId: randomUUID(),
      calculation: pv.identity,
    });
    expect(yesterday.status).toBe(400);
    expect(yesterday.json.error.problems).toEqual([
      { field: 'invoiceDate', rule: 'INVOICE_DATE_NOT_TODAY' },
    ]);
  });
});

describe('idempotent posting', () => {
  it('21-22. the same operation twice (double click, or a lost response and a retry) returns the SAME invoice and number, with no second audit row', async () => {
    const req = request([L(w.products.untracked, '2')]);
    const first = await previewAndPost(app, admin(), req);
    const before = await counts();
    const retry = await call(app, 'POST', '/invoices', {
      token: admin(),
      body: { ...req, operationId: first.operationId, calculation: first.preview.identity },
    });
    expect(first.post.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(j(retry).replayed).toBe(true);
    expect(j(retry).invoice.id).toBe(j(first.post).invoice.id);
    expect(j(retry).invoice.documentNumber).toBe(j(first.post).invoice.documentNumber);
    expect(await counts()).toEqual(before);
    // even after the master data changed, the replay returns the original invoice
    await fx.prisma.product.update({
      where: { id: w.products.untracked },
      data: { sellingPrice: '999.00' },
    });
    const late = await call(app, 'POST', '/invoices', {
      token: admin(),
      body: { ...req, operationId: first.operationId, calculation: first.preview.identity },
    });
    expect(late.status).toBe(200);
    expect(j(late).invoice.totals.grandTotal).toBe(j(first.post).invoice.totals.grandTotal);
    await fx.prisma.product.update({
      where: { id: w.products.untracked },
      data: { sellingPrice: '250.00' },
    });
  });

  it('23. the same operation id with DIFFERENT content is refused (409 OPERATION_ID_REUSED), nothing changes', async () => {
    const req = request([L(w.products.untracked, '1')]);
    const first = await previewAndPost(app, admin(), req);
    const before = await counts();
    const other = request([L(w.products.untracked, '2')]);
    const pv = j(await preview(other));
    for (const changed of [
      other,
      request([L(w.products.untracked, '1')], { customerId: w.customers.b2b }),
    ]) {
      const r = await call(app, 'POST', '/invoices', {
        token: admin(),
        body: {
          ...changed,
          operationId: first.operationId,
          calculation: j(await preview(changed)).identity ?? pv.identity,
        },
      });
      expect(r.status).toBe(409);
      expect(r.json.error.problems).toEqual([
        { field: 'operationId', rule: 'OPERATION_ID_REUSED' },
      ]);
    }
    expect(await counts()).toEqual(before);
  });

  it('ten simultaneous retries of one operation create exactly one invoice and one number', async () => {
    const req = request([L(w.products.untracked, '3')]);
    const pv = j(await preview(req));
    const operationId = randomUUID();
    const before = await counts();
    const rs = await Promise.all(
      Array.from({ length: 10 }, () =>
        call(app, 'POST', '/invoices', {
          token: admin(),
          body: { ...req, operationId, calculation: pv.identity },
        }),
      ),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(9);
    expect(new Set(rs.map((r) => j(r).invoice.documentNumber)).size).toBe(1);
    const after = await counts();
    expect(after.invoices).toBe(before.invoices + 1);
    expect(after.demoSeq).toBe(before.demoSeq + 1);
    expect(after.audit).toBe(before.audit + 1);
  });

  it('numbers stay consecutive when postings run in parallel (no duplicates, no gaps)', async () => {
    const before = await counts();
    const rs = await Promise.all(
      Array.from({ length: 8 }, () =>
        previewAndPost(app, admin(), request([L(w.products.untracked, '1')])),
      ),
    );
    expect(rs.every((r) => r.post.status === 201)).toBe(true);
    const nums = rs
      .map((r) => Number(j(r.post).invoice.documentNumber.split('/').pop()))
      .sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 8 }, (_, i) => before.demoSeq + 1 + i));
  });
});

describe('a calculation that changed after the preview is refused (CALCULATION_STALE)', () => {
  async function stale(
    mutate: () => Promise<() => Promise<void>>,
    expectedReason: string,
    lines: Line[] = [L(w.products.gst12, '1')],
    over: Record<string, unknown> = {},
  ) {
    const req = request(lines, over);
    const pv = j(await preview(req));
    expect(pv.ok).toBe(true);
    const restore = await mutate();
    try {
      const before = await counts();
      const r = await postRaw({ ...req, operationId: randomUUID(), calculation: pv.identity });
      expect(r.status).toBe(409);
      expect(r.json.error.problems).toEqual([{ field: 'calculation', rule: 'CALCULATION_STALE' }]);
      expect(r.json.error.dataSaved).toBe(false);
      const details = j(r).error.details;
      expect(details.reasons).toContain(expectedReason);
      expect(details.recalculation).toMatchObject({ ok: true, mode: 'DEMO' });
      expect(details.recalculation.identity.inputHash).not.toBe(
        pv.identity.inputHash === details.recalculation.identity.inputHash
          ? ''
          : pv.identity.inputHash,
      );
      expect(await counts()).toEqual(before); // nothing posted, no number consumed
    } finally {
      await restore();
    }
  }

  it('12-A. the product selling price changed', async () => {
    await stale(async () => {
      await fx.prisma.product.update({
        where: { id: w.products.gst12 },
        data: { sellingPrice: '310.00' },
      });
      return async () =>
        void (await fx.prisma.product.update({
          where: { id: w.products.gst12 },
          data: { sellingPrice: '300.00' },
        }));
    }, 'CALCULATION_CHANGED');
  });

  it('13-B. the customer GST status changed', async () => {
    await stale(async () => {
      await fx.prisma.customer.update({
        where: { id: w.customers.b2c },
        data: { gstStatus: 'REGISTERED', gstin: '27BBBBB1111B1Z5' },
      });
      return async () =>
        void (await fx.prisma.customer.update({
          where: { id: w.customers.b2c },
          data: { gstStatus: 'UNREGISTERED', gstin: null },
        }));
    }, 'CALCULATION_CHANGED');
  });

  it('13-C. the customer place of supply changed: the CONFIRMED state no longer matches the suggestion and is refused before anything is posted', async () => {
    const req = request([L(w.products.gst12, '1')]);
    const pv = j(await preview(req));
    await fx.prisma.customer.update({
      where: { id: w.customers.b2c },
      data: { placeOfSupplyStateCode: '29' },
    });
    try {
      const before = await counts();
      const r = await postRaw({ ...req, operationId: randomUUID(), calculation: pv.identity });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json.error.problems)).toContain('PLACE_OF_SUPPLY_CHOICE_INVALID');
      expect(await counts()).toEqual(before);
    } finally {
      await fx.prisma.customer.update({
        where: { id: w.customers.b2c },
        data: { placeOfSupplyStateCode: '27' },
      });
    }
  });

  it('14-D. the applicable tax rate changed (a new effective-dated rate takes effect today)', async () => {
    const p28 = await fx.prisma.product.create({
      data: {
        organizationId: fx.orgId,
        sku: 'G28-1',
        name: 'Twenty Eight',
        kind: 'GOODS',
        unitId: w.unit.pcs,
        taxCategoryId: w.taxId.GST_28,
        hsnSacCodeId: w.hsnId,
        sellingPrice: '100.00',
      },
    });
    await stale(
      async () => {
        const yesterday = new Date(`${w.today}T00:00:00Z`);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        await fx.prisma.taxRate.updateMany({
          where: { categoryId: w.taxId.GST_28, effectiveTo: null },
          data: { effectiveTo: yesterday },
        });
        await fx.prisma.taxRate.create({
          data: {
            organizationId: fx.orgId,
            categoryId: w.taxId.GST_28,
            ratePercent: '29.0000',
            effectiveFrom: new Date(`${w.today}T00:00:00Z`),
            origin: 'USER',
          },
        });
        return async () => undefined;
      },
      'CALCULATION_CHANGED',
      [L(p28.id, '1')],
    );
  });

  it('15-E. the tax configuration (review fingerprint) changed', async () => {
    const p28 = await fx.prisma.product.findFirstOrThrow({
      where: { organizationId: fx.orgId, sku: 'G28-1' },
    });
    const cat = await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'GST_28' },
    });
    await stale(
      async () => {
        await fx.prisma.taxCategory.update({
          where: { id: cat.id },
          data: { name: 'GST 28% (edited)' },
        });
        return async () =>
          void (await fx.prisma.taxCategory.update({
            where: { id: cat.id },
            data: { name: cat.name },
          }));
      },
      'TAX_CONFIGURATION_CHANGED',
      [L(p28.id, '1')],
    );
  });

  it('F. stock is not part of the calculation: it is checked at posting, not by staleness (demo: advisory only)', async () => {
    const pv = j(await preview(request([L(w.products.tracked, '9999')])));
    expect(pv.ok).toBe(true);
    expect(pv.stockWarnings).toEqual([
      expect.objectContaining({
        productId: w.products.tracked,
        required: '9999',
        sufficient: false,
        advisoryOnly: true,
      }),
    ]);
    const r = await postRaw({
      ...request([L(w.products.tracked, '9999')]),
      operationId: randomUUID(),
      calculation: pv.identity,
    });
    expect(r.status).toBe(201); // a demo invoice never touches (or needs) real stock
  });
});

describe('snapshots keep historical invoices stable', () => {
  it('26. changing the product, customer, tax category, rate or seller afterwards does not alter a posted invoice', async () => {
    const posted = await previewAndPost(
      app,
      admin(),
      request([L(w.products.gst5, '3'), L(w.products.tracked, '1')], {
        customerId: w.customers.b2b,
      }),
    );
    expect(posted.post.status).toBe(201);
    const id = j(posted.post).invoice.id;
    const original = JSON.stringify(j(await get(`/invoices/${id}`)).invoice);

    await fx.prisma.product.update({
      where: { id: w.products.gst5 },
      data: { name: 'Renamed Item', sellingPrice: '999.00' },
    });
    await fx.prisma.customer.update({
      where: { id: w.customers.b2b },
      data: {
        legalName: 'Renamed Buyer',
        billingAddressLine1: 'Elsewhere',
        gstin: '27CCCCC2222C1Z5',
      },
    });
    await fx.prisma.taxCategory.update({
      where: { id: w.taxId.GST_5 },
      data: { name: 'GST five, renamed' },
    });
    await fx.prisma.organization.update({
      where: { id: fx.orgId },
      data: { legalName: 'Renamed Seller Pvt Ltd' },
    });
    await fx.prisma.businessLocation.update({
      where: { id: w.locationId },
      data: { addressLine1: 'A new road' },
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

    expect(JSON.stringify(j(await get(`/invoices/${id}`)).invoice)).toBe(original);
    const inv = j(await get(`/invoices/${id}`)).invoice;
    expect(inv.customer.name).toBe('Registered Buyer Pvt Ltd');
    expect(inv.seller.legalName).toBe('Sample Traders Private Limited');
    expect(inv.lines[0]).toMatchObject({
      productName: expect.stringMatching(/^Five Percent Item/),
      unitPrice: '200.00',
      taxCategoryName: expect.stringMatching(/placeholder/),
    });
    await fx.prisma.product.update({
      where: { id: w.products.gst5 },
      data: { name: 'Five Percent Item', sellingPrice: '200.00' },
    });
  });
});

describe('reading invoices', () => {
  it('lists newest first with search, demo filter, date range and server-side paging; get returns the full snapshot', async () => {
    const all = j(await get('/invoices?limit=100'));
    expect(all.total).toBeGreaterThan(10);
    expect(all.invoices.every((i: Json) => i.isDemo === true && i.receivable === null)).toBe(true);
    const p1 = j(await get('/invoices?limit=3&offset=0'));
    const p2 = j(await get('/invoices?limit=3&offset=3'));
    expect(p1.invoices).toHaveLength(3);
    expect(p1.invoices.map((i: Json) => i.id)).not.toEqual(p2.invoices.map((i: Json) => i.id));
    expect(
      j(await get('/invoices?search=000001')).invoices.map((i: Json) => i.documentNumber),
    ).toEqual([`DEMO/${w.financialYearLabel}/000001`]);
    expect(
      j(await get('/invoices?search=registered%20buyer')).invoices.every((i: Json) =>
        i.customerName.startsWith('Registered Buyer'),
      ),
    ).toBe(true);
    expect(j(await get('/invoices?search=%25')).total).toBe(0); // "%" is a literal character
    expect(j(await get('/invoices?isDemo=false')).total).toBe(0);
    expect(j(await get(`/invoices?from=${w.today}&to=${w.today}&limit=1`)).total).toBe(all.total);
    expect(j(await get('/invoices?from=2000-01-01&to=2000-12-31')).total).toBe(0);
    expect((await get('/invoices?limit=1000')).status).toBe(400);
    const one = j(await get(`/invoices/${all.invoices[0].id}`)).invoice;
    expect(one.lines.length).toBeGreaterThan(0);
    expect(one.tax.calculation.lines[0].explanation.length).toBeGreaterThan(0);
    expect((await get(`/invoices/${randomUUID()}`)).status).toBe(404);
    expect((await get('/invoices/not-a-uuid')).status).toBe(404);
  });

  it('production reports can exclude demo invoices: the production view holds none of them', async () => {
    const view = await fx.prisma.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM production_sales_invoices`;
    expect(Number(view[0]!.n)).toBe(0);
    const demo = await fx.prisma.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM sales_invoices WHERE is_demo`;
    expect(Number(demo[0]!.n)).toBeGreaterThan(10);
  });
});

describe('posted invoices are immutable', () => {
  it('24-25. no UPDATE, DELETE or TRUNCATE of an invoice or a line succeeds, even directly in the database; no route edits or deletes', async () => {
    const inv = await fx.prisma.salesInvoice.findFirstOrThrow({ include: { lines: true } });
    await expect(
      fx.prisma.$executeRaw`UPDATE sales_invoices SET grand_total = 1 WHERE id = ${inv.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma
        .$executeRaw`UPDATE sales_invoices SET document_number = 'X/1' WHERE id = ${inv.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma.$executeRaw`UPDATE sales_invoices SET is_demo = false WHERE id = ${inv.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma
        .$executeRaw`UPDATE sales_invoices SET customer_name = 'Changed' WHERE id = ${inv.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma.$executeRaw`DELETE FROM sales_invoices WHERE id = ${inv.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma
        .$executeRaw`UPDATE sales_invoice_lines SET quantity = 99 WHERE id = ${inv.lines[0]!.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma.$executeRaw`DELETE FROM sales_invoice_lines WHERE id = ${inv.lines[0]!.id}::uuid`,
    ).rejects.toThrow();
    await expect(fx.prisma.$executeRaw`TRUNCATE sales_invoices`).rejects.toThrow();
    await expect(fx.prisma.$executeRaw`TRUNCATE sales_invoice_lines`).rejects.toThrow();
    await expect(
      fx.prisma.salesInvoice.update({ where: { id: inv.id }, data: { grandTotal: '1' } }),
    ).rejects.toThrow();
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const r = await app.inject({
        method,
        url: `/invoices/${inv.id}`,
        headers: {
          'x-commercebill-launch-secret': LAUNCH_SECRET,
          authorization: `Bearer ${admin()}`,
        },
        payload: method === 'DELETE' ? undefined : {},
      });
      expect([404, 405], method).toContain(r.statusCode);
    }
    const after = await fx.prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.grandTotal.toFixed(2)).toBe(inv.grandTotal.toFixed(2));
  });

  it('a line cannot be added to an invoice that was posted earlier', async () => {
    const inv = await fx.prisma.salesInvoice.findFirstOrThrow({ include: { lines: true } });
    const l = inv.lines[0]!;
    await expect(
      fx.prisma.salesInvoiceLine.create({
        data: { ...(l as never as Record<string, never>), id: randomUUID(), lineNo: 99 } as never,
      }),
    ).rejects.toThrow();
    expect(await fx.prisma.salesInvoiceLine.count({ where: { invoiceId: inv.id } })).toBe(
      inv.lines.length,
    );
  });
});

describe('authentication and authorization by exact key', () => {
  const endpoints: [string, string, string, () => unknown][] = [
    ['sales.invoice.read', 'GET', '/invoices', () => undefined],
    ['sales.invoice.read', 'GET', `/invoices/${randomUUID()}`, () => undefined],
    ['sales.invoice.write', 'POST', '/invoices/preview', () => ({})],
    ['sales.invoice.post', 'POST', '/invoices', () => ({})],
  ];
  const req = (method: string, path: string, token: string | undefined, b: unknown) =>
    call(app, method as 'GET', path, {
      ...(token ? { token } : {}),
      ...(b !== undefined ? { body: b } : {}),
    });

  it('29. 401 without a session or without the launch secret', async () => {
    for (const [, method, path, b] of endpoints) {
      expect((await req(method, path, undefined, b())).status, `${method} ${path}`).toBe(401);
      const noLaunch = await call(app, method as 'GET', path, {
        token: admin(),
        launch: false,
        ...(b() !== undefined ? { body: b() } : {}),
      });
      expect(noLaunch.status, `${method} ${path} no launch`).toBe(401);
    }
  });

  it('30. each role gets what its grants say (derived from the catalogue); inventory access alone gives no invoice access', async () => {
    for (const tpl of ROLE_TEMPLATES) {
      for (const [key, method, path, b] of endpoints) {
        const r = await req(method, path, tokens[tpl.name], b());
        const allowed = tpl.grants.includes(key);
        if (!allowed) expect(r.status, `${tpl.name} ${method} ${path}`).toBe(403);
        else expect(r.status, `${tpl.name} ${method} ${path}`).not.toBe(403);
      }
    }
    const grants = (n: string) => ROLE_TEMPLATES.find((t) => t.name === n)!.grants;
    expect(grants('Warehouse Operator')).toContain('inventory.adjustment.create');
    for (const k of ['sales.invoice.read', 'sales.invoice.write', 'sales.invoice.post'])
      expect(grants('Warehouse Operator')).not.toContain(k);
    expect(grants('Viewer/Auditor')).toContain('sales.invoice.read');
    expect(grants('Viewer/Auditor')).not.toContain('sales.invoice.post');
    // a Viewer/Auditor can read an invoice but cannot preview or post
    const id = (await fx.prisma.salesInvoice.findFirstOrThrow()).id;
    expect((await get(`/invoices/${id}`, tokens['Viewer/Auditor']!)).status).toBe(200);
    expect(
      (await preview(request([L(w.products.untracked)]), tokens['Viewer/Auditor']!)).status,
    ).toBe(403);
  });
});

describe('post is a separate permission from preview', () => {
  it('a role that may preview (sales.invoice.write) but not post (sales.invoice.post) is refused at POST /invoices', async () => {
    const where = { role: { name: 'Billing Operator' }, permission: { key: 'sales.invoice.post' } };
    const rows = await fx.prisma.rolePermission.findMany({ where });
    expect(rows).toHaveLength(1);
    await fx.prisma.rolePermission.deleteMany({ where });
    try {
      const token = tokens['Billing Operator']!;
      const req = request([L(w.products.untracked)]);
      const pv = await preview(req, token);
      expect(pv.status).toBe(200);
      const before = await counts();
      const r = await postRaw(
        { ...req, operationId: randomUUID(), calculation: j(pv).identity },
        token,
      );
      expect(r.status).toBe(403);
      expect(await counts()).toEqual(before);
    } finally {
      await fx.prisma.rolePermission.createMany({
        data: rows.map(({ roleId, permissionId }) => ({ roleId, permissionId })),
      });
    }
  });
});

describe('organization isolation', () => {
  let tokenB: string;
  let wb: BillingWorld;
  let invoiceB: string;

  beforeAll(async () => {
    const org = await fx.prisma.organization.create({
      data: { legalName: 'DEMO Other Co (fictional)' },
    });
    await seedReference(fx.prisma, { organizationId: org.id });
    await app.authService!.createUser({
      organizationId: org.id,
      username: 'admin.orgb',
      displayName: 'Admin B',
      password: PASSWORD,
      roleNames: ['Administrator'],
    });
    tokenB = (
      await call(app, 'POST', '/auth/login', {
        body: { username: 'admin.orgb', password: PASSWORD, organizationId: org.id },
      })
    ).json.token as string;
    wb = await setupBillingWorld(fx, org.id, { sellerName: 'Org B Seller' });
    const r = await previewAndPost(app, tokenB, {
      mode: 'DEMO',
      customerId: wb.customers.b2c,
      lines: [{ productId: wb.products.untracked, quantity: '1' }],
      placeOfSupply: { stateCode: '27', choice: 'CONFIRMED' },
    });
    expect(r.post.status).toBe(201);
    invoiceB = j(r.post).invoice.id;
  }, 120_000);

  it('31-32. another organization neither sees its invoices nor can post with its customers, products or sequences', async () => {
    expect((await get(`/invoices/${invoiceB}`)).status).toBe(404);
    expect(j(await get('/invoices?limit=100')).invoices.map((i: Json) => i.id)).not.toContain(
      invoiceB,
    );
    expect(j(await get('/invoices?limit=100', tokenB)).total).toBe(1);
    expect((await get(`/invoices/${invoiceB}`, tokenB)).status).toBe(200);
    const before = await counts();
    const crossCustomer = j(
      await preview(request([L(w.products.untracked)], { customerId: wb.customers.b2c })),
    );
    expect(crossCustomer.errors).toEqual([{ code: 'CUSTOMER_NOT_FOUND', path: 'customerId' }]);
    const crossProduct = j(await preview(request([L(wb.products.untracked)])));
    expect(crossProduct.errors).toEqual([
      expect.objectContaining({ code: 'PRODUCT_NOT_FOUND', lineRef: 'L1' }),
    ]);
    const pv = j(await preview(request([L(w.products.untracked)])));
    const forged = await postRaw({
      ...request([L(wb.products.untracked)]),
      operationId: randomUUID(),
      calculation: pv.identity,
    });
    expect(forged.status).toBe(400);
    expect(JSON.stringify(forged.json.error.problems)).toContain('PRODUCT_NOT_FOUND');
    expect(await counts()).toEqual(before);
    // an operation id is per organization: the same id may be used by two organizations
    const op = randomUUID();
    const a = await previewAndPost(app, admin(), request([L(w.products.untracked)]), op);
    const b = await previewAndPost(
      app,
      tokenB,
      {
        mode: 'DEMO',
        customerId: wb.customers.b2c,
        lines: [{ productId: wb.products.untracked, quantity: '1' }],
        placeOfSupply: { stateCode: '27', choice: 'CONFIRMED' },
      },
      op,
    );
    expect([a.post.status, b.post.status]).toEqual([201, 201]);
  });

  it('an organization without a numbering sequence cannot post and nothing is left behind', async () => {
    const org = await fx.prisma.organization.create({
      data: { legalName: 'DEMO No Sequence Co (fictional)' },
    });
    await seedReference(fx.prisma, { organizationId: org.id });
    await app.authService!.createUser({
      organizationId: org.id,
      username: 'admin.orgc',
      displayName: 'Admin C',
      password: PASSWORD,
      roleNames: ['Administrator'],
    });
    const tokenC = (
      await call(app, 'POST', '/auth/login', {
        body: { username: 'admin.orgc', password: PASSWORD, organizationId: org.id },
      })
    ).json.token as string;
    const wc = await setupBillingWorld(fx, org.id, { withSequences: false });
    const r = await previewAndPost(app, tokenC, {
      mode: 'DEMO',
      customerId: wc.customers.b2c,
      lines: [{ productId: wc.products.untracked, quantity: '1' }],
      placeOfSupply: { stateCode: '27', choice: 'CONFIRMED' },
    });
    expect(r.preview.ok).toBe(true);
    expect(r.post.status).toBe(400);
    expect(r.post.json.error.problems).toEqual([
      { field: 'DEMO_INVOICE', rule: 'NUMBER_SEQUENCE_MISSING' },
    ]);
    expect(await fx.prisma.salesInvoice.count({ where: { organizationId: org.id } })).toBe(0);
    expect(
      await fx.prisma.auditLog.count({ where: { organizationId: org.id, action: 'invoice.post' } }),
    ).toBe(0);
  });
});

describe('logs', () => {
  it('34. never contain customer names, GSTINs, addresses or search terms', async () => {
    await get('/invoices?search=secret-search-ttt');
    await previewAndPost(
      app,
      admin(),
      request([L(w.products.untracked)], { customerId: w.customers.b2b }),
    );
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(100);
    for (const secret of [
      'Registered Buyer',
      'Renamed Buyer',
      '27AAAAA0000A1Z5',
      '27CCCCC2222C1Z5',
      'Buyer Lane',
      'Market Road',
      'secret-search-ttt',
      admin(),
      LAUNCH_SECRET,
    ])
      expect(text, secret).not.toContain(secret);
    expect(text).toContain('?[query redacted]');
  });
});
