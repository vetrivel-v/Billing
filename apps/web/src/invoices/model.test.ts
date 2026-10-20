import type { CustomerView, ProductView } from '@commercebill/shared-types';
import { describe, expect, it } from 'vitest';
import { ApiError, ApiUnreachableError } from '../api.js';
import { customer } from '../test-support/customer-fixtures.js';
import {
  asCalc,
  classifyPostFailure,
  customerContextState,
  describeProblems,
  formatMoney,
  formatRate,
  formatRupees,
  operationIdFor,
  problemText,
  toRequest,
  unsupportedReason,
  validateLine,
  type LineDraft,
} from './model.js';

const product = (over: Partial<ProductView> = {}) =>
  ({
    id: 'p1',
    sku: 'S1',
    name: 'Item',
    kind: 'GOODS',
    isActive: true,
    unit: { code: 'PCS', name: 'Pieces', decimalPlaces: 0 },
    sellingPrice: '10.00',
    ...over,
  }) as ProductView;
const line = (over: Partial<LineDraft> = {}): LineDraft => ({
  key: 'l1',
  product: product(),
  quantity: '2',
  discountKind: 'NONE',
  discountValue: '',
  ...over,
});

describe('money formatting (strings only)', () => {
  it('groups in the Indian style without floating point', () => {
    expect(formatMoney('0')).toBe('0.00');
    expect(formatMoney('999.5')).toBe('999.50');
    expect(formatMoney('1234.56')).toBe('1,234.56');
    expect(formatMoney('1234567.5')).toBe('12,34,567.50');
    expect(formatMoney('-100000')).toBe('-1,00,000.00');
    expect(formatMoney('12345678901234567.89')).toBe('12,34,56,78,90,12,34,567.89');
    expect(formatMoney(null)).toBe('-');
    expect(formatMoney('abc')).toBe('abc');
    expect(formatRupees('10')).toBe('₹10.00');
    expect(formatRupees(undefined)).toBe('-');
  });
  it('formats rates', () => {
    expect(formatRate('18.0000')).toBe('18%');
    expect(formatRate('2.5000')).toBe('2.5%');
    expect(formatRate('')).toBe('');
  });
});

describe('request building and operation identity', () => {
  it('sends choices only and always DEMO', () => {
    const c = customer() as CustomerView;
    const r = toRequest(c, [line({ discountKind: 'PERCENT', discountValue: ' 10 ' })], null);
    expect(r).toEqual({
      mode: 'DEMO',
      customerId: c.id,
      lines: [{ productId: 'p1', quantity: '2', discount: { type: 'PERCENT', percent: '10' } }],
    });
    expect(
      toRequest(c, [line({ discountKind: 'AMOUNT', discountValue: '5' })], {
        stateCode: '27',
        choice: 'CONFIRMED',
      }),
    ).toMatchObject({
      placeOfSupply: { stateCode: '27', choice: 'CONFIRMED' },
      lines: [{ discount: { type: 'AMOUNT', amount: '5' } }],
    });
  });
  it('reuses the operation id for the same candidate and renews it for any change', () => {
    const a = operationIdFor({ key: '', id: '' }, 'k1');
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(operationIdFor(a, 'k1')).toBe(a);
    expect(operationIdFor(a, 'k2').id).not.toBe(a.id);
  });
  it('derives the customer states', () => {
    expect(customerContextState(customer({ billingStateCode: '27' }))).toEqual({
      billing: '27',
      shipping: '27',
    });
    expect(
      customerContextState(customer({ shippingSameAsBilling: false, shippingStateCode: '29' })),
    ).toEqual({
      billing: '27',
      shipping: '29',
    });
  });
});

describe('early line validation', () => {
  it('checks quantity against the unit and the discount shape', () => {
    expect(validateLine(line())).toEqual({});
    expect(validateLine(line({ quantity: '0' })).quantity).toMatch(/greater than zero/);
    expect(validateLine(line({ quantity: '1.5' })).quantity).toMatch(/decimal places/);
    expect(validateLine(line({ quantity: 'x' })).quantity).toBeTruthy();
    expect(
      validateLine(
        line({
          product: product({ unit: { code: 'KG', name: 'Kg', decimalPlaces: 3 } }),
          quantity: '1.250',
        }),
      ),
    ).toEqual({});
    expect(validateLine(line({ discountKind: 'PERCENT', discountValue: '101' })).discount).toMatch(
      /more than 100/,
    );
    expect(validateLine(line({ discountKind: 'PERCENT', discountValue: '100' }))).toEqual({});
    expect(
      validateLine(line({ discountKind: 'AMOUNT', discountValue: '-1' })).discount,
    ).toBeTruthy();
    expect(validateLine(line({ discountKind: 'AMOUNT', discountValue: '' })).discount).toBeTruthy();
  });
  it('explains products that cannot be invoiced', () => {
    expect(unsupportedReason(product())).toBeNull();
    expect(unsupportedReason(product({ kind: 'SERVICE' }))).toMatch(/Services/);
    expect(unsupportedReason(product({ isActive: false }))).toMatch(/inactive/);
  });
});

describe('wording and failure classification', () => {
  it('maps stable codes to plain text and never leaks an unknown code', () => {
    expect(problemText('MIXED_PRICE_BASIS')).toMatch(/include GST/);
    expect(problemText('SOMETHING_NEW')).not.toMatch(/SOMETHING_NEW/);
    expect(
      describeProblems([{ code: 'CHARGES_UNSUPPORTED' }, { code: 'CHARGES_UNSUPPORTED' }]),
    ).toHaveLength(1);
  });
  it('classifies post failures', () => {
    expect(classifyPostFailure(new ApiUnreachableError())).toEqual({ kind: 'uncertain' });
    expect(classifyPostFailure(new TypeError('x'))).toEqual({ kind: 'uncertain' });
    expect(classifyPostFailure(new ApiError(500, 'X'))).toEqual({ kind: 'uncertain' });
    const fresh = { ok: true } as never;
    expect(
      classifyPostFailure(
        new ApiError(409, 'BIZ_0001', [{ field: 'calculation', rule: 'CALCULATION_STALE' }], {
          recalculation: fresh,
        }),
      ),
    ).toEqual({ kind: 'stale', recalculation: fresh });
    expect(
      classifyPostFailure(
        new ApiError(409, 'BIZ_0001', [{ field: 'calculation', rule: 'CALCULATION_STALE' }]),
      ),
    ).toEqual({
      kind: 'stale',
      recalculation: null,
    });
    expect(classifyPostFailure(new ApiError(403, 'AUTHZ_0001'))).toMatchObject({
      kind: 'rejected',
    });
    expect(
      classifyPostFailure(
        new ApiError(409, 'BIZ_0001', [{ field: 'mode', rule: 'PRODUCTION_GATE_NOT_MET' }]),
      ),
    ).toEqual({
      kind: 'rejected',
      messages: [problemText('PRODUCTION_GATE_NOT_MET')],
    });
    expect(classifyPostFailure(new ApiError(400, 'VAL_0001'))).toMatchObject({ kind: 'rejected' });
  });
  it('reads a calculation only when it has lines', () => {
    expect(asCalc(null)).toBeNull();
    expect(asCalc({ calculation: null } as never)).toBeNull();
    expect(asCalc({ calculation: { lines: [], totals: {} } } as never)).not.toBeNull();
  });
});
