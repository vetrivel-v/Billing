import { describe, expect, it } from 'vitest';
import { gstinCheckCharacter } from '../../setup/src/validators.js';
import { validateCustomer } from './validate.js';

const gstin = (state: string, pan: string) => {
  const f = `${state}${pan}1Z`;
  return `${f}${gstinCheckCharacter(f)}`;
};
const base = {
  customerKind: 'BUSINESS',
  legalName: '  Fictional Buyer  ',
  gstStatus: 'REGISTERED',
  pan: 'abcde1234f',
  gstin: gstin('27', 'ABCDE1234F').toLowerCase(),
  billingAddressLine1: '1 Road',
  billingStateCode: '27',
};
const rules = (raw: Record<string, unknown>, code = false) => {
  const r = validateCustomer(raw, code);
  return r.ok ? [] : r.problems.map((p) => `${p.field}:${p.rule}`);
};

describe('validateCustomer normalisation', () => {
  it('trims, upper-cases identifiers, nulls blanks and defaults the place of supply', () => {
    const r = validateCustomer(
      { ...base, displayName: '   ', email: ' a@b.test ', notes: '' },
      false,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      legalName: 'Fictional Buyer',
      displayName: null,
      email: 'a@b.test',
      notes: null,
      pan: 'ABCDE1234F',
      gstin: gstin('27', 'ABCDE1234F'),
      placeOfSupplyStateCode: '27',
      shippingSameAsBilling: true,
      creditLimit: null,
      paymentTermsDays: null,
    });
  });

  it('formats money as two decimals and reads numeric strings for terms', () => {
    const r = validateCustomer({ ...base, creditLimit: 1500, paymentTermsDays: '30' }, false);
    expect(r.ok && r.value.creditLimit).toBe('1500.00');
    expect(r.ok && r.value.paymentTermsDays).toBe(30);
    expect(validateCustomer({ ...base, creditLimit: '12.5' }, false)).toMatchObject({
      value: { creditLimit: '12.5' },
    });
  });

  it('clears the GSTIN of an unregistered customer only after the rule check (never silently)', () => {
    expect(rules({ ...base, gstStatus: 'UNREGISTERED' })).toEqual(['gstin:gstin_not_allowed']);
    const r = validateCustomer(
      { ...base, gstStatus: 'UNREGISTERED', gstin: null, pan: null },
      false,
    );
    expect(r.ok && r.value.gstin).toBeNull();
  });

  it('uses the delivery state as place of supply when shipping differs, unless set', () => {
    const ship = {
      shippingSameAsBilling: false,
      shippingAddressLine1: '2 Dock',
      shippingStateCode: '29',
    };
    const r = validateCustomer({ ...base, ...ship }, false);
    expect(r.ok && r.value.placeOfSupplyStateCode).toBe('29');
    const pinned = validateCustomer({ ...base, ...ship, placeOfSupplyStateCode: '07' }, false);
    expect(pinned.ok && pinned.value.placeOfSupplyStateCode).toBe('07');
    expect(rules({ ...base, ...ship, placeOfSupplyStateCode: '98' })).toEqual([
      'placeOfSupplyStateCode:unknown_state_code',
    ]);
  });
});

describe('validateCustomer problems', () => {
  it('reports value-free problems for each bad field', () => {
    const all = rules({
      customerKind: 'B3B',
      legalName: '',
      gstStatus: 'MAYBE',
      billingAddressLine1: '',
      billingStateCode: '98',
      billingPinCode: '1234',
      email: 'x',
      phone: '!!',
      alternatePhone: 'abc',
      creditLimit: 'ten',
      paymentTermsDays: -1,
      pan: 'no',
    });
    expect(all).toEqual(
      expect.arrayContaining([
        'customerKind:invalid_value',
        'legalName:required',
        'gstStatus:invalid_value',
        'billingAddressLine1:required',
        'billingStateCode:unknown_state_code',
        'billingPinCode:invalid_pin_code',
        'email:invalid_email',
        'phone:invalid_phone',
        'alternatePhone:invalid_phone',
        'creditLimit:invalid_amount',
        'paymentTermsDays:out_of_range',
        'pan:invalid_pan_format',
      ]),
    );
  });

  it('applies the GSTIN consistency rules', () => {
    expect(rules({ ...base, gstin: undefined })).toEqual(['gstin:gstin_required']);
    expect(rules({ ...base, gstin: 'X' })).toEqual(['gstin:invalid_gstin_format']);
    expect(rules({ ...base, billingStateCode: '29' })).toEqual(['gstin:gstin_state_mismatch']);
    expect(rules({ ...base, pan: 'ZZZZZ9999Z' })).toEqual(['gstin:gstin_pan_mismatch']);
    // A composition customer is registered too: a GSTIN is required (it was optional before Task 1.12).
    expect(rules({ ...base, gstStatus: 'COMPOSITION', gstin: undefined, pan: undefined })).toEqual([
      'gstin:gstin_required',
    ]);
    expect(rules({ ...base, gstStatus: 'COMPOSITION' })).toEqual([]);
    expect(rules({ ...base, gstStatus: 'UNREGISTERED', gstin: base.gstin })).toEqual([
      'gstin:gstin_not_allowed',
    ]);
    // The customer kind says nothing about GST registration: an individual may be registered, a business may not.
    expect(rules({ ...base, customerKind: 'INDIVIDUAL' })).toEqual([]);
    expect(
      rules({
        ...base,
        customerKind: 'BUSINESS',
        gstStatus: 'UNREGISTERED',
        gstin: undefined,
        pan: undefined,
      }),
    ).toEqual([]);
  });

  it('rejects unknown fields, wrong types, over-long text and (on update) a code', () => {
    expect(rules({ ...base, organizationId: 'x' })).toEqual(['organizationId:unknown_field']);
    expect(rules({ ...base, code: 'A' })).toEqual(['code:unknown_field']); // not allowed on update
    expect(rules({ ...base, code: 'a-1' }, true)).toEqual([]);
    expect(rules({ ...base, code: 'bad code' }, true)).toEqual(['code:invalid_code']);
    expect(rules({ ...base, legalName: 5 })).toContain('legalName:invalid_type');
    expect(rules({ ...base, legalName: 'x'.repeat(201) })).toContain('legalName:too_long');
    expect(rules({ ...base, shippingSameAsBilling: 'yes' })).toContain(
      'shippingSameAsBilling:invalid_type',
    );
    expect(rules({ ...base, shippingSameAsBilling: false })).toEqual(
      expect.arrayContaining(['shippingAddressLine1:required', 'shippingStateCode:required']),
    );
  });
});
