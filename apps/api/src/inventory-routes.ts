import {
  InventoryError,
  StockError,
  type InventoryContext,
  type InventoryService,
} from '@commercebill/inventory-engine';
import {
  ErrorCodes,
  type StockListResponse,
  type StockMovementListResponse,
  type StockMovementView,
  type StockOperationResponse,
  type WarehouseView,
} from '@commercebill/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from './auth-guard.js';
import { ApiHttpError } from './errors.js';

const idParams = z.object({ id: z.uuid() });
const stockQuery = z.object({
  search: z.string().trim().max(100).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  warehouseId: z.uuid().optional(),
  productId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const movementQuery = z.object({
  productId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const BODY_LIMIT = 8 * 1024;
/** Field-level validation belongs to the inventory service; the route only checks the envelope. */
const looseBody = z.record(z.string(), z.unknown());

const bad = (message: string, problems?: { field: string; rule: string }[]) =>
  new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, message, problems);

/**
 * Stable, value-free translation of service errors. Another organization's product or warehouse is reported exactly
 * like an unknown one.
 */
function mapError(err: unknown): never {
  if (err instanceof InventoryError) {
    if (err.code === 'not_found') {
      throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, err.message);
    }
    throw bad('The stock details are not valid.', err.problems);
  }
  if (err instanceof StockError) {
    switch (err.code) {
      case 'unknown_reference':
      case 'inventory_not_tracked':
      case 'invalid_quantity':
        throw bad('The stock details are not valid.', err.problems);
      case 'insufficient_stock':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          'There is not enough stock for this change. Nothing was recorded.',
          err.problems,
        );
      case 'opening_stock_exists':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          'Opening stock has already been recorded for this product. Use a stock adjustment instead.',
          err.problems,
        );
      case 'operation_id_reused':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          'This operation id was already used for a different stock change.',
          err.problems,
        );
    }
  }
  throw err;
}

/** Identity and organization come from the validated session, never from the request. */
function ctx(req: FastifyRequest): InventoryContext {
  const a = req.auth!;
  return { userId: a.userId, organizationId: a.organizationId, correlationId: req.id };
}

/**
 * Inventory routes (Task 1.11, ADR-0022). Launch secret (earlier hook), session authentication, exact permission keys
 * and organization scope from the session. There is deliberately NO update or delete of a movement: the ledger is
 * append-only and a correction is a new opposite movement. Quantities travel as decimal strings.
 */
export async function registerInventoryRoutes(
  app: FastifyInstance,
  service: InventoryService,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    scope.get(
      '/warehouses',
      { preHandler: requirePermission('warehouse.read') },
      async (req): Promise<{ warehouses: WarehouseView[] }> => ({
        warehouses: await service.warehouses(req.auth!.organizationId),
      }),
    );

    scope.get(
      '/inventory/stock',
      { preHandler: requirePermission('inventory.stock.read') },
      async (req): Promise<StockListResponse> => {
        const q = stockQuery.safeParse(req.query);
        if (!q.success) throw bad('Invalid query.');
        try {
          return await service.stock(req.auth!.organizationId, {
            search: q.data.search,
            isActive: q.data.isActive === undefined ? undefined : q.data.isActive === 'true',
            warehouseId: q.data.warehouseId,
            productId: q.data.productId,
            limit: q.data.limit,
            offset: q.data.offset,
          });
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.get(
      '/inventory/movements',
      { preHandler: requirePermission('inventory.stock.read') },
      async (req): Promise<StockMovementListResponse> => {
        const q = movementQuery.safeParse(req.query);
        if (!q.success) throw bad('Invalid query.');
        try {
          return await service.movements(req.auth!.organizationId, q.data);
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.get(
      '/inventory/movements/:id',
      { preHandler: requirePermission('inventory.stock.read') },
      async (req): Promise<{ movement: StockMovementView }> => {
        const p = idParams.safeParse(req.params);
        if (!p.success)
          throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Stock movement not found.');
        try {
          return { movement: await service.movement(req.auth!.organizationId, p.data.id) };
        } catch (err) {
          return mapError(err);
        }
      },
    );

    const operations = [
      ['/inventory/opening-stock', 'recordOpeningStock'],
      ['/inventory/receipts', 'recordReceipt'],
      ['/inventory/adjustments', 'recordAdjustment'],
    ] as const;
    for (const [path, method] of operations) {
      scope.post(
        path,
        { preHandler: requirePermission('inventory.adjustment.create'), bodyLimit: BODY_LIMIT },
        async (req, reply) => {
          const body = looseBody.safeParse(req.body);
          if (!body.success) throw bad('Invalid stock details.');
          try {
            const result: StockOperationResponse = await service[method](ctx(req), body.data);
            // 201: a new movement was recorded. 200: this exact operation had already been recorded (nothing changed).
            return reply.code(result.replayed ? 200 : 201).send(result);
          } catch (err) {
            return mapError(err);
          }
        },
      );
    }
  });
}
