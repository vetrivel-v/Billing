// Test-only: builds a consistent posted-invoice snapshot (InvoiceView) from a few choices, using fictional data. Not shipped.
// Amounts are computed here with BigInt paise (exclusive prices, half-up) ONLY to make test data self-consistent; the document
// engine under test never calculates anything.
import type { InvoiceLineView, InvoiceView } from '@commercebill/shared-types';

export interface FixtureLine {
  name: string;
  sku?: string;
  /** Integer quantity (display string is built from it). */
  qty?: number;
  qtyText?: string;
  /** Price in paise, tax-exclusive. */
  pricePaise: number;
  /** GST rate percent; null = a line with no tax (nil/exempt/non-GST). */
  rate: number | null;
  classification?: string;
  discountPercent?: number;
  discountPaise?: number;
}

const p2 = (paise: bigint): string => {
  const neg = paise < 0n;
  const a = neg ? -paise : paise;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};
const halfUp = (num: bigint, den: bigint): bigint => (num * 2n + den) / (2n * den);

export interface FixtureOptions {
  lines: FixtureLine[];
  supply?: 'INTRA' | 'INTER';
  isDemo?: boolean;
  documentNumber?: string;
  customerName?: string;
  shippingDifferent?: boolean;
  sellerName?: string;
  roundOffPaise?: number;
}

