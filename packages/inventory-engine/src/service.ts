import type { Prisma, PrismaClient } from '@commercebill/database';
import type {
  StockListResponse,
  StockMovementListResponse,
  StockMovementView,
  StockOperationResponse,
  WarehouseView,
} from '@commercebill/shared-types';
import { postStockMovement, reconcileBalances, type MovementType } from './engine.js';
import { canonicalQuantity } from './quantity.js';
import { validateOperation, type Problem, type StockOperationKind } from './validate.js';

export type InventoryErrorCode = 'not_found' | 'validation_failed';

export class InventoryError extends Error {
  constructor(
    readonly code: InventoryErrorCode,
    message: string,
    readonly problems: Problem[] = [],
  ) {
    super(message);
    this.name = 'InventoryError';
  }
}

/** The authenticated caller. The organization ALWAYS comes from the session, never from a request. */
export interface InventoryContext {
  userId: string;
  organizationId: string;
  correlationId?: string | null;
}

export interface InventoryServiceOptions {
  prisma: PrismaClient;
  appVersion?: string;
  clock?: () => Date;
}

const AUDIT_ACTION: Record<StockOperationKind, string> = {
  OPENING_STOCK: 'inventory.opening_stock',
  STOCK_RECEIPT: 'inventory.receipt',
  ADJUSTMENT: 'inventory.adjustment',
};

const movementInclude = {
  product: { include: { unit: true } },
  warehouse: true,
  createdByUser: true,
} as const;
type MovementRow = Prisma.StockMovementGetPayload<{ include: typeof movementInclude }>;

const q4 = (d: { toFixed(dp: number): string }) => canonicalQuantity(d.toFixed(4));

export function toMovementView(r: MovementRow): StockMovementView {
  return {
    id: r.id,
    productId: r.productId,
    productSku: r.product.sku,
    productName: r.product.name,
    unit: { code: r.product.unit?.code ?? '', decimalPlaces: r.product.unit?.decimalPlaces ?? 0 },
    warehouseId: r.warehouseId,
    warehouseName: r.warehouse.name,
    movementType: r.movementType as StockMovementView['movementType'],
    quantityDelta: q4(r.quantityDelta),
    businessDate: r.businessDate.toISOString().slice(0, 10),
    reasonCode: r.reasonCode as StockMovementView['reasonCode'],
    reference: r.reference,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    createdByName: r.createdByUser.displayName,
  };
}

