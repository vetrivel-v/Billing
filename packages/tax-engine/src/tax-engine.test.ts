import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  calculate,
  type TaxEngineInput,
  type TaxEngineResult,
  type TaxLineInput,
} from './calculate.js';
import {
  computeConfigurationFingerprint,
  evaluateProductionGate,
  reviewState,
  selectEffectiveRate,
  type CategoryRow,
  type RateRow,
} from './configuration.js';
import { formatPaise, formatPercent, parseScaled, roundDiv } from './decimal.js';
import { canonicalJson } from './hash.js';
import { JURISDICTIONS, classifySupply } from './jurisdictions.js';
import { ENGINE_VERSION, ROUNDING_POLICY_ID, RULESET_VERSION } from './version.js';

// All rates and amounts below are HYPOTHETICAL examples for testing arithmetic, not statutory advice.
const GSTIN = '27ABCDE1234F1Z5';

const cat = (classification = 'STANDARD', over: Record<string, unknown> = {}) => ({
  id: `cat-${classification}`,
  code: classification === 'STANDARD' ? 'GST_X' : classification,
  classification,
  isActive: true,
  effectiveFrom: null,
  effectiveTo: null,
  ...over,
});

function line(
  over: Omit<Partial<TaxLineInput>, 'rate'> & { rate?: string; classification?: string } = {},
): TaxLineInput {
  const { rate = '18', classification = 'STANDARD', ...rest } = over;
  const category = cat(classification);
  return {
    lineRef: 'L1',
    productRef: 'P1',
    itemKind: 'GOODS',
    hsnSac: { code: '8517', kind: 'HSN' },
    taxCategory: category,
    rate: {
      id: 'rate-1',
      categoryId: category.id,
      ratePercent: classification === 'STANDARD' ? rate : '0',
      cessPercent: '0',
      effectiveFrom: '2017-07-01',
      effectiveTo: null,
    },
    quantity: '1',
    unitPrice: '100.00',
    discount: { type: 'NONE' },
    ...rest,
  } as TaxLineInput;
}

function input(over: Partial<TaxEngineInput> = {}): TaxEngineInput {
  return {
    engineVersion: ENGINE_VERSION,
    rulesetVersion: RULESET_VERSION,
    documentType: 'TAX_INVOICE',
    taxPointDate: '2026-10-20',
    supplyKind: 'DOMESTIC',
    reverseCharge: false,
    supplier: { gstStatus: 'REGISTERED', gstin: GSTIN, stateCode: '27' },
    recipient: {
      gstStatus: 'UNREGISTERED',
      gstin: null,
      billingStateCode: '27',
      shippingStateCode: null,
    },
    placeOfSupply: { stateCode: '27', source: 'USER_CONFIRMED' },
    priceBasis: 'EXCLUSIVE',
    lines: [line()],
    rounding: { invoiceRoundOff: 'NONE' },
    requirements: { hsnSacRequired: true },
    ...over,
  };
}

