import { ProductError, type ProductContext, type ProductService } from '@commercebill/products';
import {
  ErrorCodes,
  type HsnSacSearchResponse,
  type ProductListResponse,
  type ProductReferencesResponse,
  type ProductView,
} from '@commercebill/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from './auth-guard.js';
import { ApiHttpError } from './errors.js';

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  kind: z.enum(['GOODS', 'SERVICE']).optional(),
  tracked: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const hsnQuery = z.object({
  kind: z.enum(['HSN', 'SAC']).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const BODY_LIMIT = 32 * 1024;
/** Field-level validation belongs to the product service; the route only checks the envelope. */
const looseBody = z.record(z.string(), z.unknown());
const versionBody = z.object({ expectedVersion: z.int().min(1).optional() }).strict();

const bad = (message: string, problems?: { field: string; rule: string }[]) =>
  new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, message, problems);
const notFound = () => new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Product not found.');

/** Stable, value-free translation of service errors. Another organization's product is simply "not found". */
function mapError(err: unknown): never {
  if (err instanceof ProductError) {
    switch (err.code) {
      case 'not_found':
        throw notFound();
      case 'validation_failed':
        throw bad('The product details are not valid.', err.problems);
      case 'duplicate_sku':
      case 'duplicate_barcode':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          err.code === 'duplicate_sku'
            ? 'That SKU is already in use.'
            : 'Another product already uses this barcode.',
          err.problems,
        );
      case 'version_conflict':
        throw new ApiHttpError(
          409,
          ErrorCodes.DATABASE_CONFLICT,
          'This product was changed by someone else. Reload it and try again.',
        );
    }
  }
  throw err;
}

/** Identity and organization come from the validated session, never from the request. */
function ctx(req: FastifyRequest): ProductContext {
  const a = req.auth!;
  return { userId: a.userId, organizationId: a.organizationId, correlationId: req.id };
}

/**
 * Product master routes (Task 1.10, ADR-0021). Normal business routes: launch secret (earlier hook), session
 * authentication, exact permission keys (product.read / product.write) and organization scope from the session.
 * There is deliberately no DELETE: products are made inactive. Prices travel as decimal strings.
 */
export async function registerProductRoutes(
  app: FastifyInstance,
  service: ProductService,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    scope.get(
      '/products',
      { preHandler: requirePermission('product.read') },
      async (req): Promise<ProductListResponse> => {
        const q = listQuery.safeParse(req.query);
        if (!q.success) throw bad('Invalid query.');
        const { products, total } = await service.list(req.auth!.organizationId, {
          search: q.data.search,
          isActive: q.data.isActive === undefined ? undefined : q.data.isActive === 'true',
          kind: q.data.kind,
          trackInventory: q.data.tracked === undefined ? undefined : q.data.tracked === 'true',
          limit: q.data.limit,
          offset: q.data.offset,
        });
        return { products, total, limit: q.data.limit, offset: q.data.offset };
      },
    );

    // Reference lists for the product form (static paths: matched before /products/:id).
    scope.get(
      '/products/references',
      { preHandler: requirePermission('product.read') },
      async (req): Promise<ProductReferencesResponse> =>
        service.references(req.auth!.organizationId),
    );

    scope.get(
      '/products/references/hsn-sac',
      { preHandler: requirePermission('product.read') },
      async (req): Promise<HsnSacSearchResponse> => {
        const q = hsnQuery.safeParse(req.query);
        if (!q.success) throw bad('Invalid query.');
        return service.searchHsn(q.data);
      },
    );

    scope.get(
      '/products/:id',
      { preHandler: requirePermission('product.read') },
      async (req): Promise<{ product: ProductView }> => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw notFound();
        try {
          return { product: await service.get(req.auth!.organizationId, p.data.id) };
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/products',
      { preHandler: requirePermission('product.write'), bodyLimit: BODY_LIMIT },
      async (req, reply) => {
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid product details.');
        try {
          const product = await service.create(ctx(req), body.data);
          return reply.code(201).send({ product });
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.patch(
      '/products/:id',
      { preHandler: requirePermission('product.write'), bodyLimit: BODY_LIMIT },
      async (req): Promise<{ product: ProductView }> => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw notFound();
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid product details.');
        const { expectedVersion, ...changes } = body.data;
        if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
          throw bad('The product version is required.', [
            { field: 'expectedVersion', rule: 'required' },
          ]);
        }
        try {
          return {
            product: await service.update(ctx(req), p.data.id, changes, expectedVersion as number),
          };
        } catch (err) {
          return mapError(err);
        }
      },
    );

    for (const [action, active] of [
      ['activate', true],
      ['deactivate', false],
    ] as const) {
      scope.post(
        `/products/:id/${action}`,
        { preHandler: requirePermission('product.write'), bodyLimit: BODY_LIMIT },
        async (req): Promise<{ product: ProductView }> => {
          const p = idParams.safeParse(req.params);
          if (!p.success) throw notFound();
          const body = versionBody.safeParse(req.body ?? {});
          if (!body.success) throw bad('Invalid request.');
          try {
            return {
              product: await service.setActive(
                ctx(req),
                p.data.id,
                active,
                body.data.expectedVersion,
              ),
            };
          } catch (err) {
            return mapError(err);
          }
        },
      );
    }
  });
}
