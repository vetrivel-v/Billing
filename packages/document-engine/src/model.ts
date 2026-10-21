import { INDIA_STATE_CODES } from '@commercebill/setup/browser';
import type { InvoiceLineView, InvoiceView } from '@commercebill/shared-types';
import { amountInWords, formatMoney, formatRate } from './money.js';

/**
 * The document view model: every value is a display string taken from the posted snapshot. NOTHING here is calculated; the
 * model only chooses which stored values to show and how to label them.
 */
export type DocumentTitleKind = 'DEMO' | 'TAX_INVOICE' | 'NO_TAX_NOT_TAX_INVOICE';

export interface DocumentAddress {
  lines: string[];
  state: string;
}

export interface DocumentLine {
  no: string;
  description: string;
  sku: string;
  taxCategory: string;
  hsn: string;
  quantity: string;
  unit: string;
  rate: string;
  rateNote: string;
  discount: string[];
  taxable: string;
  /** Component labels with their stored rate and amount, or a single treatment label when no tax was charged. */
  tax: { label: string; amount: string | null }[];
  total: string;
}

export interface DocumentSummaryRow {
  label: string;
  value: string;
  strong?: boolean;
}

export interface InvoiceDocument {
  titleKind: DocumentTitleKind;
  title: string;
  isDemo: boolean;
  /** Shown on every demo document, on every page. Fixed wording; there is no way to turn it off. */
  demoNotice: string | null;
  /** Shown instead of the Tax Invoice title when no line carries any tax (a Bill of Supply is not supported yet). */
  notTaxInvoiceNotice: string | null;
  documentNumber: string;
  invoiceDate: string;
  financialYear: string;
  seller: { name: string; tradeName: string | null; address: string[]; gstin: string };
  customer: {
    name: string;
    code: string;
    gstin: string | null;
    recipientClass: string;
    billing: DocumentAddress;
    shipping: DocumentAddress | null;
  };
  placeOfSupply: { state: string; code: string; text: string };
  supply: 'INTRA' | 'INTER' | null;
  lines: DocumentLine[];
  summary: DocumentSummaryRow[];
  grandTotal: string;
  amountInWords: string | null;
  notes: string[];
  postedBy: string;
}

export const DEMO_MARK = 'DEMO';
export const DEMO_NOTICE = 'NOT A PRODUCTION TAX INVOICE';

export const stateLabel = (code: string): string => INDIA_STATE_CODES[code] ?? code;

/** "2026-10-20" -> "20-10-2026". */
export function displayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

const isZero = (v: string) => /^-?0+(\.0+)?$/.test(v);

function addressOf(a: {
  addressLine1: string;
  addressLine2: string | null;
  city: string | null;
  stateCode: string;
  pinCode: string | null;
}): DocumentAddress {
  return {
    lines: [a.addressLine1, a.addressLine2, [a.city, a.pinCode].filter(Boolean).join(' ')].filter(
      (x): x is string => Boolean(x),
    ),
    state: `${stateLabel(a.stateCode)} (${a.stateCode})`,
  };
}

function lineOf(l: InvoiceLineView): DocumentLine {
  const comps: { label: string; amount: string | null }[] = [];
  const add = (name: string, rate: string | null, amount: string) => {
    if (rate !== null)
      comps.push({ label: `${name} ${formatRate(rate)}`, amount: formatMoney(amount) });
  };
  add('CGST', l.cgstRate, l.cgstAmount);
  add('SGST', l.sgstRate, l.sgstAmount);
  add('UTGST', l.utgstRate, l.utgstAmount);
  add('IGST', l.igstRate, l.igstAmount);
  if (comps.length === 0) {
    const treatment =
      l.classification === 'NIL_RATED'
        ? 'Nil rated'
        : l.classification === 'EXEMPT'
          ? 'Exempt'
          : l.classification === 'NON_GST'
            ? 'Non-GST'
            : 'No tax charged';
    comps.push({ label: treatment, amount: null });
  }
  const discount: string[] = [];
  if (l.discountType === 'PERCENT') discount.push(formatRate(l.discountPercent));
  if (l.discountType !== 'NONE') discount.push(`-${formatMoney(l.discountAmount)}`);
  return {
    no: String(l.lineNo),
    description: l.productName,
    sku: l.sku,
    taxCategory: l.taxCategoryName,
    // goods carry an HSN code: the column header says HSN/SAC, so only a SAC code is labelled
    hsn: l.hsnSacCode ? (l.hsnSacKind === 'SAC' ? `SAC ${l.hsnSacCode}` : l.hsnSacCode) : '-',
    quantity: l.quantity,
    unit: l.unitCode,
    rate: formatMoney(l.unitPrice),
    rateNote: l.priceBasis === 'INCLUSIVE' ? 'incl. GST' : '',
    discount: discount.length > 0 ? discount : ['-'],
    taxable: formatMoney(l.taxableValue),
    tax: comps,
    total: formatMoney(l.lineTotal),
  };
}

