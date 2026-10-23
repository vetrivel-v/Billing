/**
 * Pure helpers around the tax CONFIGURATION: effective-rate selection, the configuration fingerprint and the production
 * gate. None of them touches a database; the API layer loads the rows and passes them in.
 */
import { canonicalJson, sha256Hex } from './hash.js';
import { formatPercent, parseScaled } from './decimal.js';
import {
  JURISDICTIONS,
  JURISDICTION_RULESET_ID,
  JURISDICTION_RULESET_VERSION,
} from './jurisdictions.js';
import { ENGINE_VERSION, ROUNDING_POLICY_ID, RULESET_VERSION } from './version.js';

export type TaxClassification = 'STANDARD' | 'ZERO_RATED' | 'NIL_RATED' | 'EXEMPT' | 'NON_GST';

/** Dates are YYYY-MM-DD text; a NULL start or end means open. */
export interface CategoryRow {
  id: string;
  code: string;
  name: string;
  classification: string;
  isActive: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface RateRow {
  id: string;
  categoryId: string;
  /** Total GST rate in percent, exact decimal text (up to 4 places). */
  ratePercent: string;
  cessPercent: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export type RateSelectionFailure =
  | 'TAX_CATEGORY_INACTIVE'
  | 'TAX_CATEGORY_NOT_EFFECTIVE'
  | 'NO_EFFECTIVE_RATE'
  | 'AMBIGUOUS_EFFECTIVE_RATE';

/** True when `date` lies inside the (inclusive, possibly open) window. */
export const inWindow = (date: string, from: string | null, to: string | null): boolean =>
  (from === null || from <= date) && (to === null || date <= to);

/**
 * Picks the one rate in force for a category on a date (the tax point / invoice date). Exactly one row must match; none
 * or several is a failure, never a guess. The category itself must be active and effective on the date.
 */
export function selectEffectiveRate(
  category: CategoryRow,
  rates: readonly RateRow[],
  date: string,
): { ok: true; rate: RateRow } | { ok: false; code: RateSelectionFailure } {
  if (!category.isActive) return { ok: false, code: 'TAX_CATEGORY_INACTIVE' };
  if (!inWindow(date, category.effectiveFrom, category.effectiveTo))
    return { ok: false, code: 'TAX_CATEGORY_NOT_EFFECTIVE' };
  const hits = rates.filter(
    (r) => r.categoryId === category.id && inWindow(date, r.effectiveFrom, r.effectiveTo),
  );
  if (hits.length === 0) return { ok: false, code: 'NO_EFFECTIVE_RATE' };
  if (hits.length > 1) return { ok: false, code: 'AMBIGUOUS_EFFECTIVE_RATE' };
  return { ok: true, rate: hits[0]! };
}

const canonicalPercent = (text: string): string => {
  const p = parseScaled(text, 4);
  return p ? formatPercent(p.units, 4) : `invalid:${text}`;
};

/**
 * The configuration fingerprint: a SHA-256 over everything that decides a tax result - the active rule set versions,
 * the jurisdiction table, every tax category and every effective-dated rate (values and dates, not review marks,
 * notes or timestamps). A review applies to exactly one fingerprint; any change of any of these makes the latest review
 * stale, so there is no "reviewed" switch that could be forgotten.
 */
export function computeConfigurationFingerprint(
  categories: readonly CategoryRow[],
  rates: readonly RateRow[],
): string {
  const codeById = new Map(categories.map((c) => [c.id, c.code]));
  const cats = [...categories]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((c) => ({
      code: c.code,
      name: c.name,
      classification: c.classification,
      isActive: c.isActive,
      effectiveFrom: c.effectiveFrom,
      effectiveTo: c.effectiveTo,
    }));
  const rs = rates
    .map((r) => ({
      categoryCode: codeById.get(r.categoryId) ?? `unknown:${r.categoryId}`,
      ratePercent: canonicalPercent(r.ratePercent),
      cessPercent: canonicalPercent(r.cessPercent),
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
    }))
    .sort((a, b) =>
      a.categoryCode === b.categoryCode
        ? a.effectiveFrom < b.effectiveFrom
          ? -1
          : a.effectiveFrom > b.effectiveFrom
            ? 1
            : 0
        : a.categoryCode < b.categoryCode
          ? -1
          : 1,
    );
  return sha256Hex(
    canonicalJson({
      engineVersion: ENGINE_VERSION,
      rulesetVersion: RULESET_VERSION,
      roundingPolicyId: ROUNDING_POLICY_ID,
      jurisdictions: {
        id: JURISDICTION_RULESET_ID,
        version: JURISDICTION_RULESET_VERSION,
        entries: JURISDICTIONS,
      },
      categories: cats,
      rates: rs,
    }),
  );
}

export type ReviewState = 'NONE' | 'CURRENT' | 'STALE';

/** A review is current only when it was made for exactly the fingerprint in force now. */
export function reviewState(
  latestReviewFingerprint: string | null,
  currentFingerprint: string,
): ReviewState {
  if (latestReviewFingerprint === null) return 'NONE';
  return latestReviewFingerprint === currentFingerprint ? 'CURRENT' : 'STALE';
}

// The seller's own GST registration facts (REGISTERED, a structurally valid GSTIN, matching state) are judged by the single shared rule set in
// @commercebill/setup (`sellerGateProblems`); the engine only receives the resulting problem codes (see evaluateProductionGate).

export type BillingMode = 'DEMO' | 'PRODUCTION';

export interface GateRequirement {
  code:
    'TAX_REVIEW_CURRENT' | 'SELLER_REGISTERED_VALID' | 'HSN_SAC_POLICY' | 'BACKUP_RESTORE_VERIFIED';
  met: boolean;
}

/**
 * The production safety gate (an internal safety check, not a compliance certification). Production billing needs ALL of:
 * a current tax review, a valid regular GST-registered seller, an HSN/SAC policy in force and a verified backup/restore
 * (Task 1.17; until it exists that fact is always false, so only DEMO billing is possible).
 */
export function evaluateProductionGate(facts: {
  review: ReviewState;
  sellerProblems: readonly string[];
  hsnSacPolicyInForce: boolean;
  backupRestoreVerified: boolean;
}): { eligible: boolean; requirements: GateRequirement[] } {
  const requirements: GateRequirement[] = [
    { code: 'TAX_REVIEW_CURRENT', met: facts.review === 'CURRENT' },
    { code: 'SELLER_REGISTERED_VALID', met: facts.sellerProblems.length === 0 },
    { code: 'HSN_SAC_POLICY', met: facts.hsnSacPolicyInForce },
    { code: 'BACKUP_RESTORE_VERIFIED', met: facts.backupRestoreVerified },
  ];
  return { eligible: requirements.every((r) => r.met), requirements };
}
