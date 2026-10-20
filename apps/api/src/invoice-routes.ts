import { InvoiceError, type InvoiceContext, type InvoiceService } from '@commercebill/invoicing';
import {
  ErrorCodes,
  type InvoiceListResponse,
  type InvoicePostResponse,
  type InvoicePreviewResponse,
  type InvoiceView,
} from '@commercebill/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from './auth-guard.js';
import { ApiHttpError } from './errors.js';

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  isDemo: z.enum(['true', 'false']).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const BODY_LIMIT = 64 * 1024;
/** Field-level validation belongs to the invoicing service; the route only checks the envelope. */
const looseBody = z.record(z.string(), z.unknown());

const bad = (message: string, problems?: { field: string; rule: string }[]) =>
  new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, message, problems);
const asProblems = (p: { code: string; path?: string }[]) =>
  p.map((x) => ({ field: x.path ?? 'invoice', rule: x.code }));

/**
 * Stable, value-free translation of service errors. Another organization's customer, product or invoice is simply "not found".
 * A stale calculation carries the fresh calculation in `details` so the screen can show the new numbers.
 */
function mapError(err: unknown): never {
  if (err instanceof InvoiceError) {
    switch (err.code) {
      case 'not_found':
        throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Invoice not found.');
      case 'validation_failed':
        throw bad(err.message, asProblems(err.problems));
      case 'calculation_stale':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          err.message,
          asProblems(err.problems),
          err.details,
        );
      case 'operation_id_reused':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          err.message,
          asProblems(err.problems),
        );
      case 'insufficient_stock':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          err.message,
          asProblems(err.problems),
        );
      case 'mode_mismatch':
        throw new ApiHttpError(409, ErrorCodes.BUSINESS_RULE_VIOLATION, err.message, [
          { field: 'mode', rule: 'MODE_MISMATCH' },
        ]);
      case 'production_gate_not_met':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          err.message,
          [{ field: 'mode', rule: 'PRODUCTION_GATE_NOT_MET' }],
          { unmet: err.problems.map((p) => p.path) },
        );
    }
  }
  throw err;
}

/** Identity and organization come from the validated session, never from the request. */
function ctx(req: FastifyRequest): InvoiceContext {
  const a = req.auth!;
  return { userId: a.userId, organizationId: a.organizationId, correlationId: req.id };
}

/**
 * Invoice routes (Task 1.13, ADR-0024): launch secret (earlier hook), session authentication, exact permission keys and
 * organization scope from the session. Preview writes nothing. Post is one transaction. There is deliberately no PATCH, PUT or
 * DELETE: a posted invoice is immutable.
 */
export async function registerInvoiceRoutes(
  app: FastifyInstance,
  service: InvoiceService,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    scope.post(
      '/invoices/preview',
      { preHandler: requirePermission('sales.invoice.write'), bodyLimit: BODY_LIMIT },
      async (req): Promise<InvoicePreviewResponse> => {
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid invoice details.');
        try {
          return await service.preview(ctx(req), body.data);
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.post(
      '/invoices',
      { preHandler: requirePermission('sales.invoice.post'), bodyLimit: BODY_LIMIT },
      async (req, reply) => {
        const body = looseBody.safeParse(req.body);
        if (!body.success) throw bad('Invalid invoice details.');
        try {
          const result: InvoicePostResponse = await service.post(ctx(req), body.data);
          // 201: a new invoice was posted. 200: this exact operation had already been posted (nothing changed).
          return reply.code(result.replayed ? 200 : 201).send(result);
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.get(
      '/invoices',
      { preHandler: requirePermission('sales.invoice.read') },
      async (req): Promise<InvoiceListResponse> => {
        const q = listQuery.safeParse(req.query);
        if (!q.success) throw bad('Invalid query.');
        return service.list(req.auth!.organizationId, {
          search: q.data.search,
          isDemo: q.data.isDemo === undefined ? undefined : q.data.isDemo === 'true',
          from: q.data.from,
          to: q.data.to,
          limit: q.data.limit,
          offset: q.data.offset,
        });
      },
    );

    scope.get(
      '/invoices/:id',
      { preHandler: requirePermission('sales.invoice.read') },
      async (req): Promise<{ invoice: InvoiceView }> => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Invoice not found.');
        try {
          return { invoice: await service.get(req.auth!.organizationId, p.data.id) };
        } catch (err) {
          return mapError(err);
        }
      },
    );
  });
}
