import {
  BusinessProfileError,
  type BusinessProfileContext,
  type BusinessProfileService,
} from '@commercebill/setup';
import {
  ErrorCodes,
  type BusinessProfileSaveResponse,
  type BusinessProfileView,
} from '@commercebill/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from './auth-guard.js';
import { ApiHttpError } from './errors.js';

const BODY_LIMIT = 8 * 1024;
const looseBody = z.record(z.string(), z.unknown());

/** Stable, value-free translation of service errors. */
function mapError(err: unknown): never {
  if (err instanceof BusinessProfileError) {
    switch (err.code) {
      case 'not_found':
        throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Not found.');
      case 'validation_failed':
        throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, err.message, err.problems);
      case 'duplicate_location_name':
        throw new ApiHttpError(409, ErrorCodes.BUSINESS_RULE_VIOLATION, err.message, err.problems);
      case 'version_conflict':
        throw new ApiHttpError(
          409,
          ErrorCodes.DATABASE_CONFLICT,
          'The business profile was changed by someone else. Reload it and try again. Nothing was saved.',
        );
    }
  }
  throw err;
}

/** Identity and organization come from the validated session, never from the request. */
const ctx = (req: FastifyRequest): BusinessProfileContext => ({
  userId: req.auth!.userId,
  organizationId: req.auth!.organizationId,
  correlationId: req.id,
});

/**
 * Business Profile routes (ADR-0030): `org.settings.read` shows the profile (read-only for roles without the update key),
 * `org.settings.update` saves it. The organization is always the session's. The request body is never logged.
 */
export async function registerBusinessProfileRoutes(
  app: FastifyInstance,
  service: BusinessProfileService,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    scope.get(
      '/business-profile',
      { preHandler: requirePermission('org.settings.read') },
      async (req): Promise<BusinessProfileView> => {
        try {
          return await service.get(
            req.auth!.organizationId,
            req.auth!.permissions.has('org.settings.update'),
          );
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.put(
      '/business-profile',
      { preHandler: requirePermission('org.settings.update'), bodyLimit: BODY_LIMIT },
      async (req): Promise<BusinessProfileSaveResponse> => {
        const body = looseBody.safeParse(req.body);
        if (!body.success)
          throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid business profile.');
        try {
          return await service.save(ctx(req), body.data);
        } catch (err) {
          return mapError(err);
        }
      },
    );
  });
}
