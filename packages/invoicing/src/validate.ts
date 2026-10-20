/**
 * Pure validation of invoice preview/post requests (shape only: every business rule runs on the server against the authoritative
 * facts). Problems carry a field path and a stable rule code, never a submitted value.
 *
 * The request never contains prices, tax rates, totals or an organization: the unit price comes from the Product, the rate from the
 * effective-dated tax tables, the totals from the TaxEngine and the organization from the session (D9; ADR-0024).
 */
import { canonicalQuantity, parseQuantity } from '@commercebill/inventory-engine/browser';
import { canonicalJson, sha256Hex } from '@commercebill/tax-engine';
import type {
  InvoiceCalculationIdentity,
  InvoiceDiscountInput,
  InvoiceMode,
} from '@commercebill/shared-types';

export interface Problem {
  field: string;
  rule: string;
}

export const MAX_INVOICE_LINES = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const AMOUNT = /^\d{1,16}(\.\d{1,4})?$/;

export interface InvoiceLineRequest {
  productId: string;
  /** Canonical decimal text (unit decimal places are checked against the product later). */
  quantity: string;
  discount: InvoiceDiscountInput;
}

export interface PlaceOfSupplyRequest {
  stateCode: string;
  /** CONFIRMED = the user accepts the suggestion; OVERRIDE = the user chose this state explicitly. */
  choice: 'CONFIRMED' | 'OVERRIDE';
}

export interface InvoiceRequest {
  mode: InvoiceMode;
  customerId: string;
  invoiceDate?: string;
  lines: InvoiceLineRequest[];
  placeOfSupply?: PlaceOfSupplyRequest;
}

export interface PostInvoiceRequest extends InvoiceRequest {
  operationId: string;
  placeOfSupply: PlaceOfSupplyRequest;
  calculation: InvoiceCalculationIdentity;
}

type Result<T> = { ok: true; value: T } | { ok: false; problems: Problem[] };
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function realDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  try {
    return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  } catch {
    return false;
  }
}

function checkKeys(
  o: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  add: (f: string, r: string) => void,
) {
  for (const k of Object.keys(o))
    if (!allowed.includes(k)) add(prefix ? `${prefix}.${k}` : k, 'unknown_field');
}

function parseDiscount(
  raw: unknown,
  path: string,
  add: (f: string, r: string) => void,
): InvoiceDiscountInput {
  if (raw === undefined || raw === null) return { type: 'NONE' };
  if (!isObj(raw)) {
    add(path, 'invalid_type');
    return { type: 'NONE' };
  }
  if (raw.type === 'NONE') {
    checkKeys(raw, ['type'], path, add);
    return { type: 'NONE' };
  }
  if (raw.type === 'PERCENT') {
    checkKeys(raw, ['type', 'percent'], path, add);
    if (typeof raw.percent !== 'string' || !AMOUNT.test(raw.percent.trim()))
      add(`${path}.percent`, 'invalid_amount');
    return { type: 'PERCENT', percent: String(raw.percent ?? '').trim() };
  }
  if (raw.type === 'AMOUNT') {
    checkKeys(raw, ['type', 'amount'], path, add);
    if (typeof raw.amount !== 'string' || !AMOUNT.test(raw.amount.trim()))
      add(`${path}.amount`, 'invalid_amount');
    return { type: 'AMOUNT', amount: String(raw.amount ?? '').trim() };
  }
  add(`${path}.type`, 'invalid_choice');
  return { type: 'NONE' };
}

