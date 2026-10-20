import { describe, expect, it } from 'vitest';
import { customer } from '../test-support/customer-fixtures.js';
import {
  describeErrors,
  emptyCustomerForm,
  errorsFromProblems,
  formFromCustomer,
  ruleText,
  toApiBody,
  validateForm,
  deliveryStateCode,
} from './model.js';

const filled = () => ({
  ...emptyCustomerForm(),
  legalName: 'Acme',
  billingAddressLine1: '1 Road',
  billingStateCode: '27',
});

describe('toApiBody', () => {
  it('sends blanks as null (so an edit clears them) and trims values', () => {
    const body = toApiBody({ ...filled(), legalName: '  Acme  ', phone: '   ', notes: '' }, false);
    expect(body).toMatchObject({ legalName: 'Acme', phone: null, notes: null, displayName: null });
    expect(body).not.toHaveProperty('code');
  });

  it('includes the code only when creating with one', () => {
    expect(toApiBody({ ...filled(), code: 'ACME-1' }, true)).toMatchObject({ code: 'ACME-1' });
    expect(toApiBody({ ...filled(), code: '' }, true)).not.toHaveProperty('code');
    expect(toApiBody({ ...filled(), code: 'ACME-1' }, false)).not.toHaveProperty('code');
  });

  it('sends GST facts by GST status alone (the kind has no tax meaning) and an unregistered one has no GSTIN', () => {
    const individual = toApiBody(
      {
        ...filled(),
        customerKind: 'INDIVIDUAL',
        gstStatus: 'REGISTERED',
        gstin: '27ABCDE1234F1Z0',
      },
      true,
    );
    expect(individual).toMatchObject({
      customerKind: 'INDIVIDUAL',
      gstStatus: 'REGISTERED',
      gstin: '27ABCDE1234F1Z0',
    });
    const unreg = toApiBody({ ...filled(), gstStatus: 'UNREGISTERED', gstin: 'X' }, true);
    expect(unreg).toMatchObject({ gstin: null });
  });

  it('drops shipping values when shipping is the same as billing', () => {
    const body = toApiBody(
      {
        ...filled(),
        shippingSameAsBilling: true,
        shippingAddressLine1: 'stale',
        shippingStateCode: '29',
      },
      true,
    );
    expect(body).toMatchObject({ shippingAddressLine1: null, shippingStateCode: null });
  });
});

describe('formFromCustomer', () => {
  it('shows the place of supply as "default" when it equals the delivery state', () => {
    expect(formFromCustomer(customer()).placeOfSupplyStateCode).toBe('');
    const ship = customer({
      shippingSameAsBilling: false,
      shippingStateCode: '29',
      placeOfSupplyStateCode: '29',
    });
    expect(formFromCustomer(ship).placeOfSupplyStateCode).toBe('');
    const pinned = customer({ placeOfSupplyStateCode: '07' });
    expect(formFromCustomer(pinned).placeOfSupplyStateCode).toBe('07');
  });

  it('turns nulls into empty strings and numbers into text', () => {
    const f = formFromCustomer(customer({ paymentTermsDays: 30, creditLimit: '1000.00' }));
    expect(f).toMatchObject({
      paymentTermsDays: '30',
      creditLimit: '1000.00',
      displayName: '',
      gstin: '',
    });
    expect(deliveryStateCode(f)).toBe('27');
  });
});

describe('validation and messages', () => {
  it('uses the same rules as the server and maps them to field keys', () => {
    expect(validateForm(filled(), true)).toEqual({});
    const errors = validateForm({ ...emptyCustomerForm() }, true);
    expect(Object.keys(errors).sort()).toEqual([
      'billingAddressLine1',
      'billingStateCode',
      'legalName',
    ]);
    const reg = validateForm({ ...filled(), gstStatus: 'REGISTERED' }, true);
    expect(reg.gstin).toContain('GSTIN');
  });

  it('puts a missing delivery state on the shipping field, not on a hidden place-of-supply field', () => {
    const e = validateForm(
      { ...filled(), shippingSameAsBilling: false, shippingAddressLine1: '9 Dock' },
      true,
    );
    expect(e.shippingStateCode).toBeTruthy();
    expect(e.placeOfSupplyStateCode).toBeUndefined();
  });

  it('summarises with field names and never echoes server wording', () => {
    expect(describeErrors({ legalName: 'This field is required.', zzz: 'plain' })).toEqual([
      'Customer name: This field is required.',
      'plain',
    ]);
    expect(
      errorsFromProblems([
        { field: 'gstin', rule: 'duplicate_gstin' },
        { field: 'x', rule: 'weird' },
      ]),
    ).toEqual({
      gstin: ruleText('duplicate_gstin'),
      x: 'This value is not acceptable.',
    });
  });
});
