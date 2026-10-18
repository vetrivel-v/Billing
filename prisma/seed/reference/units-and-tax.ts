/** Default units of measurement. Codes are stable identifiers; names are editable by the business. */
export interface UnitDef {
  code: string;
  name: string;
  decimalPlaces: number;
}

export const UNITS: readonly UnitDef[] = [
  { code: 'PCS', name: 'Pieces', decimalPlaces: 0 },
  { code: 'NOS', name: 'Numbers', decimalPlaces: 0 },
  { code: 'PAIR', name: 'Pair', decimalPlaces: 0 },
  { code: 'SET', name: 'Set', decimalPlaces: 0 },
  { code: 'BOX', name: 'Box', decimalPlaces: 0 },
  { code: 'PKT', name: 'Packet', decimalPlaces: 0 },
  { code: 'DOZ', name: 'Dozen', decimalPlaces: 0 },
  { code: 'KG', name: 'Kilogram', decimalPlaces: 3 },
  { code: 'G', name: 'Gram', decimalPlaces: 0 },
  { code: 'L', name: 'Litre', decimalPlaces: 3 },
  { code: 'ML', name: 'Millilitre', decimalPlaces: 0 },
  { code: 'M', name: 'Metre', decimalPlaces: 2 },
  { code: 'CM', name: 'Centimetre', decimalPlaces: 1 },
];

/**
 * Tax reference data. IMPORTANT (spec section 4): these are structural PLACEHOLDERS, not guaranteed
 * current statutory rates. GST rates, slabs and applicability change by notification. Every seeded
 * row is stored with origin REFERENCE_SEED and review_status UNREVIEWED and must be reviewed by an
 * authorized accountant or tax professional before production use. To change a rate, ADD a new
 * effective-dated row; never edit history.
 */
export const TAX_REVIEW_NOTE =
  'Reference placeholder, not a guaranteed current statutory rate. Must be reviewed by an authorized ' +
  'accountant or tax professional before production use; add a new effective-dated row to change it.';

/** Open-ended placeholder start date for seeded rows (start of the GST regime); not a legal assertion. */
export const TAX_PLACEHOLDER_EFFECTIVE_FROM = '2017-07-01';

export interface TaxCategoryDef {
  code: string;
  name: string;
  classification: 'STANDARD' | 'NIL_RATED' | 'EXEMPT' | 'ZERO_RATED' | 'NON_GST';
  /** Exact decimal strings - never JavaScript numbers. */
  ratePercent: string;
  cessPercent: string;
}

export const TAX_CATEGORIES: readonly TaxCategoryDef[] = [
  {
    code: 'GST_0_NIL',
    name: 'Nil rated',
    classification: 'NIL_RATED',
    ratePercent: '0.0000',
    cessPercent: '0.0000',
  },
  {
    code: 'GST_EXEMPT',
    name: 'Exempt',
    classification: 'EXEMPT',
    ratePercent: '0.0000',
    cessPercent: '0.0000',
  },
  {
    code: 'GST_ZERO_RATED',
    name: 'Zero rated',
    classification: 'ZERO_RATED',
    ratePercent: '0.0000',
    cessPercent: '0.0000',
  },
  {
    code: 'NON_GST',
    name: 'Non-GST supply',
    classification: 'NON_GST',
    ratePercent: '0.0000',
    cessPercent: '0.0000',
  },
  {
    code: 'GST_5',
    name: 'GST 5% (placeholder)',
    classification: 'STANDARD',
    ratePercent: '5.0000',
    cessPercent: '0.0000',
  },
  {
    code: 'GST_12',
    name: 'GST 12% (placeholder)',
    classification: 'STANDARD',
    ratePercent: '12.0000',
    cessPercent: '0.0000',
  },
  {
    code: 'GST_18',
    name: 'GST 18% (placeholder)',
    classification: 'STANDARD',
    ratePercent: '18.0000',
    cessPercent: '0.0000',
  },
  {
    code: 'GST_28',
    name: 'GST 28% (placeholder)',
    classification: 'STANDARD',
    ratePercent: '28.0000',
    cessPercent: '0.0000',
  },
];
