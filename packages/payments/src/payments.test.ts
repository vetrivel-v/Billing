import { describe, expect, it } from 'vitest';
import { paymentFingerprint } from './fingerprint.js';
import {
  looksLikeCardNumber,
  validateRecordRequest,
  type RecordPaymentRequest,
} from './validate.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const base = () => ({
  mode: 'DEMO',
  invoiceId: U1,
  amount: '100',
  method: 'CASH',
  operationId: U2,
});
const rules = (raw: Record<string, unknown>) => {
  const r = validateRecordRequest(raw);
  return r.ok ? [] : r.problems.map((p) => `${p.field}:${p.rule}`);
};

describe('validateRecordRequest', () => {
  it('accepts a minimal request and normalizes the amount to two decimals', () => {
    for (const [given, want] of [
      ['100', '100.00'],
      ['100.5', '100.50'],
      ['100.50', '100.50'],
      ['007', '7.00'],
      ['0.01', '0.01'],
      ['9999999999999999.99', '9999999999999999.99'],
    ]) {
      const r = validateRecordRequest({ ...base(), amount: given });
      expect(r.ok, given).toBe(true);
      if (r.ok) expect(r.value.amount).toBe(want);
    }
  });
  it('refuses zero, negative, over-precise and non-text amounts', () => {
    expect(rules({ ...base(), amount: '0' })).toEqual(['amount:amount_must_be_positive']);
    expect(rules({ ...base(), amount: '0.00' })).toEqual(['amount:amount_must_be_positive']);
    expect(rules({ ...base(), amount: '-1' })).toEqual(['amount:invalid_amount']);
    expect(rules({ ...base(), amount: '1.001' })).toEqual(['amount:too_many_decimals']);
    expect(rules({ ...base(), amount: 5 })).toEqual(['amount:invalid_amount']);
    expect(rules({ ...base(), amount: '' })).toEqual(['amount:required']);
    expect(rules({ ...base(), amount: '12345678901234567' })).toEqual(['amount:invalid_amount']);
  });
  it('requires a reference for transfers, UPI and cheques, and refuses things that look like card numbers', () => {
    for (const method of ['UPI', 'BANK_TRANSFER', 'CHEQUE'])
      expect(rules({ ...base(), method })).toEqual(['reference:required_for_method']);
    expect(rules({ ...base(), method: 'UPI', reference: 'abc123' })).toEqual([]);
    expect(rules({ ...base(), method: 'CASH' })).toEqual([]);
    expect(rules({ ...base(), method: 'CARD', reference: '5500 0000 0000 0004' })).toEqual([
      'reference:looks_like_card_number',
    ]);
    expect(rules({ ...base(), reference: 'a'.repeat(61) })).toEqual(['reference:too_long']);
    expect(rules({ ...base(), reference: 'a\nb' })).toEqual(['reference:invalid_characters']);
    expect(rules({ ...base(), reference: 7 })).toEqual(['reference:invalid_type']);
    expect(rules({ ...base(), notes: 7 })).toEqual(['notes:invalid_type']);
  });
  it('card-number detection uses Luhn: only valid-looking long digit strings are refused', () => {
    expect(looksLikeCardNumber('4111111111111111')).toBe(true);
    expect(looksLikeCardNumber('4111-1111-1111-1111')).toBe(true);
    expect(looksLikeCardNumber('4111111111111112')).toBe(false);
    expect(looksLikeCardNumber('004512')).toBe(false);
    expect(looksLikeCardNumber('UTR123456789012345')).toBe(false);
  });
  it('refuses unknown fields (no balance, customer or organization from the browser) and bad references', () => {
    for (const f of ['balanceDue', 'alreadyPaid', 'customerId', 'organizationId', 'isDemo'])
      expect(rules({ ...base(), [f]: '1' })).toEqual([`${f}:unknown_field`]);
    expect(rules({ ...base(), mode: undefined })).toEqual(['mode:required']);
    expect(rules({ ...base(), mode: 'LIVE' })).toEqual(['mode:invalid_choice']);
    expect(rules({ ...base(), invoiceId: 'x' })).toEqual(['invoiceId:invalid_reference']);
    expect(rules({ ...base(), operationId: undefined })).toEqual(['operationId:required']);
    expect(rules({ ...base(), method: 'GOLD' })).toEqual(['method:invalid_choice']);
    expect(rules({ ...base(), paymentDate: '2026-02-30' })).toEqual(['paymentDate:invalid_date']);
    expect(rules({ ...base(), paymentDate: '2026-02-28' })).toEqual([]);
  });
});

describe('paymentFingerprint', () => {
  const fp = (over: Partial<RecordPaymentRequest> = {}) => {
    const r = validateRecordRequest(base());
    if (!r.ok) throw new Error('invalid');
    return paymentFingerprint({ ...r.value, ...over });
  };
  it('is stable, ignores the operation id and changes with any content', () => {
    const a = fp();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fp()).toBe(a);
    expect(fp({ operationId: U1 })).toBe(a);
    for (const change of [
      { amount: '101.00' },
      { method: 'UPI' as const },
      { reference: 'x' },
      { notes: 'x' },
      { invoiceId: U2 },
      { mode: 'PRODUCTION' as const },
      { paymentDate: '2026-10-20' },
    ])
      expect(fp(change)).not.toBe(a);
  });
});
