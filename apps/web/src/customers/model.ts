import { validateCustomer } from '@commercebill/customers/browser';
import { INDIA_STATE_CODES } from '@commercebill/setup/browser';
import type { CustomerGstStatus, CustomerType, CustomerView } from '@commercebill/shared-types';

/** Form state: every value is a string (or boolean) exactly as typed. Conversion to the API shape is in toApiBody. */
export interface CustomerForm {
  customerType: CustomerType;
  code: string;
  legalName: string;
  displayName: string;
  contactPerson: string;
  email: string;
  phone: string;
  alternatePhone: string;
  gstStatus: CustomerGstStatus;
  gstin: string;
  pan: string;
  billingAddressLine1: string;
  billingAddressLine2: string;
  billingCity: string;
  billingStateCode: string;
  billingPinCode: string;
  shippingSameAsBilling: boolean;
  shippingAddressLine1: string;
  shippingAddressLine2: string;
  shippingCity: string;
  shippingStateCode: string;
  shippingPinCode: string;
  /** '' = "use the delivery state" (the server fills the default). */
  placeOfSupplyStateCode: string;
  creditLimit: string;
  paymentTermsDays: string;
  notes: string;
}

export function emptyCustomerForm(): CustomerForm {
  return {
    customerType: 'B2B',
    code: '',
    legalName: '',
    displayName: '',
    contactPerson: '',
    email: '',
    phone: '',
    alternatePhone: '',
    gstStatus: 'UNREGISTERED',
    gstin: '',
    pan: '',
    billingAddressLine1: '',
    billingAddressLine2: '',
    billingCity: '',
    billingStateCode: '',
    billingPinCode: '',
    shippingSameAsBilling: true,
    shippingAddressLine1: '',
    shippingAddressLine2: '',
    shippingCity: '',
    shippingStateCode: '',
    shippingPinCode: '',
    placeOfSupplyStateCode: '',
    creditLimit: '',
    paymentTermsDays: '',
    notes: '',
  };
}

const s = (v: string | null) => v ?? '';

export function formFromCustomer(c: CustomerView): CustomerForm {
  // The stored place of supply equals the delivery state unless someone chose otherwise: show "default" in that case.
  const delivery = c.shippingSameAsBilling
    ? c.billingStateCode
    : (c.shippingStateCode ?? c.billingStateCode);
  return {
    customerType: c.customerType,
    code: c.code,
    legalName: c.legalName,
    displayName: s(c.displayName),
    contactPerson: s(c.contactPerson),
    email: s(c.email),
    phone: s(c.phone),
    alternatePhone: s(c.alternatePhone),
    gstStatus: c.gstStatus,
    gstin: s(c.gstin),
    pan: s(c.pan),
    billingAddressLine1: c.billingAddressLine1,
    billingAddressLine2: s(c.billingAddressLine2),
    billingCity: s(c.billingCity),
    billingStateCode: c.billingStateCode,
    billingPinCode: s(c.billingPinCode),
    shippingSameAsBilling: c.shippingSameAsBilling,
    shippingAddressLine1: s(c.shippingAddressLine1),
    shippingAddressLine2: s(c.shippingAddressLine2),
    shippingCity: s(c.shippingCity),
    shippingStateCode: s(c.shippingStateCode),
    shippingPinCode: s(c.shippingPinCode),
    placeOfSupplyStateCode: c.placeOfSupplyStateCode === delivery ? '' : c.placeOfSupplyStateCode,
    creditLimit: s(c.creditLimit),
    paymentTermsDays: c.paymentTermsDays === null ? '' : String(c.paymentTermsDays),
    notes: s(c.notes),
  };
}