/** Builds the document from a (validated) snapshot. Pure and deterministic. */
export function buildInvoiceDocument(inv: InvoiceView): InvoiceDocument {
  const t = inv.totals;
  const taxed = inv.lines.some(
    (l) =>
      l.cgstRate !== null || l.sgstRate !== null || l.utgstRate !== null || l.igstRate !== null,
  );
  const titleKind: DocumentTitleKind = inv.isDemo
    ? 'DEMO'
    : taxed
      ? 'TAX_INVOICE'
      : 'NO_TAX_NOT_TAX_INVOICE';
  const title =
    titleKind === 'DEMO' ? 'DEMO INVOICE' : titleKind === 'TAX_INVOICE' ? 'TAX INVOICE' : 'INVOICE';

  const rows: DocumentSummaryRow[] = [
    { label: 'Gross amount', value: formatMoney(t.grossSubtotal) },
  ];
  if (!isZero(t.lineDiscountTotal))
    rows.push({ label: 'Discounts', value: `-${formatMoney(t.lineDiscountTotal)}` });
  rows.push({ label: 'Taxable value', value: formatMoney(t.taxableSubtotal), strong: true });
  const has = (pick: (l: InvoiceLineView) => string | null) =>
    inv.lines.some((l) => pick(l) !== null);
  if (has((l) => l.cgstRate)) rows.push({ label: 'CGST', value: formatMoney(t.cgst) });
  if (has((l) => l.sgstRate)) rows.push({ label: 'SGST', value: formatMoney(t.sgst) });
  if (has((l) => l.utgstRate)) rows.push({ label: 'UTGST', value: formatMoney(t.utgst) });
  if (has((l) => l.igstRate)) rows.push({ label: 'IGST', value: formatMoney(t.igst) });
  if (!taxed) rows.push({ label: 'GST', value: 'No tax charged' });
  if (!isZero(t.roundingAdjustmentTotal))
    rows.push({ label: 'Rounding adjustment', value: formatMoney(t.roundingAdjustmentTotal) });
  if (!isZero(t.roundOff)) rows.push({ label: 'Round off', value: formatMoney(t.roundOff) });

  const supplyRaw = (inv.tax.calculation as { supply?: unknown }).supply;
  // the supply kind only explains which taxes apply, so it is not shown on a document where no tax is charged
  const supply = taxed && (supplyRaw === 'INTRA' || supplyRaw === 'INTER') ? supplyRaw : null;
  const billing = addressOf(inv.customer.billing);
  const shipping = addressOf(inv.customer.shipping);
  const sameAddress = JSON.stringify(billing) === JSON.stringify(shipping);

  return {
    titleKind,
    title,
    isDemo: inv.isDemo,
    demoNotice: inv.isDemo ? DEMO_NOTICE : null,
    notTaxInvoiceNotice:
      titleKind === 'NO_TAX_NOT_TAX_INVOICE'
        ? 'No tax is charged on any line of this document. A Bill of Supply is not supported yet, so this document is not labelled a Tax Invoice.'
        : null,
    documentNumber: inv.documentNumber,
    invoiceDate: displayDate(inv.invoiceDate),
    financialYear: inv.financialYearLabel,
    seller: {
      name: inv.seller.legalName,
      tradeName:
        inv.seller.tradeName && inv.seller.tradeName !== inv.seller.legalName
          ? inv.seller.tradeName
          : null,
      address: [
        inv.seller.addressLine1,
        inv.seller.addressLine2,
        [inv.seller.city, inv.seller.pinCode].filter(Boolean).join(' '),
        `${stateLabel(inv.seller.stateCode)} (${inv.seller.stateCode})`,
      ].filter((x): x is string => Boolean(x)),
      gstin: inv.seller.gstin,
    },
    customer: {
      name: inv.customer.name,
      code: inv.customer.code,
      gstin: inv.customer.gstin,
      recipientClass: inv.customer.recipientClass,
      billing,
      shipping: sameAddress ? null : shipping,
    },
    placeOfSupply: {
      state: stateLabel(inv.placeOfSupply.stateCode),
      code: inv.placeOfSupply.stateCode,
      text: `${stateLabel(inv.placeOfSupply.stateCode)} (${inv.placeOfSupply.stateCode})`,
    },
    supply,
    lines: inv.lines.map(lineOf),
    summary: rows,
    grandTotal: formatMoney(t.grandTotal),
    amountInWords: amountInWords(t.grandTotal),
    postedBy: inv.createdByName,
    notes: [
      'Amounts are in Indian Rupees (INR).',
      ...(supply === 'INTER' ? ['Inter-state supply: IGST applies.'] : []),
      ...(supply === 'INTRA' ? ['Intra-state supply: CGST and SGST/UTGST apply.'] : []),
    ],
  };
}

/** A safe default file name derived only from the immutable document number. */
export function invoiceFileName(doc: { documentNumber: string; isDemo: boolean }): string {
  // eslint-disable-next-line no-control-regex
  let base = doc.documentNumber.replace(/[\u0000-\u001f\u007f]/g, '');
  base = base
    .replace(/[^A-Za-z0-9._-]+/g, '-') // separators, spaces, slashes, backslashes, colons, quotes ... all become "-"
    .replace(/\.{2,}/g, '.') // no ".." sequence survives
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (base === '') base = 'invoice';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = `invoice-${base}`; // Windows reserved device names
  if (doc.isDemo && !/^DEMO/i.test(base)) base = `DEMO-${base}`;
  return `${base.slice(0, 80)}.pdf`;
}
