import {
  parseQuantity,
  validateOperation,
  type StockOperationKind,
} from '@commercebill/inventory-engine/browser';
import type { AdjustmentReasonCode, StockMovementType } from '@commercebill/shared-types';
import type { StockOperation } from '../api.js';

/** Form state: text exactly as typed. A quantity stays a STRING end to end - never a JavaScript number. */
export interface StockForm {
  quantity: string;
  businessDate: string;
  reference: string;
  note: string;
  direction: 'INCREASE' | 'DECREASE';
  reasonCode: '' | AdjustmentReasonCode;
}

/** The user's local calendar date as YYYY-MM-DD (the date input works in local time). */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function emptyStockForm(today: string = localToday()): StockForm {
  return {
    quantity: '',
    businessDate: today,
    reference: '',
    note: '',
    direction: 'INCREASE',
    reasonCode: '',
  };
}

/** A fresh identity for one logical operation. A retry of the SAME form content reuses it (see StockOperationPage). */
export function newOperationId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const KIND: Record<StockOperation, StockOperationKind> = {
  opening: 'OPENING_STOCK',
  receive: 'STOCK_RECEIPT',
  adjust: 'ADJUSTMENT',
};

/**
 * The request body. The organization is never sent (the server takes it from the session) and nothing here is a
 * balance: the server decides the resulting stock.
 */
export function toApiBody(
  operation: StockOperation,
  f: StockForm,
  ids: { operationId: string; productId: string; warehouseId: string },
): Record<string, unknown> {
  const n = (v: string) => (v.trim() === '' ? null : v.trim());
  const body: Record<string, unknown> = {
    operationId: ids.operationId,
    productId: ids.productId,
    warehouseId: ids.warehouseId,
    quantity: f.quantity.trim(),
    businessDate: f.businessDate,
    reference: n(f.reference),
    note: n(f.note),
  };
  if (operation === 'adjust') {
    body.direction = f.direction;
    body.reasonCode = f.reasonCode === '' ? null : f.reasonCode;
  }
  return body;
}

// ------------------------------------------------------------------------------------------------ messages

export const OPERATION_TITLE: Record<StockOperation, string> = {
  opening: 'Opening stock',
  receive: 'Manual stock receipt',
  adjust: 'Stock adjustment',
};

export const MOVEMENT_LABEL: Record<StockMovementType, string> = {
  OPENING_STOCK: 'Opening stock',
  STOCK_RECEIPT: 'Manual receipt',
  ADJUSTMENT_INCREASE: 'Adjustment (increase)',
  ADJUSTMENT_DECREASE: 'Adjustment (decrease)',
};

export const REASON_LABEL: Record<AdjustmentReasonCode, string> = {
  COUNT_CORRECTION: 'Count correction',
  FOUND: 'Stock found',
  DAMAGE: 'Damaged',
  LOSS: 'Lost',
  OTHER: 'Other',
};

const RULE_TEXT: Record<string, string> = {
  required: 'This field is required.',
  too_long: 'This is too long.',
  invalid_type: 'This value is not acceptable.',
  invalid_quantity: 'Enter a plain number such as 12 or 2.5.',
  quantity_must_be_positive: 'Enter a quantity greater than zero.',
  unsupported_precision: 'At most four decimal places can be recorded.',
  too_many_decimals: 'This unit does not allow that many decimal places.',
  quantity_too_large: 'This quantity is too large.',
  invalid_date: 'Enter a valid date.',
  date_in_future: 'The date cannot be in the future.',
  date_too_old: 'The date is too far in the past.',
  invalid_choice: 'Choose one of the listed options.',
  required_for_other: 'Please explain the reason.',
  invalid_reference: 'This value is not acceptable.',
  unknown_reference: 'This item could not be found. Go back and try again.',
  inventory_not_tracked: 'This product does not track inventory.',
  insufficient_stock: 'There is not enough stock for this change.',
  opening_stock_exists:
    'Opening stock has already been recorded for this product. Use a stock adjustment instead.',
  operation_id_reused: 'This entry was already used for a different change. Please try again.',
  unknown_field: 'This value is not accepted.',
};
export const ruleText = (rule: string): string =>
  RULE_TEXT[rule] ?? 'This value is not acceptable.';

export const FIELD_LABELS: Record<string, string> = {
  quantity: 'Quantity',
  businessDate: 'Date',
  reference: 'Reference',
  note: 'Note',
  direction: 'Increase or decrease',
  reasonCode: 'Reason',
  productId: 'Product',
  warehouseId: 'Warehouse',
  operationId: 'Entry',
};

export type FieldErrors = Record<string, string>;

/**
 * Early feedback using the SAME validation as the server (which still validates everything and alone decides the
 * stock). The unit's decimal places are checked here too because the product's unit is known on screen.
 */
export function validateForm(
  operation: StockOperation,
  f: StockForm,
  unitDecimalPlaces: number,
  today: string = localToday(),
): FieldErrors {
  const placeholder = '00000000-0000-4000-8000-000000000000';
  const result = validateOperation(
    KIND[operation],
    toApiBody(operation, f, {
      operationId: placeholder,
      productId: placeholder,
      warehouseId: placeholder,
    }),
    today,
  );
  const errors: FieldErrors = {};
  if (!result.ok)
    for (const p of result.problems) if (!errors[p.field]) errors[p.field] = ruleText(p.rule);
  if (!errors.quantity) {
    const q = parseQuantity(f.quantity.trim(), unitDecimalPlaces);
    if (!q.ok) errors.quantity = ruleText(q.rule);
  }
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
