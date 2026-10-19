import {
  DOCUMENT_TYPES,
  previewNumber,
  validateSequenceConfig,
} from '@commercebill/numbering/browser';
import {
  FY_MAX_YEAR,
  FY_MIN_YEAR,
  INDIA_STATE_CODES,
  checkGstinStructure,
  financialYearBounds,
  isValidPanFormat,
  isValidPinCode,
  parseIsoDate,
  type GstStatus,
} from '@commercebill/setup/browser';
import { passwordRuleText } from '../messages.js';

/**
 * The wizard collects ONLY what the Task 1.4/1.5 setup API accepts. Master-specification fields the backend does
 * not store (business phone/email/website, country, bank and UPI details, backup destination) are deliberately absent:
 * the UI never collects a value the server would silently discard. See UNSUPPORTED_AT_SETUP below.
 */
export const STEPS = [
  { key: 'welcome', label: 'Welcome' },
  { key: 'business', label: 'Business details' },
  { key: 'address', label: 'Address & location' },
  { key: 'gst', label: 'GST registration' },
  { key: 'fy', label: 'Financial year' },
  { key: 'numbering', label: 'Invoice numbering' },
  { key: 'admin', label: 'Administrator' },
  { key: 'review', label: 'Review & complete' },
] as const;
export type StepKey = (typeof STEPS)[number]['key'];

/** Shown on the review page so nobody assumes these were captured or are active. */
export const UNSUPPORTED_AT_SETUP = [
  'Business phone, email and website',
  'Bank account and UPI payment details',
  'Backup destination (production backup arrives in a later release; no backups are active yet)',
] as const;

export interface WizardForm {
  business: { legalName: string; tradeName: string; businessType: string; pan: string };
  address: {
    locationName: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    stateCode: string;
    pinCode: string;
  };
  warehouse: { code: string; name: string };
  gst: { status: '' | GstStatus; gstin: string };
  fy: { startDate: string };
  numbering: { invoicePrefix: string; invoiceStartNumber: string; numericWidth: string };
  admin: {
    displayName: string;
    username: string;
    email: string;
    password: string;
    confirmPassword: string;
  };
}

/** India's financial year starts on 1 April; the wizard proposes the one containing `today`. */
export function defaultFyStart(today: Date): string {
  const year = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return `${year}-04-01`;
}

export const DEFAULT_INVOICE_PREFIX = DOCUMENT_TYPES.INVOICE.defaultPrefix;

export function emptyForm(today: Date = new Date()): WizardForm {
  return {
    business: { legalName: '', tradeName: '', businessType: '', pan: '' },
    address: {
      locationName: '',
      addressLine1: '',
      addressLine2: '',
      city: '',
      stateCode: '',
      pinCode: '',
    },
    warehouse: { code: '', name: '' },
    gst: { status: '', gstin: '' },
    fy: { startDate: defaultFyStart(today) },
    numbering: {
      invoicePrefix: DEFAULT_INVOICE_PREFIX,
      invoiceStartNumber: '1',
      numericWidth: '6',
    },
    admin: { displayName: '', username: '', email: '', password: '', confirmPassword: '' },
  };
}

