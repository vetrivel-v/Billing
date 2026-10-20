import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@commercebill/database';
import {
  addQuantities,
  canonicalQuantity,
  compareQuantities,
  StockError,
  postStockMovement,
} from '@commercebill/inventory-engine';
import { NumberingError, type createNumberingService } from '@commercebill/numbering';
import type {
  InvoiceListResponse,
  InvoicePostResponse,
  InvoicePreviewResponse,
  InvoiceProblem,
  InvoiceStockWarning,
  InvoiceSummaryView,
  InvoiceView,
} from '@commercebill/shared-types';
import type { TaxBillingContext, TaxConfigService } from '@commercebill/tax-config';
import { calculate, type TaxEngineResult } from '@commercebill/tax-engine';
import { businessDate, loadFacts, type Db, type FactsResult, type InvoiceFacts } from './facts.js';
import {
  requestFingerprint,
  validatePostRequest,
  validatePreviewRequest,
  type InvoiceRequest,
  type Problem,
} from './validate.js';

export type InvoiceErrorCode =
  | 'validation_failed'
  | 'not_found'
  | 'calculation_stale'
  | 'operation_id_reused'
  | 'production_gate_not_met'
  | 'mode_mismatch'
  | 'insufficient_stock';

export class InvoiceError extends Error {
  constructor(
    readonly code: InvoiceErrorCode,
    message: string,
    readonly problems: InvoiceProblem[] = [],
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'InvoiceError';
  }
}

/** The authenticated caller. The organization ALWAYS comes from the session, never from a request. */
export interface InvoiceContext {
  userId: string;
  organizationId: string;
  correlationId?: string | null;
}

export interface InvoiceServiceOptions {
  prisma: PrismaClient;
  taxConfig: TaxConfigService;
  numbering: ReturnType<typeof createNumberingService>;
  appVersion?: string;
  clock?: () => Date;
}

const viewInclude = {
  lines: { orderBy: { lineNo: 'asc' } },
  createdByUser: { select: { displayName: true } },
  posConfirmer: { select: { displayName: true } },
} as const;
type InvoiceRow = Prisma.SalesInvoiceGetPayload<{ include: typeof viewInclude }>;

const money = (d: { toFixed(dp: number): string }) => d.toFixed(2);
const day = (d: Date) => d.toISOString().slice(0, 10);
const trimmedRate = (d: { toFixed(dp: number): string } | null, places: number) => {
  if (d === null) return null;
  const t = d.toFixed(places);
  return t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') || '0' : t;
};

