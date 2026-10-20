import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_CODES,
  FY_TOKEN,
  containsFyToken,
  expandTemplate,
  formatDocumentNumber,
  isDocumentTypeCode,
  isValidAffix,
  previewNumber,
  setupSequencePlan,
  validateSequenceConfig,
  type SequenceConfig,
} from './index.js';

const cfg = (over: Partial<SequenceConfig> = {}): SequenceConfig => ({
  prefix: 'INV/{FY}/',
  suffix: '',
  numericLength: 6,
  startNumber: 1n,
  resetPolicy: 'FINANCIAL_YEAR',
  ...over,
});
const rules = (c: SequenceConfig) => validateSequenceConfig(c).map((p) => `${p.field}:${p.rule}`);

describe('document type registry', () => {
  it('uses stable upper-case machine codes, distinct from display labels', () => {
    expect(DOCUMENT_TYPE_CODES.sort()).toEqual(
      [
        'CREDIT_NOTE',
        'DEBIT_NOTE',
        'DEMO_INVOICE',
        'INVOICE',
        'PAYMENT_RECEIPT',
        'PURCHASE_ORDER',
      ].sort(),
    );
    for (const code of DOCUMENT_TYPE_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(DOCUMENT_TYPES[code].code).toBe(code);
      expect(DOCUMENT_TYPES[code].label).not.toBe(code); // the label is display-only
    }
  });

  it('recognises codes only, never labels or other strings', () => {
    expect(isDocumentTypeCode('INVOICE')).toBe(true);
    expect(isDocumentTypeCode('Tax invoice')).toBe(false);
    expect(isDocumentTypeCode('invoice')).toBe(false);
    expect(isDocumentTypeCode('__proto__')).toBe(false);
    expect(isDocumentTypeCode('toString')).toBe(false);
    expect(isDocumentTypeCode(undefined)).toBe(false);
  });
});

describe('formatting - the configuration decides the output', () => {
  it('builds the spec example formats from configuration, not constants', () => {
    const f = (prefix: string, n: bigint) =>
      formatDocumentNumber({
        prefix,
        suffix: '',
        numericLength: 6,
        number: n,
        financialYearLabel: '2026-27',
      });
    expect(f('INV/{FY}/', 1n)).toBe('INV/2026-27/000001');
    expect(f('CN/{FY}/', 1n)).toBe('CN/2026-27/000001');
    expect(f('DN/{FY}/', 42n)).toBe('DN/2026-27/000042');
    expect(f('PO/{FY}/', 123456n)).toBe('PO/2026-27/123456');
  });

  it('honours any prefix, suffix and width', () => {
    expect(
      formatDocumentNumber({
        prefix: 'A-',
        suffix: '/B',
        numericLength: 3,
        number: 7n,
        financialYearLabel: 'x',
      }),
    ).toBe('A-007/B');
    expect(
      formatDocumentNumber({
        prefix: '',
        suffix: '',
        numericLength: 1,
        number: 9n,
        financialYearLabel: 'x',
      }),
    ).toBe('9');
    expect(
      formatDocumentNumber({
        prefix: 'S{FY}',
        suffix: '-{FY}',
        numericLength: 4,
        number: 12n,
        financialYearLabel: '2027',
      }),
    ).toBe('S20270012-2027');
  });

  it('supports the 18-digit maximum width and bigint values', () => {
    const big = 123456789012345678n;
    expect(
      formatDocumentNumber({
        prefix: 'N',
        suffix: '',
        numericLength: 18,
        number: big,
        financialYearLabel: '',
      }),
    ).toBe('N123456789012345678');
  });

  it('refuses to truncate or widen: a number that does not fit throws', () => {
    expect(() =>
      formatDocumentNumber({
        prefix: '',
        suffix: '',
        numericLength: 3,
        number: 1000n,
        financialYearLabel: '',
      }),
    ).toThrow(RangeError);
    expect(() =>
      formatDocumentNumber({
        prefix: '',
        suffix: '',
        numericLength: 3,
        number: 0n,
        financialYearLabel: '',
      }),
    ).toThrow(RangeError);
    expect(() =>
      formatDocumentNumber({
        prefix: '',
        suffix: '',
        numericLength: 3,
        number: -5n,
        financialYearLabel: '',
      }),
    ).toThrow(RangeError);
  });

  it('expands the {FY} token everywhere it appears', () => {
    expect(expandTemplate('{FY}/{FY}', '2026-27')).toBe('2026-27/2026-27');
    expect(expandTemplate('none', '2026-27')).toBe('none');
    expect(containsFyToken('INV/{FY}/')).toBe(true);
    expect(containsFyToken('INV/')).toBe(false);
    expect(FY_TOKEN).toBe('{FY}');
  });

  it('previews a number without touching the database', () => {
    expect(previewNumber(cfg(), '2026-27')).toBe('INV/2026-27/000001');
    expect(previewNumber(cfg({ startNumber: 1001n }), '2026-27')).toBe('INV/2026-27/001001');
    expect(previewNumber(cfg(), '2026-27', 15n)).toBe('INV/2026-27/000015');
  });
});

