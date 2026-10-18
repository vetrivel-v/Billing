import type { AuthContext, AuthService } from '@commercebill/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, serviceUnavailable, unauthenticated } from './errors.js';

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
