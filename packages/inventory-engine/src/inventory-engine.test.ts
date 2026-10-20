import { describe, expect, it } from 'vitest';
import {
  addQuantities,
  canonicalQuantity,
  compareQuantities,
  formatQuantity,
  parseQuantity,
} from './quantity.js';
import { isRealDate, validateOperation } from './validate.js';

const ID = '11111111-1111-4111-8111-111111111111';
const base = {
  operationId: ID,
  productId: ID,
  warehouseId: ID,
  quantity: '5',
  businessDate: '2026-10-01',
};

describe('parseQuantity', () => {
  it('returns the canonical exact text', () => {
    expect(parseQuantity('12')).toEqual({ ok: true, value: '12' });
    expect(parseQuantity(' 007.50 ', 3)).toEqual({ ok: true, value: '7.5' });
    expect(parseQuantity('2.0', 0)).toEqual({ ok: true, value: '2' });
    expect(parseQuantity('0.0001')).toEqual({ ok: true, value: '0.0001' });
    expect(parseQuantity('999999999999.9999')).toEqual({ ok: true, value: '999999999999.9999' });
  });

  it('refuses rather than rounds', () => {
    const rule = (v: unknown, places?: number) => {
      const r = parseQuantity(v, places);
      return r.ok ? 'ok' : r.rule;
    };
    expect(rule('1.5', 0)).toBe('too_many_decimals');
    expect(rule('1.2345', 3)).toBe('too_many_decimals');
    expect(rule('1.23456')).toBe('unsupported_precision');
    expect(rule('0')).toBe('quantity_must_be_positive');
    expect(rule('0.000')).toBe('quantity_must_be_positive');
    expect(rule('-1')).toBe('quantity_must_be_positive');
    expect(rule('-0')).toBe('quantity_must_be_positive');
    expect(rule('abc')).toBe('invalid_quantity');
    expect(rule('1e3')).toBe('invalid_quantity');
    expect(rule('1,5')).toBe('invalid_quantity');
    expect(rule('.5')).toBe('invalid_quantity');
    expect(rule('5.')).toBe('invalid_quantity');
    expect(rule(5)).toBe('invalid_quantity'); // numbers lose digits: text only
    expect(rule(true)).toBe('invalid_quantity');
    expect(rule('')).toBe('required');
    expect(rule('   ')).toBe('required');
    expect(rule(null)).toBe('required');
    expect(rule(undefined)).toBe('required');
    expect(rule('1000000000000')).toBe('quantity_too_large');
  });
});

describe('exact quantity arithmetic and display', () => {
  it('adds and compares without floating point', () => {
    expect(addQuantities('0.1', '0.2')).toBe('0.3');
    expect(addQuantities('123456789012.3456', '0.0001')).toBe('123456789012.3457');
    expect(addQuantities('5', '-8.5')).toBe('-3.5');
    expect(addQuantities('1', '-1')).toBe('0');
    expect(compareQuantities('0.3', '0.30')).toBe(0);
    expect(compareQuantities('2', '10')).toBe(-1);
    expect(compareQuantities('10.0001', '10')).toBe(1);
  });

  it('shows the exact value without needless zeros, in Indian grouping', () => {
    expect(canonicalQuantity('2.5000')).toBe('2.5');
    expect(canonicalQuantity('10.0000')).toBe('10');
    expect(canonicalQuantity('0.0000')).toBe('0');
    expect(formatQuantity('2.5000')).toBe('2.5');
    expect(formatQuantity('12')).toBe('12');
    expect(formatQuantity('1234567.25')).toBe('12,34,567.25');
    expect(formatQuantity('999')).toBe('999');
    expect(formatQuantity('1000')).toBe('1,000');
    expect(formatQuantity('-1500.5')).toBe('-1,500.5');
    expect(formatQuantity('0.0001')).toBe('0.0001');
    expect(formatQuantity('')).toBe('');
    expect(formatQuantity(null)).toBe('');
    expect(formatQuantity('abc')).toBe('abc');
  });
});

describe('isRealDate', () => {
  it('accepts only real calendar dates', () => {
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026-13-01')).toBe(false);
    expect(isRealDate('01-10-2026')).toBe(false);
  });
});