export const STATE_OPTIONS = Object.entries(INDIA_STATE_CODES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

const t = (s: string) => s.trim();
const WAREHOUSE_CODE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;
const USERNAME = /^[a-z0-9][a-z0-9._@-]{2,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DIGITS = /^\d{1,15}$/;

export const MIN_PASSWORD_LENGTH = 12;

// ----------------------------------------------------------------------------------------------- messages

const RULE_TEXT: Record<string, string> = {
  required: 'This field is required.',
  invalid_pan_format: 'PAN must be 10 characters in the form ABCDE1234F.',
  gstin_required: 'Enter the GSTIN of a registered business.',
  gstin_not_allowed: 'An unregistered business has no GSTIN. Remove it or change the registration.',
  unknown_state_code: 'Choose a state from the list.',
  invalid_gstin_format: 'This GSTIN is not in the correct format. Check each character.',
  invalid_gstin_checksum: 'This GSTIN has a wrong check character. Check each character.',
  gstin_state_mismatch: 'The first two digits of the GSTIN must match the state you chose.',
  gstin_pan_mismatch: 'The PAN inside the GSTIN does not match the PAN you entered.',
  invalid_pin_code: 'PIN code must be 6 digits and must not start with 0.',
  invalid_warehouse_code:
    'Use capital letters, digits, hyphen or underscore (up to 30 characters).',
  invalid_date: 'Enter a valid date.',
  date_out_of_range: `Choose a year between ${FY_MIN_YEAR} and ${FY_MAX_YEAR}.`,
  invalid_prefix: 'Use letters, digits, / . _ - and the {FY} token only (up to 40 characters).',
  invalid_width: 'Choose a width from 1 to 18 digits.',
  invalid_start_number: 'The starting number must be 1 or more.',
  start_number_exceeds_width: 'The starting number has more digits than the chosen width.',
  format_not_unique_across_years:
    'Include {FY} in the prefix so numbers stay unique when the financial year changes.',
  invalid_username:
    'Use 3-64 characters: lower-case letters, digits, dot, underscore, hyphen or @.',
  invalid_email: 'Enter a valid email address.',
  password_too_short: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  passwords_differ: 'The two passwords do not match.',
};
const GENERIC = 'This value is not acceptable.';

/** User wording for a (field, rule) pair from the client or the server. Never echoes server text or values. */
export function ruleText(field: string, rule: string): string {
  if (field === 'administrator.password' && !RULE_TEXT[rule]) return passwordRuleText(rule);
  return RULE_TEXT[rule] ?? GENERIC;
}

// ---------------------------------------------------------------------------------------------- field map

/** Which wizard step owns a server/client field path. */
export function stepForField(field: string): StepKey | null {
  if (
    field === 'business.legalName' ||
    field === 'business.pan' ||
    field.startsWith('business.tradeName') ||
    field === 'business.businessType'
  )
    return 'business';
  if (
    field === 'business.stateCode' ||
    field.startsWith('location.') ||
    field.startsWith('warehouse.')
  )
    return 'address';
  if (field === 'business.gstStatus' || field === 'business.gstin') return 'gst';
  if (field.startsWith('financialYear.')) return 'fy';
  if (field.startsWith('numbering.')) return 'numbering';
  if (field.startsWith('administrator.') || field === 'confirmPassword') return 'admin';
  return null;
}

export type FieldErrors = Record<string, string>;

const FIELD_LABELS: Record<string, string> = {
  'business.legalName': 'Legal business name',
  'business.pan': 'PAN',
  'business.stateCode': 'State',
  'business.gstStatus': 'GST registration status',
  'business.gstin': 'GSTIN',
  'location.addressLine1': 'Address line 1',
  'location.pinCode': 'PIN code',
  'warehouse.code': 'Warehouse code',
  'financialYear.startDate': 'Financial year start',
  'numbering.invoicePrefix': 'Invoice prefix',
  'numbering.invoiceStartNumber': 'First invoice number',
  'numbering.numericWidth': 'Number width',
  'administrator.displayName': 'Administrator name',
  'administrator.username': 'Username',
  'administrator.email': 'Email',
  'administrator.password': 'Password',
  confirmPassword: 'Confirm password',
};

/** Error-summary lines that say WHICH field each message belongs to ("Legal business name: This field is required."). */
export function describeErrors(errors: FieldErrors): string[] {
  return Object.entries(errors).map(([field, text]) =>
    FIELD_LABELS[field] ? `${FIELD_LABELS[field]}: ${text}` : text,
  );
}

// ---------------------------------------------------------------------------------------------- numbering

function numberingConfig(form: WizardForm) {
  const width = DIGITS.test(t(form.numbering.numericWidth))
    ? Number(t(form.numbering.numericWidth))
    : NaN;
  const start = DIGITS.test(t(form.numbering.invoiceStartNumber))
    ? BigInt(t(form.numbering.invoiceStartNumber))
    : 0n;
  return {
    prefix: t(form.numbering.invoicePrefix) || DEFAULT_INVOICE_PREFIX,
    suffix: '',
    numericLength: width,
    startNumber: start,
    resetPolicy: 'FINANCIAL_YEAR' as const,
  };
}

export function financialYearSummary(
  startDate: string,
): { label: string; start: string; end: string } | null {
  const start = parseIsoDate(t(startDate));
  if (!start || start.getUTCFullYear() < FY_MIN_YEAR || start.getUTCFullYear() > FY_MAX_YEAR)
    return null;
  const b = financialYearBounds(start);
  const fmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeZone: 'UTC' });
  return { label: b.label, start: fmt.format(b.start), end: fmt.format(b.end) };
}

