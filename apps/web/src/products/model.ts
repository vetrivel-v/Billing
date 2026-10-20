import { validateProduct } from '@commercebill/products/browser';
import type { ProductKind, ProductView } from '@commercebill/shared-types';

/** Form state: strings (or booleans) exactly as typed. Money stays a STRING end to end - never a JavaScript number. */
export interface ProductForm {
  kind: ProductKind;
  sku: string;
  name: string;
  description: string;
  hsnSacCodeId: string;
  /** Shown next to the chosen code ("8517 - Telephone sets"); not sent to the server. */
  hsnSacLabel: string;
  unitId: string;
  taxCategoryId: string;
  mrp: string;
  sellingPrice: string;
  priceIncludesTax: boolean;
  trackInventory: boolean;
  barcode: string;
}

export function emptyProductForm(kind: ProductKind = 'GOODS'): ProductForm {
  return {
    kind,
    sku: '',
    name: '',
    description: '',
    hsnSacCodeId: '',
    hsnSacLabel: '',
    unitId: '',
    taxCategoryId: '',
    mrp: '',
    sellingPrice: '',
    priceIncludesTax: false,
    trackInventory: false,
    barcode: '',
  };
}

export function formFromProduct(p: ProductView): ProductForm {
  return {
    kind: p.kind,
    sku: p.sku,
    name: p.name,
    description: p.description ?? '',
    hsnSacCodeId: p.hsnSacCodeId ?? '',
    hsnSacLabel: p.hsnSacCode
      ? `${p.hsnSacCode.code}${p.hsnSacCode.description ? ` - ${p.hsnSacCode.description}` : ''}`
      : '',
    unitId: p.unitId ?? '',
    taxCategoryId: p.taxCategoryId,
    mrp: p.mrp ?? '',
    sellingPrice: p.sellingPrice,
    priceIncludesTax: p.priceIncludesTax,
    trackInventory: p.trackInventory,
    barcode: p.barcode ?? '',
  };
}

/**
 * The request body. Blank optional values are sent as null so an edit CLEARS them. A service never sends a unit
 * requirement or inventory tracking. Prices are passed through as typed text; the server normalises them exactly.
 */
export function toApiBody(f: ProductForm, creating: boolean): Record<string, unknown> {
  const n = (v: string) => (v.trim() === '' ? null : v.trim());
  const goods = f.kind === 'GOODS';
  const body: Record<string, unknown> = {
    kind: f.kind,
    name: f.name.trim(),
    description: n(f.description),
    hsnSacCodeId: n(f.hsnSacCodeId),
    unitId: n(f.unitId),
    taxCategoryId: n(f.taxCategoryId),
    mrp: n(f.mrp),
    sellingPrice: n(f.sellingPrice),
    priceIncludesTax: f.priceIncludesTax,
    trackInventory: goods ? f.trackInventory : false,
    barcode: n(f.barcode),
  };
  if (creating && n(f.sku)) body.sku = f.sku;
  return body;
}

// ------------------------------------------------------------------------------------------------ messages

const RULE_TEXT: Record<string, string> = {
  required: 'This field is required.',
  too_long: 'This is too long.',
  invalid_type: 'This value is not acceptable.',
  invalid_value: 'Choose one of the listed options.',
  invalid_amount: 'Enter an amount such as 1180 or 1180.50 (at most two decimal places).',
  negative_amount: 'The amount cannot be negative.',
  invalid_sku: 'Use capital letters, digits and . _ / - only (up to 40 characters).',
  invalid_barcode: 'Use letters, digits and . _ / - only (no spaces, up to 64 characters).',
  invalid_reference: 'Choose a value from the list.',
  unknown_reference: 'Choose a value from the list.',
  inactive_reference: 'This entry is no longer active. Choose another.',
  goods_need_hsn: 'Goods use an HSN code. Choose an HSN code or clear the field.',
  services_need_sac: 'Services use a SAC code. Choose a SAC code or clear the field.',
  service_cannot_track_inventory: 'A service cannot track inventory.',
  duplicate_sku: 'This SKU is already in use.',
  duplicate_barcode: 'Another product already uses this barcode.',
  unit_has_stock_history: 'This product already has stock recorded, so its unit cannot be changed.',
  tracking_has_stock_history:
    'This product already has stock recorded, so inventory tracking cannot be turned off.',
  kind_cannot_change: 'The product type cannot be changed after the product is created.',
  unknown_field: 'This value is not accepted.',
};
export const ruleText = (rule: string): string =>
  RULE_TEXT[rule] ?? 'This value is not acceptable.';

export const FIELD_LABELS: Record<string, string> = {
  sku: 'SKU',
  name: 'Product name',
  description: 'Description',
  kind: 'Product type',
  hsnSacCodeId: 'HSN/SAC code',
  unitId: 'Unit of measure',
  taxCategoryId: 'Tax category',
  mrp: 'MRP',
  sellingPrice: 'Selling price',
  priceIncludesTax: 'Price type',
  trackInventory: 'Inventory tracking',
  barcode: 'Barcode',
};

export type FieldErrors = Record<string, string>;

/** Early feedback using the SAME validation as the server (which still validates everything). */
export function validateForm(f: ProductForm, creating: boolean): FieldErrors {
  const result = validateProduct(toApiBody(f, creating), creating);
  if (result.ok) return {};
  const errors: FieldErrors = {};
  for (const p of result.problems) if (!errors[p.field]) errors[p.field] = ruleText(p.rule);
  return errors;
}

export function describeErrors(errors: FieldErrors): string[] {
  return Object.entries(errors).map(([field, text]) =>
    FIELD_LABELS[field] ? `${FIELD_LABELS[field]}: ${text}` : text,
  );
}

export function errorsFromProblems(problems: { field: string; rule: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const p of problems) if (!errors[p.field]) errors[p.field] = ruleText(p.rule);
  return errors;
}
