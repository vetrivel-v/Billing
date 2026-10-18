import { describe, expect, it } from 'vitest';
import {
  checkGstinStructure,
  financialYearBounds,
  gstinCheckCharacter,
  isValidGstinChecksum,
  isValidPanFormat,
  isValidPinCode,
  parseIsoDate,
} from './validators.js';
import { INDIA_STATE_CODES, stateNameForCode } from './india-state-codes.js';

// 27AAPFU0939F1ZV is the widely published specimen GSTIN used in GST documentation. It is used here ONLY to
// check the checksum algorithm; nothing in this project treats any GSTIN as real.
const SPECIMEN = '27AAPFU0939F1ZV';

describe('PAN format', () => {
  it.each(['AAPFU0939F', 'ABCDE1234F', 'ZZZZZ9999Z'])('accepts %s', (pan) => {
    expect(isValidPanFormat(pan)).toBe(true);
  });
  it.each([
    'aapfu0939f', // lower case (callers upper-case first)
    'AAPFU0939', // too short
    'AAPFU0939FF', // too long
    'AAPF10939F', // digit where a letter is required
    'AAPFUA939F', // letter where a digit is required
    'AAPFU09390', // digit at the check position
    ' AAPFU0939F',
    '',
  ])('rejects %j', (pan) => {
    expect(isValidPanFormat(pan)).toBe(false);
  });
});

describe('GSTIN structure and checksum', () => {
  it('computes the published specimen check character', () => {
    expect(gstinCheckCharacter(SPECIMEN.slice(0, 14))).toBe('V');
    expect(isValidGstinChecksum(SPECIMEN)).toBe(true);
    expect(checkGstinStructure(SPECIMEN)).toBeNull();
  });

  it('detects a wrong check character', () => {
    expect(checkGstinStructure(SPECIMEN.slice(0, 14) + 'W')).toBe('invalid_gstin_checksum');
    expect(isValidGstinChecksum(SPECIMEN.slice(0, 14) + '0')).toBe(false);
  });

  it('detects a single changed character anywhere in the first 14', () => {
    for (let i = 2; i < 14; i++) {
      const original = SPECIMEN[i]!;
      const replacement =
        original === 'A' ? 'B' : original === '1' ? '2' : original === 'Z' ? 'Y' : 'A';
      const mutated = SPECIMEN.slice(0, i) + replacement + SPECIMEN.slice(i + 1);
      // Either the format breaks (letter/digit position) or the checksum does - never "valid".
      expect(checkGstinStructure(mutated), `position ${i}`).not.toBeNull();
    }
  });

  it.each([
    ['lower case', SPECIMEN.toLowerCase()],
    ['too short', SPECIMEN.slice(0, 14)],
    ['too long', SPECIMEN + 'A'],
    ['no Z at position 14', SPECIMEN.slice(0, 13) + 'X' + SPECIMEN[14]],
    ['entity digit 0', SPECIMEN.slice(0, 12) + '0' + SPECIMEN.slice(13)],
    ['letters in state code', 'AAAAPFU0939F1ZV'],
    ['empty', ''],
  ])('rejects the wrong format: %s', (_name, value) => {
    expect(checkGstinStructure(value)).toBe('invalid_gstin_format');
  });

  it('check character is undefined for unusable input', () => {
    expect(gstinCheckCharacter('short')).toBeUndefined();
    expect(gstinCheckCharacter('27aapfu0939f1z')).toBeUndefined();
  });
});

describe('PIN code', () => {
  it.each(['110001', '411001', '999999'])('accepts %s', (v) =>
    expect(isValidPinCode(v)).toBe(true),
  );
  it.each(['012345', '11000', '1100011', 'abcdef', '11 001', ''])('rejects %j', (v) =>
    expect(isValidPinCode(v)).toBe(false),
  );
});

describe('ISO dates and financial-year bounds', () => {
  it('parses real dates only', () => {
    expect(parseIsoDate('2026-04-01')?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(parseIsoDate('2028-02-29')).not.toBeNull(); // leap day
    for (const bad of [
      '2027-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '26-04-01',
      '2026/04/01',
      '2026-4-1',
      '',
      ' 2026-04-01',
    ]) {
      expect(parseIsoDate(bad), bad).toBeNull();
    }
  });

  it('April start gives a one-year period labelled like 2026-27', () => {
    const fy = financialYearBounds(parseIsoDate('2026-04-01')!);
    expect(fy.end.toISOString().slice(0, 10)).toBe('2027-03-31');
    expect(fy.label).toBe('2026-27');
  });

  it('calendar-year start gives a single-year label', () => {
    const fy = financialYearBounds(parseIsoDate('2026-01-01')!);
    expect(fy.end.toISOString().slice(0, 10)).toBe('2026-12-31');
    expect(fy.label).toBe('2026');
  });

  it('handles a leap-day start and the century rollover', () => {
    expect(financialYearBounds(parseIsoDate('2028-02-29')!).end.toISOString().slice(0, 10)).toBe(
      '2029-02-28',
    );
    const fy = financialYearBounds(parseIsoDate('2099-04-01')!);
    expect(fy.label).toBe('2099-00');
    expect(fy.end.toISOString().slice(0, 10)).toBe('2100-03-31');
  });
});

describe('state code table', () => {
  it('maps known codes and rejects unknown ones', () => {
    expect(stateNameForCode('27')).toBe('Maharashtra');
    expect(stateNameForCode('07')).toBe('Delhi');
    expect(stateNameForCode('00')).toBeUndefined();
    expect(stateNameForCode('39')).toBeUndefined();
    expect(stateNameForCode('7')).toBeUndefined();
  });
  it('contains only two-digit codes', () => {
    for (const code of Object.keys(INDIA_STATE_CODES)) expect(code).toMatch(/^[0-9]{2}$/);
  });
});
