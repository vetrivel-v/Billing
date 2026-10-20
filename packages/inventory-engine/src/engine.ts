/**
 * The inventory-domain engine (ADR-0022). `postStockMovement` is the ONLY way stock changes. It runs INSIDE a
 * caller-owned Prisma/PostgreSQL transaction and never commits or opens one itself, so a later invoice posting can call
 * it as one step of its own transaction:
 *
 *   prisma.$transaction(async (tx) => {
 *     ... validate invoice, allocate number, create the posted invoice ...
 *     await postStockMovement(tx, { movementType: 'SALES_DISPATCH', source: { type: 'SALES_INVOICE', ref: invoiceId, lineRef: lineId }, ... });
 *     ... create receivable ...
 *   });                                           // one commit: all of it or none of it
 *
 * Truth lives in the append-only `stock_movements` ledger; `stock_balances` is a projection kept by a database trigger
 * in the same statement. The database also enforces every rule below (organization ownership, tracked goods, unit
 * precision, no negative stock, opening stock once, append-only), so a mistake here cannot corrupt stock.
 */
import type { Prisma } from '@commercebill/database';
import { canonicalQuantity, compareQuantities, parseQuantity } from './quantity.js';

/** Movement types supported by Task 1.11. Later tasks widen this list (and the database CHECK) together. */
export const MOVEMENT_TYPES = [
  'OPENING_STOCK',
  'STOCK_RECEIPT',
  'ADJUSTMENT_INCREASE',
  'ADJUSTMENT_DECREASE',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** The direction each type implies. A caller gives a positive quantity; the sign is decided here, never by the caller. */
const SIGN: Record<MovementType, 1 | -1> = {
  OPENING_STOCK: 1,
  STOCK_RECEIPT: 1,
  ADJUSTMENT_INCREASE: 1,
  ADJUSTMENT_DECREASE: -1,
};

export type StockErrorCode =
  | 'unknown_reference'
  | 'inventory_not_tracked'
  | 'invalid_quantity'
  | 'insufficient_stock'
  | 'opening_stock_exists'
  | 'operation_id_reused';

export class StockError extends Error {
  constructor(
    readonly code: StockErrorCode,
    message: string,
    readonly problems: { field: string; rule: string }[] = [],
  ) {
    super(message);
    this.name = 'StockError';
  }
}

export interface PostMovementInput {
  organizationId: string;
  warehouseId: string;
  productId: string;
  movementType: MovementType;
  /** POSITIVE magnitude as decimal text ("2.5"). The movement type decides whether it adds or removes stock. */
  quantity: string;
  /** YYYY-MM-DD: the day the stock event physically happened. */
  businessDate: string;
  /**
   * The idempotency identity of the logical event. Posting the same (organization, type, ref, lineRef) twice has the
   * effect of posting it once: the second call returns the first movement with `replayed: true`.
   */
  source: { type: string; ref: string; lineRef?: string };
  createdBy: string;
  reasonCode?: string | null;
  reference?: string | null;
  note?: string | null;
}

export interface PostedMovement {
  id: string;
  movementType: MovementType;
  productId: string;
  warehouseId: string;
  /** Signed, canonical decimal text. */
  quantityDelta: string;
  businessDate: string;
  reasonCode: string | null;
  /** Stock on hand after this movement (for a replay: the current stock on hand). */
  balanceAfter: string;
  /** True when this exact logical event had already been posted and nothing changed. */
  replayed: boolean;
}

const advisoryKey = (warehouseId: string, productId: string) => `stock:${warehouseId}:${productId}`;

/** Maps what PostgreSQL's rules say (the backstop) to the engine's own errors. */
function mapDatabaseError(err: unknown): never {
  const text = `${(err as { message?: string })?.message ?? ''} ${JSON.stringify((err as { meta?: unknown })?.meta ?? '')}`;
  if (/stock_balances_not_negative/.test(text)) {
    throw new StockError('insufficient_stock', 'There is not enough stock.', [
      { field: 'quantity', rule: 'insufficient_stock' },
    ]);
  }
  if (/opening stock can only be recorded/.test(text)) {
    throw new StockError('opening_stock_exists', 'Opening stock has already been recorded.', [
      { field: 'productId', rule: 'opening_stock_exists' },
    ]);
  }
  if (/stock_movements_organization_id_source_type_source_ref/.test(text)) {
    throw new StockError('operation_id_reused', 'This operation id was already used.', [
      { field: 'operationId', rule: 'operation_id_reused' },
    ]);
  }
  if (/more decimal places than the unit allows/.test(text)) {
    throw new StockError('invalid_quantity', 'The quantity is not valid for this unit.', [
      { field: 'quantity', rule: 'too_many_decimals' },
    ]);
  }
  if (/numeric field overflow/i.test(text)) {
    throw new StockError('invalid_quantity', 'The quantity is too large.', [
      { field: 'quantity', rule: 'quantity_too_large' },
    ]);
  }
  throw err;
}

const dateText = (d: Date) => d.toISOString().slice(0, 10);
const dec = (d: { toFixed(dp: number): string }) => canonicalQuantity(d.toFixed(4));

export async function postStockMovement(
  tx: Prisma.TransactionClient,
  input: PostMovementInput,
): Promise<PostedMovement> {
  const { organizationId, warehouseId, productId } = input;
  const sourceLineRef = input.source.lineRef ?? '';

  // 1. The product and warehouse must exist in THIS organization (another organization's look exactly like an unknown id).
  const product = await tx.product.findFirst({
    where: { id: productId, organizationId },
    include: { unit: true },
  });
  if (!product) {
    throw new StockError('unknown_reference', 'The product was not found.', [
      { field: 'productId', rule: 'unknown_reference' },
    ]);
  }
  const warehouse = await tx.warehouse.findFirst({
    where: { id: warehouseId, organizationId },
    select: { id: true },
  });
  if (!warehouse) {
    throw new StockError('unknown_reference', 'The warehouse was not found.', [
      { field: 'warehouseId', rule: 'unknown_reference' },
    ]);
  }
  // 2. Only tracked goods have stock. A service or untracked goods never get a (meaningless) movement.
  if (product.kind !== 'GOODS' || !product.trackInventory || !product.unit) {
    throw new StockError('inventory_not_tracked', 'This product does not track inventory.', [
      { field: 'productId', rule: 'inventory_not_tracked' },
    ]);
  }
  // 3. Exact quantity within the unit's decimal places (refused, never rounded).
  const parsed = parseQuantity(input.quantity, product.unit.decimalPlaces);
  if (!parsed.ok) {
    throw new StockError('invalid_quantity', 'The quantity is not valid.', [
      { field: 'quantity', rule: parsed.rule },
    ]);
  }
  const delta = SIGN[input.movementType] === 1 ? parsed.value : `-${parsed.value}`;

  // 4. Serialize every movement of this stock, then look for an earlier posting of the same logical event.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${advisoryKey(warehouseId, productId)}, 0))`;

  const balanceNow = async () =>
    (
      await tx.stockBalance.findUnique({
        where: { warehouseId_productId: { warehouseId, productId } },
      })
    )?.quantityOnHand;

  const prior = await tx.stockMovement.findUnique({
    where: {
      organizationId_sourceType_sourceRef_sourceLineRef: {
        organizationId,
        sourceType: input.source.type,
        sourceRef: input.source.ref,
        sourceLineRef,
      },
    },
  });
  if (prior) {
    const same =
      prior.productId === productId &&
      prior.warehouseId === warehouseId &&
      prior.movementType === input.movementType &&
      canonicalQuantity(prior.quantityDelta.toFixed(4)) === canonicalQuantity(delta) &&
      dateText(prior.businessDate) === input.businessDate;
    if (!same) {
      throw new StockError('operation_id_reused', 'This operation id was already used.', [
        { field: 'operationId', rule: 'operation_id_reused' },
      ]);
    }
    const bal = await balanceNow();
    return {
      id: prior.id,
      movementType: prior.movementType as MovementType,
      productId,
      warehouseId,
      quantityDelta: dec(prior.quantityDelta),
      businessDate: dateText(prior.businessDate),
      reasonCode: prior.reasonCode,
      balanceAfter: bal ? dec(bal) : '0',
      replayed: true,
    };
  }

  // 5. Friendly pre-checks under the lock (the database enforces the same rules as a backstop).
  if (input.movementType === 'OPENING_STOCK') {
    const any = await tx.stockMovement.findFirst({
      where: { warehouseId, productId },
      select: { id: true },
    });
    if (any) {
      throw new StockError('opening_stock_exists', 'Opening stock has already been recorded.', [
        { field: 'productId', rule: 'opening_stock_exists' },
      ]);
    }
  }
  if (SIGN[input.movementType] === -1) {
    const bal = await balanceNow();
    const have = bal ? dec(bal) : '0';
    if (compareQuantities(have, parsed.value) < 0) {
      throw new StockError('insufficient_stock', 'There is not enough stock.', [
        { field: 'quantity', rule: 'insufficient_stock' },
      ]);
    }
  }

  // 6. Append the movement. The database trigger updates the balance in the same statement.
  let created;
  try {
    created = await tx.stockMovement.create({
      data: {
        organizationId,
        warehouseId,
        productId,
        movementType: input.movementType,
        quantityDelta: delta,
        businessDate: new Date(`${input.businessDate}T00:00:00Z`),
        sourceType: input.source.type,
        sourceRef: input.source.ref,
        sourceLineRef,
        reasonCode: input.reasonCode ?? null,
        reference: input.reference ?? null,
        note: input.note ?? null,
        createdBy: input.createdBy,
      },
    });
  } catch (err) {
    return mapDatabaseError(err);
  }
  const bal = await balanceNow();
  return {
    id: created.id,
    movementType: input.movementType,
    productId,
    warehouseId,
    quantityDelta: canonicalQuantity(delta),
    businessDate: input.businessDate,
    reasonCode: created.reasonCode,
    balanceAfter: bal ? dec(bal) : '0',
    replayed: false,
  };
}

export interface BalanceDrift {
  warehouseId: string;
  productId: string;
  /** What the projection says. */
  balance: string;
  /** What the ledger adds up to. */
  ledger: string;
}

/**
 * Integrity check: compares every balance with the sum of its ledger rows (and finds ledger stock with no balance
 * row). Read-only. An empty result means the projection agrees exactly with the ledger.
 */
export async function reconcileBalances(
  db: Prisma.TransactionClient | { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  organizationId: string,
): Promise<BalanceDrift[]> {
  const rows = await db.$queryRaw<
    { warehouse_id: string; product_id: string; balance: string | null; ledger: string | null }[]
  >`
    SELECT COALESCE(b.warehouse_id, m.warehouse_id)::text AS warehouse_id,
           COALESCE(b.product_id, m.product_id)::text AS product_id,
           b.quantity_on_hand::text AS balance,
           m.total::text AS ledger
    FROM (SELECT warehouse_id, product_id, quantity_on_hand FROM stock_balances WHERE organization_id = ${organizationId}::uuid) b
    FULL JOIN (SELECT warehouse_id, product_id, SUM(quantity_delta) AS total FROM stock_movements
               WHERE organization_id = ${organizationId}::uuid GROUP BY warehouse_id, product_id) m
      ON m.warehouse_id = b.warehouse_id AND m.product_id = b.product_id
    WHERE b.quantity_on_hand IS DISTINCT FROM m.total`;
  return rows.map((r) => ({
    warehouseId: r.warehouse_id,
    productId: r.product_id,
    balance: r.balance === null ? '(missing)' : canonicalQuantity(r.balance),
    ledger: r.ledger === null ? '0' : canonicalQuantity(r.ledger),
  }));
}