/**
 * What the next invoice number WOULD look like. Pure formatting: it never contacts the server and never consumes a
 * number (numbers are only issued when a document is posted).
 */
export function invoicePreview(form: WizardForm): { text: string } | { error: string } {
  const fy = financialYearSummary(form.fy.startDate);
  if (!fy) return { error: 'Choose a valid financial year to see the example.' };
  const cfg = numberingConfig(form);
  if (validateSequenceConfig(cfg).length > 0)
    return { error: 'Fix the numbering fields to see the example.' };
  return { text: previewNumber(cfg, fy.label) };
}

// ----------------------------------------------------------------------------------------------- validation

/** Early feedback with the same rules as the server (which stays authoritative and re-checks everything). */
export function validateForm(form: WizardForm): FieldErrors {
  const e: FieldErrors = {};
  const set = (field: string, rule: string) => {
    if (!e[field]) e[field] = ruleText(field, rule);
  };

  if (!t(form.business.legalName)) set('business.legalName', 'required');
  const pan = t(form.business.pan).toUpperCase();
  if (pan && !isValidPanFormat(pan)) set('business.pan', 'invalid_pan_format');

  if (!t(form.address.addressLine1)) set('location.addressLine1', 'required');
  if (!form.address.stateCode) set('business.stateCode', 'required');
  else if (!INDIA_STATE_CODES[form.address.stateCode])
    set('business.stateCode', 'unknown_state_code');
  const pin = t(form.address.pinCode);
  if (pin && !isValidPinCode(pin)) set('location.pinCode', 'invalid_pin_code');
  const wh = t(form.warehouse.code).toUpperCase();
  if (wh && !WAREHOUSE_CODE.test(wh)) set('warehouse.code', 'invalid_warehouse_code');

  const status = form.gst.status;
  const gstin = t(form.gst.gstin).toUpperCase();
  if (!status) set('business.gstStatus', 'required');
  if (status === 'REGISTERED' && !gstin) set('business.gstin', 'gstin_required');
  if (status === 'UNREGISTERED' && gstin) set('business.gstin', 'gstin_not_allowed');
  if (gstin && status && status !== 'UNREGISTERED') {
    const structural = checkGstinStructure(gstin);
    if (structural) set('business.gstin', structural);
    else {
      if (form.address.stateCode && gstin.slice(0, 2) !== form.address.stateCode)
        set('business.gstin', 'gstin_state_mismatch');
      if (pan && gstin.slice(2, 12) !== pan) set('business.gstin', 'gstin_pan_mismatch');
    }
  }

  const start = parseIsoDate(t(form.fy.startDate));
  if (!start) set('financialYear.startDate', 'invalid_date');
  else if (start.getUTCFullYear() < FY_MIN_YEAR || start.getUTCFullYear() > FY_MAX_YEAR)
    set('financialYear.startDate', 'date_out_of_range');

  const cfg = numberingConfig(form);
  for (const p of validateSequenceConfig(cfg)) {
    const field =
      p.field === 'startNumber'
        ? 'numbering.invoiceStartNumber'
        : p.field === 'numericLength'
          ? 'numbering.numericWidth'
          : 'numbering.invoicePrefix';
    set(field, p.rule);
  }

  if (!t(form.admin.displayName)) set('administrator.displayName', 'required');
  const username = t(form.admin.username).toLowerCase();
  if (!username) set('administrator.username', 'required');
  else if (!USERNAME.test(username)) set('administrator.username', 'invalid_username');
  const email = t(form.admin.email);
  if (email && !EMAIL.test(email)) set('administrator.email', 'invalid_email');
  if (!form.admin.password) set('administrator.password', 'required');
  else if ([...form.admin.password].length < MIN_PASSWORD_LENGTH)
    set('administrator.password', 'password_too_short');
  if (form.admin.password && form.admin.confirmPassword !== form.admin.password)
    set('confirmPassword', 'passwords_differ');
  return e;
}

export function errorsForStep(errors: FieldErrors, step: StepKey): FieldErrors {
  return Object.fromEntries(Object.entries(errors).filter(([f]) => stepForField(f) === step));
}

/** The first step (after Welcome) that still has a problem, or null when the form is complete. */
export function firstStepWithProblems(errors: FieldErrors): StepKey | null {
  for (const s of STEPS) if (Object.keys(errorsForStep(errors, s.key)).length > 0) return s.key;
  return null;
}

// -------------------------------------------------------------------------------------------- API shapes

