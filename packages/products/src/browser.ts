// Browser-safe subset (pure functions only): the product form runs the SAME validation as the server for early feedback.
export {
  PRODUCT_KINDS,
  SKU_PATTERN,
  normalizeMoney,
  validateProduct,
  type NormalizedProduct,
  type Problem,
  type ValidationResult,
} from './validate.js';
