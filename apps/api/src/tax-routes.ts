import {
  TaxConfigError,
  type TaxConfigContext,
  type TaxConfigService,
} from '@commercebill/tax-config';
import {
  ErrorCodes,
  type HsnPolicyView,
  type HsnSacListResponse,
  type HsnSacView,
  type TaxConfigurationResponse,
  type TaxReviewListResponse,
  type TaxReviewView,
} from '@commercebill/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from './auth-guard.js';
import { ApiHttpError } from './errors.js';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const hsnQuery = pageQuery.extend({
  search: z.string().trim().max(100).optional(),
  kind: z.enum(['HSN', 'SAC']).optional(),
  isActive: z.enum(['true', 'false']).optional(),
});
const BODY_LIMIT = 8 * 1024;
/** Field-level validation belongs to the tax-config service; the route only checks the envelope. */
const looseBody = z.record(z.string(), z.unknown());

const bad = (message: string, problems?: { field: string; rule: string }[]) =>
  new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, message, problems);
const notFound = () => new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Not found.');

/** Stable, value-free translation of service errors. Another organization's records are simply "not found". */
function mapError(err: unknown): never {
  if (err instanceof TaxConfigError) {
    switch (err.code) {
      case 'not_found':
        throw notFound();
      case 'validation_failed':
        throw bad(err.message, err.problems);
      case 'duplicate_code':
        throw new ApiHttpError(409, ErrorCodes.BUSINESS_RULE_VIOLATION, err.message, err.problems);
      case 'configuration_changed':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          'The tax configuration changed after it was shown. Reload and review it again. Nothing was recorded.',
          err.problems,
        );
      case 'production_not_eligible':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          'Production billing is not available: some requirements are not met.',
          err.problems,
        );
      case 'version_conflict':
        throw new ApiHttpError(
          409,
          ErrorCodes.DATABASE_CONFLICT,
          'This record was changed by someone else. Reload it and try again.',
        );
    }
  }
  throw err;
}

/** Identity and organization come from the validated session, never from the request. */
function ctx(req: FastifyRequest): TaxConfigContext {
  const a = req.auth!;
  return { userId: a.userId, organizationId: a.organizationId, correlationId: req.id };
}

const versionOf = (
  body: Record<string, unknown>,
): { version: number; rest: Record<string, unknown> } => {
  const { expectedVersion, ...rest } = body;
  if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1)
    throw bad('The entry version is required.', [{ field: 'expectedVersion', rule: 'required' }]);
  return { version: expectedVersion as number, rest };
};

/**
 * Tax configuration routes (Task 1.12, ADR-0023): launch secret (earlier hook), session authentication, exact keys
 * (tax.config.read / tax.config.update / tax.config.review) and organization scope from the session. Nothing here deletes
 * or edits a tax rate, category or review; reviews are append-only.
 */
export async function registerTaxRoutes(
  app: FastifyInstance,
  service: TaxConfigService,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    scope.get(
      '/tax/configuration',
      { preHandler: requirePermission('tax.config.read') },
      async (req): Promise<TaxConfigurationResponse> =>
        service.getConfiguration(req.auth!.organizationId),
    );

    scope.get(
      '/tax/configuration/reviews',
      { preHandler: requirePermission('tax.config.read') },
      async (req): Promise<TaxReviewListResponse> => {
        const q = pageQuery.safeParse(req.query);
        if (!q.success) throw bad('Invalid query.');
        return service.listReviews(req.auth!.organizationId, q.data);
      },
    );

    scope.post(
      '/tax/configuration/reviews',
      { preHandler: requirePermission('tax.config.review'), bodyLimit: BODY_LIMIT },
      async (req, reply) => {
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid review details.');
        try {
          const review: TaxReviewView = await service.review(ctx(req), body.data);
          return reply.code(201).send({ review });
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/tax/billing-mode',
      { preHandler: requirePermission('tax.config.review'), bodyLimit: BODY_LIMIT },
      async (req) => {
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid request.');
        try {
          return await service.setBillingMode(ctx(req), body.data.mode);
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.put(
      '/tax/hsn-requirement',
      { preHandler: requirePermission('tax.config.update'), bodyLimit: BODY_LIMIT },
      async (req): Promise<{ hsnPolicy: HsnPolicyView }> => {
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid request.');
        try {
          return { hsnPolicy: await service.setHsnPolicy(ctx(req), body.data) };
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.get(
      '/tax/hsn-sac',
      { preHandler: requirePermission('tax.config.read') },
      async (req): Promise<HsnSacListResponse> => {
        const q = hsnQuery.safeParse(req.query);
        if (!q.success) throw bad('Invalid query.');
        return service.listHsn(req.auth!.organizationId, {
          search: q.data.search,
          kind: q.data.kind,
          isActive: q.data.isActive === undefined ? undefined : q.data.isActive === 'true',
          limit: q.data.limit,
          offset: q.data.offset,
        });
      },
    );

    scope.post(
      '/tax/hsn-sac',
      { preHandler: requirePermission('tax.config.update'), bodyLimit: BODY_LIMIT },
      async (req, reply) => {
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid HSN/SAC details.');
        try {
          const entry: HsnSacView = await service.createHsn(ctx(req), body.data);
          return reply.code(201).send({ entry });
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.patch(
      '/tax/hsn-sac/:id',
      { preHandler: requirePermission('tax.config.update'), bodyLimit: BODY_LIMIT },
      async (req): Promise<{ entry: HsnSacView }> => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw notFound();
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid HSN/SAC details.');
        const { version, rest } = versionOf(body.data);
        try {
          return { entry: await service.updateHsn(ctx(req), p.data.id, rest, version) };
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/tax/hsn-sac/:id/review',
      { preHandler: requirePermission('tax.config.review'), bodyLimit: BODY_LIMIT },
      async (req): Promise<{ entry: HsnSacView }> => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw notFound();
        const body = looseBody.safeParse(req.body ?? {});
        if (!body.success) throw bad('Invalid request.');
        const { version } = versionOf(body.data);
        try {
          return { entry: await service.reviewHsn(ctx(req), p.data.id, version) };
        } catch (err) {
          return mapError(err);
        }
      },
    );
  });
}
