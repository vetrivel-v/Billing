/**
 * TaxFactsLoader: reads the AUTHORITATIVE facts for an invoice (seller, customer, products, effective rates, HSN/SAC, policy) and
 * builds the frozen TaxEngineInput. The browser supplies only choices (customer, products, quantities, discounts, place of
 * supply); everything that decides money comes from here. The same function runs for the preview and, inside the posting
 * transaction, again for the post, so the two can be compared exactly.
 */
import type { Prisma, PrismaClient } from '@commercebill/database';
import { parseQuantity } from '@commercebill/inventory-engine/browser';
import type { TaxBillingContext } from '@commercebill/tax-config';
import {
  ENGINE_VERSION,
  RULESET_VERSION,
  selectEffectiveRate,
  type CategoryRow,
  type RateRow,
  type TaxEngineInput,
  type TaxLineInput,
} from '@commercebill/tax-engine';
import type { InvoiceRequest } from './validate.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export interface DomainProblem {
  code: string;
  path?: string;
  lineRef?: string;
}

const dateText = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** The business date (Asia/Kolkata, UTC+05:30): the only invoice date allowed in this version (D4). */
export function businessDate(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

const productInclude = { unit: true, taxCategory: true, hsnSacCode: true } as const;
export type FactProduct = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

export interface LineFacts {
  lineRef: string;
  product: FactProduct;
  quantity: string;
  discount: InvoiceRequest['lines'][number]['discount'];
  rate: RateRow | null;
  /** The line will dispatch stock in a PRODUCTION invoice (tracked goods). */
  tracked: boolean;
}

export interface InvoiceFacts {
  date: string;
  organization: Prisma.OrganizationGetPayload<object>;
  location: Prisma.BusinessLocationGetPayload<object>;
  warehouse: Prisma.WarehouseGetPayload<object>;
  financialYear: Prisma.FinancialYearGetPayload<object>;
  customer: Prisma.CustomerGetPayload<object>;
  lines: LineFacts[];
  priceBasis: 'EXCLUSIVE' | 'INCLUSIVE';
  suggestedStateCode: string;
  requiresExplicitChoice: boolean;
  /** Whether the organization numbers per location (then the location is part of the numbering scope). */
  numberingByLocation: boolean;
}

export type FactsResult =
  | { ok: true; facts: InvoiceFacts; input: TaxEngineInput }
  | { ok: false; errors: DomainProblem[]; partial: Partial<InvoiceFacts> };

export async function loadFacts(
  db: Db,
  args: {
    organizationId: string;
    request: InvoiceRequest;
    billing: TaxBillingContext;
    today: string;
  },
): Promise<FactsResult> {
  const { organizationId, request, billing, today } = args;
  const errors: DomainProblem[] = [];
  const err = (code: string, path?: string, lineRef?: string) =>
    errors.push({ code, ...(path ? { path } : {}), ...(lineRef ? { lineRef } : {}) });

  // D4: the current business date only; no future dating, no backdating.
  const date = today;
  if (request.invoiceDate !== undefined && request.invoiceDate !== today)
    err('INVOICE_DATE_NOT_TODAY', 'invoiceDate');

  const organization = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const location = await db.businessLocation.findFirst({
    where: { organizationId, isPrimary: true, isActive: true },
  });
  if (!location) err('NO_PRIMARY_LOCATION');
  const warehouse = await db.warehouse.findFirst({
    where: { organizationId, isActive: true },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
  if (!warehouse) err('NO_WAREHOUSE');
  const financialYear = await db.financialYear.findFirst({
    where: {
      organizationId,
      startDate: { lte: new Date(`${date}T00:00:00Z`) },
      endDate: { gte: new Date(`${date}T00:00:00Z`) },
      isLocked: false,
    },
  });
  if (!financialYear) err('NO_OPEN_FINANCIAL_YEAR');

  const customer = await db.customer.findFirst({
    where: { id: request.customerId, organizationId },
  });
  if (!customer) err('CUSTOMER_NOT_FOUND', 'customerId');
  else if (!customer.isActive) err('CUSTOMER_INACTIVE', 'customerId');

  const ids = [...new Set(request.lines.map((l) => l.productId))];
  const products = await db.product.findMany({
    where: { id: { in: ids }, organizationId },
    include: productInclude,
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  const categoryRows = new Map<string, CategoryRow>(billing.categoryRows.map((c) => [c.id, c]));

  const lines: LineFacts[] = [];
  request.lines.forEach((l, i) => {
    const lineRef = `L${i + 1}`;
    const path = `lines[${i}]`;
    const product = byId.get(l.productId);
    if (!product) {
      err('PRODUCT_NOT_FOUND', `${path}.productId`, lineRef);
      return;
    }
    if (!product.isActive) err('PRODUCT_INACTIVE', `${path}.productId`, lineRef);
    if (product.kind !== 'GOODS') err('ITEM_KIND_UNSUPPORTED', `${path}.productId`, lineRef);
    const places = product.unit?.decimalPlaces ?? 0;
    const q = parseQuantity(l.quantity, places);
    if (!q.ok) err('INVALID_QUANTITY', `${path}.quantity`, lineRef);
    const cat = categoryRows.get(product.taxCategoryId);
    const selected = cat ? selectEffectiveRate(cat, billing.rateRows, date) : null;
    lines.push({
      lineRef,
      product,
      quantity: l.quantity,
      discount: l.discount,
      rate: selected && selected.ok ? selected.rate : null,
      tracked: product.kind === 'GOODS' && product.trackInventory,
    });
  });

  // D5: one price basis per invoice. Products that disagree are blocked, never silently converted.
  const bases = new Set(lines.map((l) => (l.product.priceIncludesTax ? 'INCLUSIVE' : 'EXCLUSIVE')));
  if (bases.size > 1) err('MIXED_PRICE_BASIS', 'lines');
  const priceBasis: 'EXCLUSIVE' | 'INCLUSIVE' =
    bases.has('INCLUSIVE') && bases.size === 1 ? 'INCLUSIVE' : 'EXCLUSIVE';

  const setting = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId, key: 'numbering' } },
  });
  const numberingByLocation =
    (setting?.value as { scopeByLocation?: boolean } | null)?.scopeByLocation === true;

  const partial: Partial<InvoiceFacts> = { date, organization, ...(customer ? { customer } : {}) };
  if (errors.length > 0 || !location || !warehouse || !financialYear || !customer) {
    return { ok: false, errors, partial };
  }

  const billingState = customer.billingStateCode;
  const shippingState = customer.shippingSameAsBilling ? null : customer.shippingStateCode;
  const suggestedStateCode = customer.placeOfSupplyStateCode;
  const requiresExplicitChoice = shippingState !== null && shippingState !== billingState;

  // Place of supply: the suggestion alone is never postable (the engine returns postable:false for SUGGESTED).
  let pos: TaxEngineInput['placeOfSupply'] = { stateCode: suggestedStateCode, source: 'SUGGESTED' };
  const choice = request.placeOfSupply;
  if (choice) {
    if (choice.choice === 'CONFIRMED') {
      if (choice.stateCode !== suggestedStateCode) {
        err('PLACE_OF_SUPPLY_CHOICE_INVALID', 'placeOfSupply.stateCode');
      } else pos = { stateCode: choice.stateCode, source: 'USER_CONFIRMED' };
    } else pos = { stateCode: choice.stateCode, source: 'USER_OVERRIDE' };
  }
  if (errors.length > 0) return { ok: false, errors, partial };

  const engineLines: TaxLineInput[] = lines.map((l) => {
    const p = l.product;
    const cat = p.taxCategory;
    return {
      lineRef: l.lineRef,
      productRef: p.id,
      itemKind: p.kind as 'GOODS' | 'SERVICE',
      hsnSac: p.hsnSacCode
        ? { code: p.hsnSacCode.code, kind: p.hsnSacCode.kind as 'HSN' | 'SAC' }
        : null,
      taxCategory: {
        id: cat.id,
        code: cat.code,
        classification: cat.classification,
        isActive: cat.isActive,
        effectiveFrom: dateText(cat.effectiveFrom),
        effectiveTo: dateText(cat.effectiveTo),
      },
      rate: l.rate
        ? {
            id: l.rate.id,
            categoryId: l.rate.categoryId,
            ratePercent: l.rate.ratePercent,
            cessPercent: l.rate.cessPercent,
            effectiveFrom: l.rate.effectiveFrom,
            effectiveTo: l.rate.effectiveTo,
          }
        : null,
      quantity: l.quantity,
      unitPrice: p.sellingPrice.toFixed(2),
      discount: l.discount,
    };
  });

  const input: TaxEngineInput = {
    engineVersion: ENGINE_VERSION,
    rulesetVersion: RULESET_VERSION,
    documentType: 'TAX_INVOICE',
    taxPointDate: date,
    supplyKind: 'DOMESTIC',
    reverseCharge: false,
    supplier: {
      gstStatus: organization.gstStatus,
      gstin: location.gstin ?? organization.gstin,
      stateCode: location.stateCode ?? organization.stateCode ?? '',
    },
    recipient: {
      gstStatus: customer.gstStatus,
      gstin: customer.gstin,
      billingStateCode: billingState,
      shippingStateCode: shippingState,
    },
    placeOfSupply: pos,
    priceBasis,
    lines: engineLines,
    rounding: { invoiceRoundOff: 'NONE' },
    requirements: { hsnSacRequired: billing.hsnPolicy.required },
  };

  return {
    ok: true,
    input,
    facts: {
      date,
      organization,
      location,
      warehouse,
      financialYear,
      customer,
      lines,
      priceBasis,
      suggestedStateCode,
      requiresExplicitChoice,
      numberingByLocation,
    },
  };
}
