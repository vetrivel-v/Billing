import { timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@commercebill/database';
import { BackupError, type BackupContext, type BackupService } from '@commercebill/backup';
import {
  ErrorCodes,
  type BackupCreateResponse,
  type BackupHistoryResponse,
  type BackupReadinessResponse,
  type BackupStatusResponse,
  type BackupVerificationView,
  type RestoreInspectResponse,
  type RestoreResultResponse,
} from '@commercebill/shared-types';
import type { TaxConfigService } from '@commercebill/tax-config';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from './auth-guard.js';
import { ApiHttpError } from './errors.js';

export const CONTROL_SECRET_HEADER = 'x-commercebill-control-secret';
const looseBody = z.record(z.string(), z.unknown());
const idParams = z.object({ id: z.uuid() });
const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/**
 * Stable, value-free translation of backup errors. A wrong passphrase and a damaged or changed file look the same on purpose
 * (authenticated encryption cannot tell them apart), and nothing from a backup is ever put in a message.
 */
function mapError(err: unknown): never {
  if (err instanceof BackupError) {
    const problems = err.problems;
    switch (err.code) {
      case 'validation_failed':
      case 'confirmation_required':
        throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, err.message, problems);
      case 'wrong_passphrase':
        throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, err.message, [
          { field: 'passphrase', rule: 'wrong_passphrase_or_damaged' },
        ]);
      case 'unreadable':
        throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, err.message, [
          { field: 'file', rule: 'unreadable_backup' },
        ]);
      case 'not_found':
        throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, err.message);
      default:
        throw new ApiHttpError(409, ErrorCodes.BUSINESS_RULE_VIOLATION, err.message, [
          { field: 'backup', rule: err.code },
        ]);
    }
  }
  throw err;
}

const ctx = (req: FastifyRequest): BackupContext => ({
  userId: req.auth!.userId,
  organizationId: req.auth!.organizationId,
  correlationId: req.id,
});

function controlAllowed(expected: string, header: unknown): boolean {
  if (typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Backup and recovery routes (Task 1.17, ADR-0027): launch secret (earlier hook), session, exact permission keys and organization scope
 * from the session. No client ever supplies a path: the backup folder and the restore file are registered through the CONTROL routes,
 * which only the desktop shell can call (a second secret that is never sent to the renderer).
 */
export async function registerBackupRoutes(
  app: FastifyInstance,
  service: BackupService,
  deps: {
    taxConfig: TaxConfigService;
    prisma: PrismaClient;
    controlSecret?: string | undefined;
  },
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    scope.get(
      '/backup/status',
      { preHandler: requirePermission('backup.history.read') },
      async (req): Promise<BackupStatusResponse> => service.status(req.auth!.organizationId),
    );

    scope.get(
      '/backup/history',
      { preHandler: requirePermission('backup.history.read') },
      async (req): Promise<BackupHistoryResponse> => {
        const q = historyQuery.safeParse(req.query);
        if (!q.success) throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid query.');
        return service.history(req.auth!.organizationId, q.data);
      },
    );

    // Production readiness: the whole gate, so the screen can show what is still missing (read-only).
    scope.get(
      '/backup/readiness',
      { preHandler: requirePermission('backup.history.read') },
      async (req): Promise<BackupReadinessResponse> => {
        const b = await deps.taxConfig.billingContext(deps.prisma, req.auth!.organizationId);
        return {
          mode: b.mode,
          eligible: b.gate.eligible,
          items: b.gate.requirements.map((r) => ({ code: r.code, met: r.met })),
        };
      },
    );

    scope.post(
      '/backup',
      { preHandler: requirePermission('backup.create'), bodyLimit: 8 * 1024 },
      async (req, reply) => {
        const body = looseBody.safeParse(req.body);
        if (!body.success)
          throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid backup request.');
        try {
          const out = await service.createBackup(ctx(req), body.data);
          const res: BackupCreateResponse = { backup: out.record, verification: out.verification };
          return reply.code(201).send(res);
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/backup/:id/verify',
      { preHandler: requirePermission('backup.create'), bodyLimit: 8 * 1024 },
      async (req): Promise<{ verification: BackupVerificationView }> => {
        const p = idParams.safeParse(req.params);
        const body = looseBody.safeParse(req.body);
        if (!p.success) throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Not found.');
        if (!body.success)
          throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid request.');
        try {
          return { verification: await service.verifyBackup(ctx(req), p.data.id, body.data) };
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.put(
      '/backup/retention',
      { preHandler: requirePermission('backup.create'), bodyLimit: 1024 },
      async (req) => {
        const body = looseBody.safeParse(req.body);
        if (!body.success)
          throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid request.');
        try {
          return await service.setRetention(ctx(req), body.data.retentionKeep ?? null);
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/backup/retention/apply',
      { preHandler: requirePermission('backup.create') },
      async (req) => {
        try {
          return await service.applyRetention(ctx(req));
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/backup/restore/inspect',
      { preHandler: requirePermission('backup.restore'), bodyLimit: 8 * 1024 },
      async (req): Promise<RestoreInspectResponse> => {
        const body = looseBody.safeParse(req.body);
        if (!body.success)
          throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid request.');
        try {
          return await service.inspect(ctx(req), body.data);
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/backup/restore',
      { preHandler: requirePermission('backup.restore'), bodyLimit: 8 * 1024 },
      async (req): Promise<RestoreResultResponse> => {
        const body = looseBody.safeParse(req.body);
        if (!body.success)
          throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid request.');
        try {
          return await service.restoreActive(ctx(req), body.data);
        } catch (err) {
          return mapError(err);
        }
      },
    );

    // ---- Control routes: the desktop shell only (a secret the renderer never receives).
    if (deps.controlSecret) {
      const expected = deps.controlSecret;
      const guard = async (req: FastifyRequest) => {
        if (!controlAllowed(expected, req.headers[CONTROL_SECRET_HEADER]))
          throw new ApiHttpError(403, ErrorCodes.FORBIDDEN, 'Not allowed.');
      };
      const pathBody = z
        .object({ path: z.string().min(1).max(1024), organizationId: z.uuid().optional() })
        .strict();
      scope.put(
        '/internal/backup/destination',
        { preHandler: guard, bodyLimit: 4 * 1024 },
        async (req) => {
          const b = pathBody.safeParse(req.body);
          if (!b.success)
            throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid request.');
          const org =
            b.data.organizationId ??
            (
              await deps.prisma.organization.findFirst({
                orderBy: { createdAt: 'asc' },
                select: { id: true },
              })
            )?.id;
          if (!org)
            throw new ApiHttpError(
              409,
              ErrorCodes.BUSINESS_RULE_VIOLATION,
              'The business is not set up yet.',
            );
          try {
            return await service.registerDestination(org, b.data.path);
          } catch (err) {
            return mapError(err);
          }
        },
      );
      scope.post(
        '/internal/backup/restore-source',
        { preHandler: guard, bodyLimit: 4 * 1024 },
        async (req) => {
          const b = pathBody.safeParse(req.body);
          if (!b.success)
            throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid request.');
          try {
            return await service.registerRestoreSource(b.data.path);
          } catch (err) {
            return mapError(err);
          }
        },
      );
    }
  });
}
