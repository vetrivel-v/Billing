import {
  INDIA_STATE_CODES,
  checkGstinStructure,
  isValidPanFormat,
  isValidPinCode,
} from '@commercebill/setup/browser';

/**
 * Pure customer validation. The server runs it on every create/update (the renderer is never trusted); the UI
 * mirrors the same rules for early feedback. Problems carry only a field name and a stable rule code - never the
 * submitted value.
 */

export const CUSTOMER_KINDS = ['INDIVIDUAL', 'BUSINESS'] as const;
export const GST_STATUSES = ['REGISTERED', 'UNREGISTERED', 'COMPOSITION'] as const;

export interface Problem {
  field: string;
  rule: string;
}

/** The fields a client may send. `code` is accepted on creation only. */
export const CUSTOMER_FIELDS = [
  'code',
  'customerKind',
  'legalName',
  'displayName',
  'contactPerson',
  'email',
  'phone',
  'alternatePhone',
  'gstStatus',
  'gstin',
  'pan',
  'billingAddressLine1',
  'billingAddressLine2',
  'billingCity',
  'billingStateCode',
  'billingPinCode',
  'shippingSameAsBilling',
  'shippingAddressLine1',
  'shippingAddressLine2',
  'shippingCity',
  'shippingStateCode',
  'shippingPinCode',
  'placeOfSupplyStateCode',
  'creditLimit',
  'paymentTermsDays',
  'notes',
] as const;
export type CustomerField = (typeof CUSTOMER_FIELDS)[number];

/** The normalised customer as stored (everything trimmed, empty -> null, identifiers upper-cased). */
export interface NormalizedCustomer {
  customerKind: 'INDIVIDUAL' | 'BUSINESS';
  legalName: string;
  displayName: string | null;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  alternatePhone: string | null;
  gstStatus: 'REGISTERED' | 'UNREGISTERED' | 'COMPOSITION';
  gstin: string | null;
  pan: string | null;
  billingAddressLine1: string;
  billingAddressLine2: string | null;
  billingCity: string | null;
  billingStateCode: string;
  billingPinCode: string | null;
  shippingSameAsBilling: boolean;
  shippingAddressLine1: string | null;
  shippingAddressLine2: string | null;
  shippingCity: string | null;
  shippingStateCode: string | null;
  shippingPinCode: string | null;
  placeOfSupplyStateCode: string;
  creditLimit: string | null;
  paymentTermsDays: number | null;
}
export type NormalizedWithNotes = NormalizedCustomer & { notes: string | null };

export const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,29}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+()\-. ]{5,20}$/;
const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

const MAX = {
  legalName: 200,
  displayName: 200,
  contactPerson: 100,
  email: 254,
  line: 200,
  city: 100,
  notes: 2000,
} as const;

function text(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return null;
  const t = v.normalize('NFC').trim();
  return t === '' ? null : t;
}

export type ValidationResult =
  | { ok: true; value: NormalizedWithNotes; code: string | null }
  | { ok: false; problems: Problem[] };

/**
 * Validates a COMPLETE customer record (for a patch the caller merges the stored values first).
 * `allowCode` = creation, where a customer code may be supplied (blank = generated).
 */