describe('affix rules', () => {
  it.each(['INV/', 'INV/{FY}/', 'A.B_C-D', '', 'x'.repeat(40), '{FY}', '{FY}{FY}'])(
    'accepts %j',
    (v) => {
      expect(isValidAffix(v)).toBe(true);
    },
  );
  it.each([
    'has space',
    'quote"',
    "it's",
    '{FY',
    'FY}',
    '{OTHER}',
    '{fy}',
    'a{}b',
    '<script>',
    'x'.repeat(41),
    'ü',
    'ए',
    '\n',
    '%s',
  ])('rejects %j', (v) => {
    expect(isValidAffix(v)).toBe(false);
  });
});

describe('sequence configuration validation', () => {
  it('accepts a normal configuration and a NEVER-reset one without a year token', () => {
    expect(validateSequenceConfig(cfg())).toEqual([]);
    expect(validateSequenceConfig(cfg({ prefix: 'INV/', resetPolicy: 'NEVER' }))).toEqual([]);
    expect(validateSequenceConfig(cfg({ prefix: 'INV/', suffix: '/{FY}' }))).toEqual([]); // token in the suffix is enough
  });

  it.each([
    ['bad prefix characters', { prefix: 'INV #1' }, 'prefix:invalid_prefix'],
    ['bad suffix characters', { suffix: 'a b' }, 'suffix:invalid_suffix'],
    ['over-long prefix', { prefix: 'x'.repeat(41) + '{FY}' }, 'prefix:invalid_prefix'],
    ['width 0', { numericLength: 0 }, 'numericLength:invalid_width'],
    ['width 19', { numericLength: 19 }, 'numericLength:invalid_width'],
    ['fractional width', { numericLength: 2.5 }, 'numericLength:invalid_width'],
    ['start 0', { startNumber: 0n }, 'startNumber:invalid_start_number'],
    ['negative start', { startNumber: -1n }, 'startNumber:invalid_start_number'],
    [
      'start wider than width',
      { numericLength: 3, startNumber: 1000n },
      'startNumber:start_number_exceeds_width',
    ],
    [
      'unknown reset policy',
      { resetPolicy: 'MONTHLY' as never },
      'resetPolicy:invalid_reset_policy',
    ],
    [
      'yearly reset without a year token (would repeat text next year)',
      { prefix: 'INV/2026-27/' },
      'prefix:format_not_unique_across_years',
    ],
    [
      'yearly reset with an empty format',
      { prefix: '', suffix: '' },
      'prefix:format_not_unique_across_years',
    ],
  ])('rejects %s', (_name, over, expected) => {
    expect(rules(cfg(over as Partial<SequenceConfig>))).toContain(expected);
  });

  it('accepts the exact boundary widths', () => {
    expect(validateSequenceConfig(cfg({ numericLength: 1, startNumber: 9n }))).toEqual([]);
    expect(
      validateSequenceConfig(cfg({ numericLength: 18, startNumber: 999999999999999999n })),
    ).toEqual([]);
    expect(rules(cfg({ numericLength: 1, startNumber: 10n }))).toContain(
      'startNumber:start_number_exceeds_width',
    );
  });

  it('never echoes submitted values in problems', () => {
    const text = JSON.stringify(validateSequenceConfig(cfg({ prefix: 'secret value!' })));
    expect(text).not.toContain('secret');
  });
});

describe('setup sequence plan', () => {
  it('creates one sequence per document type with the documented defaults', () => {
    const plan = setupSequencePlan();
    expect(plan.map((p) => p.documentType).sort()).toEqual([...DOCUMENT_TYPE_CODES].sort());
    const invoice = plan.find((p) => p.documentType === 'INVOICE')!;
    expect(invoice.config).toEqual(cfg());
    expect(previewNumber(invoice.config, '2026-27')).toBe('INV/2026-27/000001');
    for (const p of plan) expect(validateSequenceConfig(p.config)).toEqual([]);
  });

  it('applies the wizard answers: prefixes, invoice start number and width', () => {
    const plan = setupSequencePlan({
      invoicePrefix: 'TAX/{FY}/',
      invoiceStartNumber: 501,
      creditNotePrefix: 'CRN-{FY}-',
      numericWidth: 8,
    });
    const by = (t: string) => plan.find((p) => p.documentType === t)!.config;
    expect(by('INVOICE')).toMatchObject({
      prefix: 'TAX/{FY}/',
      startNumber: 501n,
      numericLength: 8,
    });
    expect(by('CREDIT_NOTE').prefix).toBe('CRN-{FY}-');
    expect(by('DEBIT_NOTE').prefix).toBe('DN/{FY}/'); // untouched default
    expect(by('CREDIT_NOTE').startNumber).toBe(1n); // only invoices take a custom start
  });
});
