// Task 1.16: payments and receivables against the real Fastify API and a real, migrated PostgreSQL database. Fictional data only.
// Demo payments (separate records, separate numbers, demo invoices only) come first; then the organization is switched to
// PRODUCTION through the approved injected gate fact (AppDeps.backupRestoreVerified) and production payments are tested, including
// concurrency, idempotency and rollback by failure injection (temporary triggers in this isolated database, no production seam).
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
let w: BillingWorld;
let logs: string[];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (r: { json: ApiJson }) => r.json as unknown as Json;
const admin = () => tokens['Administrator']!;
const get = (path: string, token = admin()) => call(app, 'GET', path, { token });
const rawPay = (b: unknown, token = admin()) => call(app, 'POST', '/payments', { token, body: b });
const L = (productId: string, quantity = '1'): Line => ({ productId, quantity });

/** A posted invoice of 4 x 250.00 at 18% = 1,180.00 in the given mode. */
async function newInvoice(
  mode: 'DEMO' | 'PRODUCTION',
  customerId = w.customers.b2b,
  qty = '4',
  a: FastifyInstance = app,
  token = admin(),
  world = w,
) {
  const placeOfSupply =
    customerId === world.customers.interState
      ? { stateCode: '29', choice: 'CONFIRMED' }
      : customerId === world.customers.split
        ? { stateCode: '29', choice: 'OVERRIDE' }
        : { stateCode: '27', choice: 'CONFIRMED' };
  const r = await previewAndPost(
    a,
    token,
    body(world, { mode, customerId, placeOfSupply }, [L(world.products.untracked, qty)]),
  );
  expect(r.post.status, JSON.stringify(r.post.json)).toBe(201);
  return j(r.post).invoice as Json;
}
const payBody = (invoiceId: string, amount: string, over: Record<string, unknown> = {}) => ({
  mode: 'DEMO',
  invoiceId,
  amount,
  method: 'CASH',
  operationId: randomUUID(),
  ...over,
});
const q = async (sql: string) => (await fx.prisma.$queryRawUnsafe<Json[]>(sql))[0]!;
const state = async (invoiceId?: string) => ({
  payments: await fx.prisma.payment.count(),
  allocations: await fx.prisma.paymentAllocation.count(),
  ledger: await fx.prisma.documentNumberAllocation.count({
    where: { documentType: { in: ['PAYMENT_RECEIPT', 'DEMO_PAYMENT_RECEIPT'] } },
  }),
  receiptSeq: String(
    (
      await fx.prisma.documentSequence.findFirstOrThrow({
        where: { organizationId: fx.orgId, documentType: 'PAYMENT_RECEIPT' },
      })
    ).lastNumber,
  ),
  demoSeq: String(
    (
      await fx.prisma.documentSequence.findFirstOrThrow({
        where: { organizationId: fx.orgId, documentType: 'DEMO_PAYMENT_RECEIPT' },
      })
    ).lastNumber,
  ),
  audit: await fx.prisma.auditLog.count({ where: { action: 'payment.create' } }),
  balance: invoiceId
    ? (
        await q(
          `SELECT balance_due::text AS b FROM invoice_balances WHERE invoice_id = '${invoiceId}'`,
        )
      ).b
    : null,
});
const invoiceOf = async (id: string) => j(await get(`/invoices/${id}`)).invoice as Json;

async function injected<T>(
  fn: string,
  table: string,
  kind: 'BEFORE INSERT' | 'DEFERRED',
  whenSql: string,
  bodySql: string,
  run: () => Promise<T>,
): Promise<T> {
  await fx.prisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN ${bodySql} RETURN NEW; END $f$`,
  );
  const when = whenSql ? `WHEN (${whenSql})` : '';
  await fx.prisma.$executeRawUnsafe(
    kind === 'DEFERRED'
      ? `CREATE CONSTRAINT TRIGGER ${fn} AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW ${when} EXECUTE FUNCTION ${fn}()`
      : `CREATE TRIGGER ${fn} BEFORE INSERT ON ${table} FOR EACH ROW ${when} EXECUTE FUNCTION ${fn}()`,
  );
  try {
    return await run();
  } finally {
    await fx.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON ${table}`);
    await fx.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
}
const RAISE = "RAISE EXCEPTION 'injected failure';";

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  logs = [];
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    logStream: { write: (m: string) => void logs.push(m) },
    backupRestoreVerified: async () => true,
  });
  tokens = await createRoleUsers(app, fx.orgId);
  w = await setupBillingWorld(fx);
}, 240_000);
afterAll(async () => fx?.close());

