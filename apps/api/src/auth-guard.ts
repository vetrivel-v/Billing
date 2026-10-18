import type { AuthContext, AuthService } from '@commercebill/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  forbidden,
  passwordChangeRequired,
  serviceUnavailable,
  unauthenticated,
} from './errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Present when the API was started with a database. */
    authService?: AuthService;
  }
  interface FastifyRequest {
    /** Set by requireAuthenticatedUser / requirePermission. Never trust client-supplied identity. */
    auth?: AuthContext;
  }
}

/** Routes usable while a password change is pending (ADR-0017). Everything else answers 403 AUTH_0004. */
const PENDING_CHANGE_ALLOWED: ReadonlySet<string> = new Set([
  '/auth/me',
  '/auth/change-password',
  '/auth/logout',
]);

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/i;

/** Session tokens travel only in the Authorization header - never in a URL or body. */
export function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  return BEARER.exec(header)?.[1];
}

/**
 * 401 unless the request carries a valid, unexpired, unrevoked session of an active user. The service
 * validates everything server-side; the reason for rejection is never revealed.
 */
export async function requireAuthenticatedUser(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const service = req.server.authService;
  if (!service) throw serviceUnavailable();
  const context = await service.authenticateToken(bearerToken(req));
  if (!context) throw unauthenticated();
  req.auth = context;
  // A user still on an administrator-supplied temporary password may do nothing but change it (or look/leave).
  if (context.mustChangePassword && !PENDING_CHANGE_ALLOWED.has(req.routeOptions.url ?? '')) {
    throw passwordChangeRequired();
  }
}

/**
 * Authorization by stable permission key, resolved from the caller's roles in the database on every
 * request. 401 if not authenticated, 403 if authenticated without the permission. There is no
 * administrator bypass: an unknown key is denied to everyone, including the Administrator role.
 */
export function requirePermission(permissionKey: string) {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/.test(permissionKey)) {
    throw new Error(`Invalid permission key "${permissionKey}"`);
  }
  return async function permissionGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuthenticatedUser(req, reply);
    const auth = req.auth!;
    if (!auth.permissions.has(permissionKey)) {
      // Security log only (no response detail): who tried what.
      req.log.warn({ userId: auth.userId, permission: permissionKey }, 'permission denied');
      throw forbidden();
    }
  };
}
