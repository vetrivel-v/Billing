import { ErrorCodes, type LoginResponse, type MeResponse } from '@commercebill/shared-types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuthenticatedUser } from './auth-guard.js';
import { ApiHttpError, serviceUnavailable } from './errors.js';

const loginBody = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
  organizationId: z.uuid().optional(),
});

export interface LoginRateLimit {
  max: number;
  timeWindowMs: number;
}

/** Generic by design: identical for unknown user, wrong password, locked and disabled accounts. */
const LOGIN_FAILED = 'Sign-in failed. Check your username and password.';

/**
 * Registers /auth/login, /auth/logout, /auth/me. All sit behind the launch-secret hook (a separate,
 * earlier control); user authentication below is independent of it.
 */
export async function registerAuthRoutes(
  app: FastifyInstance,
  options: { loginRateLimit: LoginRateLimit },
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    scope.post(
      '/auth/login',
      {
        config: {
          // Coarse per-route limiter (all local clients share one IP); the real brute-force control is
          // the per-account lockout in the service.
          rateLimit: {
            max: options.loginRateLimit.max,
            timeWindow: options.loginRateLimit.timeWindowMs,
          },
        },
      },
      async (req, reply): Promise<LoginResponse> => {
        const service = app.authService;
        if (!service) throw serviceUnavailable();
        const parsed = loginBody.safeParse(req.body);
        if (!parsed.success) {
          throw new ApiHttpError(
            400,
            ErrorCodes.VALIDATION_FAILED,
            'Enter a username and password.',
          );
        }
        const result = await service.login({ ...parsed.data, correlationId: req.id });
        if (!result.ok) {
          throw new ApiHttpError(401, ErrorCodes.UNAUTHENTICATED, LOGIN_FAILED);
        }
        void reply.code(200);
        return {
          token: result.token,
          expiresAt: result.expiresAt.toISOString(),
          idleTimeoutSeconds: result.idleTimeoutSeconds,
          mustChangePassword: result.mustChangePassword,
          user: {
            id: result.user.id,
            username: result.user.username,
            displayName: result.user.displayName,
            organizationId: result.user.organizationId,
          },
        };
      },
    );

    scope.post('/auth/logout', { preHandler: requireAuthenticatedUser }, async (req, reply) => {
      await app.authService!.logout(req.auth!, { userId: req.auth!.userId, correlationId: req.id });
      return reply.code(204).send();
    });

    scope.get(
      '/auth/me',
      { preHandler: requireAuthenticatedUser },
      async (req): Promise<MeResponse> => {
        const a = req.auth!;
        return {
          user: {
            id: a.userId,
            username: a.username,
            displayName: a.displayName,
            organizationId: a.organizationId,
          },
          permissions: [...a.permissions].sort(),
          mustChangePassword: a.mustChangePassword,
          sessionExpiresAt: a.sessionExpiresAt.toISOString(),
          idleTimeoutSeconds: app.authService!.config.session.idleMinutes * 60,
        };
      },
    );
  });
}