describe('DEMO payments: separate records, never real money', () => {
  let demo: Json;
  it('records a partial DEMO payment: DEMO number, derived balance, receivable stays null, one audit row, production sequence untouched', async () => {
    demo = await newInvoice('DEMO');
    expect(demo.payment).toMatchObject({
      isDemo: true,
      grandTotal: '1180.00',
      allocated: '0.00',
      balanceDue: '1180.00',
      status: 'UNPAID',
    });
    const before = await state(demo.id);
    const r = await rawPay(payBody(demo.id, '500', { reference: 'receipt book 12' }));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const p = j(r).payment;
    expect(p).toMatchObject({
      documentType: 'DEMO_PAYMENT_RECEIPT',
      isDemo: true,
      amount: '500.00',
      method: 'CASH',
      paymentNumber: `DPAY/${w.financialYearLabel}/000001`,
      customer: { name: 'Registered Buyer Pvt Ltd' },
    });
    expect(p.allocations).toEqual([
      { invoiceId: demo.id, invoiceNumber: demo.documentNumber, amount: '500.00' },
    ]);
    expect(j(r).replayed).toBe(false);
    expect(j(r).invoice).toMatchObject({
      allocated: '500.00',
      balanceDue: '680.00',
      status: 'PARTIALLY_PAID',
      isDemo: true,
    });
    const after = await state(demo.id);
    expect(after).toMatchObject({
      payments: before.payments + 1,
      allocations: before.allocations + 1,
      ledger: before.ledger + 1,
      audit: before.audit + 1,
      receiptSeq: before.receiptSeq,
      balance: '680.00',
    });
    expect(after.demoSeq).toBe(String(Number(before.demoSeq) + 1));
    expect(j(await get(`/payments?invoiceId=${demo.id}`)).total).toBe(1); // the per-invoice history
    expect(j(await get(`/payments?invoiceId=${w.customers.b2c}`)).total).toBe(0);
    const inv = await invoiceOf(demo.id);
    expect(inv.receivable).toBeNull(); // a demo invoice never has a production receivable
    expect(inv.payment).toMatchObject({
      allocated: '500.00',
      balanceDue: '680.00',
      status: 'PARTIALLY_PAID',
    });
    const audit = await fx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'payment.create', entityId: p.id },
    });
    expect(audit.afterValues).toMatchObject({
      isDemo: true,
      amount: '500.00',
      method: 'CASH',
      operationId: expect.any(String),
      invoiceIds: [demo.id],
    });
    expect(JSON.stringify(audit.afterValues)).not.toContain('receipt book');
  });

  it('is excluded from production receivables and appears in the demo view only', async () => {
    const prod = j(await get('/receivables'));
    expect(prod).toMatchObject({
      isDemo: false,
      totals: { invoiced: '0.00', paid: '0.00', outstanding: '0.00' },
      total: 0,
    });
    const d = j(await get('/receivables?isDemo=true'));
    expect(d.customers).toEqual([
      expect.objectContaining({
        customerName: 'Registered Buyer Pvt Ltd',
        totalInvoiced: '1180.00',
        totalPaid: '500.00',
        outstanding: '680.00',
        invoiceCount: 1,
      }),
    ]);
    const cr = j(await get(`/receivables/customers/${w.customers.b2b}?isDemo=true`));
    expect(cr.totals).toEqual({ invoiced: '1180.00', paid: '500.00', outstanding: '680.00' });
    expect(cr.invoices).toEqual([
      expect.objectContaining({
        documentNumber: demo.documentNumber,
        paid: '500.00',
        balanceDue: '680.00',
        status: 'PARTIALLY_PAID',
      }),
    ]);
    expect(j(await get(`/receivables/customers/${w.customers.b2b}`)).invoices).toEqual([]); // the production view of the same customer
  });

  it('refuses more than the balance, then settles exactly, then refuses a payment on a fully paid invoice - leaving no trace', async () => {
    const before = await state(demo.id);
    const over = await rawPay(payBody(demo.id, '680.01'));
    expect(over.status).toBe(409);
    expect(over.json.error.problems).toEqual([{ field: 'amount', rule: 'AMOUNT_EXCEEDS_BALANCE' }]);
    expect(j(over).error.details).toEqual({ balanceDue: '680.00' });
    expect(await state(demo.id)).toEqual(before);
    const exact = await rawPay(
      payBody(demo.id, '680.00', { method: 'UPI', reference: 'UPI-REF-778899' }),
    );
    expect(exact.status).toBe(201);
    expect(j(exact).invoice).toMatchObject({
      allocated: '1180.00',
      balanceDue: '0.00',
      status: 'PAID',
    });
    const settled = await state(demo.id);
    const again = await rawPay(payBody(demo.id, '1.00'));
    expect(again.status).toBe(409);
    expect(again.json.error.problems).toEqual([{ field: 'invoiceId', rule: 'INVOICE_FULLY_PAID' }]);
    expect(await state(demo.id)).toEqual(settled);
    expect((await invoiceOf(demo.id)).payment.status).toBe('PAID');
  });

  it('keeps cents exact: 100.10 + 200.20 allocated is exactly 300.30', async () => {
    const inv = await newInvoice('DEMO', w.customers.b2c, '4');
    await rawPay(payBody(inv.id, '100.10'));
    const r = await rawPay(payBody(inv.id, '200.20'));
    expect(j(r).invoice).toMatchObject({
      allocated: '300.30',
      balanceDue: '879.70',
      status: 'PARTIALLY_PAID',
    });
    expect(
      (await q(`SELECT allocated::text AS a FROM invoice_balances WHERE invoice_id = '${inv.id}'`))
        .a,
    ).toBe('300.30');
  });

  it('a DEMO payment cannot touch a production-kind payment request and the modes must match the invoice', async () => {
    const inv = await newInvoice('DEMO', w.customers.b2c, '1');
    const before = await state(inv.id);
    const r = await rawPay(payBody(inv.id, '10', { mode: 'PRODUCTION' }));
    expect(r.status).toBe(409);
    expect(r.json.error.problems).toEqual([{ field: 'mode', rule: 'INVOICE_MODE_MISMATCH' }]);
    expect(await state(inv.id)).toEqual(before);
  });

  it('validates the request: amount, method, reference, card numbers, unknown fields, missing operation id', async () => {
    const inv = await newInvoice('DEMO', w.customers.b2c, '1');
    const before = await state(inv.id);
    const rules = async (over: Record<string, unknown>) =>
      (await rawPay({ ...payBody(inv.id, '10'), ...over })).json.error?.problems?.map(
        (p: Json) => `${p.field}:${p.rule}`,
      ) ?? ['(accepted)'];
    expect(await rules({ amount: '0' })).toEqual(['amount:amount_must_be_positive']);
    expect(await rules({ amount: '0.00' })).toEqual(['amount:amount_must_be_positive']);
    expect(await rules({ amount: '-5' })).toEqual(['amount:invalid_amount']);
    expect(await rules({ amount: '1.234' })).toEqual(['amount:too_many_decimals']);
    expect(await rules({ amount: 'ten' })).toEqual(['amount:invalid_amount']);
    expect(await rules({ amount: 10 })).toEqual(['amount:invalid_amount']);
    expect(await rules({ amount: '1e3' })).toEqual(['amount:invalid_amount']);
    expect(await rules({ method: 'BITCOIN' })).toEqual(['method:invalid_choice']);
    expect(await rules({ method: undefined })).toEqual(['method:required']);
    expect(await rules({ method: 'UPI' })).toEqual(['reference:required_for_method']);
    expect(await rules({ method: 'CHEQUE' })).toEqual(['reference:required_for_method']);
    expect(await rules({ method: 'BANK_TRANSFER', reference: '   ' })).toEqual([
      'reference:required_for_method',
    ]);
    expect(await rules({ method: 'CARD', reference: '4111 1111 1111 1111' })).toEqual([
      'reference:looks_like_card_number',
    ]);
    expect(await rules({ method: 'CARD', reference: '4111111111111111' })).toEqual([
      'reference:looks_like_card_number',
    ]);
    expect(await rules({ method: 'CARD', reference: 'x'.repeat(61) })).toEqual([
      'reference:too_long',
    ]);
    expect(await rules({ reference: 'a\u0000b' })).toEqual(['reference:invalid_characters']);
    expect(await rules({ notes: 'n'.repeat(501) })).toEqual(['notes:too_long']);
    expect(await rules({ operationId: undefined })).toEqual(['operationId:required']);
    expect(await rules({ mode: undefined })).toEqual(['mode:required']);
    expect(await rules({ invoiceId: 'nope' })).toEqual(['invoiceId:invalid_reference']);
    for (const field of [
      'balanceDue',
      'alreadyPaid',
      'remainingBalance',
      'customerId',
      'organizationId',
      'isDemo',
    ])
      expect(await rules({ [field]: '1' }), field).toEqual([`${field}:unknown_field`]);
    expect(await rules({ paymentDate: '2000-01-01' })).toEqual([
      'paymentDate:PAYMENT_DATE_NOT_TODAY',
    ]);
    expect(await rules({ paymentDate: '2999-01-01' })).toEqual([
      'paymentDate:PAYMENT_DATE_NOT_TODAY',
    ]);
    expect(await rules({ paymentDate: 'not a date' })).toEqual(['paymentDate:invalid_date']);
    // a 10-digit cheque number or a 12-digit UPI reference is fine (not Luhn-valid card numbers)
    expect(await rules({ method: 'CHEQUE', reference: '004512', amount: '1' })).toEqual([
      '(accepted)',
    ]);
    expect((await state(inv.id)).payments).toBe(before.payments + 1);
  });

  it('refuses an unknown invoice', async () => {
    const r = await rawPay(payBody(randomUUID(), '10'));
    expect(r.status).toBe(400);
    expect(r.json.error.problems).toEqual([{ field: 'invoiceId', rule: 'INVOICE_NOT_FOUND' }]);
  });
});