describe('validateOperation', () => {
  const today = '2026-10-20';
  const run = (
    kind: 'OPENING_STOCK' | 'STOCK_RECEIPT' | 'ADJUSTMENT',
    over: Record<string, unknown> = {},
  ) => validateOperation(kind, { ...base, ...over }, today);
  const problems = (r: ReturnType<typeof run>) => (r.ok ? [] : r.problems);

  it('normalizes a valid receipt', () => {
    const r = run('STOCK_RECEIPT', { quantity: '5.0', reference: '  Challan 7 ', note: ' ' });
    expect(r).toEqual({
      ok: true,
      value: {
        operationId: ID,
        productId: ID,
        warehouseId: ID,
        quantity: '5',
        businessDate: '2026-10-01',
        reference: 'Challan 7',
        note: null,
        direction: 'INCREASE',
        reasonCode: null,
      },
    });
  });

  it('requires the identity fields and rejects unknown ones (a client cannot name an organization)', () => {
    const r = validateOperation(
      'STOCK_RECEIPT',
      { quantity: '1', businessDate: today, organizationId: ID, cost: '1' },
      today,
    );
    expect(problems(r)).toEqual(
      expect.arrayContaining([
        { field: 'organizationId', rule: 'unknown_field' },
        { field: 'cost', rule: 'unknown_field' },
        { field: 'operationId', rule: 'required' },
        { field: 'productId', rule: 'required' },
        { field: 'warehouseId', rule: 'required' },
      ]),
    );
    // direction and reason belong to adjustments only
    expect(problems(run('STOCK_RECEIPT', { direction: 'DECREASE' }))).toEqual([
      { field: 'direction', rule: 'unknown_field' },
    ]);
    expect(problems(run('OPENING_STOCK', { reasonCode: 'FOUND' }))).toEqual([
      { field: 'reasonCode', rule: 'unknown_field' },
    ]);
  });

  it('checks ids, dates and text length', () => {
    expect(problems(run('STOCK_RECEIPT', { productId: 'x' }))).toEqual([
      { field: 'productId', rule: 'invalid_reference' },
    ]);
    expect(problems(run('STOCK_RECEIPT', { productId: 5 }))).toEqual([
      { field: 'productId', rule: 'invalid_reference' },
    ]);
    expect(problems(run('STOCK_RECEIPT', { businessDate: '2026-10-21' }))).toEqual([
      { field: 'businessDate', rule: 'date_in_future' },
    ]);
    expect(problems(run('STOCK_RECEIPT', { businessDate: '1999-01-01' }))).toEqual([
      { field: 'businessDate', rule: 'date_too_old' },
    ]);
    expect(problems(run('STOCK_RECEIPT', { businessDate: 20261001 }))).toEqual([
      { field: 'businessDate', rule: 'invalid_date' },
    ]);
    expect(problems(run('STOCK_RECEIPT', { businessDate: undefined }))).toEqual([
      { field: 'businessDate', rule: 'required' },
    ]);
    expect(problems(run('STOCK_RECEIPT', { reference: 'x'.repeat(61) }))).toEqual([
      { field: 'reference', rule: 'too_long' },
    ]);
    expect(problems(run('STOCK_RECEIPT', { note: 'x'.repeat(501) }))).toEqual([
      { field: 'note', rule: 'too_long' },
    ]);
    expect(problems(run('STOCK_RECEIPT', { note: 5 }))).toEqual([
      { field: 'note', rule: 'invalid_type' },
    ]);
    expect(run('STOCK_RECEIPT', { note: 'x'.repeat(500) }).ok).toBe(true);
  });

  it('an adjustment needs a direction and a reason, and "Other" needs an explanation', () => {
    const adj = (over: Record<string, unknown>) =>
      run('ADJUSTMENT', { direction: 'DECREASE', reasonCode: 'LOSS', ...over });
    expect(adj({}).ok).toBe(true);
    expect(problems(adj({ direction: undefined }))).toEqual([
      { field: 'direction', rule: 'required' },
    ]);
    expect(problems(adj({ direction: 'SIDEWAYS' }))).toEqual([
      { field: 'direction', rule: 'invalid_choice' },
    ]);
    expect(problems(adj({ reasonCode: undefined }))).toEqual([
      { field: 'reasonCode', rule: 'required' },
    ]);
    expect(problems(adj({ reasonCode: 'BECAUSE' }))).toEqual([
      { field: 'reasonCode', rule: 'invalid_choice' },
    ]);
    expect(problems(adj({ reasonCode: 'OTHER' }))).toEqual([
      { field: 'note', rule: 'required_for_other' },
    ]);
    expect(adj({ reasonCode: 'OTHER', note: 'Pallet collapsed' }).ok).toBe(true);
    const ok = adj({});
    expect(ok.ok && ok.value).toMatchObject({ direction: 'DECREASE', reasonCode: 'LOSS' });
  });
});
