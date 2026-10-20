// Browser-safe subset: the forms run the SAME validation as the server for early feedback.
export {
  HSN_CODE,
  HSN_SAC_KINDS,
  MAX_CAPACITY,
  MAX_HSN_DESCRIPTION,
  MAX_REASON,
  MAX_REVIEW_NOTE,
  REVIEW_NOTICE_TEXT,
  REVIEW_NOTICE_VERSION,
  validateHsnPolicy,
  validateHsnSac,
  validateReviewRequest,
  type Problem,
} from './validate.js';
