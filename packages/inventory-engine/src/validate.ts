/**
 * Pure validation of a manual stock operation. The server runs it on every request; the UI runs the same function for
 * early feedback. Problems carry only a field name and a stable rule code - never a submitted value.
 * Checks that need the database (product/warehouse ownership, unit decimal places, stock available) are the engine's.
 */
import { parseQuantity, QUANTITY_SCALE } from './quantity.js';

export interface Problem {
  field: string;
  rule: string;
}

export type StockOperationKind = 'OPENING_STOCK' | 'STOCK_RECEIPT' | 'ADJUSTMENT';

export const ADJUSTMENT_REASONS = ['COUNT_CORRECTION', 'FOUND', 'DAMAGE', 'LOSS', 'OTHER'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
export const ADJUSTMENT_DIRECTIONS = ['INCREASE', 'DECREASE'] as const;

const COMMON = [
  'operationId',
  'productId',
  'warehouseId',
  'quantity',
  'businessDate',
  'reference',
  'note',
] as const;
const FIELDS: Record<StockOperationKind, readonly string[]> = {
  OPENING_STOCK: COMMON,
  STOCK_RECEIPT: COMMON,
  ADJUSTMENT: [...COMMON, 'direction', 'reasonCode'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_REFERENCE = 60;
export const MAX_NOTE = 500;

export interface NormalizedOperation {
  operationId: string;
  productId: string;
  warehouseId: string;
  /** Canonical positive decimal text (unit decimal places are checked later against the product's unit). */
  quantity: string;
  /** YYYY-MM-DD */
  businessDate: string;
  reference: string | null;
  note: string | null;
  direction: 'INCREASE' | 'DECREASE';
  reasonCode: AdjustmentReason | null;
}

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.normalize('NFC').trim();
  return t === '' ? null : t;
}

/** A real calendar date in YYYY-MM-DD form. */
export function isRealDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * @param today the current date as YYYY-MM-DD (the server clock; the UI passes its local date). A stock event cannot be
 *   dated in the future, nor before 2000-01-01.
 */
export function validateOperation(
  kind: StockOperationKind,
  raw: Record<string, unknown>,
  today: string,
): { ok: true; value: NormalizedOperation } | { ok: false; problems: Problem[] } {
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });

  for (const key of Object.keys(raw)) if (!FIELDS[kind].includes(key)) add(key, 'unknown_field');

  const id = (field: string): string => {
    const v = raw[field];
    if (v === undefined || v === null || v === '') {
      add(field, 'required');
      return '';
    }
    if (typeof v !== 'string' || !UUID.test(v)) {
      add(field, 'invalid_reference');
      return '';
    }
    return v.toLowerCase();
  };
  const operationId = id('operationId');
  const productId = id('productId');
  const warehouseId = id('warehouseId');

  // Only the format and the ledger's own precision are checked here; the unit's decimal places need the product.
  let quantity = '';
  const q = parseQuantity(raw.quantity, QUANTITY_SCALE);
  if (q.ok) quantity = q.value;
  else add('quantity', q.rule);

  let businessDate = '';
  const d = raw.businessDate;
  if (d === undefined || d === null || d === '') add('businessDate', 'required');
  else if (typeof d !== 'string' || !isRealDate(d)) add('businessDate', 'invalid_date');
  else if (d > today) add('businessDate', 'date_in_future');
  else if (d < '2000-01-01') add('businessDate', 'date_too_old');
  else businessDate = d;

  const optional = (field: string, max: number): string | null => {
    const v = raw[field];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') {
      add(field, 'invalid_type');
      return null;
    }
    const t = text(v);
    if (t !== null && [...t].length > max) {
      add(field, 'too_long');
      return null;
    }
    return t;
  };
  const reference = optional('reference', MAX_REFERENCE);
  const note = optional('note', MAX_NOTE);

  let direction: 'INCREASE' | 'DECREASE' = 'INCREASE';
  let reasonCode: AdjustmentReason | null = null;
  if (kind === 'ADJUSTMENT') {
    const dir = raw.direction;
    if (dir === undefined || dir === null || dir === '') add('direction', 'required');
    else if (dir === 'INCREASE' || dir === 'DECREASE') direction = dir;
    else add('direction', 'invalid_choice');

    const r = raw.reasonCode;
    if (r === undefined || r === null || r === '') add('reasonCode', 'required');
    else if (typeof r === 'string' && (ADJUSTMENT_REASONS as readonly string[]).includes(r)) {
      reasonCode = r as AdjustmentReason;
      // "Other" must be explained.
      if (r === 'OTHER' && note === null) add('note', 'required_for_other');
    } else add('reasonCode', 'invalid_choice');
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      operationId,
      productId,
      warehouseId,
      quantity,
      businessDate,
      reference,
      note,
      direction,
      reasonCode,
    },
  };
}
