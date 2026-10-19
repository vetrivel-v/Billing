import { describe, expect, it } from 'vitest';
import { product, TAX_18, UNIT_PCS } from '../test-support/product-fixtures.js';
import {
  describeErrors,
  emptyProductForm,
  errorsFromProblems,
  formFromProduct,
  ruleText,
  toApiBody,
  validateForm,
} from './model.js';

const filled = () => ({
  ...emptyProductForm('GOODS'),
  name: 'Widget',
  unitId: UNIT_PCS,
  taxCategoryId: TAX_18,
  sellingPrice: '1180',
});

describe('toApiBody', () => {
  it('sends blanks as null and prices as typed text (never numbers)', () => {
    const body = toApiBody(
      { ...filled(), name: '  Widget ', mrp: '', description: ' ', barcode: '' },
      false,
    );
    expect(body).toMatchObject({
      name: 'Widget',
      mrp: null,
      description: null,
      barcode: null,
      sellingPrice: '1180',
    });
    expect(typeof body.sellingPrice).toBe('string');
    expect(body).not.toHaveProperty('sku');
  });

  it('includes the SKU only when creating with one', () => {
    expect(toApiBody({ ...filled(), sku: 'ABC-1' }, true)).toMatchObject({ sku: 'ABC-1' });
    expect(toApiBody({ ...filled(), sku: '' }, true)).not.toHaveProperty('sku');
    expect(toApiBody({ ...filled(), sku: 'ABC-1' }, false)).not.toHaveProperty('sku');
  });

  it('a service never sends inventory tracking, whatever the form says', () => {
    const body = toApiBody({ ...filled(), kind: 'SERVICE', trackInventory: true }, true);
    expect(body).toMatchObject({ kind: 'SERVICE', trackInventory: false });
    expect(toApiBody({ ...filled(), trackInventory: true }, true)).toMatchObject({
      trackInventory: true,
    });
  });

  it('never carries a quantity, cost or organization', () => {
    const keys = Object.keys(toApiBody(filled(), true));
    for (const k of ['quantity', 'stock', 'costPrice', 'organizationId', 'id', 'version'])
      expect(keys).not.toContain(k);
  });
});

describe('formFromProduct', () => {
  it('turns nulls into empty text, keeps money as text, labels the HSN/SAC code', () => {
    const f = formFromProduct(
      product({
        mrp: '1500.00',
        description: null,
        hsnSacCodeId: 'h1',
        hsnSacCode: { code: '8517', kind: 'HSN', description: 'Telephone sets' },
      }),
    );
    expect(f).toMatchObject({
      mrp: '1500.00',
      sellingPrice: '1180.00',
      description: '',
      hsnSacLabel: '8517 - Telephone sets',
    });
  });
});

describe('validation and messages', () => {
  it('uses the same rules as the server', () => {
    expect(validateForm(filled(), true)).toEqual({});
    const errors = validateForm(emptyProductForm('GOODS'), true);
    expect(Object.keys(errors).sort()).toEqual(['name', 'sellingPrice', 'taxCategoryId', 'unitId']);
    expect(validateForm({ ...filled(), sellingPrice: '10.999' }, true).sellingPrice).toContain(
      'two decimal places',
    );
    expect(validateForm({ ...filled(), sellingPrice: '-5' }, true).sellingPrice).toContain(
      'cannot be negative',
    );
    expect(validateForm({ ...filled(), kind: 'SERVICE', unitId: '' }, true)).toEqual({});
    expect(validateForm({ ...filled(), mrp: 'abc' }, true).mrp).toBeTruthy();
  });

  it('does not impose a selling-price-versus-MRP rule', () => {
    expect(validateForm({ ...filled(), sellingPrice: '2000', mrp: '1000' }, true)).toEqual({});
  });

  it('summarises with field names and maps server rules without echoing server wording', () => {
    expect(describeErrors({ sellingPrice: 'x', zzz: 'plain' })).toEqual([
      'Selling price: x',
      'plain',
    ]);
    expect(
      errorsFromProblems([
        { field: 'sku', rule: 'duplicate_sku' },
        { field: 'q', rule: 'weird' },
      ]),
    ).toEqual({
      sku: ruleText('duplicate_sku'),
      q: 'This value is not acceptable.',
    });
  });
});
