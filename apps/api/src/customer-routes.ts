import { CustomerError, type CustomerContext, type CustomerService } from '@commercebill/customers';
import {
  ErrorCodes,
  type CustomerListResponse,
  type CustomerView,
} from '@commercebill/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from './auth-guard.js';
import { ApiHttpError } from './errors.js';

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  kind: z.enum(['INDIVIDUAL', 'BUSINESS']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const BODY_LIMIT = 32 * 1024;
/** Field-level validation belongs to the customer service; the route only checks the envelope. */
const looseBody = z.record(z.string(), z.unknown());
const versionBody = z.object({ expectedVersion: z.int().min(1).optional() }).strict();

const bad = (message: string, problems?: { field: string; rule: string }[]) =>
  new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, message, problems);
const notFound = () => new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Customer not found.');

/** Stable, value-free translation of service errors. Another organization's customer is simply "not found". */
function mapError(err: unknown): never {
  if (err instanceof CustomerError) {
    switch (err.code) {
      case 'not_found':
        throw notFound();
      case 'validation_failed':
        throw bad('The customer details are not valid.', err.problems);
      case 'duplicate_code':
      case 'duplicate_gstin':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          err.code === 'duplicate_code'
            ? 'That customer code is already in use.'
            : 'Another customer already uses this GSTIN.',
          err.problems,
        );
      case 'version_conflict':
        throw new ApiHttpError(
          409,
          ErrorCodes.DATABASE_CONFLICT,
          'This customer was changed by someone else. Reload it and try again.',
        );
    }
  }
  throw err;
}

/** Identity and organization come from the validated session, never from the request. */
function ctx(req: FastifyRequest): CustomerContext {
  const a = req.auth!;
  return { userId: a.userId, organizationId: a.organizationId, correlationId: req.id };
}

/**
 * Customer master routes (Task 1.9, ADR-0020). Normal business routes: launch secret (earlier hook), session
 * authentication, exact permission keys (customer.read / customer.write) and organization scope from the session.
 * There is deliberately no DELETE: customers are made inactive.
 */
export async function registerCustomerRoutes(
  app: FastifyInstance,
  service: CustomerService,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    scope.get(
      '/customers',
      { preHandler: requirePermission('customer.read') },
      async (req): Promise<CustomerListResponse> => {
        const q = listQuery.safeParse(req.query);
        if (!q.success) throw bad('Invalid query.');
        const { customers, total } = await service.list(req.auth!.organizationId, {
          search: q.data.search,
          isActive: q.data.isActive === undefined ? undefined : q.data.isActive === 'true',
          customerKind: q.data.kind,
          limit: q.data.limit,
          offset: q.data.offset,
        });
        return { customers, total, limit: q.data.limit, offset: q.data.offset };
      },
    );

    scope.get(
      '/customers/:id',
      { preHandler: requirePermission('customer.read') },
      async (req): Promise<{ customer: CustomerView }> => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw notFound();
        try {
          return { customer: await service.get(req.auth!.organizationId, p.data.id) };
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/customers',
      { preHandler: requirePermission('customer.write'), bodyLimit: BODY_LIMIT },
      async (req, reply) => {
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid customer details.');
        try {
          const customer = await service.create(ctx(req), body.data);
          return reply.code(201).send({ customer });
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.patch(
      '/customers/:id',
      { preHandler: requirePermission('customer.write'), bodyLimit: BODY_LIMIT },
      async (req): Promise<{ customer: CustomerView }> => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw notFound();
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid customer details.');
        const { expectedVersion, ...changes } = body.data;
        if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
          throw bad('The customer version is required.', [
            { field: 'expectedVersion', rule: 'required' },
          ]);
        }
        try {
          return {
            customer: await service.update(ctx(req), p.data.id, changes, expectedVersion as number),
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
        `/customers/:id/${action}`,
        { preHandler: requirePermission('customer.write'), bodyLimit: BODY_LIMIT },
        async (req): Promise<{ customer: CustomerView }> => {
          const p = idParams.safeParse(req.params);
          if (!p.success) throw notFound();
          const body = versionBody.safeParse(req.body ?? {});
          if (!body.success) throw bad('Invalid request.');
          try {
            return {
              customer: await service.setActive(
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
