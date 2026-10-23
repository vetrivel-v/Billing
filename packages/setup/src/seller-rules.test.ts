import { describe, expect, it } from 'vitest';
import { sellerGateProblems, sellerRegistrationProblems } from './seller-rules.js';

// A structurally valid fictional GSTIN (check character included): state 27, PAN AAPFU0939F.
const GSTIN = '27AAPFU0939F1ZV';

describe('sellerRegistrationProblems (the one shared GST rule set)', () => {
  const ok = { gstStatus: 'REGISTERED', gstin: GSTIN, pan: 'AAPFU0939F', stateCode: '27' } as const;
  it('accepts a consistent registered seller, with or without a PAN', () => {
    expect(sellerRegistrationProblems(ok)).toEqual([]);
    expect(sellerRegistrationProblems({ ...ok, pan: null })).toEqual([]);
  });
  it('requires a GSTIN for a registered seller and forbids one for an unregistered seller', () => {
    expect(sellerRegistrationProblems({ ...ok, gstin: null })).toEqual([
      { field: 'gstin', rule: 'gstin_required' },
    ]);
    expect(sellerRegistrationProblems({ ...ok, gstStatus: 'UNREGISTERED' })).toEqual([
      { field: 'gstin', rule: 'gstin_not_allowed' },
    ]);
    expect(sellerRegistrationProblems({ ...ok, gstStatus: 'UNREGISTERED', gstin: null })).toEqual(
      [],
    );
  });
  it('checks the GSTIN shape and check character, then the state and the PAN inside it', () => {
    expect(sellerRegistrationProblems({ ...ok, gstin: 'garbage' })).toContainEqual({
      field: 'gstin',
      rule: 'invalid_gstin_format',
    });
    expect(sellerRegistrationProblems({ ...ok, gstin: '27AAPFU0939F1ZA' })).toContainEqual({
      field: 'gstin',
      rule: 'invalid_gstin_checksum',
    });
    expect(sellerRegistrationProblems({ ...ok, stateCode: '29' })).toContainEqual({
      field: 'gstin',
      rule: 'gstin_state_mismatch',
    });
    expect(sellerRegistrationProblems({ ...ok, pan: 'ABCDE1234F' })).toContainEqual({
      field: 'gstin',
      rule: 'gstin_pan_mismatch',
    });
    expect(sellerRegistrationProblems({ ...ok, pan: 'bad' })).toContainEqual({
      field: 'pan',
      rule: 'invalid_pan_format',
    });
    expect(sellerRegistrationProblems({ ...ok, stateCode: '00' })).toContainEqual({
      field: 'stateCode',
      rule: 'unknown_state_code',
    });
  });
});

describe('sellerGateProblems (the production-readiness view of the same rules)', () => {
  it('describes seller configuration problems with stable codes', () => {
    expect(sellerGateProblems({ gstStatus: 'REGISTERED', gstin: GSTIN, stateCode: '27' })).toEqual(
      [],
    );
    expect(sellerGateProblems({ gstStatus: 'COMPOSITION', gstin: GSTIN, stateCode: '27' })).toEqual(
      ['SELLER_NOT_SUPPORTED'],
    );
    expect(sellerGateProblems({ gstStatus: 'REGISTERED', gstin: null, stateCode: '27' })).toEqual([
      'SELLER_GSTIN_MISSING',
    ]);
    expect(
      sellerGateProblems({ gstStatus: 'REGISTERED', gstin: 'garbage', stateCode: '27' }),
    ).toEqual(['SELLER_GSTIN_MISSING']);
    // the old gate accepted any well-shaped GSTIN; the shared rule also checks the check character
    expect(
      sellerGateProblems({ gstStatus: 'REGISTERED', gstin: '27ABCDE1234F1Z5', stateCode: '27' }),
    ).toEqual(['SELLER_GSTIN_MISSING']);
    expect(sellerGateProblems({ gstStatus: 'REGISTERED', gstin: GSTIN, stateCode: '29' })).toEqual([
      'SELLER_GSTIN_STATE_MISMATCH',
    ]);
    expect(sellerGateProblems({ gstStatus: 'REGISTERED', gstin: GSTIN, stateCode: null })).toEqual([
      'SELLER_GSTIN_STATE_MISMATCH',
    ]);
  });
});
