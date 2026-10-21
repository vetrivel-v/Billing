import type { InvoiceView } from '@commercebill/shared-types';
import { z } from 'zod';

/**
 * Strict shape check of a posted-invoice snapshot before it is turned into a document. The Electron main process uses it to
 * validate the payload of the print/save channels, so every string is bounded and every amount must be a plain decimal.
 */
const text = (max = 500) => z.string().max(max);
const optText = (max = 500) => z.string().max(max).nullable();
const money = z.string().regex(/^-?\d{1,16}(\.\d{1,5})?$/);
const optMoney = money.nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const stateCode = z.string().regex(/^\d{2}$/);
/** Document numbers are printed in the page margin: keep them to a safe, boring alphabet. */
const docNumber = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 /._-]{0,39}$/);

const address = z.object({
  addressLine1: text(),
  addressLine2: optText(),
  city: optText(),
  stateCode,
  pinCode: optText(20),
});

const line = z.object({
  id: text(64),
  lineNo: z.number().int().min(1).max(10_000),
  sku: text(100),
  productName: text(),
  hsnSacCode: optText(20),
  hsnSacKind: optText(10),
  unitCode: text(20),
  taxCategoryName: text(),
  classification: text(40),
  quantity: z.string().regex(/^\d{1,12}(\.\d{1,4})?$/),
  unitPrice: money,
  priceBasis: z.enum(['EXCLUSIVE', 'INCLUSIVE']),
  grossAmount: money,
  discountType: z.enum(['NONE', 'PERCENT', 'AMOUNT']),
  discountPercent: optMoney,
  discountAmount: money,
  taxableValue: money,
  cgstRate: optMoney,
  cgstAmount: money,
  sgstRate: optMoney,
  sgstAmount: money,
  utgstRate: optMoney,
  utgstAmount: money,
  igstRate: optMoney,
  igstAmount: money,
  roundingAdjustment: money,
  lineTotal: money,
});

export const MAX_DOCUMENT_LINES = 500;

const snapshot = z.object({
  id: text(64),
  documentType: z.enum(['INVOICE', 'DEMO_INVOICE']),
  documentNumber: docNumber,
  isDemo: z.boolean(),
  invoiceDate: date,
  financialYearLabel: text(20),
  currency: z.literal('INR'),
  seller: z.object({
    legalName: text(),
    tradeName: optText(),
    gstin: text(20),
    gstStatus: text(40),
    stateCode,
    addressLine1: text(),
    addressLine2: optText(),
    city: optText(),
    pinCode: optText(20),
  }),
  customer: z.object({
    code: text(40),
    name: text(),
    gstin: optText(20),
    recipientClass: z.enum(['B2B', 'B2C']),
    billing: address,
    shipping: address,
  }),
  placeOfSupply: z.object({
    stateCode,
    source: z.enum(['USER_CONFIRMED', 'USER_OVERRIDE']),
    confirmedByName: text(),
    confirmedAt: text(40),
  }),
  tax: z.object({ calculation: z.record(z.string(), z.unknown()) }),
  totals: z.object({
    grossSubtotal: money,
    lineDiscountTotal: money,
    taxableSubtotal: money,
    cgst: money,
    sgst: money,
    utgst: money,
    igst: money,
    roundingAdjustmentTotal: money,
    roundOff: money,
    grandTotal: money,
  }),
  lines: z.array(line).min(1).max(MAX_DOCUMENT_LINES),
  createdAt: text(40),
  createdByName: text(),
});

export type SnapshotProblem = { path: string; rule: string };

/** Validates a snapshot and returns it as the InvoiceView the document is built from. Values are never echoed in problems. */
export function parseInvoiceSnapshot(
  raw: unknown,
): { ok: true; invoice: InvoiceView } | { ok: false; problems: SnapshotProblem[] } {
  const r = snapshot.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      problems: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), rule: i.code })),
    };
  const v = r.data;
  // A demo flag and a document type must agree, or the DEMO marking could be bypassed by a mismatched payload.
  if (v.isDemo !== (v.documentType === 'DEMO_INVOICE'))
    return { ok: false, problems: [{ path: 'documentType', rule: 'demo_flag_mismatch' }] };
  return { ok: true, invoice: raw as InvoiceView };
}