describe('switching to PRODUCTION (approved injected gate fact)', () => {
  it('records a review and switches the organization to PRODUCTION', async () => {
    const cfg = j(await get('/tax/configuration'));
    const review = await call(app, 'POST', '/tax/configuration/reviews', {
      token: admin(),
      body: {
        capacity: 'Accountant for the business',
        note: 'Fictional test review',
        acknowledged: true,
        noticeVersion: cfg.notice.version,
        expectedFingerprint: cfg.fingerprint,
      },
    });
    expect(review.status).toBe(201);
    expect(
      (
        await call(app, 'POST', '/tax/billing-mode', {
          token: admin(),
          body: { mode: 'PRODUCTION' },
        })
      ).status,
    ).toBe(200);
  });
});

describe('PRODUCTION payments', () => {
  it('full lifecycle: partial, partial, final settles, then refused; production numbers; real receivable', async () => {
    const inv = await newInvoice('PRODUCTION', w.customers.b2b, '40'); // 11,800.00
    expect(inv.grandTotal ?? inv.totals.grandTotal).toBe('11800.00');
    expect(inv.receivable).toEqual({ allocated: '0.00', balanceDue: '11800.00' });
    const pay = (amount: string, over: Record<string, unknown> = {}) =>
      rawPay(payBody(inv.id, amount, { mode: 'PRODUCTION', ...over }));
    const r1 = await pay('3000');
    expect(r1.status).toBe(201);
    expect(j(r1).payment).toMatchObject({
      documentType: 'PAYMENT_RECEIPT',
      isDemo: false,
      paymentNumber: `PAY/${w.financialYearLabel}/000001`,
    });
    expect(j(r1).invoice).toMatchObject({
      allocated: '3000.00',
      balanceDue: '8800.00',
      status: 'PARTIALLY_PAID',
      isDemo: false,
    });
    expect(
      j(await pay('5000', { method: 'BANK_TRANSFER', reference: 'NEFT-UTR-123' })).invoice
        .balanceDue,
    ).toBe('3800.00');
    expect((await invoiceOf(inv.id)).receivable).toEqual({
      allocated: '8000.00',
      balanceDue: '3800.00',
    });
    const over = await pay('3800.01');
    expect(over.status).toBe(409);
    const last = await pay('3800');
    expect(j(last).invoice).toMatchObject({
      allocated: '11800.00',
      balanceDue: '0.00',
      status: 'PAID',
    });
    expect((await pay('1')).json.error.problems).toEqual([
      { field: 'invoiceId', rule: 'INVOICE_FULLY_PAID' },
    ]);
    expect((await invoiceOf(inv.id)).receivable).toEqual({
      allocated: '11800.00',
      balanceDue: '0.00',
    });
    const list = j(await get('/invoices?isDemo=false&limit=100')).invoices.find(
      (i: Json) => i.id === inv.id,
    );
    expect(list.payment).toMatchObject({ status: 'PAID', balanceDue: '0.00' });
  });

  it('cross-mode: a production payment cannot touch a demo invoice, a demo payment cannot touch a production invoice', async () => {
    const prodInv = await newInvoice('PRODUCTION', w.customers.b2c, '4');
    const demoInv = await fx.prisma.salesInvoice.findFirstOrThrow({
      where: { isDemo: true, customerId: w.customers.b2c },
    });
    const a = await rawPay(payBody(prodInv.id, '10', { mode: 'DEMO' }));
    expect(a.json.error.problems).toEqual([{ field: 'mode', rule: 'INVOICE_MODE_MISMATCH' }]);
    const b = await rawPay(payBody(demoInv.id, '10', { mode: 'PRODUCTION' }));
    expect(b.json.error.problems).toEqual([{ field: 'mode', rule: 'INVOICE_MODE_MISMATCH' }]);
    // and the database refuses it too, even if the service were bypassed: a DEMO payment row cannot take an allocation against a
    // production invoice (nor the reverse), whatever the application does
    const before = await state(prodInv.id);
    const user = await fx.prisma.user.findFirstOrThrow({ where: { organizationId: fx.orgId } });
    const fy = await fx.prisma.financialYear.findFirstOrThrow({
      where: { organizationId: fx.orgId },
    });
    const paymentRow = (isDemo: boolean) => ({
      id: randomUUID(),
      organizationId: fx.orgId,
      customerId: prodInv.customer.id as string,
      documentType: isDemo ? 'DEMO_PAYMENT_RECEIPT' : 'PAYMENT_RECEIPT',
      paymentNumber: `X/${randomUUID().slice(0, 6)}`,
      isDemo,
      paymentDate: new Date(),
      amount: '10.00',
      method: 'CASH',
      financialYearId: fy.id,
      postOperationId: randomUUID(),
      requestFingerprint: 'a'.repeat(64),
      createdBy: user.id,
    });
    await expect(
      fx.prisma.$transaction(async (tx) => {
        const pay = await tx.payment.create({ data: paymentRow(true) });
        await tx.paymentAllocation.create({
          data: {
            organizationId: fx.orgId,
            paymentId: pay.id,
            invoiceId: prodInv.id,
            isDemo: true,
            amount: '10.00',
          },
        });
      }),
    ).rejects.toThrow(/demo payment can only be allocated to a demo invoice/);
    await expect(
      fx.prisma.$transaction(async (tx) => {
        const pay = await tx.payment.create({
          data: { ...paymentRow(false), customerId: demoInv.customerId },
        });
        await tx.paymentAllocation.create({
          data: {
            organizationId: fx.orgId,
            paymentId: pay.id,
            invoiceId: demoInv.id,
            isDemo: false,
            amount: '10.00',
          },
        });
      }),
    ).rejects.toThrow(/production payment to a production invoice/);
    expect(await state(prodInv.id)).toEqual(before);
  });

  it('production receivables count only production invoices and payments', async () => {
    const prod = j(await get('/receivables?limit=100'));
    expect(prod.isDemo).toBe(false);
    const b2b = prod.customers.find((c: Json) => c.customerName === 'Registered Buyer Pvt Ltd');
    expect(b2b).toMatchObject({
      totalInvoiced: '11800.00',
      totalPaid: '11800.00',
      outstanding: '0.00',
      invoiceCount: 1,
    });
    const demo = j(await get('/receivables?isDemo=true&limit=100'));
    expect(
      demo.customers.find((c: Json) => c.customerName === 'Registered Buyer Pvt Ltd').totalInvoiced,
    ).toBe('1180.00');
    const sum = (rows: Json[], k: string) =>
      rows.reduce((a, r) => a + BigInt(String(r[k]).replace('.', '')), 0n);
    expect(sum(prod.customers, 'totalInvoiced')).toBe(
      BigInt(prod.totals.invoiced.replace('.', '')),
    );
    expect(sum(prod.customers, 'outstanding')).toBe(
      BigInt(prod.totals.outstanding.replace('.', '')),
    );
  });

  it('concurrent over-allocation: 8,000 already paid of 10,000, two payments of 2,000 -> exactly one succeeds; final balance 0', async () => {
    // 10,000.00 exactly is not reachable with one 18% line; use the invoice total of 1,180 x 10 = 11,800 and pre-pay 9,800.
    const inv = await newInvoice('PRODUCTION', w.customers.interState, '40');
    const pay = (amount: string) => rawPay(payBody(inv.id, amount, { mode: 'PRODUCTION' }));
    expect((await pay('9800')).status).toBe(201);
    const before = await state(inv.id);
    expect(before.balance).toBe('2000.00');
    const [a, b] = await Promise.all([pay('2000'), pay('2000')]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json.error.problems![0]!.rule).toBe('INVOICE_FULLY_PAID'); // the second saw the first's committed allocation
    const after = await state(inv.id);
    expect(after).toMatchObject({
      payments: before.payments + 1,
      allocations: before.allocations + 1,
      ledger: before.ledger + 1,
      audit: before.audit + 1,
      balance: '0.00',
    });
    expect(after.receiptSeq).toBe(String(Number(before.receiptSeq) + 1)); // no number consumed by the loser: no gap
    expect(
      (await q(`SELECT allocated::text AS a FROM invoice_balances WHERE invoice_id = '${inv.id}'`))
        .a,
    ).toBe('11800.00');
  });

  it('many simultaneous payments never over-allocate (8 x 500 against a 2,000 balance -> exactly four succeed)', async () => {
    const inv = await newInvoice('PRODUCTION', w.customers.split, '40');
    expect((await rawPay(payBody(inv.id, '9800', { mode: 'PRODUCTION' }))).status).toBe(201);
    const rs = await Promise.all(
      Array.from({ length: 8 }, () => rawPay(payBody(inv.id, '500', { mode: 'PRODUCTION' }))),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(4);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(4);
    expect((await state(inv.id)).balance).toBe('0.00');
  });

  it('idempotency: a retry returns the same payment with no new rows or audit; different content under the same operation id is refused', async () => {
    const inv = await newInvoice('PRODUCTION', w.customers.b2b, '40');
    const b = payBody(inv.id, '5000', { mode: 'PRODUCTION', method: 'UPI', reference: 'UPI-9' });
    const first = await rawPay(b);
    expect(first.status).toBe(201);
    const before = await state(inv.id);
    const retry = await rawPay(b);
    expect(retry.status).toBe(200);
    expect(j(retry).replayed).toBe(true);
    expect(j(retry).payment.id).toBe(j(first).payment.id);
    expect(j(retry).payment.paymentNumber).toBe(j(first).payment.paymentNumber);
    expect(await state(inv.id)).toEqual(before);
    for (const changed of [
      { amount: '5001' },
      { method: 'CASH' },
      { reference: 'UPI-10' },
      { notes: 'changed' },
    ]) {
      const r = await rawPay({ ...b, ...changed });
      expect(r.status, JSON.stringify(changed)).toBe(409);
      expect(r.json.error.problems).toEqual([
        { field: 'operationId', rule: 'OPERATION_ID_REUSED' },
      ]);
    }
    expect(await state(inv.id)).toEqual(before);
    // ten simultaneous retries of a new operation create exactly one payment
    const c = payBody(inv.id, '100', { mode: 'PRODUCTION' });
    const mid = await state(inv.id);
    const rs = await Promise.all(Array.from({ length: 10 }, () => rawPay(c)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(9);
    expect(new Set(rs.map((r) => j(r).payment.paymentNumber)).size).toBe(1);
    const end = await state(inv.id);
    expect(end).toMatchObject({
      payments: mid.payments + 1,
      allocations: mid.allocations + 1,
      audit: mid.audit + 1,
    });
    // the replay still works after the invoice is settled
    const settle = await rawPay(payBody(inv.id, '6700', { mode: 'PRODUCTION' }));
    expect(settle.status).toBe(201);
    expect((await rawPay(c)).status).toBe(200);
  });
});

describe('all-or-nothing: an injected failure at each step leaves nothing behind', () => {
  const setup = async () => {
    const inv = await newInvoice('PRODUCTION', w.customers.b2b, '4');
    return { inv, run: () => rawPay(payBody(inv.id, '100', { mode: 'PRODUCTION' })) };
  };
  const expectUntouched = async (invoiceId: string, before: Awaited<ReturnType<typeof state>>) => {
    expect(await state(invoiceId)).toEqual(before);
  };

  it('A. the payment insert fails after the number was allocated: the number is not consumed (no gap)', async () => {
    const { inv, run } = await setup();
    const before = await state(inv.id);
    const r = await injected('a_fail_pay', 'payments', 'BEFORE INSERT', '', RAISE, run);
    expect(r.status).toBeGreaterThanOrEqual(500);
    await expectUntouched(inv.id, before);
    const ok = await run();
    expect(ok.status).toBe(201);
    expect(j(ok).payment.paymentNumber).toBe(
      `PAY/${w.financialYearLabel}/${String(Number(before.receiptSeq) + 1).padStart(6, '0')}`,
    );
  });

  it('B. the allocation insert fails after the payment insert: the payment is rolled back too', async () => {
    const { inv, run } = await setup();
    const before = await state(inv.id);
    const r = await injected(
      'a_fail_alloc',
      'payment_allocations',
      'BEFORE INSERT',
      '',
      RAISE,
      run,
    );
    expect(r.status).toBeGreaterThanOrEqual(500);
    await expectUntouched(inv.id, before);
  });

  it('C. the audit insert fails: payment, allocation and number are rolled back', async () => {
    const { inv, run } = await setup();
    const before = await state(inv.id);
    const r = await injected(
      'a_fail_audit',
      'audit_logs',
      'BEFORE INSERT',
      "NEW.action = 'payment.create'",
      RAISE,
      run,
    );
    expect(r.status).toBeGreaterThanOrEqual(500);
    await expectUntouched(inv.id, before);
  });

  it('D. a deferred constraint fails at COMMIT: everything is rolled back', async () => {
    const { inv, run } = await setup();
    const before = await state(inv.id);
    const r = await injected('a_fail_commit', 'payments', 'DEFERRED', '', RAISE, run);
    expect(r.status).toBeGreaterThanOrEqual(500);
    await expectUntouched(inv.id, before);
  });

  it('database invariants: a fabricated number, a part-allocated payment and an over-allocation are each refused at COMMIT', async () => {
    const { inv, run } = await setup();
    const before = await state(inv.id);
    const fake = await injected(
      'a_fake_no',
      'payments',
      'BEFORE INSERT',
      '',
      "NEW.payment_number := 'FAKE/1';",
      run,
    );
    expect(fake.status).toBeGreaterThanOrEqual(500);
    const partial = await injected(
      'a_partial',
      'payment_allocations',
      'BEFORE INSERT',
      '',
      'NEW.amount := NEW.amount - 0.01;',
      run,
    );
    expect(partial.status).toBeGreaterThanOrEqual(500);
    // both rows are inflated beyond the balance (the service's own check passed): the over-allocation limit still refuses it
    const over = await injected(
      'a_over_pay',
      'payments',
      'BEFORE INSERT',
      '',
      'NEW.amount := NEW.amount + 100000;',
      () =>
        injected(
          'a_over_alloc',
          'payment_allocations',
          'BEFORE INSERT',
          '',
          'NEW.amount := NEW.amount + 100000;',
          run,
        ),
    );
    expect(over.status).toBeGreaterThanOrEqual(500);
    await expectUntouched(inv.id, before);
  });
});

describe('payments are immutable', () => {
  it('26-29. no UPDATE, DELETE or TRUNCATE of a payment or an allocation succeeds, even directly in the database; no route edits or deletes', async () => {
    const pay = await fx.prisma.payment.findFirstOrThrow({ include: { allocations: true } });
    const alloc = pay.allocations[0]!;
    await expect(
      fx.prisma.$executeRaw`UPDATE payments SET amount = 1 WHERE id = ${pay.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma.$executeRaw`UPDATE payments SET method = 'CASH' WHERE id = ${pay.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma.$executeRaw`UPDATE payments SET is_demo = NOT is_demo WHERE id = ${pay.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma.$executeRaw`DELETE FROM payments WHERE id = ${pay.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma.$executeRaw`UPDATE payment_allocations SET amount = 1 WHERE id = ${alloc.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      fx.prisma.$executeRaw`DELETE FROM payment_allocations WHERE id = ${alloc.id}::uuid`,
    ).rejects.toThrow();
    await expect(fx.prisma.$executeRaw`TRUNCATE payments`).rejects.toThrow();
    await expect(fx.prisma.$executeRaw`TRUNCATE payment_allocations`).rejects.toThrow();
    await expect(
      fx.prisma.payment.update({ where: { id: pay.id }, data: { amount: '1' } }),
    ).rejects.toThrow();
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const r = await app.inject({
        method,
        url: `/payments/${pay.id}`,
        headers: {
          'x-commercebill-launch-secret': LAUNCH_SECRET,
          authorization: `Bearer ${admin()}`,
        },
        payload: method === 'DELETE' ? undefined : {},
      });
      expect([404, 405], method).toContain(r.statusCode);
    }
    expect(
      (await fx.prisma.payment.findUniqueOrThrow({ where: { id: pay.id } })).amount.toFixed(2),
    ).toBe(pay.amount.toFixed(2));
  });

  it('an allocation cannot be added later to an earlier payment, nor a payment mixed across customers', async () => {
    const pay = await fx.prisma.payment.findFirstOrThrow({ where: { isDemo: false } });
    const other = await fx.prisma.salesInvoice.findFirstOrThrow({
      where: { isDemo: false, customerId: { not: pay.customerId } },
    });
    await expect(
      fx.prisma.paymentAllocation.create({
        data: {
          organizationId: fx.orgId,
          paymentId: pay.id,
          invoiceId: other.id,
          isDemo: false,
          amount: '1.00',
        },
      }),
    ).rejects.toThrow();
  });
});

describe('authentication, authorization and organization isolation', () => {
  const endpoints: [string, string, string, () => unknown][] = [
    ['sales.payment.read', 'GET', '/payments', () => undefined],
    ['sales.payment.read', 'GET', `/payments/${randomUUID()}`, () => undefined],
    ['sales.payment.read', 'GET', '/receivables', () => undefined],
    ['sales.payment.read', 'GET', `/receivables/customers/${randomUUID()}`, () => undefined],
    ['sales.payment.record', 'POST', '/payments', () => ({})],
  ];
  const req = (method: string, path: string, token: string | undefined, b: unknown) =>
    call(app, method as 'GET', path, {
      ...(token ? { token } : {}),
      ...(b !== undefined ? { body: b } : {}),
    });

  it('18. 401 without a session or without the launch secret', async () => {
    for (const [, method, path, b] of endpoints) {
      expect((await req(method, path, undefined, b())).status, `${method} ${path}`).toBe(401);
      expect(
        (
          await call(app, method as 'GET', path, {
            token: admin(),
            launch: false,
            ...(b() !== undefined ? { body: b() } : {}),
          })
        ).status,
      ).toBe(401);
    }
  });

  it('17,19,20. each role gets exactly what the catalogue grants; inventory access gives no payment access', async () => {
    for (const tpl of ROLE_TEMPLATES)
      for (const [key, method, path, b] of endpoints) {
        const r = await req(method, path, tokens[tpl.name], b());
        if (!tpl.grants.includes(key)) expect(r.status, `${tpl.name} ${method} ${path}`).toBe(403);
        else expect(r.status, `${tpl.name} ${method} ${path}`).not.toBe(403);
      }
    const grants = (n: string) => ROLE_TEMPLATES.find((t) => t.name === n)!.grants;
    expect(grants('Warehouse Operator').filter((k) => k.startsWith('sales.payment'))).toEqual([]);
    expect(grants('Viewer/Auditor')).toContain('sales.payment.read');
    expect(grants('Viewer/Auditor')).not.toContain('sales.payment.record');
    const inv = await fx.prisma.salesInvoice.findFirstOrThrow({ where: { isDemo: false } });
    const denied = await rawPay(
      payBody(inv.id, '1', { mode: 'PRODUCTION' }),
      tokens['Viewer/Auditor']!,
    );
    expect(denied.status).toBe(403);
    expect((await get('/payments', tokens['Viewer/Auditor']!)).status).toBe(200);
  });

  it('13-16. another organization cannot see, allocate to, or query this organization', async () => {
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
    const tokenB = (
      await call(app, 'POST', '/auth/login', {
        body: { username: 'admin.orgb', password: PASSWORD, organizationId: org.id },
      })
    ).json.token as string;
    const wb = await setupBillingWorld(fx, org.id, { sellerName: 'Org B Seller' });
    const pay = await fx.prisma.payment.findFirstOrThrow({ where: { isDemo: false } });
    expect((await get(`/payments/${pay.id}`, tokenB)).status).toBe(404);
    expect(j(await get('/payments?limit=100', tokenB)).total).toBe(0);
    expect(j(await get('/receivables', tokenB)).total).toBe(0);
    expect((await get(`/receivables/customers/${w.customers.b2b}`, tokenB)).status).toBe(404);
    // a payment against another organization's invoice is "not found", and nothing is written
    const before = await state();
    const foreign = await fx.prisma.salesInvoice.findFirstOrThrow({ where: { isDemo: false } });
    const r = await rawPay(payBody(foreign.id, '1', { mode: 'PRODUCTION' }), tokenB);
    expect(r.status).toBe(400);
    expect(r.json.error.problems).toEqual([{ field: 'invoiceId', rule: 'INVOICE_NOT_FOUND' }]);
    expect(await state()).toEqual(before);
    // the database refuses a cross-organization payment even if the service were bypassed (customer of another organization)
    await expect(
      fx.prisma.payment.create({
        data: {
          organizationId: org.id,
          customerId: w.customers.b2b,
          documentType: 'DEMO_PAYMENT_RECEIPT',
          paymentNumber: 'X/1',
          isDemo: true,
          paymentDate: new Date(),
          amount: '1.00',
          method: 'CASH',
          financialYearId: wb.financialYearId,
          postOperationId: randomUUID(),
          requestFingerprint: 'a'.repeat(64),
          createdBy: (await fx.prisma.user.findFirstOrThrow({ where: { organizationId: org.id } }))
            .id,
        },
      }),
    ).rejects.toThrow();
    // its own payments are its own: organization B can pay its own demo invoice; this organization never sees that payment
    const own = await newInvoice('DEMO', wb.customers.b2c, '1', app, tokenB, wb);
    const mine = await rawPay(payBody(own.id, '10'), tokenB);
    expect(mine.status, JSON.stringify(mine.json)).toBe(201);
    expect(j(await get('/payments?limit=100', tokenB)).total).toBe(1);
    expect(await fx.prisma.payment.count({ where: { organizationId: fx.orgId } })).toBe(
      before.payments,
    );
  });
});

describe('reading, reopening and logs', () => {
  it('35-37. the customer view, invoice detail and list agree, and survive a reopened application', async () => {
    const reopened = await fx.makeApp({
      env: { LOG_LEVEL: 'silent' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    });
    const token = (
      await call(reopened, 'POST', '/auth/login', {
        body: { username: 'admin.user', password: PASSWORD, organizationId: fx.orgId },
      })
    ).json.token as string;
    const a = j(await get('/receivables?limit=100'));
    const b = j(await call(reopened, 'GET', '/receivables?limit=100', { token }));
    expect(b).toEqual(a);
    for (const c of a.customers) {
      const cr = j(
        await call(reopened, 'GET', `/receivables/customers/${c.customerId}`, { token }),
      );
      expect(cr.totals).toEqual({
        invoiced: c.totalInvoiced,
        paid: c.totalPaid,
        outstanding: c.outstanding,
      });
      for (const row of cr.invoices) {
        const inv = j(await call(reopened, 'GET', `/invoices/${row.invoiceId}`, { token })).invoice;
        expect(inv.payment).toMatchObject({
          grandTotal: row.grandTotal,
          allocated: row.paid,
          balanceDue: row.balanceDue,
          status: row.status,
        });
      }
    }
    const list = j(await get('/payments?limit=100'));
    expect(list.total).toBeGreaterThan(10);
    expect(list.payments.every((p: Json) => p.allocations.length === 1)).toBe(true);
    expect(j(await get('/payments?isDemo=true')).payments.every((p: Json) => p.isDemo)).toBe(true);
    expect(
      j(await get('/payments?method=UPI')).payments.every((p: Json) => p.method === 'UPI'),
    ).toBe(true);
    expect(j(await get('/payments?search=%25')).total).toBe(0);
    expect(j(await get('/payments?search=DPAY')).payments.every((p: Json) => p.isDemo)).toBe(true);
    expect((await get('/payments?limit=1000')).status).toBe(400);
  });

  it('21-22. exactly one audit row per payment, and neither the audit nor the logs carry references, notes or credentials', async () => {
    expect(await fx.prisma.auditLog.count({ where: { action: 'payment.create' } })).toBe(
      await fx.prisma.payment.count(),
    );
    const audits = JSON.stringify(
      await fx.prisma.auditLog.findMany({ where: { action: 'payment.create' } }),
    );
    for (const secret of [
      'UPI-REF-778899',
      'NEFT-UTR-123',
      'receipt book',
      'changed',
      '4111111111111111',
    ])
      expect(audits, secret).not.toContain(secret);
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(1000);
    for (const secret of [
      'UPI-REF-778899',
      'NEFT-UTR-123',
      'receipt book',
      '4111111111111111',
      'Registered Buyer',
      admin(),
      LAUNCH_SECRET,
    ])
      expect(text, secret).not.toContain(secret);
  });
});