/** LIKE wildcards in typed text are literal characters. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => '\\' + ch);

export function createInventoryService(options: InventoryServiceOptions) {
  const { prisma } = options;
  const appVersion = options.appVersion ?? '0.0.0';
  const clock = options.clock ?? (() => new Date());

  async function warehouses(organizationId: string): Promise<WarehouseView[]> {
    const rows = await prisma.warehouse.findMany({
      where: { organizationId },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    });
    return rows.map((w) => ({
      id: w.id,
      code: w.code,
      name: w.name,
      isPrimary: w.isPrimary,
      isActive: w.isActive,
    }));
  }

  /** The warehouse a read is about: the requested one (must belong to the organization) or the primary one. */
  async function resolveWarehouse(organizationId: string, warehouseId?: string) {
    if (warehouseId) {
      const w = await prisma.warehouse.findFirst({ where: { id: warehouseId, organizationId } });
      if (!w) throw new InventoryError('not_found', 'Warehouse not found.');
      return w;
    }
    return prisma.warehouse.findFirst({
      where: { organizationId, isActive: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async function stock(
    organizationId: string,
    o: {
      search?: string | undefined;
      isActive?: boolean | undefined;
      warehouseId?: string | undefined;
      productId?: string | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<StockListResponse> {
    const warehouse = await resolveWarehouse(organizationId, o.warehouseId);
    if (!warehouse) {
      return { warehouse: null, stock: [], total: 0, limit: o.limit, offset: o.offset };
    }
    const term = o.search?.trim() ? escapeLike(o.search.trim()) : undefined;
    // Only tracked goods can have stock; services and untracked goods are never listed here.
    const where: Prisma.ProductWhereInput = {
      organizationId,
      kind: 'GOODS',
      trackInventory: true,
      ...(o.productId ? { id: o.productId } : {}),
      ...(o.isActive === undefined ? {} : { isActive: o.isActive }),
      ...(term
        ? {
            OR: [
              { sku: { contains: term, mode: 'insensitive' } },
              { name: { contains: term, mode: 'insensitive' } },
              { barcode: { contains: term } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          unit: true,
          stockBalances: { where: { warehouseId: warehouse.id } },
          stockMovements: { where: { warehouseId: warehouse.id }, select: { id: true }, take: 1 },
        },
        orderBy: [{ name: 'asc' }, { sku: 'asc' }],
        take: o.limit,
        skip: o.offset,
      }),
      prisma.product.count({ where }),
    ]);
    return {
      warehouse: { id: warehouse.id, code: warehouse.code, name: warehouse.name },
      stock: rows.map((p) => ({
        productId: p.id,
        sku: p.sku,
        name: p.name,
        isActive: p.isActive,
        unit: {
          code: p.unit?.code ?? '',
          name: p.unit?.name ?? '',
          decimalPlaces: p.unit?.decimalPlaces ?? 0,
        },
        onHand: p.stockBalances[0] ? q4(p.stockBalances[0].quantityOnHand) : '0',
        hasMovements: p.stockMovements.length > 0,
      })),
      total,
      limit: o.limit,
      offset: o.offset,
    };
  }

  async function movements(
    organizationId: string,
    o: {
      productId?: string | undefined;
      warehouseId?: string | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<StockMovementListResponse> {
    if (o.productId) {
      const p = await prisma.product.findFirst({
        where: { id: o.productId, organizationId },
        select: { id: true },
      });
      if (!p) throw new InventoryError('not_found', 'Product not found.');
    }
    if (o.warehouseId) await resolveWarehouse(organizationId, o.warehouseId);
    const where: Prisma.StockMovementWhereInput = {
      organizationId,
      ...(o.productId ? { productId: o.productId } : {}),
      ...(o.warehouseId ? { warehouseId: o.warehouseId } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        include: movementInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: o.limit,
        skip: o.offset,
      }),
      prisma.stockMovement.count({ where }),
    ]);
    return { movements: rows.map(toMovementView), total, limit: o.limit, offset: o.offset };
  }

  async function movement(organizationId: string, id: string): Promise<StockMovementView> {
    const row = await prisma.stockMovement.findFirst({
      where: { id, organizationId },
      include: movementInclude,
    });
    if (!row) throw new InventoryError('not_found', 'Stock movement not found.');
    return toMovementView(row);
  }

  /**
   * One manual stock operation = one transaction: validate, post the movement (which updates the balance), audit.
   * A retry with the same operationId and the same content changes nothing and writes no second audit row.
   */
  async function record(
    kind: StockOperationKind,
    ctx: InventoryContext,
    raw: Record<string, unknown>,
  ): Promise<StockOperationResponse> {
    // A stock event may be dated up to one day ahead of UTC so that a clock in the east (India) is never refused.
    const tomorrow = new Date(clock().getTime() + 86_400_000).toISOString().slice(0, 10);
    const checked = validateOperation(kind, raw, tomorrow);
    if (!checked.ok) {
      throw new InventoryError(
        'validation_failed',
        'The stock details are not valid.',
        checked.problems,
      );
    }
    const v = checked.value;
    const movementType: MovementType =
      kind === 'ADJUSTMENT'
        ? v.direction === 'INCREASE'
          ? 'ADJUSTMENT_INCREASE'
          : 'ADJUSTMENT_DECREASE'
        : kind;
    return prisma.$transaction(async (tx) => {
      const posted = await postStockMovement(tx, {
        organizationId: ctx.organizationId,
        warehouseId: v.warehouseId,
        productId: v.productId,
        movementType,
        quantity: v.quantity,
        businessDate: v.businessDate,
        source: { type: 'MANUAL', ref: v.operationId },
        createdBy: ctx.userId,
        reasonCode: v.reasonCode,
        reference: v.reference,
        note: v.note,
      });
      if (!posted.replayed) {
        // Facts only: ids, type, quantity, reason. Free text (reference, note) stays in the ledger row.
        await tx.auditLog.create({
          data: {
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            category: 'business',
            action: AUDIT_ACTION[kind],
            entityType: 'stock_movement',
            entityId: posted.id,
            afterValues: {
              productId: posted.productId,
              warehouseId: posted.warehouseId,
              movementType: posted.movementType,
              quantityDelta: posted.quantityDelta,
              businessDate: posted.businessDate,
              ...(posted.reasonCode ? { reasonCode: posted.reasonCode } : {}),
            },
            appVersion,
            correlationId: ctx.correlationId ?? null,
            occurredAt: clock(),
          },
        });
      }
      const row = await tx.stockMovement.findUniqueOrThrow({
        where: { id: posted.id },
        include: movementInclude,
      });
      return {
        movement: toMovementView(row),
        onHand: posted.balanceAfter,
        replayed: posted.replayed,
      };
    });
  }

  return {
    warehouses,
    stock,
    movements,
    movement,
    recordOpeningStock: (ctx: InventoryContext, raw: Record<string, unknown>) =>
      record('OPENING_STOCK', ctx, raw),
    recordReceipt: (ctx: InventoryContext, raw: Record<string, unknown>) =>
      record('STOCK_RECEIPT', ctx, raw),
    recordAdjustment: (ctx: InventoryContext, raw: Record<string, unknown>) =>
      record('ADJUSTMENT', ctx, raw),
    /** Integrity check of the balance projection against the ledger (empty = consistent). */
    reconcile: (organizationId: string) => reconcileBalances(prisma, organizationId),
  };
}

export type InventoryService = ReturnType<typeof createInventoryService>;
