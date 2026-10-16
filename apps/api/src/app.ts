import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { pingDatabase, type PrismaClient } from '@commercebill/database';
import {
  APP_VERSION,
  ErrorCodes,
  type ApiErrorBody,
  type DatabaseHealthResponse,
  type HealthResponse,
} from '@commercebill/shared-types';
import type { AppEnv } from '@commercebill/validation';

export interface AppDeps {
  env: Pick<AppEnv, 'LOG_LEVEL' | 'WEB_ORIGIN'>;
  /** Optional: when absent, /health/db reports the database as down. */
  prisma?: PrismaClient | undefined;
}

/** Fields that must never reach logs (spec sections 33 and 53). */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
  '*.apiKey',
];

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.env.LOG_LEVEL,
      redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
    },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: deps.env.WEB_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  // Coarse global limiter; stricter per-route limits (e.g. login) arrive in Phase 1.
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-correlation-id', req.id);
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ApiErrorBody = {
      error: {
        code: ErrorCodes.NOT_FOUND,
        message: 'The requested resource was not found.',
        dataSaved: false,
        correlationId: req.id,
      },
    };
    void reply.code(404).send(body);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    // Full detail goes to the server log only; clients get a stable code and correlation ID.
    req.log.error({ err }, 'request failed');
    const code =
      status === 429
        ? ErrorCodes.RATE_LIMITED
        : status < 500
          ? ErrorCodes.VALIDATION_FAILED
          : ErrorCodes.INTERNAL;
    const body: ApiErrorBody = {
      error: {
        code,
        message:
          status === 429
            ? 'Too many requests. Please wait and try again.'
            : status < 500
              ? 'The request was not valid.'
              : 'An unexpected error occurred. No data was changed.',
        dataSaved: false,
        correlationId: req.id,
      },
    };
    void reply.code(status).send(body);
  });

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'commercebill-api',
    version: APP_VERSION,
    time: new Date().toISOString(),
  }));

  app.get('/health/db', async (_req, reply): Promise<DatabaseHealthResponse> => {
    const up = deps.prisma ? await pingDatabase(deps.prisma) : false;
    if (!up) void reply.code(503);
    return {
      status: up ? 'ok' : 'degraded',
      service: 'commercebill-api',
      version: APP_VERSION,
      time: new Date().toISOString(),
      database: { status: up ? 'ok' : 'down' },
    };
  });

  return app;
}
