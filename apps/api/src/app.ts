import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { createAuthService, type HasherLike, type PartialAuthConfig } from '@commercebill/auth';
import { pingDatabase, type PrismaClient } from '@commercebill/database';
import { createSetupService, type SetupHooks } from '@commercebill/setup';
import {
  APP_VERSION,
  ErrorCodes,
  type ApiErrorBody,
  type DatabaseHealthResponse,
  type HealthResponse,
} from '@commercebill/shared-types';
import type { AppEnv } from '@commercebill/validation';
import { registerAuthRoutes, type LoginRateLimit } from './auth-routes.js';
import { registerUserRoutes } from './user-routes.js';
import { registerCustomerRoutes } from './customer-routes.js';
import { registerInventoryRoutes } from './inventory-routes.js';
import { registerInvoiceRoutes } from './invoice-routes.js';
import { registerPaymentRoutes } from './payment-routes.js';
import { registerProductRoutes } from './product-routes.js';
import { registerTaxRoutes } from './tax-routes.js';
import { createInventoryService } from '@commercebill/inventory-engine';
import { createProductService } from '@commercebill/products';
import { createTaxConfigService } from '@commercebill/tax-config';
import { createInvoiceService } from '@commercebill/invoicing';
import { createPaymentService } from '@commercebill/payments';
import { createNumberingService } from '@commercebill/numbering';
import { createCustomerService } from '@commercebill/customers';
import { registerSetupRoutes } from './setup-routes.js';
import { ApiHttpError } from './errors.js';
import { LAUNCH_SECRET_HEADER, isExemptPath, launchSecretMatches } from './launch-secret.js';

export interface AppDeps {
  env: Pick<AppEnv, 'LOG_LEVEL' | 'WEB_ORIGIN'>;
  /** Optional: when absent, /health/db reports the database as down. */
  prisma?: PrismaClient | undefined;
  /**
   * Per-launch shared secret between the Electron shell and the API (ADR-0010, risk R-032).
   * When set, every route except liveness requires the ${LAUNCH_SECRET_HEADER} header.
   */
  launchSecret?: string | undefined;
  /** User authentication settings (ADR-0014). Defaults are secure; tests may override. */
  auth?: {
    config?: PartialAuthConfig;
    hasher?: HasherLike;
    clock?: () => Date;
    allowWeakHashingForTests?: boolean;
  };
  /**
   * Whether a verified backup AND restore exists for an organization (the production-gate fact that Task 1.17 will provide).
   * Absent = false, so production billing is refused. Tests inject a value to exercise the production paths in isolation.
   */
  backupRestoreVerified?: ((organizationId: string) => Promise<boolean>) | undefined;
  /** Global request limiter. Default 300 requests per minute. */
  globalRateLimit?: LoginRateLimit;
  /** Per-route limit for POST /auth/login. Default 10 requests per minute. */
  loginRateLimit?: LoginRateLimit;
  /** Per-route limits: POST /auth/change-password (default 5/min) and the admin password reset (default 10/min). */
  changePasswordRateLimit?: LoginRateLimit;
  resetPasswordRateLimit?: LoginRateLimit;
  /** First-run setup (ADR-0015). Rate limits default to 5/min for completion and 60/min for draft saves. */
  setup?: {
    completeRateLimit?: LoginRateLimit;
    draftRateLimit?: LoginRateLimit;
    /** Test hook: fail part-way through completion to prove rollback. */
    hooks?: SetupHooks;
  };
  /** Test hook: capture structured logs. */
  logStream?: { write(msg: string): void } | undefined;
}

