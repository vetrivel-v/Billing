import { parseQuantity } from '@commercebill/inventory-engine/browser';
import type {
  CustomerView,
  InvoiceDiscountInput,
  InvoicePreviewResponse,
  InvoiceProblem,
  ProductView,
} from '@commercebill/shared-types';
import { ApiError, ApiUnreachableError } from '../api.js';
import { newOperationId } from '../inventory/model.js';

export { newOperationId };

// ------------------------------------------------------------------------------------------------ money (strings only)

/** Indian digit grouping for a decimal STRING ("1234567.5" -> "12,34,567.50"). No JavaScript number is involved. */
export function formatMoney(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return value;
  const [, sign, whole, frac = ''] = m;
  const last3 = whole!.slice(-3);
  const rest = whole!.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${sign}${grouped}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

export const formatRupees = (v: string | null | undefined): string =>
  v === null || v === undefined ? '-' : `₹${formatMoney(v)}`;

/** A GST rate such as "18.0000" shown as "18%". */
export function formatRate(v: string | null | undefined): string {
  if (!v) return '';
  return `${v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}%`;
}

// ------------------------------------------------------------------------------------------------ candidate invoice

export type DiscountKind = 'NONE' | 'PERCENT' | 'AMOUNT';

/** One line as typed. Everything business-related (price, rate, tax) is the server's; only choices are kept here. */
export interface LineDraft {
  key: string;
  product: ProductView;
  quantity: string;
  discountKind: DiscountKind;
  discountValue: string;
}

export interface PlaceOfSupplyChoice {
  stateCode: string;
  choice: 'CONFIRMED' | 'OVERRIDE';
}

export function discountInput(l: LineDraft): InvoiceDiscountInput {
  if (l.discountKind === 'PERCENT') return { type: 'PERCENT', percent: l.discountValue.trim() };
  if (l.discountKind === 'AMOUNT') return { type: 'AMOUNT', amount: l.discountValue.trim() };
  return { type: 'NONE' };
}

/** The request body for preview. Mode is always DEMO: there is no production switch in the UI (Task 1.17). */
export function toRequest(
  customer: CustomerView,
  lines: LineDraft[],
  pos: PlaceOfSupplyChoice | null,
): Record<string, unknown> {
  return {
    mode: 'DEMO',
    customerId: customer.id,
    lines: lines.map((l) => ({
      productId: l.product.id,
      quantity: l.quantity.trim(),
      discount: discountInput(l),
    })),
    ...(pos ? { placeOfSupply: pos } : {}),
  };
}

/**
 * One operation id per composed candidate: the same candidate (same canonical request) always reuses it - double clicks and
 * retries after an uncertain outcome - and any material edit gets a new one.
 */
export function operationIdFor(
  holder: { key: string; id: string },
  requestKey: string,
): { key: string; id: string } {
  return holder.key === requestKey ? holder : { key: requestKey, id: newOperationId() };
}

// ------------------------------------------------------------------------------------------------ early validation

export type LineErrors = { quantity?: string; discount?: string };

const AMOUNT = /^\d{1,16}(\.\d{1,4})?$/;

export function validateLine(l: LineDraft): LineErrors {
  const errors: LineErrors = {};
  const q = parseQuantity(l.quantity.trim(), l.product.unit?.decimalPlaces ?? 0);
  if (!q.ok) errors.quantity = QUANTITY_TEXT[q.rule] ?? 'Enter a valid quantity.';
  if (l.discountKind !== 'NONE') {
    const v = l.discountValue.trim();
    if (!AMOUNT.test(v)) errors.discount = 'Enter a plain number such as 10 or 25.50.';
    else if (l.discountKind === 'PERCENT' && Number(v) > 100)
      errors.discount = 'A percentage discount cannot be more than 100.';
  }
  return errors;
}

const QUANTITY_TEXT: Record<string, string> = {
  required: 'Enter a quantity.',
  invalid_quantity: 'Enter a plain number such as 2 or 1.5.',
  quantity_must_be_positive: 'Enter a quantity greater than zero.',
  unsupported_precision: 'At most four decimal places can be used.',
  too_many_decimals: 'This unit does not allow that many decimal places.',
  quantity_too_large: 'This quantity is too large.',
};

/** Why a product cannot be put on an invoice yet (null = it can). */
export function unsupportedReason(p: ProductView): string | null {
  if (p.kind !== 'GOODS') return 'Services cannot be invoiced yet. Only goods are supported.';
  if (!p.isActive) return 'This product is inactive.';
  return null;
}

// ------------------------------------------------------------------------------------------------ wording for stable codes

const PROBLEM_TEXT: Record<string, string> = {
  MIXED_PRICE_BASIS:
    'Some of these products have prices that include GST and some that do not. Put them on separate invoices; prices are never converted automatically.',
  ITEM_KIND_UNSUPPORTED:
    'Services cannot be invoiced yet. Remove this item; only goods are supported.',
  PRODUCT_NOT_FOUND: 'This product could not be found. Remove it and add it again.',
  PRODUCT_INACTIVE: 'This product is inactive. Remove it from the invoice.',
  CUSTOMER_NOT_FOUND: 'This customer could not be found. Choose the customer again.',
  CUSTOMER_INACTIVE: 'This customer is inactive. Choose another customer.',
  INVALID_QUANTITY: 'This quantity is not valid for the product’s unit.',
  INVOICE_DATE_NOT_TODAY: 'Invoices can only be dated today. Backdating is not available.',
  NO_OPEN_FINANCIAL_YEAR:
    'There is no open financial year for today’s date. Ask your administrator.',
  NO_PRIMARY_LOCATION: 'The business has no primary location set up. Ask your administrator.',
  NO_WAREHOUSE: 'The business has no warehouse set up. Ask your administrator.',
  PLACE_OF_SUPPLY_CHOICE_INVALID:
    'The place of supply you confirmed no longer matches. Choose the place of supply again.',
  PLACE_OF_SUPPLY_SELECTION_REQUIRED:
    'Billing and delivery are in different states. Choose the place of supply yourself.',
  PLACE_OF_SUPPLY_NOT_CONFIRMED: 'Confirm the place of supply for this transaction before posting.',
  PLACE_OF_SUPPLY_MISSING: 'Confirm the place of supply for this transaction.',
  PLACE_OF_SUPPLY_INVALID: 'The place of supply is not valid. Choose it again.',
  PLACE_OF_SUPPLY_OVERRIDDEN: 'You chose a place of supply different from the suggestion.',
  SELLER_NOT_SUPPORTED:
    'Your business registration type is not supported for invoices yet (only regular GST-registered sellers).',
  SELLER_GSTIN_MISSING: 'Your business GSTIN is missing. Complete it in setup.',
  SELLER_GSTIN_STATE_MISMATCH:
    'Your business GSTIN does not match its state. Ask your administrator.',
  SELLER_STATE_INVALID: 'Your business state is not valid. Ask your administrator.',
  INVOICE_DISCOUNT_UNSUPPORTED: 'Invoice-level discounts are not supported. Use line discounts.',
  CHARGES_UNSUPPORTED: 'Shipping and other charges are not supported yet.',
  CESS_UNSUPPORTED: 'Cess is not supported yet.',
  REVERSE_CHARGE_UNSUPPORTED: 'Reverse charge is not supported yet.',
  EXPORT_UNSUPPORTED: 'Exports and SEZ supplies are not supported yet.',
  ADVANCES_UNSUPPORTED: 'Advances are not supported yet.',
  TCS_TDS_UNSUPPORTED: 'TCS and TDS are not supported yet.',
  DOCUMENT_TYPE_UNSUPPORTED: 'This document type is not supported yet.',
  CLASSIFICATION_UNSUPPORTED: 'This kind of tax treatment is not supported yet.',
  HSN_SAC_REQUIRED:
    'This product needs an HSN/SAC code before it can be invoiced. Add it in Products.',
  HSN_SAC_MISSING:
    'This product needs an HSN/SAC code before it can be invoiced. Add it in Products.',
  NO_EFFECTIVE_RATE: 'No GST rate applies to this product today. Check the tax configuration.',
  TAX_CATEGORY_INACTIVE: 'This product’s tax category is inactive. Check the tax configuration.',
  TAX_CATEGORY_NOT_EFFECTIVE: 'This product’s tax category is not in effect today.',
  RATE_OUTSIDE_EFFECTIVE_WINDOW:
    'The GST rate is not in effect today. Check the tax configuration.',
  DISCOUNT_EXCEEDS_GROSS: 'The discount is more than the line amount.',
  DISCOUNT_RANGE_INVALID: 'The discount is out of range.',
  RECIPIENT_GSTIN_REQUIRED: 'This customer needs a GSTIN. Update the customer first.',
  RECIPIENT_STATE_INVALID: 'The customer’s state is not valid. Update the customer first.',
  NO_TAX_ON_ANY_LINE: 'No tax applies to any line of this invoice.',
  ZERO_TAXABLE_VALUE: 'A line has a zero taxable value.',
  NUMBER_SEQUENCE_MISSING:
    'Invoice numbering is not set up for demo invoices. Ask your administrator.',
  INSUFFICIENT_STOCK: 'There is not enough stock for this item.',
  PRODUCTION_GATE_NOT_MET:
    'Production billing is unavailable. Backup and restore verification is required first.',
  MODE_MISMATCH:
    'This business is no longer in demo billing mode, so demo invoices cannot be posted.',
  OPERATION_ID_REUSED:
    'This posting was already used for different invoice details. Review the invoice and post again.',
  CALCULATION_STALE:
    'Invoice details changed since the last preview. Review the updated totals before posting.',
};
export const FALLBACK_PROBLEM = 'This invoice cannot be calculated. Check the customer and items.';
export const problemText = (code: string): string => PROBLEM_TEXT[code] ?? FALLBACK_PROBLEM;

export function describeProblems(list: InvoiceProblem[]): string[] {
  return [...new Set(list.map((p) => problemText(p.code)))];
}

/** Outcome of an attempt to post, in the words the screen needs. */
export type PostFailure =
  | { kind: 'stale'; recalculation: InvoicePreviewResponse | null }
  | { kind: 'uncertain' }
  | { kind: 'rejected'; messages: string[] };

export function classifyPostFailure(err: unknown): PostFailure {
  if (err instanceof ApiUnreachableError) return { kind: 'uncertain' };
  if (err instanceof ApiError) {
    const rules = err.problems.map((p) => p.rule);
    if (rules.includes('CALCULATION_STALE')) {
      const r = err.details?.recalculation;
      return {
        kind: 'stale',
        recalculation: r && typeof r === 'object' ? (r as InvoicePreviewResponse) : null,
      };
    }
    if (err.status >= 500 || err.status === 0) return { kind: 'uncertain' };
    if (err.status === 403)
      return { kind: 'rejected', messages: ['You do not have permission to post invoices.'] };
    const messages = [...new Set(rules.map(problemText))];
    return {
      kind: 'rejected',
      messages:
        messages.length > 0 ? messages : ['The invoice could not be posted. Nothing was saved.'],
    };
  }
  return { kind: 'uncertain' };
}

// ------------------------------------------------------------------------------------------------ preview calculation shape

export interface CalcLine {
  lineRef: string;
  classification: string;
  rate: { ratePercent: string };
  grossAmount: string;
  discountAmount: string;
  taxableValue: string;
  components: { kind: string; ratePercent: string; amount: string }[];
  lineTotal: string;
}
export interface CalcTotals {
  grossSubtotal: string;
  lineDiscountTotal: string;
  taxableSubtotal: string;
  componentTotals: Record<string, string>;
  roundingAdjustmentTotal: string;
  roundOff: string;
  grandTotal: string;
}
export interface Calc {
  lines: CalcLine[];
  totals: CalcTotals;
  supply: 'INTRA' | 'INTER';
}
export const asCalc = (p: InvoicePreviewResponse | null): Calc | null =>
  p?.calculation && Array.isArray((p.calculation as { lines?: unknown }).lines)
    ? (p.calculation as unknown as Calc)
    : null;

export const customerContextState = (c: CustomerView) => ({
  billing: c.billingStateCode,
  shipping: c.shippingSameAsBilling
    ? c.billingStateCode
    : (c.shippingStateCode ?? c.billingStateCode),
});
