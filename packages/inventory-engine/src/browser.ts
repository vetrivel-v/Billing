// Browser-safe subset (pure functions only): the stock forms run the SAME quantity and field validation as the server for
// early feedback. The server recomputes everything and is the only authority on stock.
export {
  QUANTITY_SCALE,
  addQuantities,
  canonicalQuantity,
  compareQuantities,
  formatQuantity,
  parseQuantity,
  type QuantityRule,
} from './quantity.js';
export {
  ADJUSTMENT_REASONS,
  MAX_NOTE,
  MAX_REFERENCE,
  isRealDate,
  validateOperation,
  type AdjustmentReason,
  type NormalizedOperation,
  type Problem,
  type StockOperationKind,
} from './validate.js';
