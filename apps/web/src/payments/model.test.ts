import { describe, expect, it } from 'vitest';
import { ApiError, ApiUnreachableError } from '../api.js';
import {
  METHOD_OPTIONS,
  STATUS_LABEL,
  classifyPaymentFailure,
  emptyPaymentForm,
  methodLabel,
  ruleText,
  toPaymentRequest,
  validateForm,
} from './model.js';

const INV = '11111111-1111-4111-8111-111111111111';
const form = (over = {}) => ({ ...emptyPaymentForm(), amount: '100', ...over });

describe('payment request building', () => {
  it('sends choices only; the mode follows the invoice; blank optional fields are left out', () => {
    expect(toPaymentRequest(INV, true, form({ amount: ' 250.50 ' }))).toEqual({
      mode: 'DEMO',
      invoiceId: INV,
      amount: '250.50',
      method: 'CASH',
    });
    expect(
      toPaymentRequest(INV, false, form({ method: 'UPI', reference: ' UTR1 ', notes: ' n ' })),
    ).toEqual({
      mode: 'PRODUCTION',
      invoiceId: INV,
      amount: '100',
      method: 'UPI',
      reference: 'UTR1',
      notes: 'n',
    });
  });
  it('never contains a balance, customer or organization', () => {
    const keys = Object.keys(toPaymentRequest(INV, false, form({ reference: 'x', notes: 'y' })));
    for (const k of ['balanceDue', 'alreadyPaid', 'customerId', 'organizationId', 'isDemo'])
      expect(keys).not.toContain(k);
  });
});

describe('early validation (same rules as the server)', () => {
  it('accepts a good form and explains each problem', () => {
    expect(validateForm(INV, true, form())).toEqual({});
    expect(validateForm(INV, true, form({ amount: '' })).amount).toBe(ruleText('required'));
    expect(validateForm(INV, true, form({ amount: '0' })).amount).toMatch(/greater than zero/);
    expect(validateForm(INV, true, form({ amount: '1.234' })).amount).toMatch(/two decimal/);
    expect(validateForm(INV, true, form({ amount: 'x' })).amount).toMatch(/plain amount/);
    expect(validateForm(INV, true, form({ method: 'UPI' })).reference).toMatch(/needs a reference/);
    expect(validateForm(INV, true, form({ method: 'CHEQUE', reference: '004512' }))).toEqual({});
    expect(
      validateForm(INV, true, form({ method: 'CARD', reference: '4111111111111111' })).reference,
    ).toMatch(/card number/);
    expect(validateForm(INV, true, form({ notes: 'n'.repeat(501) })).notes).toMatch(/too long/);
    expect(ruleText('unheard_of')).toBe('This value is not acceptable.');
  });
});

describe('labels', () => {
  it('has a label for every method and every display status', () => {
    expect(METHOD_OPTIONS.map((o) => o.value)).toEqual([
      'CASH',
      'UPI',
      'BANK_TRANSFER',
      'CHEQUE',
      'CARD',
      'OTHER',
    ]);
    expect(methodLabel('BANK_TRANSFER')).toBe('Bank transfer');
    expect(methodLabel('ODD')).toBe('ODD');
    expect(Object.values(STATUS_LABEL)).toEqual(['Unpaid', 'Partly paid', 'Paid']);
  });
});

describe('failure wording', () => {
  it('maps stable codes to plain text and treats lost answers as uncertain', () => {
    expect(classifyPaymentFailure(new ApiUnreachableError())).toEqual({ kind: 'uncertain' });
    expect(classifyPaymentFailure(new TypeError('x'))).toEqual({ kind: 'uncertain' });
    expect(classifyPaymentFailure(new ApiError(500, 'SYS_0500'))).toEqual({ kind: 'uncertain' });
    expect(classifyPaymentFailure(new ApiError(403, 'AUTHZ_0001'))).toMatchObject({
      kind: 'rejected',
    });
    const over = classifyPaymentFailure(
      new ApiError(409, 'BIZ_0001', [{ field: 'amount', rule: 'AMOUNT_EXCEEDS_BALANCE' }], {
        balanceDue: '680.00',
      }),
    );
    expect(over).toEqual({
      kind: 'rejected',
      message: 'The amount is more than the balance due (₹680.00). Nothing was recorded.',
      balanceDue: '680.00',
    });
    expect(
      classifyPaymentFailure(
        new ApiError(409, 'BIZ_0001', [{ field: 'invoiceId', rule: 'INVOICE_FULLY_PAID' }]),
      ),
    ).toMatchObject({ message: expect.stringMatching(/already fully paid/) });
    expect(
      classifyPaymentFailure(
        new ApiError(409, 'BIZ_0001', [{ field: 'mode', rule: 'INVOICE_MODE_MISMATCH' }]),
      ),
    ).toMatchObject({ message: expect.stringMatching(/demo or production/) });
    expect(
      classifyPaymentFailure(new ApiError(400, 'VAL_0001', [{ field: 'x', rule: 'WHATEVER' }])),
    ).toMatchObject({ message: expect.stringMatching(/could not be recorded/) });
    expect(
      classifyPaymentFailure(
        new ApiError(409, 'BIZ_0001', [{ field: 'amount', rule: 'AMOUNT_EXCEEDS_BALANCE' }]),
      ),
    ).toMatchObject({ message: 'The amount is more than the balance due. Nothing was recorded.' });
  });
});
