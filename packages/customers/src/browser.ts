// Browser-safe subset (pure functions only): the customer form runs the SAME validation as the server for early feedback.
export {
  CODE_PATTERN,
  CUSTOMER_TYPES,
  GST_STATUSES,
  validateCustomer,
  type NormalizedWithNotes,
  type Problem,
  type ValidationResult,
} from './validate.js';
