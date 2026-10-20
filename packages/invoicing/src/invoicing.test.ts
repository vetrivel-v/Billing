import { describe, expect, it } from 'vitest';
import { businessDate } from './facts.js';
import { requestFingerprint, validatePostRequest, validatePreviewRequest } from './validate.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const base = () => ({
  mode: 'DEMO',
  customerId: U1,
  lines: [{ productId: U2, quantity: '2' }],
  placeOfSupply: { stateCode: '27', choice: 'CONFIRMED' },
});
const post = () => ({
  ...base(),
  operationId: U1,
  calculation: {
    inputHash: 'a'.repeat(64),
    configurationFingerprint: 'b'.repeat(64),
    grandTotal: '10.00',
  },
});
const problems = (r: { ok: boolean; problems?: { field: string; rule: string }[] }) =>
  r.ok ? [] : r.problems!;

describe('businessDate (Asia/Kolkata, UTC+05:30)', () => {
  it('rolls over at 18:30 UTC', () => {
    expect(businessDate(new Date('2026-10-20T18:29:59Z'))).toBe('2026-10-20');
    expect(businessDate(new Date('2026-10-20T18:30:00Z'))).toBe('2026-10-21');
    expect(businessDate(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01');
  });
});

describe('validatePreviewRequest', () => {
  it('accepts a minimal request and canonicalizes quantities', () => {
    const r = validatePreviewRequest({ ...base(), lines: [{ productId: U2, quantity: '2.50' }] });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value.lines[0]).toMatchObject({ quantity: '2.5', discount: { type: 'NONE' } });
  });
  it('requires a mode and refuses an invalid one', () => {
    expect(problems(validatePreviewRequest({ ...base(), mode: undefined }))).toEqual([
      { field: 'mode', rule: 'required' },
    ]);
    expect(problems(validatePreviewRequest({ ...base(), mode: 'LIVE' }))).toEqual([
      { field: 'mode', rule: 'invalid_choice' },
    ]);
  });
  it('refuses unknown fields anywhere (no prices, totals or organization from the browser)', () => {
    expect(problems(validatePreviewRequest({ ...base(), total: '1' }))).toEqual([
      { field: 'total', rule: 'unknown_field' },
    ]);
    expect(
      problems(
        validatePreviewRequest({
          ...base(),
          lines: [{ productId: U2, quantity: '1', unitPrice: '1' }],
        }),
      ),
    ).toEqual([{ field: 'lines[0].unitPrice', rule: 'unknown_field' }]);
    expect(
      problems(
        validatePreviewRequest({
          ...base(),
          placeOfSupply: { stateCode: '27', choice: 'OVERRIDE', x: 1 },
        }),
      ),
    ).toEqual([{ field: 'placeOfSupply.x', rule: 'unknown_field' }]);
  });
  it('validates references, dates, line count, discounts and place of supply shape', () => {
    expect(problems(validatePreviewRequest({ ...base(), customerId: 'nope' }))).toEqual([
      { field: 'customerId', rule: 'invalid_reference' },
    ]);
    expect(problems(validatePreviewRequest({ ...base(), customerId: undefined }))).toEqual([
      { field: 'customerId', rule: 'required' },
    ]);
    expect(problems(validatePreviewRequest({ ...base(), invoiceDate: '2026-02-30' }))).toEqual([
      { field: 'invoiceDate', rule: 'invalid_date' },
    ]);
    expect(validatePreviewRequest({ ...base(), invoiceDate: '2026-02-28' }).ok).toBe(true);
    expect(problems(validatePreviewRequest({ ...base(), lines: [] }))).toEqual([
      { field: 'lines', rule: 'required' },
    ]);
    const many = Array.from({ length: 101 }, () => ({ productId: U2, quantity: '1' }));
    expect(problems(validatePreviewRequest({ ...base(), lines: many }))).toEqual([
      { field: 'lines', rule: 'too_many_lines' },
    ]);
    expect(problems(validatePreviewRequest({ ...base(), lines: ['x'] }))).toEqual([
      { field: 'lines[0]', rule: 'invalid_type' },
    ]);
    const d = (discount: unknown) =>
      validatePreviewRequest({ ...base(), lines: [{ productId: U2, quantity: '1', discount }] });
    expect(d({ type: 'PERCENT', percent: '10' }).ok).toBe(true);
    expect(d({ type: 'AMOUNT', amount: '5.25' }).ok).toBe(true);
    expect(problems(d({ type: 'PERCENT', percent: 'ten' }))).toEqual([
      { field: 'lines[0].discount.percent', rule: 'invalid_amount' },
    ]);
    expect(problems(d({ type: 'AMOUNT', amount: -1 }))).toEqual([
      { field: 'lines[0].discount.amount', rule: 'invalid_amount' },
    ]);
    expect(problems(d({ type: 'GIFT' }))).toEqual([
      { field: 'lines[0].discount.type', rule: 'invalid_choice' },
    ]);
    expect(problems(d('x'))).toEqual([{ field: 'lines[0].discount', rule: 'invalid_type' }]);
    expect(
      problems(
        validatePreviewRequest({
          ...base(),
          placeOfSupply: { stateCode: '2', choice: 'CONFIRMED' },
        }),
      ),
    ).toEqual([{ field: 'placeOfSupply.stateCode', rule: 'invalid_state_code' }]);
    expect(
      problems(
        validatePreviewRequest({ ...base(), placeOfSupply: { stateCode: '27', choice: 'GUESS' } }),
      ),
    ).toEqual([{ field: 'placeOfSupply.choice', rule: 'invalid_choice' }]);
    expect(problems(validatePreviewRequest({ ...base(), placeOfSupply: 'x' }))).toEqual([
      { field: 'placeOfSupply', rule: 'invalid_type' },
    ]);
  });
  it('refuses a non-numeric or non-positive quantity', () => {
    for (const q of ['abc', '0', '-1', '', 5, null])
      expect(
        validatePreviewRequest({ ...base(), lines: [{ productId: U2, quantity: q }] }).ok,
        String(q),
      ).toBe(false);
  });
});

describe('validatePostRequest', () => {
  it('accepts a complete post and requires the operation id, the place of supply and the calculation identity', () => {
    expect(validatePostRequest(post()).ok).toBe(true);
    const bare = { ...base(), placeOfSupply: undefined };
    expect(
      problems(validatePostRequest(bare))
        .map((p) => p.field)
        .sort(),
    ).toEqual(['calculation', 'operationId', 'placeOfSupply']);
  });
  it('checks the identity formats', () => {
    const bad = {
      ...post(),
      calculation: { inputHash: 'zz', configurationFingerprint: 'yy', grandTotal: '10' },
    };
    expect(problems(validatePostRequest(bad)).map((p) => p.field)).toEqual([
      'calculation.inputHash',
      'calculation.configurationFingerprint',
      'calculation.grandTotal',
    ]);
    expect(problems(validatePostRequest({ ...post(), operationId: 'x' }))).toEqual([
      { field: 'operationId', rule: 'invalid_reference' },
    ]);
    expect(problems(validatePostRequest({ ...post(), calculation: 'x' }))).toEqual([
      { field: 'calculation', rule: 'invalid_type' },
    ]);
    expect(
      problems(
        validatePostRequest({ ...post(), calculation: { ...post().calculation, extra: 1 } }),
      ),
    ).toEqual([{ field: 'calculation.extra', rule: 'unknown_field' }]);
  });
});

describe('requestFingerprint', () => {
  const fp = (over: Record<string, unknown> = {}) => {
    const r = validatePostRequest({ ...post(), ...over });
    if (!r.ok) throw new Error('invalid');
    return requestFingerprint(r.value);
  };
  it('is stable, ignores the freshness token and operation id, and changes with any content', () => {
    const a = fp();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fp()).toBe(a);
    expect(fp({ calculation: { ...post().calculation, grandTotal: '99.00' } })).toBe(a);
    expect(fp({ operationId: U2 })).toBe(a);
    expect(fp({ customerId: U2 })).not.toBe(a);
    expect(fp({ lines: [{ productId: U2, quantity: '3' }] })).not.toBe(a);
    expect(fp({ mode: 'PRODUCTION' })).not.toBe(a);
    expect(fp({ placeOfSupply: { stateCode: '29', choice: 'OVERRIDE' } })).not.toBe(a);
    expect(fp({ invoiceDate: '2026-10-20' })).not.toBe(a);
    expect(
      fp({
        lines: [{ productId: U2, quantity: '2', discount: { type: 'PERCENT', percent: '5' } }],
      }),
    ).not.toBe(a);
  });
});
