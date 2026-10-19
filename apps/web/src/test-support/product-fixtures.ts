// Test-only: product records and reference lists for component tests (fictional data). Not shipped.
import type { ProductReferencesResponse, ProductView } from '@commercebill/shared-types';

let n = 0;
export const UNIT_PCS = '10000000-0000-4000-8000-000000000001';
export const UNIT_KG = '10000000-0000-4000-8000-000000000002';
export const TAX_18 = '20000000-0000-4000-8000-000000000018';
export const TAX_5 = '20000000-0000-4000-8000-000000000005';

export const references = (
  over: Partial<ProductReferencesResponse> = {},
): ProductReferencesResponse => ({
  units: [
    { id: UNIT_PCS, code: 'PCS', name: 'Pieces', decimalPlaces: 0 },
    { id: UNIT_KG, code: 'KG', name: 'Kilogram', decimalPlaces: 3 },
  ],
  taxCategories: [
    { id: TAX_18, code: 'GST_18', name: 'GST 18%', classification: 'STANDARD' },
    { id: TAX_5, code: 'GST_5', name: 'GST 5%', classification: 'STANDARD' },
  ],
  hsnSacTotal: 2,
  ...over,
});

export function product(over: Partial<ProductView> = {}): ProductView {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n + 5000).padStart(12, '0')}`,
    sku: `PRD-${String(n).padStart(6, '0')}`,
    name: `Fictional Product ${n}`,
    description: null,
    kind: 'GOODS',
    hsnSacCodeId: null,
    hsnSacCode: null,
    unitId: UNIT_PCS,
    unit: { code: 'PCS', name: 'Pieces', decimalPlaces: 0 },
    taxCategoryId: TAX_18,
    taxCategory: { code: 'GST_18', name: 'GST 18%', classification: 'STANDARD' },
    mrp: null,
    sellingPrice: '1180.00',
    priceIncludesTax: false,
    trackInventory: false,
    barcode: null,
    isActive: true,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    version: 1,
    ...over,
  };
}