export function makeInvoice(o: FixtureOptions): InvoiceView {
  const supply = o.supply ?? 'INTRA';
  const isDemo = o.isDemo ?? true;
  let gross = 0n;
  let discounts = 0n;
  let taxable = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  const lines: InvoiceLineView[] = o.lines.map((l, i) => {
    const qty = BigInt(l.qty ?? 1);
    const g = qty * BigInt(l.pricePaise);
    const d = l.discountPercent
      ? halfUp(g * BigInt(Math.round(l.discountPercent * 100)), 10000n)
      : BigInt(l.discountPaise ?? 0);
    const t = g - d;
    const half =
      l.rate !== null && supply === 'INTRA'
        ? halfUp(t * BigInt(Math.round(l.rate * 100)), 20000n)
        : 0n;
    const full =
      l.rate !== null && supply === 'INTER'
        ? halfUp(t * BigInt(Math.round(l.rate * 100)), 10000n)
        : 0n;
    gross += g;
    discounts += d;
    taxable += t;
    cgst += half;
    sgst += half;
    igst += full;
    const rateText =
      l.rate === null ? null : `${l.rate}.00000`.replace(/^(\d+)\.00000$/, '$1.00000');
    const halfRate = l.rate === null ? null : String(l.rate / 2);
    return {
      id: `line-${i + 1}`,
      lineNo: i + 1,
      productId: `p-${i + 1}`,
      sku: l.sku ?? `SKU-${i + 1}`,
      productName: l.name,
      itemKind: 'GOODS',
      hsnSacCode: '8517',
      hsnSacKind: 'HSN',
      unitCode: 'PCS',
      unitName: 'Pieces',
      taxCategoryCode: l.rate === null ? 'NIL' : `GST_${l.rate}`,
      taxCategoryName: l.rate === null ? 'Nil rated' : `GST ${l.rate}%`,
      classification: l.classification ?? (l.rate === null ? 'NIL_RATED' : 'STANDARD'),
      ratePercent: rateText ?? '0',
      rateEffectiveFrom: '2017-07-01',
      rateEffectiveTo: null,
      quantity: l.qtyText ?? String(l.qty ?? 1),
      unitPrice: p2(BigInt(l.pricePaise)),
      priceBasis: 'EXCLUSIVE',
      grossAmount: p2(g),
      discountType: l.discountPercent ? 'PERCENT' : l.discountPaise ? 'AMOUNT' : 'NONE',
      discountPercent: l.discountPercent ? `${l.discountPercent}.0000` : null,
      discountAmount: p2(d),
      taxableValue: p2(t),
      cgstRate: l.rate !== null && supply === 'INTRA' ? `${halfRate}` : null,
      cgstAmount: p2(half),
      sgstRate: l.rate !== null && supply === 'INTRA' ? `${halfRate}` : null,
      sgstAmount: p2(half),
      utgstRate: null,
      utgstAmount: '0.00',
      igstRate: l.rate !== null && supply === 'INTER' ? `${l.rate}` : null,
      igstAmount: p2(full),
      roundingAdjustment: '0.00',
      lineTotal: p2(t + half * 2n + full),
      stockEffect: 'NONE',
    };
  });
  const roundOff = BigInt(o.roundOffPaise ?? 0);
  const grand = taxable + cgst + sgst + igst + roundOff;
  const addr = (line1: string, state: string, city: string) => ({
    addressLine1: line1,
    addressLine2: null,
    city,
    stateCode: state,
    pinCode: '400001',
  });
  return {
    id: '00000000-0000-4000-8000-000000000001',
    status: 'POSTED',
    documentType: isDemo ? 'DEMO_INVOICE' : 'INVOICE',
    documentNumber: o.documentNumber ?? (isDemo ? 'DEMO/2026-27/000001' : 'INV/2026-27/000001'),
    isDemo,
    invoiceDate: '2026-10-20',
    financialYearLabel: '2026-27',
    currency: 'INR',
    warehouseName: 'Main Warehouse',
    seller: {
      legalName: o.sellerName ?? 'Sample Traders Private Limited',
      tradeName: 'Sample Traders',
      gstin: '27ABCDE1234F1Z5',
      gstStatus: 'REGISTERED',
      stateCode: '27',
      addressLine1: '12 Market Road',
      addressLine2: null,
      city: 'Mumbai',
      pinCode: '400001',
    },
    customer: {
      id: 'c-1',
      code: 'CUS-000001',
      name: o.customerName ?? 'Walk-in Buyer',
      gstStatus: 'UNREGISTERED',
      gstin: null,
      billing: addr(
        '1 Buyer Lane',
        supply === 'INTER' ? '29' : '27',
        supply === 'INTER' ? 'Bengaluru' : 'Pune',
      ),
      shipping: o.shippingDifferent
        ? addr('9 Dock Road', '29', 'Bengaluru')
        : addr(
            '1 Buyer Lane',
            supply === 'INTER' ? '29' : '27',
            supply === 'INTER' ? 'Bengaluru' : 'Pune',
          ),
      recipientClass: 'B2C',
    },
    placeOfSupply: {
      stateCode: supply === 'INTER' ? '29' : '27',
      source: 'USER_CONFIRMED',
      confirmedByName: 'Administrator (test)',
      confirmedAt: '2026-10-20T07:11:50.000Z',
    },
    priceBasis: 'EXCLUSIVE',
    tax: {
      engineVersion: '1.0.0',
      rulesetVersion: 'FUB-GST-1',
      roundingPolicyId: 'HALF_UP_PAISE_V1',
      inputHash: 'a'.repeat(64),
      configurationFingerprint: 'b'.repeat(64),
      taxReviewId: null,
      calculation: { ok: true, supply, warnings: [] },
    },
    totals: {
      grossSubtotal: p2(gross),
      lineDiscountTotal: p2(discounts),
      taxableSubtotal: p2(taxable),
      cgst: p2(cgst),
      sgst: p2(sgst),
      utgst: '0.00',
      igst: p2(igst),
      roundingAdjustmentTotal: '0.00',
      roundOff: p2(roundOff),
      grandTotal: p2(grand),
    },
    receivable: isDemo ? null : { allocated: '0.00', balanceDue: p2(grand) },
    payment: {
      isDemo,
      grandTotal: p2(grand),
      allocated: '0.00',
      balanceDue: p2(grand),
      status: 'UNPAID',
    },
    lines,
    createdAt: '2026-10-20T07:11:51.000Z',
    createdByName: 'Administrator (test)',
  };
}

/** A long invoice that must span several A4 pages. */
export const longInvoice = (n = 90, isDemo = true) =>
  makeInvoice({
    isDemo,
    lines: Array.from({ length: n }, (_, i) => ({
      name: `Fictional product number ${i + 1} with a reasonably long descriptive name to exercise wrapping`,
      sku: `LONG-${String(i + 1).padStart(3, '0')}`,
      qty: (i % 5) + 1,
      pricePaise: 12_345 + i * 100,
      rate: [5, 12, 18, 28][i % 4]!,
    })),
  });
