// Browser-safe subset (no hashing, no calculation): constants and the jurisdiction ruleset for display.
export {
  JURISDICTIONS,
  JURISDICTION_REVIEW_STATUS,
  JURISDICTION_RULESET_ID,
  JURISDICTION_RULESET_VERSION,
  classifySupply,
  jurisdictionFor,
  type Jurisdiction,
  type JurisdictionKind,
  type TaxComponentKind,
} from './jurisdictions.js';
export { ENGINE_VERSION, ROUNDING_POLICY_ID, RULESET_VERSION } from './version.js';