const opt = (s: string) => (t(s) ? t(s) : undefined);
const optInt = (s: string) => (DIGITS.test(t(s)) ? Number(t(s)) : undefined);
const clean = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** The non-secret draft. It has NO password field: the server's strict schema would reject one. */
export function buildDraftData(form: WizardForm): Record<string, unknown> {
  return {
    business: clean({
      legalName: opt(form.business.legalName),
      tradeName: opt(form.business.tradeName),
      businessType: opt(form.business.businessType),
      pan: opt(form.business.pan),
      gstStatus: form.gst.status || undefined,
      gstin: opt(form.gst.gstin),
      stateCode: opt(form.address.stateCode),
    }),
    location: clean({
      name: opt(form.address.locationName),
      addressLine1: opt(form.address.addressLine1),
      addressLine2: opt(form.address.addressLine2),
      city: opt(form.address.city),
      pinCode: opt(form.address.pinCode),
    }),
    warehouse: clean({ code: opt(form.warehouse.code), name: opt(form.warehouse.name) }),
    financialYear: clean({ startDate: opt(form.fy.startDate) }),
    numbering: clean({
      invoicePrefix: opt(form.numbering.invoicePrefix),
      invoiceStartNumber: optInt(form.numbering.invoiceStartNumber),
      numericWidth: optInt(form.numbering.numericWidth),
    }),
    administrator: clean({
      displayName: opt(form.admin.displayName),
      username: opt(form.admin.username),
      email: opt(form.admin.email),
    }),
  };
}

/** The final submission for POST /setup/complete (the only place the password is sent). */
export function buildSubmitBody(form: WizardForm): Record<string, unknown> {
  const d = buildDraftData(form) as Record<string, Record<string, unknown>>;
  return {
    business: d.business,
    location: d.location,
    warehouse: d.warehouse,
    financialYear: d.financialYear,
    numbering: d.numbering,
    administrator: { ...d.administrator, password: form.admin.password },
  };
}

type DraftBlock = Record<string, unknown> | undefined;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const numStr = (v: unknown, fallback: string) => (typeof v === 'number' ? String(v) : fallback);

/** Restores a saved draft over the defaults. The password and its confirmation are never restored. */
export function formFromDraft(
  data: Record<string, Record<string, unknown>> | undefined,
  today: Date = new Date(),
): WizardForm {
  const base = emptyForm(today);
  if (!data) return base;
  const b: DraftBlock = data.business;
  const l: DraftBlock = data.location;
  const w: DraftBlock = data.warehouse;
  const f: DraftBlock = data.financialYear;
  const n: DraftBlock = data.numbering;
  const a: DraftBlock = data.administrator;
  const status = b?.gstStatus;
  return {
    business: {
      legalName: str(b?.legalName),
      tradeName: str(b?.tradeName),
      businessType: str(b?.businessType),
      pan: str(b?.pan),
    },
    address: {
      locationName: str(l?.name),
      addressLine1: str(l?.addressLine1),
      addressLine2: str(l?.addressLine2),
      city: str(l?.city),
      stateCode: str(b?.stateCode),
      pinCode: str(l?.pinCode),
    },
    warehouse: { code: str(w?.code), name: str(w?.name) },
    gst: {
      status:
        status === 'REGISTERED' || status === 'UNREGISTERED' || status === 'COMPOSITION'
          ? status
          : '',
      gstin: str(b?.gstin),
    },
    fy: { startDate: str(f?.startDate) || base.fy.startDate },
    numbering: {
      invoicePrefix: str(n?.invoicePrefix) || base.numbering.invoicePrefix,
      invoiceStartNumber: numStr(n?.invoiceStartNumber, base.numbering.invoiceStartNumber),
      numericWidth: numStr(n?.numericWidth, base.numbering.numericWidth),
    },
    admin: {
      displayName: str(a?.displayName),
      username: str(a?.username),
      email: str(a?.email),
      password: '',
      confirmPassword: '',
    },
  };
}

/** True when the form holds anything the user typed (used to decide whether a draft is worth saving). */
export function hasContent(form: WizardForm): boolean {
  const d = buildDraftData(form) as Record<string, Record<string, unknown>>;
  const typed = (k: string, skip: string[] = []) =>
    Object.entries(d[k] ?? {}).some(([key, v]) => v !== undefined && !skip.includes(key));
  return typed('business') || typed('location') || typed('warehouse') || typed('administrator');
}
