import { describe, expect, it } from 'vitest';
import {
  describeErrors,
  emptyStockForm,
  errorsFromProblems,
  localToday,
  newOperationId,
  ruleText,
  toApiBody,
  validateForm,
} from './model.js';

const ids = { operationId: 'op', productId: 'p', warehouseId: 'w' };
const filled = () => ({
  ...emptyStockForm('2026-10-01'),
  quantity: '5',
  reasonCode: 'LOSS' as const,
});

describe('toApiBody', () => {
  it('sends quantities as typed text and blanks as null; never an organization, balance or cost', () => {
    const body = toApiBody('receive', { ...filled(), reference: ' Challan ', note: '' }, ids);
    expect(body).toEqual({
      operationId: 'op',
      productId: 'p',
      warehouseId: 'w',
      quantity: '5',
      businessDate: '2026-10-01',
      reference: 'Challan',
      note: null,
    });
    expect(typeof body.quantity).toBe('string');
    for (const k of ['organizationId', 'balance', 'onHand', 'cost', 'direction', 'reasonCode'])
      expect(Object.keys(body)).not.toContain(k);
  });

  it('adds the direction and reason for an adjustment only', () => {
    expect(toApiBody('adjust', { ...filled(), direction: 'DECREASE' }, ids)).toMatchObject({
      direction: 'DECREASE',
      reasonCode: 'LOSS',
    });
    expect(toApiBody('adjust', { ...filled(), reasonCode: '' }, ids)).toMatchObject({
      reasonCode: null,
    });
    expect(toApiBody('opening', filled(), ids)).not.toHaveProperty('direction');
  });
});

describe('validateForm', () => {
  it('uses the same rules as the server, plus the unit decimal places', () => {
    expect(validateForm('receive', filled(), 0, '2026-10-20')).toEqual({});
    expect(validateForm('receive', { ...filled(), quantity: '' }, 0, '2026-10-20').quantity).toBe(
      ruleText('required'),
    );
    expect(
      validateForm('receive', { ...filled(), quantity: '1.5' }, 0, '2026-10-20').quantity,
    ).toBe(ruleText('too_many_decimals'));
    expect(validateForm('receive', { ...filled(), quantity: '1.5' }, 3, '2026-10-20')).toEqual({});
    expect(validateForm('receive', { ...filled(), quantity: '0' }, 3, '2026-10-20').quantity).toBe(
      ruleText('quantity_must_be_positive'),
    );
    expect(
      validateForm('receive', { ...filled(), businessDate: '2999-01-01' }, 0, '2026-10-20')
        .businessDate,
    ).toBe(ruleText('date_in_future'));
  });

  it('an adjustment needs a reason, and Other needs a note', () => {
    expect(
      validateForm('adjust', { ...filled(), reasonCode: '' }, 0, '2026-10-20').reasonCode,
    ).toBe(ruleText('required'));
    expect(validateForm('adjust', { ...filled(), reasonCode: 'OTHER' }, 0, '2026-10-20').note).toBe(
      ruleText('required_for_other'),
    );
  });
});

describe('messages and helpers', () => {
  it('maps rule codes to wording and never echoes server text', () => {
    expect(ruleText('insufficient_stock')).toMatch(/not enough stock/);
    expect(ruleText('something_new')).toBe('This value is not acceptable.');
    expect(
      errorsFromProblems([
        { field: 'quantity', rule: 'insufficient_stock' },
        { field: 'quantity', rule: 'x' },
      ]),
    ).toEqual({
      quantity: ruleText('insufficient_stock'),
    });
    expect(describeErrors({ quantity: 'x', zzz: 'plain' })).toEqual(['Quantity: x', 'plain']);
  });

  it('localToday is the local calendar date; operation ids are unique UUIDs', () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localToday(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
    const a = newOperationId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newOperationId()).not.toBe(a);
  });
});
