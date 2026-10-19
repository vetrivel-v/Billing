import { describe, expect, it } from 'vitest';
import { normalizeMoney, validateProduct } from './validate.js';

const UNIT = '11111111-1111-4111-8111-111111111111';
const TAX = '22222222-2222-4222-8222-222222222222';
const HSN = '33333333-3333-4333-8333-333333333333';
const goods = {
  sku: 'abc-1',
  name: '  Fictional Widget  ',
  kind: 'GOODS',
  unitId: UNIT,
  taxCategoryId: TAX,
  sellingPrice: '1180',
};
const rules = (raw: Record<string, unknown>, allowSku = true) => {
  const r = validateProduct(raw, allowSku);
  return r.ok ? [] : r.problems.map((p) => `${p.field}:${p.rule}`);
};

describe('normalizeMoney (exact decimal strings, no floating point)', () => {
  it('pads to two places and strips leading zeros without changing the value', () => {
    expect(normalizeMoney('12')).toEqual({ ok: true, value: '12.00' });
    expect(normalizeMoney('12.5')).toEqual({ ok: true, value: '12.50' });
    expect(normalizeMoney('007.5')).toEqual({ ok: true, value: '7.50' });
    expect(normalizeMoney('0.10')).toEqual({ ok: true, value: '0.10' });
    expect(normalizeMoney(' 0 ')).toEqual({ ok: true, value: '0.00' });
  });

  it('keeps every digit of a value that a JavaScript number would corrupt', () => {
    expect(normalizeMoney('1234567890123456.78')).toEqual({
      ok: true,
      value: '1234567890123456.78',
    });
    expect(normalizeMoney('9007199254740993.01')).toEqual({
      ok: true,
      value: '9007199254740993.01',
    });
    // for contrast: a JavaScript number cannot hold that value
    expect(String(Number('1234567890123456.78'))).not.toBe('1234567890123456.78');
  });

  it('accepts a JavaScript number only through its exact text and refuses anything inexact', () => {
    expect(normalizeMoney(19.99)).toEqual({ ok: true, value: '19.99' });
    expect(normalizeMoney(5)).toEqual({ ok: true, value: '5.00' });
    expect(normalizeMoney(0.1 + 0.2)).toEqual({ ok: false, rule: 'invalid_amount' }); // 0.30000000000000004
    expect(normalizeMoney(1e21)).toEqual({ ok: false, rule: 'invalid_amount' });
    expect(normalizeMoney(Number.NaN)).toEqual({ ok: false, rule: 'invalid_amount' });
  });

  it('refuses a third decimal place (never rounds), negatives, exponents and junk', () => {
    expect(normalizeMoney('10.999')).toEqual({ ok: false, rule: 'invalid_amount' });
    expect(normalizeMoney('10.001')).toEqual({ ok: false, rule: 'invalid_amount' });
    expect(normalizeMoney('-5')).toEqual({ ok: false, rule: 'negative_amount' });
    expect(normalizeMoney('-0.50')).toEqual({ ok: false, rule: 'negative_amount' });
    for (const bad of ['1e3', '.5', '5.', '1,000', '₹5', 'abc', '', '10000000000000000.00']) {
      expect(normalizeMoney(bad), bad).toEqual({ ok: false, rule: 'invalid_amount' });
    }
  });
});

describe('validateProduct', () => {
  it('normalises: trims, upper-cases the SKU, two-place prices, defaults', () => {
    const r = validateProduct({ ...goods, description: '  ', mrp: '1500.5' }, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sku).toBe('ABC-1');
    expect(r.value).toMatchObject({
      name: 'Fictional Widget',
      description: null,
      kind: 'GOODS',
      sellingPrice: '1180.00',
      mrp: '1500.50',
      priceIncludesTax: false,
      trackInventory: false,
      barcode: null,
      hsnSacCodeId: null,
    });
  });

  it('does not impose "selling price <= MRP" or any other price relationship', () => {
    expect(rules({ ...goods, sellingPrice: '2000', mrp: '1000' })).toEqual([]);
    expect(rules({ ...goods, sellingPrice: '0' })).toEqual([]); // free items are allowed
  });

  it('goods need a unit; services do not, and a service can never track inventory', () => {
    expect(rules({ ...goods, unitId: undefined })).toEqual(['unitId:required']);
    expect(rules({ ...goods, kind: 'SERVICE', unitId: undefined })).toEqual([]);
    expect(rules({ ...goods, kind: 'SERVICE', trackInventory: true })).toEqual([
      'trackInventory:service_cannot_track_inventory',
    ]);
    expect(rules({ ...goods, trackInventory: true })).toEqual([]);
  });

  it('reports value-free problems for every bad field', () => {
    const all = rules({
      sku: 'bad sku!',
      name: '',
      kind: 'BUNDLE',
      taxCategoryId: 'not-a-uuid',
      unitId: 5,
      hsnSacCodeId: 'x',
      sellingPrice: '1.234',
      mrp: '-1',
      priceIncludesTax: 'yes',
      barcode: 'has space',
    });
    expect(all).toEqual(
      expect.arrayContaining([
        'sku:invalid_sku',
        'name:required',
        'kind:invalid_value',
        'taxCategoryId:invalid_reference',
        'unitId:invalid_reference',
        'hsnSacCodeId:invalid_reference',
        'sellingPrice:invalid_amount',
        'mrp:negative_amount',
        'priceIncludesTax:invalid_type',
        'barcode:invalid_barcode',
      ]),
    );
  });

  it('requires a selling price and a tax category', () => {
    expect(rules({ ...goods, sellingPrice: undefined })).toEqual(['sellingPrice:required']);
    expect(rules({ ...goods, taxCategoryId: undefined })).toEqual(['taxCategoryId:required']);
  });

  it('rejects unknown fields, a SKU on update, quantity-like fields and over-long text', () => {
    expect(rules({ ...goods, organizationId: 'x' })).toEqual(['organizationId:unknown_field']);
    expect(rules({ ...goods, quantity: 5 })).toEqual(['quantity:unknown_field']); // stock is not a product field
    expect(rules({ ...goods, costPrice: '5' })).toEqual(['costPrice:unknown_field']); // cost is deferred
    expect(rules(goods, false)).toEqual(['sku:unknown_field']);
    expect(rules({ ...goods, name: 'x'.repeat(201) })).toEqual(['name:too_long']);
    expect(rules({ ...goods, hsnSacCodeId: HSN })).toEqual([]);
  });
});