export function validateCustomer(
  raw: Record<string, unknown>,
  allowCode: boolean,
): ValidationResult {
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });

  for (const key of Object.keys(raw)) {
    if (!(CUSTOMER_FIELDS as readonly string[]).includes(key) || (key === 'code' && !allowCode)) {
      add(key, 'unknown_field');
    }
  }

  const str = (field: string, max: number, required = false): string | null => {
    const v = raw[field];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      add(field, 'invalid_type');
      return null;
    }
    const t = text(v);
    if (t === null) {
      if (required) add(field, 'required');
      return null;
    }
    if ([...t].length > max) {
      add(field, 'too_long');
      return null;
    }
    return t;
  };

  const customerKind = raw.customerKind;
  if (customerKind !== 'INDIVIDUAL' && customerKind !== 'BUSINESS')
    add('customerKind', 'invalid_value');

  const legalName = str('legalName', MAX.legalName, true);
  const displayName = str('displayName', MAX.displayName);
  const contactPerson = str('contactPerson', MAX.contactPerson);
  const email = str('email', MAX.email);
  if (email && !EMAIL.test(email)) add('email', 'invalid_email');
  const phone = str('phone', 20);
  if (phone && !PHONE.test(phone)) add('phone', 'invalid_phone');
  const alternatePhone = str('alternatePhone', 20);
  if (alternatePhone && !PHONE.test(alternatePhone)) add('alternatePhone', 'invalid_phone');
  const notes = str('notes', MAX.notes);

  const gstStatus = raw.gstStatus;
  if (!(GST_STATUSES as readonly string[]).includes(gstStatus as string))
    add('gstStatus', 'invalid_value');

  const panRaw = str('pan', 10);
  const pan = panRaw ? panRaw.toUpperCase() : null;
  if (pan && !isValidPanFormat(pan)) add('pan', 'invalid_pan_format');

  const gstinRaw = str('gstin', 15);
  const gstin = gstinRaw ? gstinRaw.toUpperCase() : null;

  const line1 = str('billingAddressLine1', MAX.line, true);
  const line2 = str('billingAddressLine2', MAX.line);
  const city = str('billingCity', MAX.city);
  const billingState = str('billingStateCode', 2, true);
  if (billingState && !INDIA_STATE_CODES[billingState])
    add('billingStateCode', 'unknown_state_code');
  const pin = str('billingPinCode', 6);
  if (pin && !isValidPinCode(pin)) add('billingPinCode', 'invalid_pin_code');

  if ((gstStatus === 'REGISTERED' || gstStatus === 'COMPOSITION') && !gstin)
    add('gstin', 'gstin_required');
  if (gstStatus === 'UNREGISTERED' && gstin) add('gstin', 'gstin_not_allowed');
  if (gstin && gstStatus !== 'UNREGISTERED') {
    const structural = checkGstinStructure(gstin);
    if (structural) add('gstin', structural);
    else {
      if (billingState && INDIA_STATE_CODES[billingState] && gstin.slice(0, 2) !== billingState) {
        add('gstin', 'gstin_state_mismatch');
      }
      if (pan && isValidPanFormat(pan) && gstin.slice(2, 12) !== pan)
        add('gstin', 'gstin_pan_mismatch');
    }
  }

  const same = raw.shippingSameAsBilling === undefined ? true : raw.shippingSameAsBilling;
  if (typeof same !== 'boolean') add('shippingSameAsBilling', 'invalid_type');
  const useSeparate = same === false;
  let sLine1: string | null = null;
  let sLine2: string | null = null;
  let sCity: string | null = null;
  let sState: string | null = null;
  let sPin: string | null = null;
  if (useSeparate) {
    sLine1 = str('shippingAddressLine1', MAX.line, true);
    sLine2 = str('shippingAddressLine2', MAX.line);
    sCity = str('shippingCity', MAX.city);
    sState = str('shippingStateCode', 2, true);
    if (sState && !INDIA_STATE_CODES[sState]) add('shippingStateCode', 'unknown_state_code');
    sPin = str('shippingPinCode', 6);
    if (sPin && !isValidPinCode(sPin)) add('shippingPinCode', 'invalid_pin_code');
  }

  // Place of supply is a stored FACT for the tax engine: default to where goods are delivered.
  const posRaw = str('placeOfSupplyStateCode', 2);
  const place = posRaw ?? (useSeparate ? sState : billingState);
  if (!place) add('placeOfSupplyStateCode', 'required');
  else if (!INDIA_STATE_CODES[place]) add('placeOfSupplyStateCode', 'unknown_state_code');

  let creditLimit: string | null = null;
  const cl = raw.creditLimit;
  if (cl !== undefined && cl !== null && cl !== '') {
    const s = typeof cl === 'number' ? String(cl) : typeof cl === 'string' ? cl.trim() : '';
    if (!AMOUNT.test(s)) add('creditLimit', 'invalid_amount');
    else creditLimit = s.includes('.') ? s : `${s}.00`;
  }
  let paymentTermsDays: number | null = null;
  const pt = raw.paymentTermsDays;
  if (pt !== undefined && pt !== null && pt !== '') {
    const n = typeof pt === 'string' && /^\d{1,3}$/.test(pt.trim()) ? Number(pt.trim()) : pt;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 365)
      add('paymentTermsDays', 'out_of_range');
    else paymentTermsDays = n;
  }

  let code: string | null = null;
  if (allowCode) {
    const c = str('code', 30);
    if (c) {
      code = c.toUpperCase();
      if (!CODE_PATTERN.test(code)) add('code', 'invalid_code');
    }
  }

  if (
    problems.length > 0 ||
    !legalName ||
    !line1 ||
    !billingState ||
    !place ||
    (customerKind !== 'INDIVIDUAL' && customerKind !== 'BUSINESS') ||
    (gstStatus !== 'REGISTERED' && gstStatus !== 'UNREGISTERED' && gstStatus !== 'COMPOSITION')
  ) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    code,
    value: {
      customerKind,
      legalName,
      displayName,
      contactPerson,
      email,
      phone,
      alternatePhone,
      gstStatus,
      gstin: gstStatus === 'UNREGISTERED' ? null : gstin,
      pan,
      billingAddressLine1: line1,
      billingAddressLine2: line2,
      billingCity: city,
      billingStateCode: billingState,
      billingPinCode: pin,
      shippingSameAsBilling: !useSeparate,
      shippingAddressLine1: sLine1,
      shippingAddressLine2: sLine2,
      shippingCity: sCity,
      shippingStateCode: sState,
      shippingPinCode: sPin,
      placeOfSupplyStateCode: place,
      creditLimit,
      paymentTermsDays,
      notes,
    },
  };
}
