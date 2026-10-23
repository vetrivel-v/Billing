import { INDIA_STATE_CODES } from './india-state-codes.js';
import { checkGstinStructure, isValidPanFormat, type GstStatus } from './validators.js';

/**
 * The ONE place that decides whether a seller's GST registration facts are acceptable. First-run setup, the Business Profile screen and
 * the production readiness check all call this, so there is no second GSTIN rule anywhere.
 *
 * It checks FORMAT and internal consistency only (PAN shape, GSTIN shape and check character, the GSTIN's state digits against the state,
 * the PAN inside the GSTIN). It cannot know that a GSTIN exists or belongs to the business, and it never contacts the GST portal.
 */
export interface SellerRegistrationFacts {
  gstStatus: GstStatus;
  gstin: string | null;
  pan: string | null;
  stateCode: string;
}

export interface SellerRegistrationProblem {
  field: 'gstStatus' | 'gstin' | 'pan' | 'stateCode';
  rule: string;
}

export function sellerRegistrationProblems(
  facts: SellerRegistrationFacts,
): SellerRegistrationProblem[] {
  const out: SellerRegistrationProblem[] = [];
  const { gstStatus, gstin, pan, stateCode } = facts;
  if (pan && !isValidPanFormat(pan)) out.push({ field: 'pan', rule: 'invalid_pan_format' });
  if (gstStatus === 'REGISTERED' && !gstin) out.push({ field: 'gstin', rule: 'gstin_required' });
  if (gstStatus === 'UNREGISTERED' && gstin)
    out.push({ field: 'gstin', rule: 'gstin_not_allowed' });
  const stateName = INDIA_STATE_CODES[stateCode];
  if (!stateName) out.push({ field: 'stateCode', rule: 'unknown_state_code' });
  if (gstin && gstStatus !== 'UNREGISTERED') {
    const structural = checkGstinStructure(gstin);
    if (structural) out.push({ field: 'gstin', rule: structural });
    else {
      if (stateName && gstin.slice(0, 2) !== stateCode)
        out.push({ field: 'gstin', rule: 'gstin_state_mismatch' });
      if (pan && gstin.slice(2, 12) !== pan)
        out.push({ field: 'gstin', rule: 'gstin_pan_mismatch' });
    }
  }
  return out;
}

/**
 * The production-readiness view of the same rules: a regular (REGISTERED) seller with a structurally valid GSTIN whose state digits match
 * the seller's state. Returns the stable readiness codes used by the production gate.
 */
export function sellerGateProblems(seller: {
  gstStatus: string;
  gstin: string | null;
  stateCode: string | null;
}): string[] {
  const out: string[] = [];
  if (seller.gstStatus !== 'REGISTERED') out.push('SELLER_NOT_SUPPORTED');
  if (!seller.gstin || checkGstinStructure(seller.gstin)) out.push('SELLER_GSTIN_MISSING');
  else if (!seller.stateCode || seller.gstin.slice(0, 2) !== seller.stateCode)
    out.push('SELLER_GSTIN_STATE_MISMATCH');
  return out;
}