export function toInvoiceView(r: InvoiceRow): InvoiceView {
  return {
    id: r.id,
    status: 'POSTED',
    documentType: r.documentType as InvoiceView['documentType'],
    documentNumber: r.documentNumber,
    isDemo: r.isDemo,
    invoiceDate: day(r.invoiceDate),
    financialYearLabel: r.financialYearLabel,
    currency: r.currency,
    warehouseName: r.warehouseName,
    seller: {
      legalName: r.sellerLegalName,
      tradeName: r.sellerTradeName,
      gstin: r.sellerGstin,
      gstStatus: r.sellerGstStatus,
      stateCode: r.sellerStateCode,
      addressLine1: r.sellerAddressLine1,
      addressLine2: r.sellerAddressLine2,
      city: r.sellerCity,
      pinCode: r.sellerPinCode,
    },
    customer: {
      id: r.customerId,
      code: r.customerCode,
      name: r.customerName,
      gstStatus: r.customerGstStatus,
      gstin: r.customerGstin,
      billing: {
        addressLine1: r.billingAddressLine1,
        addressLine2: r.billingAddressLine2,
        city: r.billingCity,
        stateCode: r.billingStateCode,
        pinCode: r.billingPinCode,
      },
      shipping: {
        addressLine1: r.shippingAddressLine1,
        addressLine2: r.shippingAddressLine2,
        city: r.shippingCity,
        stateCode: r.shippingStateCode,
        pinCode: r.shippingPinCode,
      },
      recipientClass: r.recipientClass as 'B2B' | 'B2C',
    },
    placeOfSupply: {
      stateCode: r.posStateCode,
      source: r.posSource as 'USER_CONFIRMED' | 'USER_OVERRIDE',
      confirmedByName: r.posConfirmer.displayName,
      confirmedAt: r.posConfirmedAt.toISOString(),
    },
    priceBasis: r.priceBasis,
    tax: {
      engineVersion: r.engineVersion,
      rulesetVersion: r.rulesetVersion,
      roundingPolicyId: r.roundingPolicyId,
      inputHash: r.taxInputHash,
      configurationFingerprint: r.taxConfigurationFingerprint,
      taxReviewId: r.taxReviewId,
      calculation: r.taxCalculation as Record<string, unknown>,
    },
    totals: {
      grossSubtotal: money(r.grossSubtotal),
      lineDiscountTotal: money(r.lineDiscountTotal),
      taxableSubtotal: money(r.taxableSubtotal),
      cgst: money(r.cgstTotal),
      sgst: money(r.sgstTotal),
      utgst: money(r.utgstTotal),
      igst: money(r.igstTotal),
      roundingAdjustmentTotal: money(r.roundingAdjustmentTotal),
      roundOff: money(r.roundOff),
      grandTotal: money(r.grandTotal),
    },
    // Production: balance due = grand total (payment allocations arrive in Task 1.16). Demo: no receivable at all.
    receivable: r.isDemo ? null : { allocated: '0.00', balanceDue: money(r.grandTotal) },
    lines: r.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      productId: l.productId,
      sku: l.sku,
      productName: l.productName,
      itemKind: l.itemKind,
      hsnSacCode: l.hsnSacCode,
      hsnSacKind: l.hsnSacKind,
      unitCode: l.unitCode,
      unitName: l.unitName,
      taxCategoryCode: l.taxCategoryCode,
      taxCategoryName: l.taxCategoryName,
      classification: l.classification,
      ratePercent: trimmedRate(l.ratePercent, 4)!,
      rateEffectiveFrom: day(l.rateEffectiveFrom),
      rateEffectiveTo: l.rateEffectiveTo ? day(l.rateEffectiveTo) : null,
      quantity: canonicalQuantity(l.quantity.toFixed(4)),
      unitPrice: money(l.unitPrice),
      priceBasis: l.priceBasis,
      grossAmount: money(l.grossAmount),
      discountType: l.discountType,
      discountPercent: trimmedRate(l.discountPercent, 4),
      discountAmount: money(l.discountAmount),
      taxableValue: money(l.taxableValue),
      cgstRate: trimmedRate(l.cgstRate, 5),
      cgstAmount: money(l.cgstAmount),
      sgstRate: trimmedRate(l.sgstRate, 5),
      sgstAmount: money(l.sgstAmount),
      utgstRate: trimmedRate(l.utgstRate, 5),
      utgstAmount: money(l.utgstAmount),
      igstRate: trimmedRate(l.igstRate, 5),
      igstAmount: money(l.igstAmount),
      roundingAdjustment: money(l.roundingAdjustment),
      lineTotal: money(l.lineTotal),
      stockEffect: l.stockEffect as 'DISPATCH' | 'NONE',
    })),
    createdAt: r.createdAt.toISOString(),
    createdByName: r.createdByUser.displayName,
  };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => '\\' + ch);

