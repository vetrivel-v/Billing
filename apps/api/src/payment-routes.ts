import { PaymentError, type PaymentContext, type PaymentService } from '@commercebill/payments';
import {
  ErrorCodes,
  type CustomerReceivableResponse,
  type PaymentListResponse,
  type PaymentRecordResponse,
  type PaymentView,
  type ReceivablesResponse,
} from '@commercebill/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from './auth-guard.js';
import { ApiHttpError } from './errors.js';

const idParams = z.object({ id: z.uuid() });
const customerParams = z.object({ customerId: z.uuid() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'UPI', 'CARD', 'CHEQUE', 'OTHER']).optional(),
  isDemo: z.enum(['true', 'false']).optional(),
  from: date.optional(),
  to: date.optional(),
  invoiceId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const receivablesQuery = z.object({
  isDemo: z.enum(['true', 'false']).default('false'),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const customerQuery = z.object({ isDemo: z.enum(['true', 'false']).default('false') });
const BODY_LIMIT = 16 * 1024;
/** Field-level validation belongs to the payments service; the route only checks the envelope. */
const looseBody = z.record(z.string(), z.unknown());

const asProblems = (p: { code: string; path?: string }[]) =>
  p.map((x) => ({ field: x.path ?? 'payment', rule: x.code }));

/** Stable, value-free translation of service errors. Another organization's invoice, customer or payment is simply "not found". */
function mapError(err: unknown): never {
  if (err instanceof PaymentError) {
    switch (err.code) {
      case 'not_found':
        throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Not found.');
      case 'validation_failed':
        throw new ApiHttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          err.message,
          asProblems(err.problems),
        );
      case 'operation_id_reused':
      case 'mode_mismatch':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          err.message,
          asProblems(err.problems),
        );
      case 'balance_conflict':
        throw new ApiHttpError(
          409,
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          err.message,
          asProblems(err.problems),
          err.details,
        );
    }
  }
  throw err;
}

/** Identity and organization come from the validated session, never from the request. */
function ctx(req: FastifyRequest): PaymentContext {
  const a = req.auth!;
  return { userId: a.userId, organizationId: a.organizationId, correlationId: req.id };
}

/**
 * Payment and receivable routes (Task 1.16, ADR-0026): launch secret (earlier hook), session authentication, exact permission keys
 * and organization scope from the session. There is deliberately no PATCH, PUT or DELETE: a recorded payment is immutable.
 */
export async function registerPaymentRoutes(
  app: FastifyInstance,
  service: PaymentService,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    scope.post(
      '/payments',
      { preHandler: requirePermission('sales.payment.record'), bodyLimit: BODY_LIMIT },
      async (req, reply) => {
        const body = looseBody.safeParse(req.body);
        if (!body.success)
          throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid payment details.');
        try {
          const result: PaymentRecordResponse = await service.record(ctx(req), body.data);
          // 201: a new payment was recorded. 200: this exact operation had already been recorded (nothing changed).
          return reply.code(result.replayed ? 200 : 201).send(result);
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.get(
      '/payments',
      { preHandler: requirePermission('sales.payment.read') },
      async (req): Promise<PaymentListResponse> => {
        const q = listQuery.safeParse(req.query);
        if (!q.success) throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid query.');
        return service.list(req.auth!.organizationId, {
          ...q.data,
          isDemo: q.data.isDemo === undefined ? undefined : q.data.isDemo === 'true',
        });
      },
    );

    scope.get(
      '/payments/:id',
      { preHandler: requirePermission('sales.payment.read') },
      async (req): Promise<{ payment: PaymentView }> => {
        const p = idParams.safeParse(req.params);
        if (!p.success) throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Not found.');
        try {
          return { payment: await service.get(req.auth!.organizationId, p.data.id) };
        } catch (err) {
          return mapError(err);
        }
      },
    );

    scope.get(
      '/receivables',
      { preHandler: requirePermission('sales.payment.read') },
      async (req): Promise<ReceivablesResponse> => {
        const q = receivablesQuery.safeParse(req.query);
        if (!q.success) throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid query.');
        return service.receivables(req.auth!.organizationId, {
          ...q.data,
          isDemo: q.data.isDemo === 'true',
        });
      },
    );

    scope.get(
      '/receivables/customers/:customerId',
      { preHandler: requirePermission('sales.payment.read') },
      async (req): Promise<CustomerReceivableResponse> => {
        const p = customerParams.safeParse(req.params);
        const q = customerQuery.safeParse(req.query);
        if (!p.success) throw new ApiHttpError(404, ErrorCodes.NOT_FOUND, 'Not found.');
        if (!q.success) throw new ApiHttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid query.');
        try {
          return await service.customerReceivable(
            req.auth!.organizationId,
            p.data.customerId,
            q.data.isDemo === 'true',
          );
        } catch (err) {
          return mapError(err);
        }
      },
    );
  });
}
