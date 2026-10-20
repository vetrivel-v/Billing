/**
 * The jurisdiction ruleset: which GST state/territory codes exist and which intra-state tax pair each one uses.
 *
 * UNREVIEWED REFERENCE DATA (R-040). It was written from general knowledge, not from an official source, and
 * jurisdictions change. It is versioned, included in the tax-configuration fingerprint (so changing it makes the current
 * review stale) and displayed on the tax review screen. No other code in the application decides state/UT behaviour.
 *
 * kinds:
 *  - STATE: intra-state supply = CGST + SGST
 *  - UT_WITH_LEGISLATURE: intra-state supply = CGST + SGST
 *  - UT_WITHOUT_LEGISLATURE: intra-state supply = CGST + UTGST
 *  - OTHER_TERRITORY / CENTRE_JURISDICTION: a supply to such a place of supply is always IGST
 */
export type JurisdictionKind =
  | 'STATE'
  | 'UT_WITH_LEGISLATURE'
  | 'UT_WITHOUT_LEGISLATURE'
  | 'OTHER_TERRITORY'
  | 'CENTRE_JURISDICTION';

export interface Jurisdiction {
  code: string;
  name: string;
  kind: JurisdictionKind;
}

export const JURISDICTION_RULESET_ID = 'FUB-GST-1-JURISDICTIONS';
export const JURISDICTION_RULESET_VERSION = '1';
export const JURISDICTION_REVIEW_STATUS = 'UNREVIEWED' as const;

const S = (code: string, name: string): Jurisdiction => ({ code, name, kind: 'STATE' });
const UTL = (code: string, name: string): Jurisdiction => ({
  code,
  name,
  kind: 'UT_WITH_LEGISLATURE',
});
const UTN = (code: string, name: string): Jurisdiction => ({
  code,
  name,
  kind: 'UT_WITHOUT_LEGISLATURE',
});

export const JURISDICTIONS: readonly Jurisdiction[] = [
  UTL('01', 'Jammu and Kashmir'),
  S('02', 'Himachal Pradesh'),
  S('03', 'Punjab'),
  UTN('04', 'Chandigarh'),
  S('05', 'Uttarakhand'),
  S('06', 'Haryana'),
  UTL('07', 'Delhi'),
  S('08', 'Rajasthan'),
  S('09', 'Uttar Pradesh'),
  S('10', 'Bihar'),
  S('11', 'Sikkim'),
  S('12', 'Arunachal Pradesh'),
  S('13', 'Nagaland'),
  S('14', 'Manipur'),
  S('15', 'Mizoram'),
  S('16', 'Tripura'),
  S('17', 'Meghalaya'),
  S('18', 'Assam'),
  S('19', 'West Bengal'),
  S('20', 'Jharkhand'),
  S('21', 'Odisha'),
  S('22', 'Chhattisgarh'),
  S('23', 'Madhya Pradesh'),
  S('24', 'Gujarat'),
  UTN('25', 'Daman and Diu (legacy code)'),
  UTN('26', 'Dadra and Nagar Haveli and Daman and Diu'),
  S('27', 'Maharashtra'),
  S('28', 'Andhra Pradesh (legacy code)'),
  S('29', 'Karnataka'),
  S('30', 'Goa'),
  UTN('31', 'Lakshadweep'),
  S('32', 'Kerala'),
  S('33', 'Tamil Nadu'),
  UTL('34', 'Puducherry'),
  UTN('35', 'Andaman and Nicobar Islands'),
  S('36', 'Telangana'),
  S('37', 'Andhra Pradesh'),
  UTN('38', 'Ladakh'),
  { code: '97', name: 'Other Territory', kind: 'OTHER_TERRITORY' },
  { code: '99', name: 'Centre Jurisdiction', kind: 'CENTRE_JURISDICTION' },
];

const BY_CODE: ReadonlyMap<string, Jurisdiction> = new Map(JURISDICTIONS.map((j) => [j.code, j]));

export const jurisdictionFor = (code: string): Jurisdiction | undefined => BY_CODE.get(code);

export type TaxComponentKind = 'CGST' | 'SGST' | 'UTGST' | 'IGST';

export interface SupplyClassification {
  supply: 'INTRA' | 'INTER';
  /** The tax components that apply to a taxable line of this supply. */
  components: readonly TaxComponentKind[];
}

/**
 * The ONE place that decides CGST+SGST / CGST+UTGST / IGST.
 * Same state code on both sides = intra-state, unless the place of supply is an "other territory" or centre
 * jurisdiction (always IGST). Returns undefined when either code is unknown.
 */
export function classifySupply(
  supplierStateCode: string,
  placeOfSupplyCode: string,
): SupplyClassification | undefined {
  const supplier = jurisdictionFor(supplierStateCode);
  const pos = jurisdictionFor(placeOfSupplyCode);
  if (!supplier || !pos) return undefined;
  if (pos.kind === 'OTHER_TERRITORY' || pos.kind === 'CENTRE_JURISDICTION')
    return { supply: 'INTER', components: ['IGST'] };
  if (supplier.code !== pos.code) return { supply: 'INTER', components: ['IGST'] };
  return {
    supply: 'INTRA',
    components: pos.kind === 'UT_WITHOUT_LEGISLATURE' ? ['CGST', 'UTGST'] : ['CGST', 'SGST'],
  };
}
