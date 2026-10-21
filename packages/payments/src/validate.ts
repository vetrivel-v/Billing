/**
 * Pure validation of a payment request (shape and form only; the balance, the invoice, the date and the mode are checked by the
 * server against the database). Problems carry a field path and a stable rule code, never a submitted value.
 *
 * The request never contains a balance, an amount already paid, a customer or an organization: the customer comes from the
 * invoice, the balance from the allocations, the organization from the session.
 */
import type { InvoiceMode, PaymentMethod } from '@commercebill/shared-types';

export interface Problem {
  field: string;
  rule: string;
}

export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'CASH',
  'BANK_TRANSFER',
  'UPI',
  'CARD',
  'CHEQUE',
  'OTHER',
];
/** These methods need a reference the business can trace: a transfer or UPI reference, a cheque number. */
export const REFERENCE_REQUIRED: readonly PaymentMethod[] = ['BANK_TRANSFER', 'UPI', 'CHEQUE'];
export const MAX_REFERENCE = 60;
export const MAX_NOTES = 500;

export interface RecordPaymentRequest {
  mode: InvoiceMode;
  invoiceId: string;
  /** Plain decimal text with at most two places, greater than zero. */
  amount: string;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  /** Optional; when present it must be today's business date (checked by the server). */
  paymentDate: string | null;
  operationId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^\d{1,16}(\.\d{1,2})?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const KEYS = [
  'mode',
  'invoiceId',
  'amount',
  'method',
  'reference',
  'notes',
  'paymentDate',
  'operationId',
] as const;

/** Luhn check: a long digit string that passes it looks like a card number and is refused (a card number must never be stored). */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function looksLikeCardNumber(reference: string): boolean {
  const stripped = reference.replace(/[\s-]/g, '');
  return /^\d{13,19}$/.test(stripped) && luhn(stripped);
}

function realDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  try {
    return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  } catch {
    return false;
  }
}

const isZero = (v: string) => /^0+(\.0+)?$/.test(v);

export function validateRecordRequest(
  raw: Record<string, unknown>,
): { ok: true; value: RecordPaymentRequest } | { ok: false; problems: Problem[] } {
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });
  for (const k of Object.keys(raw))
    if (!(KEYS as readonly string[]).includes(k)) add(k, 'unknown_field');

  const mode = raw.mode;
  if (mode === undefined || mode === null || mode === '') add('mode', 'required');
  else if (mode !== 'DEMO' && mode !== 'PRODUCTION') add('mode', 'invalid_choice');

  let invoiceId = '';
  if (raw.invoiceId === undefined || raw.invoiceId === null || raw.invoiceId === '')
    add('invoiceId', 'required');
  else if (typeof raw.invoiceId !== 'string' || !UUID.test(raw.invoiceId))
    add('invoiceId', 'invalid_reference');
  else invoiceId = raw.invoiceId.toLowerCase();

  let operationId = '';
  if (raw.operationId === undefined || raw.operationId === null || raw.operationId === '')
    add('operationId', 'required');
  else if (typeof raw.operationId !== 'string' || !UUID.test(raw.operationId))
    add('operationId', 'invalid_reference');
  else operationId = raw.operationId.toLowerCase();

  let amount = '';
  if (raw.amount === undefined || raw.amount === null || raw.amount === '')
    add('amount', 'required');
  else if (typeof raw.amount !== 'string') add('amount', 'invalid_amount');
  else {
    const a = raw.amount.trim();
    if (/^\d{1,16}\.\d{3,}$/.test(a)) add('amount', 'too_many_decimals');
    else if (!AMOUNT.test(a)) add('amount', 'invalid_amount');
    else if (isZero(a)) add('amount', 'amount_must_be_positive');
    else amount = a.includes('.') ? a : `${a}.00`;
    if (amount.includes('.')) {
      const [w, f = ''] = amount.split('.');
      amount = `${w!.replace(/^0+(?=\d)/, '')}.${f.padEnd(2, '0')}`;
    }
  }

  let method: PaymentMethod = 'OTHER';
  if (raw.method === undefined || raw.method === null || raw.method === '')
    add('method', 'required');
  else if (
    typeof raw.method !== 'string' ||
    !(PAYMENT_METHODS as readonly string[]).includes(raw.method)
  )
    add('method', 'invalid_choice');
  else method = raw.method as PaymentMethod;

  let reference: string | null = null;
  if (raw.reference !== undefined && raw.reference !== null) {
    if (typeof raw.reference !== 'string') add('reference', 'invalid_type');
    else {
      const r = raw.reference.trim();
      if (r.length > MAX_REFERENCE) add('reference', 'too_long');
      else if (CONTROL.test(r)) add('reference', 'invalid_characters');
      else if (looksLikeCardNumber(r)) add('reference', 'looks_like_card_number');
      else if (r !== '') reference = r;
    }
  }
  if (
    reference === null &&
    (REFERENCE_REQUIRED as readonly string[]).includes(method) &&
    !problems.some((p) => p.field === 'reference')
  )
    add('reference', 'required_for_method');

  let notes: string | null = null;
  if (raw.notes !== undefined && raw.notes !== null) {
    if (typeof raw.notes !== 'string') add('notes', 'invalid_type');
    else {
      const n = raw.notes.trim();
      if (n.length > MAX_NOTES) add('notes', 'too_long');
      else if (CONTROL.test(n)) add('notes', 'invalid_characters');
      else if (n !== '') notes = n;
    }
  }

  let paymentDate: string | null = null;
  if (raw.paymentDate !== undefined && raw.paymentDate !== null) {
    if (typeof raw.paymentDate !== 'string' || !realDate(raw.paymentDate))
      add('paymentDate', 'invalid_date');
    else paymentDate = raw.paymentDate;
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      mode: mode as InvoiceMode,
      invoiceId,
      amount,
      method,
      reference,
      notes,
      paymentDate,
      operationId,
    },
  };
}
