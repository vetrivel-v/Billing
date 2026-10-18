import { AuthServiceError, type AdminContext, type UserView } from '@commercebill/auth';
import { ErrorCodes } from '@commercebill/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from './auth-guard.js';
import { ApiHttpError, forbidden, serviceUnavailable, unauthenticated } from './errors.js';
import type { LoginRateLimit } from './auth-routes.js';

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  isActive: z.enum(['true', 'false']).optional(),
});
const createBody = z.strictObject({
  username: z.string().min(1).max(128),
  displayName: z.string().trim().min(1).max(200),
  email: z.string().trim().max(254).nullable().optional(),
  password: z.string().min(1).max(1024),
  roleIds: z.array(z.uuid()).max(50).optional(),
});
const rolesBody = z.strictObject({ roleIds: z.array(z.uuid()).max(50) });
const resetBody = z.strictObject({ temporaryPassword: z.string().min(1).max(1024) });

const bad = (message: string, problems?: { field: string; rule: string }[]) =>
  new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, message, problems);
const notFound = () => new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Not found.');
const conflict = (message: string) =>
  new ApiHttpError(409, ErrorCodes.BUSINESS_RULE_VIOLATION, message);

/** Stable, value-free translation of service errors. Unknown and cross-organization targets look identical. */
function mapError(err: unknown): never {
  if (err instanceof AuthServiceError) {
    switch (err.code) {
      case 'unknown_user':
        throw notFound();
      case 'unknown_role':
        throw bad('One or more roles are not valid.', [{ field: 'roleIds', rule: 'unknown_role' }]);
      case 'role_exceeds_caller_privileges':
      case 'cannot_change_own_roles':
      case 'target_exceeds_caller_privileges':
      case 'actor_forbidden':
        throw forbidden();
      case 'actor_inactive':
        throw unauthenticated();
      case 'cannot_disable_self':
        throw conflict('You cannot disable your own account.');
      case 'cannot_reset_self':
        throw conflict('Use change password to change your own password.');
      case 'last_administrator':
        throw conflict('The organization must keep at least one active administrator.');
      case 'duplicate_username':
        throw conflict('That username is already in use.');
      case 'invalid_username':
        throw bad('The username is not valid.', [{ field: 'username', rule: 'invalid_username' }]);
      case 'weak_password':
        throw bad(
          'The password does not meet the policy.',
          err.problems.map((rule) => ({ field: 'password', rule })),
        );
      default:
        break;
    }
  }
  throw err;
}

function present(u: UserView) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
    roles: u.roles,
  };
}

/** Identity and organization come from the validated session, never from the request. */
function ctx(req: FastifyRequest): AdminContext {
  const a = req.auth!;
  return { userId: a.userId, organizationId: a.organizationId, correlationId: req.id };
}

/** Task 1.6 routes 3-10 (ADR-0017). All are behind the launch-secret hook and the permission guards. */
export async function registerUserRoutes(
  app: FastifyInstance,
  options: { resetPasswordRateLimit?: LoginRateLimit } = {},
): Promise<void> {
  const svc = () => {
    if (!app.authService) throw serviceUnavailable();
    return app.authService;
  };
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    scope.get('/roles', { preHandler: requirePermission('security.role.read') }, async (req) => ({
      roles: await svc().listRoles(req.auth!.organizationId),
    }));

    scope.get('/users', { preHandler: requirePermission('security.user.read') }, async (req) => {
      const q = listQuery.safeParse(req.query);
      if (!q.success) throw bad('Invalid query.');
      const { users, total } = await svc().listUsers(req.auth!.organizationId, {
        limit: q.data.limit,
        offset: q.data.offset,
        ...(q.data.isActive === undefined ? {} : { isActive: q.data.isActive === 'true' }),
      });
      return { users: users.map(present), total, limit: q.data.limit, offset: q.data.offset };
    });

    scope.get(
      '/users/:id',
      { preHandler: requirePermission('security.user.read') },
      async (req) => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw notFound();
        const user = await svc().getUser(req.auth!.organizationId, p.data.id);
        if (!user) throw notFound();
        return { user: present(user) };
      },
    );

    // The route needs security.user.manage; non-empty roleIds additionally need security.role.manage, which the
    // service re-checks inside its transaction (so the rule cannot be bypassed by a stale permission snapshot).
    scope.post(
      '/users',
      { preHandler: requirePermission('security.user.manage') },
      async (req, reply) => {
        const b = createBody.safeParse(req.body);
        if (!b.success) throw bad('Invalid user details.');
        if (
          (b.data.roleIds?.length ?? 0) > 0 &&
          !req.auth!.permissions.has('security.role.manage')
        ) {
          throw forbidden();
        }
        try {
          const user = await svc().adminCreateUser(ctx(req), {
            username: b.data.username,
            displayName: b.data.displayName,
            email: b.data.email ?? null,
            password: b.data.password,
            ...(b.data.roleIds ? { roleIds: b.data.roleIds } : {}),
          });
          return reply.code(201).send({ user: present(user) });
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/users/:id/disable',
      { preHandler: requirePermission('security.user.manage') },
      async (req) => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw notFound();
        try {
          const r = await svc().adminDisableUser(ctx(req), p.data.id);
          return { user: present(r.user) };
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/users/:id/enable',
      { preHandler: requirePermission('security.user.manage') },
      async (req) => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw notFound();
        try {
          const r = await svc().adminEnableUser(ctx(req), p.data.id);
          return { user: present(r.user) };
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.put(
      '/users/:id/roles',
      { preHandler: requirePermission('security.role.manage') },
      async (req) => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw notFound();
        const b = rolesBody.safeParse(req.body);
        if (!b.success) throw bad('Invalid role list.', [{ field: 'roleIds', rule: 'invalid' }]);
        try {
          return {
            user: present(await svc().adminSetUserRoles(ctx(req), p.data.id, b.data.roleIds)),
          };
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/users/:id/reset-password',
      {
        preHandler: requirePermission('security.user.reset_password'),
        config: {
          rateLimit: {
            max: options.resetPasswordRateLimit?.max ?? 10,
            timeWindow: options.resetPasswordRateLimit?.timeWindowMs ?? 60_000,
          },
        },
      },
      async (req, reply) => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw notFound();
        const b = resetBody.safeParse(req.body);
        if (!b.success) throw bad('Enter a temporary password.');
        try {
          await svc().adminResetPassword(ctx(req), p.data.id, b.data.temporaryPassword);
        } catch (err) {
          return mapError(err);
        }
        return reply.code(204).send();
      },
    );
  });
}
