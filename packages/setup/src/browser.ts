// Browser-safe subset (no database, hashing or validation-library imports) for the setup wizard UI.
// The server remains authoritative: the UI uses these only to give early, identical-rule feedback.
export { INDIA_STATE_CODES } from './india-state-codes.js';
export {
  FY_MAX_YEAR,
  FY_MIN_YEAR,
  GST_STATUSES,
  checkGstinStructure,
  financialYearBounds,
  isValidPanFormat,
  isValidPinCode,
  parseIsoDate,
  type GstStatus,
} from './validators.js';
export { sellerRegistrationProblems, type SellerRegistrationFacts } from './seller-rules.js';