function parseCommon(
  raw: Record<string, unknown>,
  add: (f: string, r: string) => void,
): InvoiceRequest {
  const mode = raw.mode;
  if (mode === undefined || mode === null || mode === '') add('mode', 'required');
  else if (mode !== 'DEMO' && mode !== 'PRODUCTION') add('mode', 'invalid_choice');

  const customerId =
    typeof raw.customerId === 'string' && UUID.test(raw.customerId)
      ? raw.customerId.toLowerCase()
      : '';
  if (raw.customerId === undefined || raw.customerId === null || raw.customerId === '')
    add('customerId', 'required');
  else if (!customerId) add('customerId', 'invalid_reference');

  let invoiceDate: string | undefined;
  if (raw.invoiceDate !== undefined && raw.invoiceDate !== null) {
    if (typeof raw.invoiceDate !== 'string' || !realDate(raw.invoiceDate))
      add('invoiceDate', 'invalid_date');
    else invoiceDate = raw.invoiceDate;
  }

  const lines: InvoiceLineRequest[] = [];
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) add('lines', 'required');
  else if (raw.lines.length > MAX_INVOICE_LINES) add('lines', 'too_many_lines');
  else {
    raw.lines.forEach((l: unknown, i: number) => {
      const p = `lines[${i}]`;
      if (!isObj(l)) {
        add(p, 'invalid_type');
        return;
      }
      checkKeys(l, ['productId', 'quantity', 'discount'], p, add);
      let productId = '';
      if (l.productId === undefined || l.productId === null || l.productId === '')
        add(`${p}.productId`, 'required');
      else if (typeof l.productId !== 'string' || !UUID.test(l.productId))
        add(`${p}.productId`, 'invalid_reference');
      else productId = l.productId.toLowerCase();
      let quantity = '';
      const q = parseQuantity(l.quantity, 4);
      if (q.ok) quantity = canonicalQuantity(q.value);
      else add(`${p}.quantity`, q.rule);
      lines.push({
        productId,
        quantity,
        discount: parseDiscount(l.discount, `${p}.discount`, add),
      });
    });
  }

  let placeOfSupply: PlaceOfSupplyRequest | undefined;
  if (raw.placeOfSupply !== undefined && raw.placeOfSupply !== null) {
    const pos = raw.placeOfSupply;
    if (!isObj(pos)) add('placeOfSupply', 'invalid_type');
    else {
      checkKeys(pos, ['stateCode', 'choice'], 'placeOfSupply', add);
      if (typeof pos.stateCode !== 'string' || !/^[0-9]{2}$/.test(pos.stateCode))
        add('placeOfSupply.stateCode', 'invalid_state_code');
      if (pos.choice !== 'CONFIRMED' && pos.choice !== 'OVERRIDE')
        add('placeOfSupply.choice', 'invalid_choice');
      if (
        typeof pos.stateCode === 'string' &&
        (pos.choice === 'CONFIRMED' || pos.choice === 'OVERRIDE')
      )
        placeOfSupply = { stateCode: pos.stateCode, choice: pos.choice };
    }
  }

  return {
    mode: mode === 'PRODUCTION' ? 'PRODUCTION' : 'DEMO',
    customerId,
    ...(invoiceDate ? { invoiceDate } : {}),
    lines,
    ...(placeOfSupply ? { placeOfSupply } : {}),
  };
}

export function validatePreviewRequest(raw: Record<string, unknown>): Result<InvoiceRequest> {
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });
  checkKeys(raw, ['mode', 'customerId', 'invoiceDate', 'lines', 'placeOfSupply'], '', add);
  const value = parseCommon(raw, add);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value };
}

export function validatePostRequest(raw: Record<string, unknown>): Result<PostInvoiceRequest> {
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });
  checkKeys(
    raw,
    ['mode', 'customerId', 'invoiceDate', 'lines', 'placeOfSupply', 'operationId', 'calculation'],
    '',
    add,
  );
  const common = parseCommon(raw, add);

  let operationId = '';
  if (raw.operationId === undefined || raw.operationId === null || raw.operationId === '')
    add('operationId', 'required');
  else if (typeof raw.operationId !== 'string' || !UUID.test(raw.operationId))
    add('operationId', 'invalid_reference');
  else operationId = raw.operationId.toLowerCase();

  // Posting needs an EXPLICIT place-of-supply choice: opening a preview is never a confirmation.
  if (!common.placeOfSupply && raw.placeOfSupply === undefined) add('placeOfSupply', 'required');

  let calculation: InvoiceCalculationIdentity = {
    inputHash: '',
    configurationFingerprint: '',
    grandTotal: '',
  };
  const c = raw.calculation;
  if (c === undefined || c === null) add('calculation', 'required');
  else if (!isObj(c)) add('calculation', 'invalid_type');
  else {
    checkKeys(c, ['inputHash', 'configurationFingerprint', 'grandTotal'], 'calculation', add);
    if (typeof c.inputHash !== 'string' || !HEX64.test(c.inputHash))
      add('calculation.inputHash', 'invalid_value');
    if (typeof c.configurationFingerprint !== 'string' || !HEX64.test(c.configurationFingerprint))
      add('calculation.configurationFingerprint', 'invalid_value');
    if (typeof c.grandTotal !== 'string' || !/^\d+\.\d{2}$/.test(c.grandTotal))
      add('calculation.grandTotal', 'invalid_amount');
    calculation = {
      inputHash: String(c.inputHash ?? ''),
      configurationFingerprint: String(c.configurationFingerprint ?? ''),
      grandTotal: String(c.grandTotal ?? ''),
    };
  }
  if (problems.length > 0 || !common.placeOfSupply) return { ok: false, problems };
  return {
    ok: true,
    value: { ...common, placeOfSupply: common.placeOfSupply, operationId, calculation },
  };
}

/**
 * The canonical content of a posting request, hashed and stored on the immutable invoice. A retry with the same operation id must
 * carry the same content; the calculation identity is a freshness token, not content, so it is not part of it.
 */
export function requestFingerprint(r: PostInvoiceRequest): string {
  return sha256Hex(
    canonicalJson({
      mode: r.mode,
      customerId: r.customerId,
      invoiceDate: r.invoiceDate ?? null,
      lines: r.lines.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        discount: l.discount,
      })),
      placeOfSupply: r.placeOfSupply,
    }),
  );
}
