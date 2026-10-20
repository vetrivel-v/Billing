export {
  MOVEMENT_TYPES,
  StockError,
  postStockMovement,
  reconcileBalances,
  type BalanceDrift,
  type MovementType,
  type PostMovementInput,
  type PostedMovement,
  type StockErrorCode,
} from './engine.js';
export {
  InventoryError,
  createInventoryService,
  toMovementView,
  type InventoryContext,
  type InventoryErrorCode,
  type InventoryService,
  type InventoryServiceOptions,
} from './service.js';
export {
  QUANTITY_MAX_INTEGER_DIGITS,
  QUANTITY_SCALE,
  addQuantities,
  canonicalQuantity,
  compareQuantities,
  formatQuantity,
  parseQuantity,
  type QuantityRule,
} from './quantity.js';
export {
  ADJUSTMENT_DIRECTIONS,
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