const ok = (r: TaxEngineResult) => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.errors)}`);
  return r;
};
const codes = (r: TaxEngineResult) => (r.ok ? [] : r.errors.map((e) => e.code));
const inter = { placeOfSupply: { stateCode: '29', source: 'USER_CONFIRMED' as const } };

describe('worked examples (hypothetical rates)', () => {
  it('1. exclusive, intra-state: 3 x 1,000.00 at 18%', () => {
    const r = ok(calculate(input({ lines: [line({ quantity: '3', unitPrice: '1000.00' })] })));
    const l = r.lines[0]!;
    expect(r.supply).toBe('INTRA');
    expect([l.grossAmount, l.taxableValue, l.lineTotal]).toEqual(['3000.00', '3000.00', '3540.00']);
    expect(l.components).toEqual([
      { kind: 'CGST', ratePercent: '9.00', amount: '270.00' },
      { kind: 'SGST', ratePercent: '9.00', amount: '270.00' },
    ]);
    expect(r.totals.grandTotal).toBe('3540.00');
    expect(r.totals.componentTotals).toEqual({
      CGST: '270.00',
      SGST: '270.00',
      UTGST: '0.00',
      IGST: '0.00',
    });
  });

  it('2. exclusive, inter-state: the same line gives IGST 540.00', () => {
    const r = ok(
      calculate(input({ ...inter, lines: [line({ quantity: '3', unitPrice: '1000.00' })] })),
    );
    expect(r.supply).toBe('INTER');
    expect(r.lines[0]!.components).toEqual([
      { kind: 'IGST', ratePercent: '18.00', amount: '540.00' },
    ]);
    expect(r.totals.grandTotal).toBe('3540.00');
  });

  it('3. inclusive, intra-state: 1,180.00 at 18% -> 1,000.00 + 90.00 + 90.00', () => {
    const r = ok(
      calculate(input({ priceBasis: 'INCLUSIVE', lines: [line({ unitPrice: '1180.00' })] })),
    );
    const l = r.lines[0]!;
    expect([l.taxableValue, l.roundingAdjustment, l.lineTotal]).toEqual([
      '1000.00',
      '0.00',
      '1180.00',
    ]);
    expect(l.components.map((c) => c.amount)).toEqual(['90.00', '90.00']);
  });

  it('3b. inclusive, inter-state: 1,180.00 at 18% -> 1,000.00 + IGST 180.00', () => {
    const r = ok(
      calculate(
        input({ ...inter, priceBasis: 'INCLUSIVE', lines: [line({ unitPrice: '1180.00' })] }),
      ),
    );
    expect(r.lines[0]!.taxableValue).toBe('1000.00');
    expect(r.lines[0]!.components).toEqual([
      { kind: 'IGST', ratePercent: '18.00', amount: '180.00' },
    ]);
  });

  it('4. fractional quantity: 0.333 x 99.99 = 33.29667 -> gross 33.30; 18% intra gives 3.00 + 3.00', () => {
    const r = ok(calculate(input({ lines: [line({ quantity: '0.333', unitPrice: '99.99' })] })));
    const l = r.lines[0]!;
    expect([l.grossAmount, l.taxableValue, l.lineTotal]).toEqual(['33.30', '33.30', '39.30']);
    expect(l.components.map((c) => c.amount)).toEqual(['3.00', '3.00']);
    expect(l.quantity).toBe('0.333');
  });

  it('5. inclusive with a rounding residual: 10.00 at 18% keeps the price and shows +0.01', () => {
    const r = ok(
      calculate(input({ priceBasis: 'INCLUSIVE', lines: [line({ unitPrice: '10.00' })] })),
    );
    const l = r.lines[0]!;
    expect(l.taxableValue).toBe('8.47');
    expect(l.components.map((c) => c.amount)).toEqual(['0.76', '0.76']);
    expect(l.roundingAdjustment).toBe('0.01');
    expect(l.lineTotal).toBe('10.00');
    expect(r.totals.roundingAdjustmentTotal).toBe('0.01');
    expect(r.totals.grandTotal).toBe('10.00');
    expect(l.explanation.map((s) => s.step)).toContain('ROUNDING_ADJUSTMENT');
  });

  it('6. component rounding edge: 5% on 0.50 gives 0.01 + 0.01 (not 0.03), and says so', () => {
    const r = ok(calculate(input({ lines: [line({ rate: '5', unitPrice: '0.50' })] })));
    expect(r.lines[0]!.components.map((c) => c.amount)).toEqual(['0.01', '0.01']);
    expect(r.lines[0]!.lineTotal).toBe('0.52');
    expect(r.warnings).toContainEqual({
      code: 'COMPONENT_ROUNDING_DIFFERS_FROM_TOTAL_RATE',
      lineRef: 'L1',
    });
    const tiny = ok(calculate(input({ lines: [line({ rate: '5', unitPrice: '0.10' })] })));
    expect(tiny.lines[0]!.components.map((c) => c.amount)).toEqual(['0.00', '0.00']); // 0.0025 each
  });

  it('7. percentage line discount: 2 x 500.00 less 10% at 18% intra', () => {
    const r = ok(
      calculate(
        input({
          lines: [
            line({
              quantity: '2',
              unitPrice: '500.00',
              discount: { type: 'PERCENT', percent: '10' },
            }),
          ],
        }),
      ),
    );
    const l = r.lines[0]!;
    expect([l.grossAmount, l.discountAmount, l.taxableValue, l.lineTotal]).toEqual([
      '1000.00',
      '100.00',
      '900.00',
      '1062.00',
    ]);
    expect(l.components.map((c) => c.amount)).toEqual(['81.00', '81.00']);
  });

  it('7a. a percentage discount that needs rounding rounds half-up to the paisa', () => {
    // 99.99 x 33.33 / 100 = 33.326667 -> 33.33 (a truncated discount would be 33.32)
    const r = ok(
      calculate(
        input({
          lines: [line({ unitPrice: '99.99', discount: { type: 'PERCENT', percent: '33.33' } })],
        }),
      ),
    );
    const l = r.lines[0]!;
    expect([l.discountAmount, l.taxableValue]).toEqual(['33.33', '66.66']);
    expect(l.components.map((c) => c.amount)).toEqual(['6.00', '6.00']); // 66.66 x 9% = 5.9994
    expect(l.lineTotal).toBe('78.66');
  });

  it('7b. fixed line discount: 500.00 less 50.00 at 5% intra', () => {
    const r = ok(
      calculate(
        input({
          lines: [
            line({ rate: '5', unitPrice: '500.00', discount: { type: 'AMOUNT', amount: '50' } }),
          ],
        }),
      ),
    );
    expect(r.lines[0]!.taxableValue).toBe('450.00');
    expect(r.lines[0]!.components.map((c) => c.amount)).toEqual(['11.25', '11.25']);
    expect(r.lines[0]!.lineTotal).toBe('472.50');
  });

  it('7c. discount on an inclusive price reduces the inclusive amount first', () => {
    const r = ok(
      calculate(
        input({
          priceBasis: 'INCLUSIVE',
          lines: [line({ unitPrice: '1180.00', discount: { type: 'PERCENT', percent: '50' } })],
        }),
      ),
    );
    expect(r.lines[0]!.lineTotal).toBe('590.00');
    expect(r.lines[0]!.taxableValue).toBe('500.00');
  });

  it('8. multiple tax rates on one invoice are summed per component', () => {
    const r = ok(
      calculate(
        input({
          lines: [
            line({ lineRef: 'A', unitPrice: '1000.00' }),
            line({ lineRef: 'B', rate: '5', unitPrice: '200.00' }),
          ],
        }),
      ),
    );
    expect(r.totals.componentTotals.CGST).toBe('95.00');
    expect(r.totals.componentTotals.SGST).toBe('95.00');
    expect(r.totals.taxableSubtotal).toBe('1200.00');
    expect(r.totals.grandTotal).toBe('1390.00');
  });

  it('9. zero taxable value is allowed with a warning; a discount above gross is refused', () => {
    const r = ok(
      calculate(input({ lines: [line({ discount: { type: 'AMOUNT', amount: '100.00' } })] })),
    );
    expect(r.lines[0]!.taxableValue).toBe('0.00');
    expect(r.lines[0]!.lineTotal).toBe('0.00');
    expect(r.warnings).toContainEqual({ code: 'ZERO_TAXABLE_VALUE', lineRef: 'L1' });
    expect(
      codes(
        calculate(input({ lines: [line({ discount: { type: 'AMOUNT', amount: '100.01' } })] })),
      ),
    ).toEqual(['DISCOUNT_EXCEEDS_GROSS']);
  });

  it('10. optional whole-rupee round-off is its own line and is NONE by default', () => {
    const lines = [line({ unitPrice: '100.10' })];
    const none = ok(calculate(input({ lines })));
    expect([none.totals.roundOff, none.totals.grandTotal]).toEqual(['0.00', '118.12']);
    const rounded = ok(calculate(input({ lines, rounding: { invoiceRoundOff: 'NEAREST_RUPEE' } })));
    expect([rounded.totals.roundOff, rounded.totals.grandTotal]).toEqual(['-0.12', '118.00']);
    const down = ok(
      calculate(
        input({
          lines: [line({ unitPrice: '100.40' })],
          rounding: { invoiceRoundOff: 'NEAREST_RUPEE' },
        }),
      ),
    );
    expect([down.totals.roundOff, down.totals.grandTotal]).toEqual(['-0.48', '118.00']); // 100.40 + 9.04 + 9.04 = 118.48
    const up = ok(
      calculate(
        input({
          lines: [line({ unitPrice: '100.60' })],
          rounding: { invoiceRoundOff: 'NEAREST_RUPEE' },
        }),
      ),
    );
    expect([up.totals.roundOff, up.totals.grandTotal]).toEqual(['0.30', '119.00']); // 100.60 + 9.05 + 9.05 = 118.70
  });
});

describe('classifications are distinct (not "rate 0")', () => {
  it('nil-rated, exempt and non-GST charge no tax, keep their own classification, and never get components', () => {
    for (const classification of ['NIL_RATED', 'EXEMPT', 'NON_GST']) {
      const r = ok(
        calculate(input({ lines: [line({ classification, unitPrice: '50.00', quantity: '2' })] })),
      );
      const l = r.lines[0]!;
      expect(l.classification).toBe(classification);
      expect([l.taxableValue, l.lineTotal, l.components]).toEqual(['100.00', '100.00', []]);
      expect(r.warnings).toContainEqual({ code: 'NO_TAX_ON_ANY_LINE' });
    }
  });

  it('a no-tax line mixed with a taxable line keeps both classifications', () => {
    const r = ok(
      calculate(
        input({
          lines: [line({ lineRef: 'A' }), line({ lineRef: 'B', classification: 'EXEMPT' })],
        }),
      ),
    );
    expect(r.lines.map((l) => l.classification)).toEqual(['STANDARD', 'EXEMPT']);
    expect(r.warnings.map((w) => w.code)).not.toContain('NO_TAX_ON_ANY_LINE');
  });

  it('refuses a non-zero rate on a no-tax classification, a zero rate on a standard one, and zero-rated', () => {
    const nilWithRate = line({ classification: 'NIL_RATED' });
    nilWithRate.rate!.ratePercent = '5';
    expect(codes(calculate(input({ lines: [nilWithRate] })))).toEqual([
      'CLASSIFICATION_RATE_MISMATCH',
    ]);
    expect(codes(calculate(input({ lines: [line({ rate: '0' })] })))).toEqual([
      'CLASSIFICATION_RATE_MISMATCH',
    ]);
    expect(codes(calculate(input({ lines: [line({ classification: 'ZERO_RATED' })] })))).toEqual([
      'CLASSIFICATION_UNSUPPORTED',
    ]);
    const odd = line();
    odd.taxCategory.classification = 'MYSTERY';
    expect(codes(calculate(input({ lines: [odd] })))).toEqual(['CLASSIFICATION_UNKNOWN']);
  });
});

describe('supply classification and jurisdictions', () => {
  it('uses CGST+SGST in a state, CGST+UTGST in a UT without legislature, IGST between places', () => {
    expect(classifySupply('27', '27')).toEqual({ supply: 'INTRA', components: ['CGST', 'SGST'] });
    expect(classifySupply('07', '07')).toEqual({ supply: 'INTRA', components: ['CGST', 'SGST'] }); // UT with legislature
    expect(classifySupply('04', '04')).toEqual({ supply: 'INTRA', components: ['CGST', 'UTGST'] });
    expect(classifySupply('35', '35')?.components).toEqual(['CGST', 'UTGST']);
    expect(classifySupply('27', '29')).toEqual({ supply: 'INTER', components: ['IGST'] });
    expect(classifySupply('04', '27')?.components).toEqual(['IGST']);
    expect(classifySupply('97', '97')?.components).toEqual(['IGST']);
    expect(classifySupply('27', '99')?.components).toEqual(['IGST']);
    expect(classifySupply('27', '00')).toBeUndefined();
    expect(JURISDICTIONS.length).toBeGreaterThan(38);
  });

  it('a UTGST invoice carries CGST + UTGST components in the result', () => {
    const r = ok(
      calculate(
        input({
          supplier: { gstStatus: 'REGISTERED', gstin: '04ABCDE1234F1Z5', stateCode: '04' },
          recipient: {
            gstStatus: 'UNREGISTERED',
            gstin: null,
            billingStateCode: '04',
            shippingStateCode: null,
          },
          placeOfSupply: { stateCode: '04', source: 'USER_CONFIRMED' },
        }),
      ),
    );
    expect(r.lines[0]!.components.map((c) => c.kind)).toEqual(['CGST', 'UTGST']);
    expect(r.totals.componentTotals.UTGST).toBe('9.00');
  });
});

describe('effective-dated rate selection', () => {
  const category: CategoryRow = {
    id: 'c1',
    code: 'C',
    name: 'Hypothetical',
    classification: 'STANDARD',
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
  };
  const rates: RateRow[] = [
    {
      id: 'old',
      categoryId: 'c1',
      ratePercent: '5',
      cessPercent: '0',
      effectiveFrom: '2017-07-01',
      effectiveTo: '2026-09-30',
    },
    {
      id: 'new',
      categoryId: 'c1',
      ratePercent: '12',
      cessPercent: '0',
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
    },
  ];

  it('picks the rate in force on the date, including both boundary days', () => {
    const pick = (d: string) => {
      const r = selectEffectiveRate(category, rates, d);
      return r.ok ? r.rate.id : r.code;
    };
    expect(pick('2026-09-30')).toBe('old');
    expect(pick('2026-10-01')).toBe('new');
    expect(pick('2017-07-01')).toBe('old');
    expect(pick('2017-06-30')).toBe('NO_EFFECTIVE_RATE');
    expect(pick('2030-01-01')).toBe('new');
  });

  it('fails (never guesses) when ranges overlap or the category cannot be used', () => {
    const overlapping = [...rates, { ...rates[1]!, id: 'dup', effectiveFrom: '2026-09-15' }];
    expect(selectEffectiveRate(category, overlapping, '2026-09-20')).toEqual({
      ok: false,
      code: 'AMBIGUOUS_EFFECTIVE_RATE',
    });
    expect(selectEffectiveRate({ ...category, isActive: false }, rates, '2026-10-01')).toEqual({
      ok: false,
      code: 'TAX_CATEGORY_INACTIVE',
    });
    expect(
      selectEffectiveRate({ ...category, effectiveFrom: '2027-01-01' }, rates, '2026-10-01'),
    ).toEqual({ ok: false, code: 'TAX_CATEGORY_NOT_EFFECTIVE' });
    expect(selectEffectiveRate(category, [], '2026-10-01')).toEqual({
      ok: false,
      code: 'NO_EFFECTIVE_RATE',
    });
  });

  it('a calculation keeps the rate it was given: a later rate row changes nothing already calculated', () => {
    const oldLine = line({ rate: '5' });
    oldLine.rate!.id = 'old';
    const before = ok(calculate(input({ taxPointDate: '2026-09-30', lines: [oldLine] })));
    // the "new" row now exists, but the snapshot of the earlier calculation names the old one
    expect(before.lines[0]!.rate).toEqual({
      id: 'old',
      ratePercent: '5.00',
      effectiveFrom: '2017-07-01',
      effectiveTo: null,
    });
    const again = ok(calculate(input({ taxPointDate: '2026-09-30', lines: [oldLine] })));
    expect(again).toEqual(before);
  });

  it('the engine itself refuses a rate whose window does not contain the date, a missing rate and a wrong category', () => {
    const stale = line({ rate: '5' });
    stale.rate!.effectiveTo = '2026-09-30';
    expect(codes(calculate(input({ taxPointDate: '2026-10-01', lines: [stale] })))).toEqual([
      'RATE_OUTSIDE_EFFECTIVE_WINDOW',
    ]);
    expect(codes(calculate(input({ lines: [{ ...line(), rate: null }] })))).toContain(
      'NO_EFFECTIVE_RATE',
    );
    const wrong = line();
    wrong.rate!.categoryId = 'another';
    expect(codes(calculate(input({ lines: [wrong] })))).toEqual(['RATE_CATEGORY_MISMATCH']);
    const inactive = line();
    inactive.taxCategory.isActive = false;
    expect(codes(calculate(input({ lines: [inactive] })))).toEqual(['TAX_CATEGORY_INACTIVE']);
  });
});

describe('unsupported and invalid input is rejected, never ignored', () => {
  const rejects = (
    over: Partial<TaxEngineInput> | Record<string, unknown>,
    ...expected: string[]
  ) => expect(codes(calculate(input(over as Partial<TaxEngineInput>)))).toEqual(expected);

  it('scope that is deferred', () => {
    rejects({ invoiceDiscount: { amount: '10.00' } }, 'INVOICE_DISCOUNT_UNSUPPORTED');
    rejects({ charges: [{ type: 'SHIPPING', amount: '50.00' }] }, 'CHARGES_UNSUPPORTED');
    expect(calculate(input({ charges: [] })).ok).toBe(true); // an empty list carries nothing
    rejects({ advances: [] }, 'ADVANCES_UNSUPPORTED');
    rejects({ tcs: { rate: '1' } }, 'TCS_TDS_UNSUPPORTED');
    rejects({ tds: {} }, 'TCS_TDS_UNSUPPORTED');
    rejects({ reverseCharge: true }, 'REVERSE_CHARGE_UNSUPPORTED');
    rejects({ supplyKind: 'EXPORT' } as never, 'EXPORT_UNSUPPORTED');
    rejects({ supplyKind: 'SEZ' } as never, 'EXPORT_UNSUPPORTED');
    rejects({ documentType: 'BILL_OF_SUPPLY' } as never, 'DOCUMENT_TYPE_UNSUPPORTED');
    rejects({ rulesetVersion: 'FUB-GST-2' }, 'RULESET_UNSUPPORTED');
    rejects({ mystery: 1 }, 'UNKNOWN_INPUT_FIELD');
  });

  it('services, cess, composition and unregistered sellers', () => {
    rejects(
      { lines: [line({ itemKind: 'SERVICE', hsnSac: { code: '998314', kind: 'SAC' } })] },
      'ITEM_KIND_UNSUPPORTED',
    );
    const cess = line();
    cess.rate!.cessPercent = '12';
    rejects({ lines: [cess] }, 'CESS_UNSUPPORTED');
    rejects(
      { supplier: { gstStatus: 'COMPOSITION', gstin: GSTIN, stateCode: '27' } },
      'SELLER_NOT_SUPPORTED',
    );
    rejects(
      { supplier: { gstStatus: 'UNREGISTERED', gstin: null, stateCode: '27' } },
      'SELLER_NOT_SUPPORTED',
      'SELLER_GSTIN_MISSING',
    );
    rejects(
      { supplier: { gstStatus: 'REGISTERED', gstin: null, stateCode: '27' } },
      'SELLER_GSTIN_MISSING',
    );
    rejects(
      { supplier: { gstStatus: 'REGISTERED', gstin: '29ABCDE1234F1Z5', stateCode: '27' } },
      'SELLER_GSTIN_STATE_MISMATCH',
    );
  });

  it('place of supply', () => {
    rejects(
      { placeOfSupply: { stateCode: '', source: 'USER_CONFIRMED' } },
      'PLACE_OF_SUPPLY_MISSING',
    );
    rejects({ placeOfSupply: undefined } as never, 'PLACE_OF_SUPPLY_MISSING');
    rejects(
      { placeOfSupply: { stateCode: '55', source: 'USER_CONFIRMED' } },
      'PLACE_OF_SUPPLY_INVALID',
    );
    // billing and delivery states differ: only an explicit choice will do
    const split = {
      recipient: {
        gstStatus: 'UNREGISTERED',
        gstin: null,
        billingStateCode: '27',
        shippingStateCode: '29',
      },
    };
    rejects(
      { ...split, placeOfSupply: { stateCode: '29', source: 'USER_CONFIRMED' } },
      'PLACE_OF_SUPPLY_SELECTION_REQUIRED',
    );
    rejects(
      { ...split, placeOfSupply: { stateCode: '29', source: 'SUGGESTED' } },
      'PLACE_OF_SUPPLY_SELECTION_REQUIRED',
    );
    const chosen = ok(
      calculate(input({ ...split, placeOfSupply: { stateCode: '29', source: 'USER_OVERRIDE' } })),
    );
    expect(chosen.supply).toBe('INTER');
    expect(chosen.warnings).toContainEqual({ code: 'PLACE_OF_SUPPLY_OVERRIDDEN' });
  });

  it('a merely SUGGESTED place of supply calculates but is not postable', () => {
    const r = ok(calculate(input({ placeOfSupply: { stateCode: '27', source: 'SUGGESTED' } })));
    expect(r.postable).toBe(false);
    expect(r.placeOfSupply.confirmed).toBe(false);
    expect(r.warnings).toContainEqual({ code: 'PLACE_OF_SUPPLY_NOT_CONFIRMED' });
    const confirmed = ok(calculate(input()));
    expect(confirmed.postable).toBe(true);
    expect(confirmed.placeOfSupply).toEqual({
      stateCode: '27',
      source: 'USER_CONFIRMED',
      confirmed: true,
    });
  });

  it('recipient GST facts: B2B is derived per invoice from a supplied GSTIN', () => {
    const b2b = ok(
      calculate(
        input({
          recipient: {
            gstStatus: 'REGISTERED',
            gstin: '27AAAAA0000A1Z5',
            billingStateCode: '27',
            shippingStateCode: null,
          },
        }),
      ),
    );
    expect(b2b.recipientClassification).toBe('B2B');
    expect(ok(calculate(input())).recipientClassification).toBe('B2C');
    rejects(
      {
        recipient: {
          gstStatus: 'REGISTERED',
          gstin: null,
          billingStateCode: '27',
          shippingStateCode: null,
        },
      },
      'RECIPIENT_GSTIN_REQUIRED',
    );
    rejects(
      {
        recipient: {
          gstStatus: 'COMPOSITION',
          gstin: null,
          billingStateCode: '27',
          shippingStateCode: null,
        },
      },
      'RECIPIENT_GSTIN_REQUIRED',
    );
    rejects(
      {
        recipient: {
          gstStatus: 'UNREGISTERED',
          gstin: '27AAAAA0000A1Z5',
          billingStateCode: '27',
          shippingStateCode: null,
        },
      },
      'RECIPIENT_GSTIN_NOT_ALLOWED',
    );
    rejects(
      {
        recipient: {
          gstStatus: 'UNREGISTERED',
          gstin: null,
          billingStateCode: '77',
          shippingStateCode: null,
        },
      },
      'RECIPIENT_STATE_INVALID',
    );
  });

  it('HSN/SAC: required blocks, optional warns, a SAC code on goods is a mismatch', () => {
    rejects({ lines: [line({ hsnSac: null })] }, 'HSN_SAC_REQUIRED');
    const optional = ok(
      calculate(
        input({ requirements: { hsnSacRequired: false }, lines: [line({ hsnSac: null })] }),
      ),
    );
    expect(optional.warnings).toContainEqual({ code: 'HSN_SAC_MISSING', lineRef: 'L1' });
    rejects(
      { lines: [line({ hsnSac: { code: '998314', kind: 'SAC' } })] },
      'HSN_SAC_KIND_MISMATCH',
    );
  });

  it('decimals and discounts', () => {
    for (const bad of ['1e3', '-1', '1,5', '.5', '5.', 'abc', '', '1.23456', '99999999999999999']) {
      expect(codes(calculate(input({ lines: [line({ quantity: bad })] })))).toContain(
        'INVALID_DECIMAL',
      );
    }
    rejects({ lines: [line({ quantity: '0' })] }, 'INVALID_DECIMAL');
    rejects({ lines: [line({ unitPrice: '10.001' })] }, 'INVALID_DECIMAL');
    rejects({ lines: [line({ unitPrice: 10 as never })] }, 'INVALID_DECIMAL');
    rejects(
      { lines: [line({ discount: { type: 'PERCENT', percent: '100.0001' } })] },
      'DISCOUNT_RANGE_INVALID',
    );
    rejects(
      { lines: [line({ discount: { type: 'PERCENT', percent: '-5' } })] },
      'DISCOUNT_RANGE_INVALID',
    );
    rejects(
      { lines: [line({ discount: { type: 'AMOUNT', amount: '1.005' } })] },
      'DISCOUNT_RANGE_INVALID',
    );
    rejects(
      { lines: [line({ discount: { type: 'COUPON' } as never })] },
      'DISCOUNT_TYPE_UNSUPPORTED',
    );
    expect(
      ok(calculate(input({ lines: [line({ discount: { type: 'PERCENT', percent: '100' } })] })))
        .lines[0]!.taxableValue,
    ).toBe('0.00');
  });

  it('structure: no lines, duplicate line refs, bad dates and options', () => {
    rejects({ lines: [] }, 'INVALID_INPUT');
    rejects({ lines: [line(), line()] }, 'DUPLICATE_LINE_REF');
    rejects({ taxPointDate: '2026-02-30' }, 'INVALID_DATE');
    rejects({ priceBasis: 'MIXED' } as never, 'INVALID_INPUT');
    rejects({ rounding: { invoiceRoundOff: 'BANKERS' } } as never, 'ROUNDING_OPTION_INVALID');
    expect(calculate(null as never).ok).toBe(false);
  });

  it('a failed calculation returns no totals, so a half-calculated invoice cannot be posted', () => {
    const r = calculate(input({ lines: [line(), line({ lineRef: 'B', quantity: '0' })] }));
    expect(r.ok).toBe(false);
    expect('totals' in r).toBe(false);
    expect('lines' in r).toBe(false);
    expect(r.engineVersion).toBe(ENGINE_VERSION);
  });
});

describe('determinism and provenance', () => {
  it('returns the same bytes for the same input, with a stable input hash and the rule set identity', () => {
    const a = calculate(input());
    const b = calculate(JSON.parse(JSON.stringify(input())) as TaxEngineInput);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.inputHash).toBe(b.inputHash);
    expect([a.engineVersion, a.rulesetVersion, a.roundingPolicyId]).toEqual([
      ENGINE_VERSION,
      'FUB-GST-1',
      ROUNDING_POLICY_ID,
    ]);
    // key order does not matter, content does
    const reordered = {
      ...input(),
      lines: input().lines.map((l) => Object.fromEntries(Object.entries(l).reverse())),
    } as TaxEngineInput;
    expect(calculate(reordered).inputHash).toBe(a.inputHash);
    const changed = calculate(input({ lines: [line({ quantity: '2' })] }));
    expect(changed.inputHash).not.toBe(a.inputHash);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it('does not change its input', () => {
    const i = input();
    const copy = JSON.stringify(i);
    calculate(i);
    expect(JSON.stringify(i)).toBe(copy);
  });

  it('explains every step of a line so the result can be reproduced', () => {
    const l = ok(calculate(input({ lines: [line({ quantity: '3', unitPrice: '1000.00' })] })))
      .lines[0]!;
    expect(l.explanation.map((s) => s.step)).toEqual([
      'GROSS',
      'TAXABLE',
      'COMPONENT_CGST',
      'COMPONENT_SGST',
      'LINE_TOTAL',
    ]);
    expect(l.explanation[2]).toEqual({
      step: 'COMPONENT_CGST',
      formula: 'round2(taxable x ratePercent / 200)',
      inputs: { taxable: '3000.00', ratePercent: '18.00' },
      result: '270.00',
    });
  });
});

describe('exact decimal helpers', () => {
  it('parses plain decimals only and keeps every digit', () => {
    expect(parseScaled('12.5', 4)).toEqual({ units: 125000n, scale: 4 });
    expect(parseScaled('007', 2)).toEqual({ units: 700n, scale: 2 });
    expect(parseScaled('1.50', 1)).toEqual({ units: 15n, scale: 1 }); // a trailing zero is not a place
    expect(parseScaled('1.55', 1)).toBeNull();
    expect(parseScaled('123456789012345.67', 2, 16)?.units).toBe(12345678901234567n);
    expect(parseScaled('9007199254740993.01', 2)?.units).toBe(900719925474099301n); // beyond 2^53
    for (const bad of [5, null, '1e3', '+1', ' 1', '1 ']) expect(parseScaled(bad, 2)).toBeNull();
  });

  it('rounds half up at the named points only', () => {
    expect(roundDiv(5n, 10n)).toBe(1n);
    expect(roundDiv(4n, 10n)).toBe(0n);
    expect(roundDiv(15n, 10n)).toBe(2n);
    expect(roundDiv(25n, 10n)).toBe(3n); // half-up, not banker's
    expect(() => roundDiv(1n, 0n)).toThrow();
    expect(() => roundDiv(-1n, 2n)).toThrow();
  });

  it('formats paise and percentages exactly', () => {
    expect(formatPaise(5n)).toBe('0.05');
    expect(formatPaise(123456789n)).toBe('1234567.89');
    expect(formatPaise(-12n)).toBe('-0.12');
    expect(formatPercent(180000n, 4)).toBe('18.00');
    expect(formatPercent(1250n, 4)).toBe('0.125');
  });
});

describe('configuration fingerprint, review state and production gate', () => {
  const categories: CategoryRow[] = [
    {
      id: 'a',
      code: 'GST_5',
      name: 'GST 5%',
      classification: 'STANDARD',
      isActive: true,
      effectiveFrom: null,
      effectiveTo: null,
    },
    {
      id: 'b',
      code: 'EXEMPT',
      name: 'Exempt',
      classification: 'EXEMPT',
      isActive: true,
      effectiveFrom: null,
      effectiveTo: null,
    },
  ];
  const rates: RateRow[] = [
    {
      id: 'r1',
      categoryId: 'a',
      ratePercent: '5.0000',
      cessPercent: '0.0000',
      effectiveFrom: '2017-07-01',
      effectiveTo: null,
    },
    {
      id: 'r2',
      categoryId: 'b',
      ratePercent: '0.0000',
      cessPercent: '0.0000',
      effectiveFrom: '2017-07-01',
      effectiveTo: null,
    },
  ];
  const fp = (c = categories, r = rates) => computeConfigurationFingerprint(c, r);

  it('is stable, order-independent and independent of row ids and number formatting', () => {
    expect(fp()).toMatch(/^[0-9a-f]{64}$/);
    expect(fp([...categories].reverse(), [...rates].reverse())).toBe(fp());
    expect(
      fp(
        categories,
        rates.map((r) => ({
          ...r,
          id: `x-${r.id}`,
          ratePercent: r.ratePercent.replace('.0000', ''),
        })),
      ),
    ).toBe(fp());
  });

  it('changes when anything that decides a tax result changes', () => {
    const base = fp();
    const changed = [
      fp(categories, [
        ...rates,
        {
          id: 'r3',
          categoryId: 'a',
          ratePercent: '12',
          cessPercent: '0',
          effectiveFrom: '2026-10-01',
          effectiveTo: null,
        },
      ]),
      fp(categories, [{ ...rates[0]!, ratePercent: '5.0001' }, rates[1]!]),
      fp(categories, [{ ...rates[0]!, effectiveTo: '2026-09-30' }, rates[1]!]),
      fp(categories, [{ ...rates[0]!, cessPercent: '1' }, rates[1]!]),
      fp([{ ...categories[0]!, isActive: false }, categories[1]!]),
      fp([{ ...categories[0]!, name: 'GST five' }, categories[1]!]),
      fp([{ ...categories[0]!, classification: 'NIL_RATED' }, categories[1]!]),
      fp([categories[0]!], rates.slice(0, 1)),
    ];
    for (const c of changed) expect(c).not.toBe(base);
    expect(new Set(changed).size).toBe(changed.length);
  });

  it('a review is current only for exactly the fingerprint it was made for', () => {
    const now = fp();
    expect(reviewState(null, now)).toBe('NONE');
    expect(reviewState(now, now)).toBe('CURRENT');
    expect(reviewState(now, fp([{ ...categories[0]!, isActive: false }, categories[1]!]))).toBe(
      'STALE',
    );
  });

  it('production needs a current review, a valid seller, an HSN/SAC policy AND a verified backup (never true yet)', () => {
    const facts = {
      review: 'CURRENT' as const,
      sellerProblems: [] as string[],
      hsnSacPolicyInForce: true,
      backupRestoreVerified: true,
    };
    expect(evaluateProductionGate(facts).eligible).toBe(true);
    for (const worse of [
      { review: 'STALE' as const },
      { review: 'NONE' as const },
      { sellerProblems: ['SELLER_NOT_SUPPORTED'] },
      { hsnSacPolicyInForce: false },
      { backupRestoreVerified: false },
    ]) {
      const g = evaluateProductionGate({ ...facts, ...worse });
      expect(g.eligible).toBe(false);
      expect(g.requirements.filter((r) => !r.met)).toHaveLength(1);
    }
  });
});

describe('property tests (seeded, deterministic)', () => {
  // A small linear congruential generator keeps these reproducible without a dependency.
  let seed = 20261020;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const RATES = ['0.25', '1', '1.5', '3', '5', '12', '18', '28'];
  const randomInput = (): TaxEngineInput => {
    const n = 1 + rnd(5);
    const lines: TaxLineInput[] = [];
    for (let i = 0; i < n; i++) {
      const gross = rnd(1_000_000);
      const kind = rnd(4);
      lines.push(
        line({
          lineRef: `L${i}`,
          rate: RATES[rnd(RATES.length)]!,
          quantity: `${1 + rnd(50)}.${String(rnd(10000)).padStart(4, '0')}`,
          unitPrice: `${rnd(5000)}.${String(rnd(100)).padStart(2, '0')}`,
          discount:
            kind === 0
              ? {
                  type: 'PERCENT',
                  percent: `${rnd(101)}.${String(rnd(100)).padStart(2, '0')}`.replace(
                    /^100\..*/,
                    '100',
                  ),
                }
              : kind === 1
                ? { type: 'AMOUNT', amount: `0.${String(gross % 100).padStart(2, '0')}` }
                : { type: 'NONE' },
        }),
      );
    }
    return input({
      lines,
      priceBasis: rnd(2) === 0 ? 'EXCLUSIVE' : 'INCLUSIVE',
      ...(rnd(2) === 0 ? inter : {}),
    });
  };
  const paise = (s: string) => BigInt(s.replace('.', ''));

  it('keeps every invariant over 3000 random invoices', () => {
    let calculated = 0;
    for (let i = 0; i < 3000; i++) {
      const inp = randomInput();
      const res = calculate(inp);
      if (!res.ok) {
        // the only way a random invoice may fail here is a fixed discount above a tiny gross
        expect(res.errors.every((e) => e.code === 'DISCOUNT_EXCEEDS_GROSS')).toBe(true);
        continue;
      }
      calculated++;
      let sumTotal = 0n;
      let sumTaxable = 0n;
      let sumResidual = 0n;
      const comps = { CGST: 0n, SGST: 0n, UTGST: 0n, IGST: 0n };
      for (const l of res.lines) {
        const tax = l.components.reduce((a, c) => a + paise(c.amount), 0n);
        const net = paise(l.grossAmount) - paise(l.discountAmount);
        expect(paise(l.discountAmount) <= paise(l.grossAmount)).toBe(true);
        if (inp.priceBasis === 'EXCLUSIVE') {
          expect(paise(l.taxableValue)).toBe(net);
          expect(paise(l.lineTotal)).toBe(paise(l.taxableValue) + tax);
          expect(paise(l.roundingAdjustment)).toBe(0n);
        } else {
          // the price the customer sees is preserved exactly, and the leftover is at most one paisa
          expect(paise(l.lineTotal)).toBe(net);
          expect(paise(l.taxableValue) + tax + paise(l.roundingAdjustment)).toBe(net);
          const r = paise(l.roundingAdjustment);
          expect(r >= -1n && r <= 1n).toBe(true);
        }
        if (res.supply === 'INTRA') expect(l.components[0]!.amount).toBe(l.components[1]!.amount); // CGST = SGST always
        sumTotal += paise(l.lineTotal);
        sumTaxable += paise(l.taxableValue);
        sumResidual += paise(l.roundingAdjustment);
        for (const c of l.components) comps[c.kind] += paise(c.amount);
      }
      expect(paise(res.totals.grandTotal)).toBe(sumTotal); // round-off is NONE
      expect(paise(res.totals.taxableSubtotal)).toBe(sumTaxable);
      expect(paise(res.totals.roundingAdjustmentTotal)).toBe(sumResidual);
      for (const k of ['CGST', 'SGST', 'UTGST', 'IGST'] as const)
        expect(paise(res.totals.componentTotals[k])).toBe(comps[k]);
      expect(JSON.stringify(calculate(inp))).toBe(JSON.stringify(res)); // deterministic
    }
    expect(calculated).toBeGreaterThan(2500);
  });

  it('whole-rupee round-off never moves the total by more than half a rupee and lands on a whole rupee', () => {
    for (let i = 0; i < 500; i++) {
      const inp = randomInput();
      inp.rounding = { invoiceRoundOff: 'NEAREST_RUPEE' };
      const res = calculate(inp);
      if (!res.ok) continue;
      const off = paise(res.totals.roundOff);
      expect(off >= -50n && off <= 50n).toBe(true); // a tie rounds up
      expect(paise(res.totals.grandTotal) % 100n).toBe(0n);
    }
  });
});

describe('no binary floating point in the engine', () => {
  const dir = resolve(import.meta.dirname);
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  /** Source without comments and string/template literals. */
  const code = (file: string) =>
    readFileSync(resolve(dir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/`(?:\\.|[^`\\])*`/g, '``');

  it('contains none of the constructs that introduce a float', () => {
    expect(sources.length).toBeGreaterThanOrEqual(7);
    for (const f of sources) {
      const c = code(f);
      for (const [name, re] of [
        ['Number', /\bNumber\b/],
        ['parseFloat', /\bparseFloat\b/],
        ['parseInt', /\bparseInt\b/],
        ['Math', /\bMath\./],
        ['toFixed', /\.toFixed\b/],
        ['float literal', /\b\d+\.\d+\b/],
        ['unary plus conversion', /[=(,]\s*\+[a-zA-Z_]/],
      ] as const) {
        expect(re.test(c), `${f}: ${name}`).toBe(false);
      }
    }
  });
});
