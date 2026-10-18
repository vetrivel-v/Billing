import {
  ErrorCodes,
  type SetupCompleteResponse,
  type SetupStatusResponse,
} from '@commercebill/shared-types';
import { SetupError, type SetupService } from '@commercebill/setup';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiHttpError } from './errors.js';
import type { LoginRateLimit } from './auth-routes.js';

/**
 * BOOTSTRAP ROUTES (Task 1.4, ADR-0015). These are the only business-initialisation routes that run WITHOUT
 * user authentication or permission checks, because no user can exist before setup completes. They are an
 * explicit, temporary exception - NOT a pattern. Every normal business route added later MUST use
 * requireAuthenticatedUser and requirePermission (ADR-0014).
 *
 * Controls instead of user auth: (1) the Electron launch secret (global hook, no exemption); (2) the
 * database-authoritative "setup incomplete" precondition, re-checked under an advisory lock; (3) per-route
 * rate limits and body-size limits; (4) generic errors that never echo submitted values.
 */
const BODY_LIMIT = 32 * 1024;

const draftEnvelope = z.strictObject({
  data: z.unknown(),
  expectedVersion: z.int().min(0).optional(),
});

function toApiError(err: unknown): never {
  if (err instanceof SetupError) {
    switch (err.code) {
      case 'already_completed':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          'Setup has already been completed.',
        );
      case 'draft_conflict':
        throw new ApiHttpError(
          409,
          ErrorCodes.DATABASE_CONFLICT,
          'The saved draft was changed elsewhere. Reload it and try again.',
        );
      case 'validation_failed':
        throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, err.message, err.problems);
    }
  }
  throw err;
}

export interface SetupRateLimits {
  complete: LoginRateLimit;
  draft: LoginRateLimit;
}

export async function registerSetupRoutes(
  app: FastifyInstance,
  service: SetupService,
  limits: SetupRateLimits,
): Promise<void> {
  const rl = (l: LoginRateLimit) => ({ rateLimit: { max: l.max, timeWindow: l.timeWindowMs } });

  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    // Minimum state for the UI to decide "setup required / resumable". Nothing else is returned.
    scope.get('/setup/status', async (): Promise<SetupStatusResponse> => service.getStatus());

    scope.get('/setup/draft', async () => {
      try {
        return await service.getDraft();
      } catch (err) {
        return toApiError(err);
      }
    });

    scope.put('/setup/draft', { bodyLimit: BODY_LIMIT, config: rl(limits.draft) }, async (req) => {
      const envelope = draftEnvelope.safeParse(req.body);
      if (!envelope.success) {
        throw new ApiHttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'The draft request is not valid.',
        );
      }
      try {
        return await service.saveDraft(envelope.data.data, envelope.data.expectedVersion ?? 0);
      } catch (err) {
        return toApiError(err);
      }
    });

    scope.post(
      '/setup/complete',
      { bodyLimit: BODY_LIMIT, config: rl(limits.complete) },
      async (req, reply): Promise<SetupCompleteResponse> => {
        try {
          const result = await service.complete(req.body, { correlationId: req.id });
          void reply.code(201);
          // No token and no session: the administrator signs in through POST /auth/login.
          return {
            organizationId: result.organizationId,
            administratorUsername: result.administratorUsername,
            nextStep: 'login',
          };
        } catch (err) {
          return toApiError(err);
        }
      },
    );
  });
}
