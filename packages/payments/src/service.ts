import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@commercebill/database';
import { businessDate, paymentSummaries } from '@commercebill/invoicing';
import { NumberingError, type createNumberingService } from '@commercebill/numbering';
import type {
  CustomerReceivableResponse,
  PaymentDisplayStatus,
  PaymentListResponse,
  PaymentMethod,
  PaymentRecordResponse,
  PaymentView,
  ReceivablesResponse,
} from '@commercebill/shared-types';
import { paymentFingerprint } from './fingerprint.js';
import { validateRecordRequest, type Problem } from './validate.js';

export type PaymentErrorCode =
  'validation_failed' | 'not_found' | 'operation_id_reused' | 'balance_conflict' | 'mode_mismatch';

export interface PaymentProblem {
  code: string;
  path?: string;
}

export class PaymentError extends Error {
  constructor(
    readonly code: PaymentErrorCode,
    message: string,
    readonly problems: PaymentProblem[] = [],
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/** The authenticated caller. The organization ALWAYS comes from the session, never from a request. */
export interface PaymentContext {
  userId: string;
  organizationId: string;
  correlationId?: string | null;
}

export interface PaymentServiceOptions {
  prisma: PrismaClient;
  numbering: ReturnType<typeof createNumberingService>;
  appVersion?: string;
  clock?: () => Date;
}

const viewInclude = {
  customer: { select: { id: true, code: true, legalName: true, displayName: true } },
  allocations: { include: { invoice: { select: { documentNumber: true } } } },
  creator: { select: { displayName: true } },
} as const;
type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof viewInclude }>;

const day = (d: Date) => d.toISOString().slice(0, 10);
const money = (d: { toFixed(dp: number): string }) => d.toFixed(2);
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function toPaymentView(r: PaymentRow): PaymentView {
  return {
    id: r.id,
    paymentNumber: r.paymentNumber,
    documentType: r.documentType as PaymentView['documentType'],
    isDemo: r.isDemo,
    paymentDate: day(r.paymentDate),
    amount: money(r.amount),
    method: r.method as PaymentMethod,
    reference: r.reference,
    notes: r.notes,
    customer: {
      id: r.customer.id,
      code: r.customer.code,
      name: r.customer.displayName ?? r.customer.legalName,
    },
    allocations: r.allocations.map((a) => ({
      invoiceId: a.invoiceId,
      invoiceNumber: a.invoice.documentNumber,
      amount: money(a.amount),
    })),
    createdAt: r.createdAt.toISOString(),
    createdByName: r.creator.displayName,
  };
}

const toProblem = (p: Problem): PaymentProblem => ({ code: p.rule, path: p.field });

interface LockedInvoice {
  id: string;
  customer_id: string;
  is_demo: boolean;
  document_number: string;
  balance_due: string;
  exceeds: boolean;
}

export function createPaymentService(options: PaymentServiceOptions) {
  const { prisma, numbering } = options;
  const appVersion = options.appVersion ?? '0.0.0';
  const clock = options.clock ?? (() => new Date());

  async function recordedInvoice(
    tx: Prisma.TransactionClient,
    ctx: PaymentContext,
    row: PaymentRow,
  ) {
    const invoiceId = row.allocations[0]!.invoiceId;
    const sums = await paymentSummaries(tx, ctx.organizationId, [invoiceId]);
    return {
      id: invoiceId,
      documentNumber: row.allocations[0]!.invoice.documentNumber,
      ...sums.get(invoiceId)!,
    };
  }

  /**
   * Records one payment against one invoice in ONE transaction: lock the invoice, check its balance (derived from the persisted
   * allocations), take the number, write the payment, its allocation and the audit row. Deferred database constraints re-check the
   * number, the full allocation and the over-allocation limit at COMMIT. Any failure leaves nothing behind.
   */
  async function record(
    ctx: PaymentContext,
    raw: Record<string, unknown>,
  ): Promise<PaymentRecordResponse> {
    const v = validateRecordRequest(raw);
    if (!v.ok)
      throw new PaymentError(
        'validation_failed',
        'The payment details are not valid.',
        v.problems.map(toProblem),
      );
    const request = v.value;
    const fingerprint = paymentFingerprint(request);

    return prisma.$transaction(async (tx) => {
      // Idempotency: one successful recording per (organization, operation id). Concurrent retries wait here for the first.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment_post:${ctx.organizationId}:${request.operationId}`}, 0))`;
      const existing = await tx.payment.findUnique({
        where: {
          organizationId_postOperationId: {
            organizationId: ctx.organizationId,
            postOperationId: request.operationId,
          },
        },
        include: viewInclude,
      });
      if (existing) {
        if (existing.requestFingerprint !== fingerprint)
          throw new PaymentError(
            'operation_id_reused',
            'This operation id was already used for a different payment.',
            [{ code: 'OPERATION_ID_REUSED', path: 'operationId' }],
          );
        return {
          payment: toPaymentView(existing),
          replayed: true,
          invoice: await recordedInvoice(tx, ctx, existing),
        };
      }

      // The invoice row is locked FIRST, in a statement of its own. The balance is then read by a second statement: under READ
      // COMMITTED a statement that waited for the lock still uses its original snapshot, so computing the balance in the locking
      // statement would miss an allocation committed while it waited. Two payments for one invoice are serialized here.
      await tx.$queryRaw`SELECT i."id" FROM "sales_invoices" i
         WHERE i."id" = ${request.invoiceId}::uuid AND i."organization_id" = ${ctx.organizationId}::uuid
           FOR NO KEY UPDATE OF i`;
      const locked = await tx.$queryRaw<LockedInvoice[]>`
        SELECT i."id", i."customer_id", i."is_demo", i."document_number",
               (i."grand_total" - COALESCE((SELECT sum(a."amount") FROM "payment_allocations" a WHERE a."invoice_id" = i."id"), 0))::numeric(18,2)::text AS "balance_due",
               (${request.amount}::numeric > i."grand_total" - COALESCE((SELECT sum(a."amount") FROM "payment_allocations" a WHERE a."invoice_id" = i."id"), 0)) AS "exceeds"
          FROM "sales_invoices" i
         WHERE i."id" = ${request.invoiceId}::uuid AND i."organization_id" = ${ctx.organizationId}::uuid`;
      const inv = locked[0];
      if (!inv)
        throw new PaymentError('validation_failed', 'The invoice was not found.', [
          { code: 'INVOICE_NOT_FOUND', path: 'invoiceId' },
        ]);
      if ((request.mode === 'DEMO') !== inv.is_demo)
        throw new PaymentError('mode_mismatch', 'The payment mode does not match the invoice.', [
          { code: 'INVOICE_MODE_MISMATCH', path: 'mode' },
        ]);

      const today = businessDate(clock());
      if (request.paymentDate !== null && request.paymentDate !== today)
        throw new PaymentError('validation_failed', 'Payments can only be dated today.', [
          { code: 'PAYMENT_DATE_NOT_TODAY', path: 'paymentDate' },
        ]);
      const fy = await tx.financialYear.findFirst({
        where: {
          organizationId: ctx.organizationId,
          startDate: { lte: new Date(`${today}T00:00:00Z`) },
          endDate: { gte: new Date(`${today}T00:00:00Z`) },
          isLocked: false,
        },
      });
      if (!fy)
        throw new PaymentError('validation_failed', 'There is no open financial year.', [
          { code: 'NO_OPEN_FINANCIAL_YEAR' },
        ]);

      if (/^0+(\.0+)?$/.test(inv.balance_due))
        throw new PaymentError(
          'balance_conflict',
          'The invoice is already fully paid.',
          [{ code: 'INVOICE_FULLY_PAID', path: 'invoiceId' }],
          { balanceDue: inv.balance_due },
        );
      if (inv.exceeds)
        throw new PaymentError(
          'balance_conflict',
          'The amount is more than the balance due.',
          [{ code: 'AMOUNT_EXCEEDS_BALANCE', path: 'amount' }],
          { balanceDue: inv.balance_due },
        );

      // The payment number, from the existing numbering ledger in this same transaction (a rollback leaves no gap).
      const documentType = inv.is_demo ? 'DEMO_PAYMENT_RECEIPT' : 'PAYMENT_RECEIPT';
      const setting = await tx.organizationSetting.findFirst({
        where: { organizationId: ctx.organizationId, key: 'numbering' },
      });
      const byLocation =
        (setting?.value as { scopeByLocation?: boolean } | null)?.scopeByLocation === true;
      const location = byLocation
        ? await tx.businessLocation.findFirst({
            where: { organizationId: ctx.organizationId, isPrimary: true },
          })
        : null;
      const paymentId = randomUUID();
      let number: string;
      try {
        const allocated = await numbering.allocate(
          tx,
          {
            organizationId: ctx.organizationId,
            documentType,
            financialYearId: fy.id,
            ...(location ? { locationId: location.id } : {}),
          },
          { documentRef: paymentId, correlationId: ctx.correlationId ?? null },
        );
        number = allocated.number;
      } catch (err) {
        if (err instanceof NumberingError && err.code === 'sequence_not_found')
          throw new PaymentError(
            'validation_failed',
            'No numbering sequence is configured for this document.',
            [{ code: 'NUMBER_SEQUENCE_MISSING', path: documentType }],
          );
        throw err;
      }

      await tx.payment.create({
        data: {
          id: paymentId,
          organizationId: ctx.organizationId,
          customerId: inv.customer_id,
          documentType,
          paymentNumber: number,
          isDemo: inv.is_demo,
          paymentDate: new Date(`${today}T00:00:00Z`),
          amount: request.amount,
          method: request.method,
          reference: request.reference,
          notes: request.notes,
          financialYearId: fy.id,
          postOperationId: request.operationId,
          requestFingerprint: fingerprint,
          createdBy: ctx.userId,
          correlationId: ctx.correlationId ?? null,
        },
      });
      const allocation = await tx.paymentAllocation.create({
        data: {
          organizationId: ctx.organizationId,
          paymentId,
          invoiceId: inv.id,
          isDemo: inv.is_demo,
          amount: request.amount,
        },
      });

      // One audit event (facts only: no reference, notes or any credential).
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          category: 'business',
          action: 'payment.create',
          entityType: 'payment',
          entityId: paymentId,
          afterValues: {
            paymentNumber: number,
            documentType,
            isDemo: inv.is_demo,
            customerId: inv.customer_id,
            amount: request.amount,
            method: request.method,
            invoiceIds: [inv.id],
            allocationIds: [allocation.id],
            operationId: request.operationId,
          },
          appVersion,
          correlationId: ctx.correlationId ?? null,
          occurredAt: clock(),
        },
      });

      const created = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: viewInclude,
      });
      return {
        payment: toPaymentView(created),
        replayed: false,
        invoice: await recordedInvoice(tx, ctx, created),
      };
    });
  }

  async function list(
    organizationId: string,
    o: {
      search?: string | undefined;
      method?: PaymentMethod | undefined;
      isDemo?: boolean | undefined;
      from?: string | undefined;
      to?: string | undefined;
      invoiceId?: string | undefined;
      customerId?: string | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<PaymentListResponse> {
    const term = o.search?.trim() ? escapeLike(o.search.trim()) : undefined;
    const where: Prisma.PaymentWhereInput = {
      organizationId,
      ...(o.method ? { method: o.method } : {}),
      ...(o.isDemo === undefined ? {} : { isDemo: o.isDemo }),
      ...(o.invoiceId ? { allocations: { some: { invoiceId: o.invoiceId } } } : {}),
      ...(o.customerId ? { customerId: o.customerId } : {}),
      ...(o.from || o.to
        ? {
            paymentDate: {
              ...(o.from ? { gte: new Date(`${o.from}T00:00:00Z`) } : {}),
              ...(o.to ? { lte: new Date(`${o.to}T00:00:00Z`) } : {}),
            },
          }
        : {}),
      ...(term
        ? {
            OR: [
              { paymentNumber: { contains: term, mode: 'insensitive' } },
              { reference: { contains: term, mode: 'insensitive' } },
              { customer: { legalName: { contains: term, mode: 'insensitive' } } },
              { customer: { displayName: { contains: term, mode: 'insensitive' } } },
              { customer: { code: { contains: term, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: viewInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: o.limit,
        skip: o.offset,
      }),
      prisma.payment.count({ where }),
    ]);
    return { payments: rows.map(toPaymentView), total, limit: o.limit, offset: o.offset };
  }

  async function get(organizationId: string, id: string): Promise<PaymentView> {
    const row = await prisma.payment.findFirst({
      where: { id, organizationId },
      include: viewInclude,
    });
    if (!row) throw new PaymentError('not_found', 'Payment not found.');
    return toPaymentView(row);
  }

  const statusOf = (paid: string, due: string): PaymentDisplayStatus =>
    /^0+(\.0+)?$/.test(paid) ? 'UNPAID' : /^0+(\.0+)?$/.test(due) ? 'PAID' : 'PARTIALLY_PAID';

  /** Outstanding per customer, for DEMO or production invoices (never mixed): derived from invoice grand totals and allocations. */
  async function receivables(
    organizationId: string,
    o: { isDemo: boolean; search?: string | undefined; limit: number; offset: number },
  ): Promise<ReceivablesResponse> {
    const like = o.search?.trim() ? `%${escapeLike(o.search.trim())}%` : null;
    const rows = await prisma.$queryRaw<
      {
        id: string;
        code: string;
        name: string;
        invoice_count: bigint;
        invoiced: string;
        paid: string;
        outstanding: string;
      }[]
    >`SELECT c."id", c."code", COALESCE(c."display_name", c."legal_name") AS "name", count(*) AS "invoice_count",
             sum(b."grand_total")::numeric(18,2)::text AS "invoiced", sum(b."allocated")::numeric(18,2)::text AS "paid",
             sum(b."balance_due")::numeric(18,2)::text AS "outstanding"
        FROM "invoice_balances" b JOIN "customers" c ON c."id" = b."customer_id"
       WHERE b."organization_id" = ${organizationId}::uuid AND b."is_demo" = ${o.isDemo}
         AND (${like}::text IS NULL OR c."legal_name" ILIKE ${like} OR c."display_name" ILIKE ${like} OR c."code" ILIKE ${like})
       GROUP BY c."id"
       ORDER BY sum(b."balance_due") DESC, c."code"
       LIMIT ${o.limit} OFFSET ${o.offset}`;
    const agg = await prisma.$queryRaw<
      { n: bigint; invoiced: string | null; paid: string | null; outstanding: string | null }[]
    >`
      SELECT count(DISTINCT b."customer_id") AS "n", sum(b."grand_total")::numeric(18,2)::text AS "invoiced",
             sum(b."allocated")::numeric(18,2)::text AS "paid", sum(b."balance_due")::numeric(18,2)::text AS "outstanding"
        FROM "invoice_balances" b JOIN "customers" c ON c."id" = b."customer_id"
       WHERE b."organization_id" = ${organizationId}::uuid AND b."is_demo" = ${o.isDemo}
         AND (${like}::text IS NULL OR c."legal_name" ILIKE ${like} OR c."display_name" ILIKE ${like} OR c."code" ILIKE ${like})`;
    const a = agg[0]!;
    return {
      isDemo: o.isDemo,
      customers: rows.map((r) => ({
        customerId: r.id,
        customerCode: r.code,
        customerName: r.name,
        invoiceCount: Number(r.invoice_count),
        totalInvoiced: r.invoiced,
        totalPaid: r.paid,
        outstanding: r.outstanding,
      })),
      totals: {
        invoiced: a.invoiced ?? '0.00',
        paid: a.paid ?? '0.00',
        outstanding: a.outstanding ?? '0.00',
      },
      total: Number(a.n),
      limit: o.limit,
      offset: o.offset,
    };
  }

  async function customerReceivable(
    organizationId: string,
    customerId: string,
    isDemo: boolean,
  ): Promise<CustomerReceivableResponse> {
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, organizationId },
      select: { id: true, code: true, legalName: true, displayName: true },
    });
    if (!customer) throw new PaymentError('not_found', 'Customer not found.');
    const rows = await prisma.$queryRaw<
      {
        invoice_id: string;
        document_number: string;
        invoice_date: Date;
        grand_total: string;
        allocated: string;
        balance_due: string;
      }[]
    >`SELECT "invoice_id", "document_number", "invoice_date", "grand_total"::numeric(18,2)::text AS "grand_total",
             "allocated"::numeric(18,2)::text AS "allocated", "balance_due"::numeric(18,2)::text AS "balance_due"
        FROM "invoice_balances"
       WHERE "organization_id" = ${organizationId}::uuid AND "customer_id" = ${customerId}::uuid AND "is_demo" = ${isDemo}
       ORDER BY "invoice_date" DESC, "document_number" DESC`;
    const tot = await prisma.$queryRaw<
      { invoiced: string | null; paid: string | null; outstanding: string | null }[]
    >`
      SELECT sum("grand_total")::numeric(18,2)::text AS "invoiced", sum("allocated")::numeric(18,2)::text AS "paid",
             sum("balance_due")::numeric(18,2)::text AS "outstanding"
        FROM "invoice_balances"
       WHERE "organization_id" = ${organizationId}::uuid AND "customer_id" = ${customerId}::uuid AND "is_demo" = ${isDemo}`;
    const t = tot[0]!;
    return {
      isDemo,
      customer: {
        id: customer.id,
        code: customer.code,
        name: customer.displayName ?? customer.legalName,
      },
      totals: {
        invoiced: t.invoiced ?? '0.00',
        paid: t.paid ?? '0.00',
        outstanding: t.outstanding ?? '0.00',
      },
      invoices: rows.map((r) => ({
        invoiceId: r.invoice_id,
        documentNumber: r.document_number,
        invoiceDate: day(r.invoice_date),
        grandTotal: r.grand_total,
        paid: r.allocated,
        balanceDue: r.balance_due,
        status: statusOf(r.allocated, r.balance_due),
      })),
    };
  }

  return { record, list, get, receivables, customerReceivable };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