export const STATE_OPTIONS = Object.entries(INDIA_STATE_CODES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const stateName = (code: string): string | undefined => INDIA_STATE_CODES[code];

/** The delivery state: where goods go, which is also the default place of supply. */
export function deliveryStateCode(f: CustomerForm): string {
  return f.shippingSameAsBilling ? f.billingStateCode : f.shippingStateCode;
}

/**
 * The request body. A blank optional value is sent as null so an edit CLEARS it; GST fields follow the type
 * (a B2C customer is always unregistered, an unregistered one has no GSTIN).
 */
export function toApiBody(f: CustomerForm, creating: boolean): Record<string, unknown> {
  const n = (v: string) => (v.trim() === '' ? null : v.trim());
  const b2c = f.customerType === 'B2C';
  const status: CustomerGstStatus = b2c ? 'UNREGISTERED' : f.gstStatus;
  const body: Record<string, unknown> = {
    customerType: f.customerType,
    legalName: f.legalName.trim(),
    displayName: n(f.displayName),
    contactPerson: n(f.contactPerson),
    email: n(f.email),
    phone: n(f.phone),
    alternatePhone: n(f.alternatePhone),
    gstStatus: status,
    gstin: status === 'UNREGISTERED' ? null : n(f.gstin),
    pan: n(f.pan),
    billingAddressLine1: f.billingAddressLine1.trim(),
    billingAddressLine2: n(f.billingAddressLine2),
    billingCity: n(f.billingCity),
    billingStateCode: f.billingStateCode,
    billingPinCode: n(f.billingPinCode),
    shippingSameAsBilling: f.shippingSameAsBilling,
    shippingAddressLine1: f.shippingSameAsBilling ? null : n(f.shippingAddressLine1),
    shippingAddressLine2: f.shippingSameAsBilling ? null : n(f.shippingAddressLine2),
    shippingCity: f.shippingSameAsBilling ? null : n(f.shippingCity),
    shippingStateCode: f.shippingSameAsBilling ? null : n(f.shippingStateCode),
    shippingPinCode: f.shippingSameAsBilling ? null : n(f.shippingPinCode),
    placeOfSupplyStateCode: n(f.placeOfSupplyStateCode),
    creditLimit: n(f.creditLimit),
    paymentTermsDays: n(f.paymentTermsDays),
    notes: n(f.notes),
  };
  if (creating && n(f.code)) body.code = f.code;
  return body;
}

// ------------------------------------------------------------------------------------------------ messages

const RULE_TEXT: Record<string, string> = {
  required: 'This field is required.',
  too_long: 'This is too long.',
  invalid_type: 'This value is not acceptable.',
  invalid_value: 'Choose one of the listed options.',
  invalid_email: 'Enter a valid email address.',
  invalid_phone: 'Use digits, spaces and + ( ) - . only (5 to 20 characters).',
  invalid_pan_format: 'PAN must be 10 characters in the form ABCDE1234F.',
  invalid_gstin_format: 'This GSTIN is not in the correct format. Check each character.',
  invalid_gstin_checksum: 'This GSTIN has a wrong check character. Check each character.',
  gstin_required: 'Enter the GSTIN of a registered customer.',
  gstin_not_allowed: 'An unregistered customer has no GSTIN. Remove it or change the GST status.',
  gstin_state_mismatch: 'The first two digits of the GSTIN must match the billing state.',
  gstin_pan_mismatch: 'The PAN inside the GSTIN does not match the PAN you entered.',
  duplicate_gstin: 'Another customer already uses this GSTIN.',
  duplicate_code: 'This customer code is already in use.',
  invalid_code: 'Use capital letters, digits and . _ / - only (up to 30 characters).',
  unknown_state_code: 'Choose a state from the list.',
  invalid_pin_code: 'PIN code must be 6 digits and must not start with 0.',
  invalid_amount: 'Enter an amount such as 25000 or 25000.50.',
  out_of_range: 'Enter a whole number of days from 0 to 365.',
  b2c_must_be_unregistered:
    'A B2C (consumer) customer cannot be GST registered. Choose B2B for a business.',
  unknown_field: 'This value is not accepted.',
};
const GENERIC = 'This value is not acceptable.';
export const ruleText = (rule: string): string => RULE_TEXT[rule] ?? GENERIC;

export const FIELD_LABELS: Record<string, string> = {
  code: 'Customer code',
  customerType: 'Customer type',
  legalName: 'Customer name',
  displayName: 'Display name',
  contactPerson: 'Contact person',
  email: 'Email',
  phone: 'Phone',
  alternatePhone: 'Alternate phone',
  gstStatus: 'GST registration',
  gstin: 'GSTIN',
  pan: 'PAN',
  billingAddressLine1: 'Billing address line 1',
  billingAddressLine2: 'Billing address line 2',
  billingCity: 'Billing city',
  billingStateCode: 'Billing state',
  billingPinCode: 'Billing PIN code',
  shippingAddressLine1: 'Shipping address line 1',
  shippingStateCode: 'Shipping state',
  shippingPinCode: 'Shipping PIN code',
  placeOfSupplyStateCode: 'Place of supply',
  creditLimit: 'Credit limit',
  paymentTermsDays: 'Payment terms',
  notes: 'Notes',
};

export type FieldErrors = Record<string, string>;

/**
 * Early feedback using the SAME validation as the server. (The server still validates everything.) The code is
 * checked here only when creating.
 */
export function validateForm(f: CustomerForm, creating: boolean): FieldErrors {
  const body = toApiBody(f, creating);
  // A blank-clearing null is "absent" for the validator.
  const result = validateCustomer(body, creating);
  if (result.ok) return {};
  const errors: FieldErrors = {};
  for (const p of result.problems) {
    // A missing delivery state is reported where the user can fix it: on the billing state (same address) or on the
    // shipping state - never on the optional place-of-supply field, which merely defaults to it.
    if (
      p.field === 'placeOfSupplyStateCode' &&
      !f.placeOfSupplyStateCode &&
      f.shippingSameAsBilling
    )
      continue;
    const field =
      p.field === 'placeOfSupplyStateCode' && !f.placeOfSupplyStateCode
        ? 'shippingStateCode'
        : p.field;
    if (!errors[field]) errors[field] = ruleText(p.rule);
  }
  return errors;
}

/** Summary lines that say which field each message belongs to. */
export function describeErrors(errors: FieldErrors): string[] {
  return Object.entries(errors).map(([field, text]) =>
    FIELD_LABELS[field] ? `${FIELD_LABELS[field]}: ${text}` : text,
  );
}

/** Server problems -> field messages (never the server's own wording). */
export function errorsFromProblems(problems: { field: string; rule: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const p of problems) {
    if (!errors[p.field]) errors[p.field] = ruleText(p.rule);
  }
  return errors;
}