export function createInvoiceService(options: InvoiceServiceOptions) {
  const { prisma, taxConfig, numbering } = options;
  const appVersion = options.appVersion ?? '0.0.0';
  const clock = options.clock ?? (() => new Date());

  /** D6: the requested mode must be the organization's mode, and PRODUCTION needs the whole gate. */
  function modeProblems(
    requested: InvoiceRequest['mode'],
    billing: TaxBillingContext,
  ): InvoiceProblem[] {
    if (requested === 'PRODUCTION') {
      const unmet = billing.gate.requirements.filter((r) => !r.met).map((r) => r.code as string);
      if (billing.mode !== 'PRODUCTION') unmet.push('BILLING_MODE_NOT_PRODUCTION');
      return unmet.map((code) => ({ code: 'PRODUCTION_GATE_NOT_MET', path: code }));
    }
    return billing.mode === 'PRODUCTION' ? [{ code: 'MODE_MISMATCH', path: 'mode' }] : [];
  }

  async function stockWarnings(
    db: Db,
    facts: InvoiceFacts,
    mode: InvoiceRequest['mode'],
  ): Promise<InvoiceStockWarning[]> {
    const byProduct = new Map<string, { sku: string; required: string; lineRefs: string[] }>();
    for (const l of facts.lines) {
      if (!l.tracked) continue;
      const cur = byProduct.get(l.product.id) ?? {
        sku: l.product.sku,
        required: '0',
        lineRefs: [],
      };
      cur.required = addQuantities(cur.required, l.quantity);
      cur.lineRefs.push(l.lineRef);
      byProduct.set(l.product.id, cur);
    }
    const out: InvoiceStockWarning[] = [];
    for (const [productId, v] of byProduct) {
      const bal = await db.stockBalance.findUnique({
        where: { warehouseId_productId: { warehouseId: facts.warehouse.id, productId } },
      });
      const onHand = bal ? canonicalQuantity(bal.quantityOnHand.toFixed(4)) : '0';
      out.push({
        lineRefs: v.lineRefs,
        productId,
        sku: v.sku,
        required: v.required,
        onHand,
        sufficient: compareQuantities(onHand, v.required) >= 0,
        advisoryOnly: mode === 'DEMO',
      });
    }
    return out;
  }

  const posInfo = (loaded: FactsResult) => {
    if (loaded.ok)
      return {
        suggestedStateCode: loaded.facts.suggestedStateCode,
        requiresExplicitChoice: loaded.facts.requiresExplicitChoice,
      };
    const c = loaded.partial.customer;
    if (!c) return { suggestedStateCode: null, requiresExplicitChoice: false };
    return {
      suggestedStateCode: c.placeOfSupplyStateCode,
      requiresExplicitChoice:
        !c.shippingSameAsBilling && c.shippingStateCode !== c.billingStateCode,
    };
  };

  async function buildPreview(
    db: Db,
    request: InvoiceRequest,
    billing: TaxBillingContext,
    loaded: FactsResult,
    result: TaxEngineResult | null,
  ): Promise<InvoicePreviewResponse> {
    const errors: InvoiceProblem[] = loaded.ok ? [] : loaded.errors;
    if (result && !result.ok) errors.push(...result.errors);
    const ok = loaded.ok && result !== null && result.ok;
    return {
      ok,
      postable: ok && result !== null && result.ok && result.postable,
      mode: request.mode,
      errors,
      warnings: result ? result.warnings : [],
      calculation: result ? (JSON.parse(JSON.stringify(result)) as Record<string, unknown>) : null,
      identity:
        ok && result !== null && result.ok
          ? {
              inputHash: result.inputHash,
              configurationFingerprint: billing.fingerprint,
              grandTotal: result.totals.grandTotal,
            }
          : null,
      placeOfSupply: posInfo(loaded),
      stockWarnings: loaded.ok ? await stockWarnings(db, loaded.facts, request.mode) : [],
    };
  }

  /**
   * Preview: the same authoritative reload and TaxEngine call the post will make, with NO business writes: no invoice, number, stock
   * movement, receivable or audit row. Business problems come back as data (HTTP 200, ok: false); only a malformed request is a 400.
   */
  async function preview(
    ctx: InvoiceContext,
    raw: Record<string, unknown>,
  ): Promise<InvoicePreviewResponse> {
    const v = validatePreviewRequest(raw);
    if (!v.ok)
      throw new InvoiceError(
        'validation_failed',
        'The invoice details are not valid.',
        v.problems.map(toProblem),
      );
    const request = v.value;
    const billing = await taxConfig.billingContext(prisma, ctx.organizationId);
    const mp = modeProblems(request.mode, billing);
    if (mp.length > 0) {
      return {
        ok: false,
        postable: false,
        mode: request.mode,
        errors: mp,
        warnings: [],
        calculation: null,
        identity: null,
        placeOfSupply: { suggestedStateCode: null, requiresExplicitChoice: false },
        stockWarnings: [],
      };
    }
    const loaded = await loadFacts(prisma, {
      organizationId: ctx.organizationId,
      request,
      billing,
      today: businessDate(clock()),
    });
    const result = loaded.ok ? calculate(loaded.input) : null;
    return buildPreview(prisma, request, billing, loaded, result);
  }

  /**
   * Post: ONE transaction (ADR-0024). Numbering and inventory run on this transaction, so a failure anywhere rolls back everything,
   * including the number counter and its ledger row. Order (D2): reload, validate, recompute, compare, stock, number, invoice, audit.
   */
  async function post(
    ctx: InvoiceContext,
    raw: Record<string, unknown>,
  ): Promise<InvoicePostResponse> {
    const v = validatePostRequest(raw);
    if (!v.ok)
      throw new InvoiceError(
        'validation_failed',
        'The invoice details are not valid.',
        v.problems.map(toProblem),
      );
    const request = v.value;
    const fingerprint = requestFingerprint(request);

    return prisma.$transaction(async (tx) => {
      // Idempotency: one successful post per (organization, operation id). Concurrent retries wait here for the first.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`invoice_post:${ctx.organizationId}:${request.operationId}`}, 0))`;
      const existing = await tx.salesInvoice.findUnique({
        where: {
          organizationId_postOperationId: {
            organizationId: ctx.organizationId,
            postOperationId: request.operationId,
          },
        },
        include: viewInclude,
      });
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new InvoiceError(
            'operation_id_reused',
            'This operation id was already used for a different invoice.',
            [{ code: 'OPERATION_ID_REUSED', path: 'operationId' }],
          );
        }
        return { invoice: toInvoiceView(existing), replayed: true };
      }

      // 1. Authoritative reload.
      const billing = await taxConfig.billingContext(tx, ctx.organizationId);
      const mp = modeProblems(request.mode, billing);
      if (mp.length > 0) {
        throw new InvoiceError(
          mp[0]!.code === 'MODE_MISMATCH' ? 'mode_mismatch' : 'production_gate_not_met',
          mp[0]!.code === 'MODE_MISMATCH'
            ? 'The requested billing mode is not the organization billing mode.'
            : 'Production billing is not available: some requirements are not met.',
          mp,
        );
      }
      const loaded = await loadFacts(tx, {
        organizationId: ctx.organizationId,
        request,
        billing,
        today: businessDate(clock()),
      });
      if (!loaded.ok)
        throw new InvoiceError('validation_failed', 'The invoice cannot be posted.', loaded.errors);

      // 2. TaxEngine recomputation; 3. stale comparison against what the user was shown.
      const result = calculate(loaded.input);
      if (!result.ok)
        throw new InvoiceError('validation_failed', 'The invoice cannot be posted.', result.errors);
      if (!result.postable) {
        throw new InvoiceError('validation_failed', 'The place of supply has not been confirmed.', [
          { code: 'PLACE_OF_SUPPLY_NOT_CONFIRMED', path: 'placeOfSupply' },
        ]);
      }
      const seen = request.calculation;
      const reasons: string[] = [];
      if (seen.inputHash !== result.inputHash) reasons.push('CALCULATION_CHANGED');
      if (seen.configurationFingerprint !== billing.fingerprint)
        reasons.push('TAX_CONFIGURATION_CHANGED');
      if (seen.grandTotal !== result.totals.grandTotal) reasons.push('TOTAL_CHANGED');
      if (reasons.length > 0) {
        const fresh = await buildPreview(tx, request, billing, loaded, result);
        throw new InvoiceError(
          'calculation_stale',
          'The calculation changed since it was shown. Nothing was posted; review the new calculation.',
          [{ code: 'CALCULATION_STALE', path: 'calculation' }],
          { reasons, recalculation: fresh as unknown as Record<string, unknown> },
        );
      }

      const facts = loaded.facts;
      const isDemo = request.mode === 'DEMO';
      const invoiceId = randomUUID();
      const lineIds = facts.lines.map(() => randomUUID());

      // 4. Stock (PRODUCTION only; a demo invoice NEVER touches the stock ledger, D3). Fixed product order, so two postings take
      //    their stock locks in the same order.
      const stockEffect = (i: number): 'DISPATCH' | 'NONE' =>
        !isDemo && facts.lines[i]!.tracked ? 'DISPATCH' : 'NONE';
      const order = facts.lines
        .map((l, i) => ({ l, i }))
        .filter(({ i }) => stockEffect(i) === 'DISPATCH')
        .sort((a, b) =>
          a.l.product.id < b.l.product.id ? -1 : a.l.product.id > b.l.product.id ? 1 : a.i - b.i,
        );
      for (const { l, i } of order) {
        try {
          await postStockMovement(tx, {
            organizationId: ctx.organizationId,
            warehouseId: facts.warehouse.id,
            productId: l.product.id,
            movementType: 'SALES_DISPATCH',
            quantity: l.quantity,
            businessDate: facts.date,
            source: { type: 'SALES_INVOICE', ref: invoiceId, lineRef: lineIds[i]! },
            createdBy: ctx.userId,
          });
        } catch (err) {
          if (err instanceof StockError) {
            const code =
              err.code === 'insufficient_stock'
                ? 'INSUFFICIENT_STOCK'
                : (err.problems[0]?.rule ?? err.code);
            throw new InvoiceError(
              err.code === 'insufficient_stock' ? 'insufficient_stock' : 'validation_failed',
              err.code === 'insufficient_stock'
                ? 'There is not enough stock. Nothing was posted.'
                : 'The stock effect is not valid.',
              [{ code, path: `lines[${i}].quantity`, lineRef: l.lineRef }],
            );
          }
          throw err;
        }
      }

      // 5. The permanent number, from the DEMO or the production sequence (never both).
      const documentType = isDemo ? 'DEMO_INVOICE' : 'INVOICE';
      let number: string;
      try {
        const allocated = await numbering.allocate(
          tx,
          {
            organizationId: ctx.organizationId,
            documentType,
            financialYearId: facts.financialYear.id,
            ...(facts.numberingByLocation ? { locationId: facts.location.id } : {}),
          },
          { documentRef: invoiceId, correlationId: ctx.correlationId ?? null },
        );
        number = allocated.number;
      } catch (err) {
        if (err instanceof NumberingError && err.code === 'sequence_not_found') {
          throw new InvoiceError(
            'validation_failed',
            'No numbering sequence is configured for this document.',
            [{ code: 'NUMBER_SEQUENCE_MISSING', path: documentType }],
          );
        }
        throw err;
      }

      // 6. The immutable invoice: header snapshot, then the line snapshots.
      const t = result.totals;
      const c = facts.customer;
      const shippingSame = c.shippingSameAsBilling;
      const confirmedAt = clock();
      const pos = result.placeOfSupply;
      await tx.salesInvoice.create({
        data: {
          id: invoiceId,
          organizationId: ctx.organizationId,
          postOperationId: request.operationId,
          requestFingerprint: fingerprint,
          documentType,
          documentNumber: number,
          isDemo,
          invoiceDate: new Date(`${facts.date}T00:00:00Z`),
          financialYearId: facts.financialYear.id,
          financialYearLabel: facts.financialYear.label,
          locationId: facts.location.id,
          warehouseId: facts.warehouse.id,
          warehouseName: facts.warehouse.name,
          sellerLegalName: facts.organization.legalName,
          sellerTradeName: facts.organization.tradeName,
          sellerGstin: loaded.input.supplier.gstin!,
          sellerGstStatus: loaded.input.supplier.gstStatus,
          sellerStateCode: loaded.input.supplier.stateCode,
          sellerAddressLine1: facts.location.addressLine1,
          sellerAddressLine2: facts.location.addressLine2,
          sellerCity: facts.location.city,
          sellerPinCode: facts.location.pinCode,
          customerId: c.id,
          customerCode: c.code,
          customerName: c.legalName,
          customerGstStatus: c.gstStatus,
          customerGstin: c.gstin,
          billingAddressLine1: c.billingAddressLine1,
          billingAddressLine2: c.billingAddressLine2,
          billingCity: c.billingCity,
          billingStateCode: c.billingStateCode,
          billingPinCode: c.billingPinCode,
          shippingAddressLine1: shippingSame
            ? c.billingAddressLine1
            : (c.shippingAddressLine1 ?? c.billingAddressLine1),
          shippingAddressLine2: shippingSame ? c.billingAddressLine2 : c.shippingAddressLine2,
          shippingCity: shippingSame ? c.billingCity : c.shippingCity,
          shippingStateCode: shippingSame
            ? c.billingStateCode
            : (c.shippingStateCode ?? c.billingStateCode),
          shippingPinCode: shippingSame ? c.billingPinCode : c.shippingPinCode,
          recipientClass: result.recipientClassification,
          posStateCode: pos.stateCode,
          posSource: pos.source,
          posConfirmedBy: ctx.userId,
          posConfirmedAt: confirmedAt,
          priceBasis: result.priceBasis,
          engineVersion: result.engineVersion,
          rulesetVersion: result.rulesetVersion,
          roundingPolicyId: result.roundingPolicyId,
          taxInputHash: result.inputHash,
          taxConfigurationFingerprint: billing.fingerprint,
          taxReviewId: isDemo ? null : billing.review.latestId,
          taxCalculation: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
          grossSubtotal: t.grossSubtotal,
          lineDiscountTotal: t.lineDiscountTotal,
          taxableSubtotal: t.taxableSubtotal,
          cgstTotal: t.componentTotals.CGST,
          sgstTotal: t.componentTotals.SGST,
          utgstTotal: t.componentTotals.UTGST,
          igstTotal: t.componentTotals.IGST,
          roundingAdjustmentTotal: t.roundingAdjustmentTotal,
          roundOff: t.roundOff,
          grandTotal: t.grandTotal,
          createdBy: ctx.userId,
          correlationId: ctx.correlationId ?? null,
        },
      });
      await tx.salesInvoiceLine.createMany({
        data: facts.lines.map((lf, i) => {
          const rl = result.lines[i]!;
          const p = lf.product;
          const comp = (kind: 'CGST' | 'SGST' | 'UTGST' | 'IGST') =>
            rl.components.find((x) => x.kind === kind);
          return {
            id: lineIds[i]!,
            invoiceId,
            organizationId: ctx.organizationId,
            lineNo: i + 1,
            productId: p.id,
            sku: p.sku,
            productName: p.name,
            itemKind: 'GOODS',
            hsnSacCode: p.hsnSacCode?.code ?? null,
            hsnSacKind: p.hsnSacCode?.kind ?? null,
            unitCode: p.unit!.code,
            unitName: p.unit!.name,
            taxCategoryId: p.taxCategory.id,
            taxCategoryCode: p.taxCategory.code,
            taxCategoryName: p.taxCategory.name,
            classification: rl.classification,
            taxRateId: rl.rate.id,
            ratePercent: rl.rate.ratePercent,
            rateEffectiveFrom: new Date(`${rl.rate.effectiveFrom}T00:00:00Z`),
            rateEffectiveTo: rl.rate.effectiveTo
              ? new Date(`${rl.rate.effectiveTo}T00:00:00Z`)
              : null,
            quantity: rl.quantity,
            unitPrice: rl.unitPrice,
            priceBasis: rl.priceBasis,
            grossAmount: rl.grossAmount,
            discountType: lf.discount.type,
            discountPercent: lf.discount.type === 'PERCENT' ? lf.discount.percent : null,
            discountAmount: rl.discountAmount,
            taxableValue: rl.taxableValue,
            cgstRate: comp('CGST')?.ratePercent ?? null,
            cgstAmount: comp('CGST')?.amount ?? '0.00',
            sgstRate: comp('SGST')?.ratePercent ?? null,
            sgstAmount: comp('SGST')?.amount ?? '0.00',
            utgstRate: comp('UTGST')?.ratePercent ?? null,
            utgstAmount: comp('UTGST')?.amount ?? '0.00',
            igstRate: comp('IGST')?.ratePercent ?? null,
            igstAmount: comp('IGST')?.amount ?? '0.00',
            roundingAdjustment: rl.roundingAdjustment,
            lineTotal: rl.lineTotal,
            stockEffect: stockEffect(i),
          };
        }),
      });

      // 7. One audit event for one posted invoice (facts only; the invoice itself is the detailed record).
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          category: 'business',
          action: 'invoice.post',
          entityType: 'sales_invoice',
          entityId: invoiceId,
          afterValues: {
            documentNumber: number,
            documentType,
            isDemo,
            grandTotal: t.grandTotal,
            customerId: c.id,
            lineCount: facts.lines.length,
            operationId: request.operationId,
          },
          appVersion,
          correlationId: ctx.correlationId ?? null,
          occurredAt: clock(),
        },
      });

      const created = await tx.salesInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: viewInclude,
      });
      return { invoice: toInvoiceView(created), replayed: false };
    });
  }

  async function list(
    organizationId: string,
    o: {
      search?: string | undefined;
      isDemo?: boolean | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<InvoiceListResponse> {
    const term = o.search?.trim() ? escapeLike(o.search.trim()) : undefined;
    const where: Prisma.SalesInvoiceWhereInput = {
      organizationId,
      ...(o.isDemo === undefined ? {} : { isDemo: o.isDemo }),
      ...(o.from || o.to
        ? {
            invoiceDate: {
              ...(o.from ? { gte: new Date(`${o.from}T00:00:00Z`) } : {}),
              ...(o.to ? { lte: new Date(`${o.to}T00:00:00Z`) } : {}),
            },
          }
        : {}),
      ...(term
        ? {
            OR: [
              { documentNumber: { contains: term, mode: 'insensitive' } },
              { customerName: { contains: term, mode: 'insensitive' } },
              { customerCode: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.salesInvoice.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: o.limit,
        skip: o.offset,
      }),
      prisma.salesInvoice.count({ where }),
    ]);
    const invoices: InvoiceSummaryView[] = rows.map((r) => ({
      id: r.id,
      documentNumber: r.documentNumber,
      isDemo: r.isDemo,
      invoiceDate: day(r.invoiceDate),
      customerId: r.customerId,
      customerCode: r.customerCode,
      customerName: r.customerName,
      taxableSubtotal: money(r.taxableSubtotal),
      taxTotal: money(r.cgstTotal.plus(r.sgstTotal).plus(r.utgstTotal).plus(r.igstTotal)),
      grandTotal: money(r.grandTotal),
      receivable: r.isDemo ? null : { allocated: '0.00', balanceDue: money(r.grandTotal) },
      createdAt: r.createdAt.toISOString(),
    }));
    return { invoices, total, limit: o.limit, offset: o.offset };
  }

  async function get(organizationId: string, id: string): Promise<InvoiceView> {
    const row = await prisma.salesInvoice.findFirst({
      where: { id, organizationId },
      include: viewInclude,
    });
    if (!row) throw new InvoiceError('not_found', 'Invoice not found.');
    return toInvoiceView(row);
  }

  return { preview, post, list, get };
}

const toProblem = (p: Problem): InvoiceProblem => ({ code: p.rule, path: p.field });

export type InvoiceService = ReturnType<typeof createInvoiceService>;