/** Fields that must never reach logs (spec sections 33 and 53). */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["x-commercebill-launch-secret"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
  '*.apiKey',
  'req.headers["x-commercebill-launch-secret"]',
];

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.env.LOG_LEVEL,
      redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
      serializers: {
        // Query strings can carry personal data (customer search by phone, e-mail or GSTIN): log the path only.
        req(req) {
          const url = req.url ?? '';
          const q = url.indexOf('?');
          return {
            method: req.method,
            url: q >= 0 ? `${url.slice(0, q)}?[query redacted]` : url,
            host: req.host,
            remoteAddress: req.ip,
          };
        },
      },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
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
  await app.register(rateLimit, {
    max: deps.globalRateLimit?.max ?? 300,
    timeWindow: deps.globalRateLimit?.timeWindowMs ?? 60_000,
  });

  const launchSecret = deps.launchSecret;
  if (launchSecret) {
    app.addHook('onRequest', async (req, reply) => {
      if (isExemptPath(req.url)) return;
      if (launchSecretMatches(launchSecret, req.headers[LAUNCH_SECRET_HEADER])) return;
      const body: ApiErrorBody = {
        error: {
          code: ErrorCodes.UNAUTHENTICATED,
          message: 'This request was not authorised.',
          dataSaved: false,
          correlationId: req.id,
        },
      };
      return reply.code(401).send(body);
    });
  }

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
    if (err instanceof ApiHttpError) {
      // Expected, application-decided outcome (401/403/400/503): stable code, safe message, no internals.
      req.log.info({ statusCode: err.statusCode, code: err.apiCode }, 'request rejected');
      const known: ApiErrorBody = {
        error: {
          code: err.apiCode,
          message: err.message,
          dataSaved: false,
          correlationId: req.id,
          ...(err.problems ? { problems: err.problems } : {}),
          ...(err.details ? { details: err.details } : {}),
        },
      };
      void reply.code(err.statusCode).send(known);
      return;
    }
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

  if (deps.prisma) {
    const authService = await createAuthService({
      prisma: deps.prisma,
      appVersion: APP_VERSION,
      ...deps.auth,
    });
    app.decorate('authService', authService);
    await registerAuthRoutes(app, {
      loginRateLimit: deps.loginRateLimit ?? { max: 10, timeWindowMs: 60_000 },
      ...(deps.changePasswordRateLimit
        ? { changePasswordRateLimit: deps.changePasswordRateLimit }
        : {}),
    });
    await registerUserRoutes(app, {
      ...(deps.resetPasswordRateLimit
        ? { resetPasswordRateLimit: deps.resetPasswordRateLimit }
        : {}),
    });
    await registerCustomerRoutes(
      app,
      createCustomerService({
        prisma: deps.prisma,
        appVersion: APP_VERSION,
        ...(deps.auth?.clock ? { clock: deps.auth.clock } : {}),
      }),
    );
    await registerProductRoutes(
      app,
      createProductService({
        prisma: deps.prisma,
        appVersion: APP_VERSION,
        ...(deps.auth?.clock ? { clock: deps.auth.clock } : {}),
      }),
    );
    await registerInventoryRoutes(
      app,
      createInventoryService({
        prisma: deps.prisma,
        appVersion: APP_VERSION,
        ...(deps.auth?.clock ? { clock: deps.auth.clock } : {}),
      }),
    );
    const taxConfigService = createTaxConfigService({
      prisma: deps.prisma,
      appVersion: APP_VERSION,
      ...(deps.auth?.clock ? { clock: deps.auth.clock } : {}),
      ...(deps.backupRestoreVerified ? { backupRestoreVerified: deps.backupRestoreVerified } : {}),
    });
    await registerTaxRoutes(app, taxConfigService);
    await registerInvoiceRoutes(
      app,
      createInvoiceService({
        prisma: deps.prisma,
        taxConfig: taxConfigService,
        numbering: createNumberingService({
          appVersion: APP_VERSION,
          ...(deps.auth?.clock ? { clock: deps.auth.clock } : {}),
        }),
        appVersion: APP_VERSION,
        ...(deps.auth?.clock ? { clock: deps.auth.clock } : {}),
      }),
    );
    await registerPaymentRoutes(
      app,
      createPaymentService({
        prisma: deps.prisma,
        numbering: createNumberingService({
          appVersion: APP_VERSION,
          ...(deps.auth?.clock ? { clock: deps.auth.clock } : {}),
        }),
        appVersion: APP_VERSION,
        ...(deps.auth?.clock ? { clock: deps.auth.clock } : {}),
      }),
    );
    const setupService = createSetupService({
      prisma: deps.prisma,
      auth: authService,
      appVersion: APP_VERSION,
      ...(deps.auth?.clock ? { clock: deps.auth.clock } : {}),
      ...(deps.setup?.hooks ? { hooks: deps.setup.hooks } : {}),
    });
    await registerSetupRoutes(app, setupService, {
      complete: deps.setup?.completeRateLimit ?? { max: 5, timeWindowMs: 60_000 },
      draft: deps.setup?.draftRateLimit ?? { max: 60, timeWindowMs: 60_000 },
    });
  }

  return app;
}
