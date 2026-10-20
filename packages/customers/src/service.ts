import type { Prisma, PrismaClient } from '@commercebill/database';
import { INDIA_STATE_CODES } from '@commercebill/setup/browser';
import type { CustomerView } from '@commercebill/shared-types';
import {
  CUSTOMER_FIELDS,
  validateCustomer,
  type NormalizedWithNotes,
  type Problem,
} from './validate.js';

export type CustomerErrorCode =
  'not_found' | 'validation_failed' | 'duplicate_code' | 'duplicate_gstin' | 'version_conflict';

export class CustomerError extends Error {
  constructor(
    readonly code: CustomerErrorCode,
    message: string,
    readonly problems: Problem[] = [],
  ) {
    super(message);
    this.name = 'CustomerError';
  }
}

/** The authenticated caller. The organization ALWAYS comes from the session, never from a request. */
export interface CustomerContext {
  userId: string;
  organizationId: string;
  correlationId?: string | null;
}

export interface ListOptions {
  search?: string | undefined;
  isActive?: boolean | undefined;
  customerKind?: 'INDIVIDUAL' | 'BUSINESS' | undefined;
  limit: number;
  offset: number;
}

type Row = Prisma.CustomerGetPayload<object>;

const stateName = (code: string | null) => (code ? (INDIA_STATE_CODES[code] ?? null) : null);

export function toCustomerView(r: Row): CustomerView {
  return {
    id: r.id,
    code: r.code,
    customerKind: r.customerKind as CustomerView['customerKind'],
    legalName: r.legalName,
    displayName: r.displayName,
    contactPerson: r.contactPerson,
    email: r.email,
    phone: r.phone,
    alternatePhone: r.alternatePhone,
    gstStatus: r.gstStatus,
    gstin: r.gstin,
    pan: r.pan,
    billingAddressLine1: r.billingAddressLine1,
    billingAddressLine2: r.billingAddressLine2,
    billingCity: r.billingCity,
    billingStateCode: r.billingStateCode,
    billingStateName: stateName(r.billingStateCode),
    billingPinCode: r.billingPinCode,
    country: r.country,
    shippingSameAsBilling: r.shippingSameAsBilling,
    shippingAddressLine1: r.shippingAddressLine1,
    shippingAddressLine2: r.shippingAddressLine2,
    shippingCity: r.shippingCity,
    shippingStateCode: r.shippingStateCode,
    shippingStateName: stateName(r.shippingStateCode),
    shippingPinCode: r.shippingPinCode,
    placeOfSupplyStateCode: r.placeOfSupplyStateCode,
    placeOfSupplyStateName: stateName(r.placeOfSupplyStateCode),
    creditLimit: r.creditLimit === null ? null : r.creditLimit.toFixed(2),
    paymentTermsDays: r.paymentTermsDays,
    notes: r.notes,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    version: r.version,
  };
}

/** Fields whose before/after VALUES are safe to put in the audit log (no personal data). The rest log names only. */
const AUDIT_VALUE_FIELDS = new Set([
  'customerKind',
  'gstStatus',
  'paymentTermsDays',
  'creditLimit',
  'shippingSameAsBilling',
  'isActive',
]);

const ADDRESS_FIELDS = new Set(['billingStateCode', 'shippingStateCode', 'shippingSameAsBilling']);

export interface CustomerServiceOptions {
  prisma: PrismaClient;
  appVersion?: string;
  clock?: () => Date;
}

export function createCustomerService(options: CustomerServiceOptions) {
  const { prisma } = options;
  const appVersion = options.appVersion ?? '0.0.0';
  const clock = options.clock ?? (() => new Date());

  async function audit(
    tx: Prisma.TransactionClient,
    ctx: CustomerContext,
    action: string,
    entityId: string,
    values: { before?: Prisma.InputJsonObject; after?: Prisma.InputJsonObject },
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        category: 'business',
        action,
        entityType: 'customer',
        entityId,
        ...(values.before ? { beforeValues: values.before } : {}),
        ...(values.after ? { afterValues: values.after } : {}),
        appVersion,
        correlationId: ctx.correlationId ?? null,
        occurredAt: clock(),
      },
    });
  }

  async function list(
    organizationId: string,
    o: ListOptions,
  ): Promise<{ customers: CustomerView[]; total: number }> {
    // LIKE wildcards in the typed text are literal characters: escape them so "%" or "_" cannot match everything.
    const term = o.search?.trim().replace(/[\\%_]/g, (ch) => '\\' + ch);
    const where: Prisma.CustomerWhereInput = {
      organizationId,
      ...(o.isActive === undefined ? {} : { isActive: o.isActive }),
      ...(o.customerKind ? { customerKind: o.customerKind } : {}),
      ...(term
        ? {
            OR: [
              { code: { contains: term, mode: 'insensitive' } },
              { legalName: { contains: term, mode: 'insensitive' } },
              { displayName: { contains: term, mode: 'insensitive' } },
              { phone: { contains: term } },
              { alternatePhone: { contains: term } },
              { email: { contains: term, mode: 'insensitive' } },
              { gstin: { contains: term.toUpperCase() } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy: [{ legalName: 'asc' }, { code: 'asc' }],
        take: o.limit,
        skip: o.offset,
      }),
      prisma.customer.count({ where }),
    ]);
    return { customers: rows.map(toCustomerView), total };
  }

  async function get(organizationId: string, id: string): Promise<CustomerView> {
    const row = await prisma.customer.findFirst({ where: { id, organizationId } });
    if (!row) throw new CustomerError('not_found', 'Customer not found.');
    return toCustomerView(row);
  }

  /** The next free generated code (CUS-000001...). Runs inside the creating transaction on a locked counter row. */
  async function nextCode(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const [row] = await tx.$queryRaw<{ last_number: bigint }[]>`
        INSERT INTO customer_code_counters (organization_id, last_number, updated_at)
        VALUES (${organizationId}::uuid, 1, now())
        ON CONFLICT (organization_id)
        DO UPDATE SET last_number = customer_code_counters.last_number + 1, updated_at = now()
        RETURNING last_number`;
      const code = `CUS-${String(row!.last_number).padStart(6, '0')}`;
      // A customer code typed by hand may already use this number: skip it.
      if (
        !(await tx.customer.findFirst({ where: { organizationId, code }, select: { id: true } }))
      ) {
        return code;
      }
    }
    throw new Error('Could not allocate a customer code');
  }

  const dataOf = (v: NormalizedWithNotes) => ({
    customerKind: v.customerKind,
    legalName: v.legalName,
    displayName: v.displayName,
    contactPerson: v.contactPerson,
    email: v.email,
    phone: v.phone,
    alternatePhone: v.alternatePhone,
    gstStatus: v.gstStatus,
    gstin: v.gstin,
    pan: v.pan,
    billingAddressLine1: v.billingAddressLine1,
    billingAddressLine2: v.billingAddressLine2,
    billingCity: v.billingCity,
    billingStateCode: v.billingStateCode,
    billingPinCode: v.billingPinCode,
    shippingSameAsBilling: v.shippingSameAsBilling,
    shippingAddressLine1: v.shippingAddressLine1,
    shippingAddressLine2: v.shippingAddressLine2,
    shippingCity: v.shippingCity,
    shippingStateCode: v.shippingStateCode,
    shippingPinCode: v.shippingPinCode,
    placeOfSupplyStateCode: v.placeOfSupplyStateCode,
    creditLimit: v.creditLimit,
    paymentTermsDays: v.paymentTermsDays,
    notes: v.notes,
  });

  function validated(raw: Record<string, unknown>, allowCode: boolean) {
    const result = validateCustomer(raw, allowCode);
    if (!result.ok) {
      throw new CustomerError(
        'validation_failed',
        'The customer details are not valid.',
        result.problems,
      );
    }
    return result;
  }

  async function assertGstinFree(
    tx: Prisma.TransactionClient,
    organizationId: string,
    gstin: string | null,
    exceptId?: string,
  ): Promise<void> {
    if (!gstin) return;
    const clash = await tx.customer.findFirst({
      where: { organizationId, gstin, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) {
      throw new CustomerError('duplicate_gstin', 'Another customer already uses this GSTIN.', [
        { field: 'gstin', rule: 'duplicate_gstin' },
      ]);
    }
  }

  /** A unique-violation raised by a concurrent writer after our pre-checks. */
  function mapUniqueViolation(err: unknown): never {
    const e = err as { code?: string; message?: string };
    if (e?.code === 'P2002') {
      const text = String(e.message ?? '');
      if (/gstin/i.test(text)) {
        throw new CustomerError('duplicate_gstin', 'Another customer already uses this GSTIN.', [
          { field: 'gstin', rule: 'duplicate_gstin' },
        ]);
      }
      throw new CustomerError('duplicate_code', 'That customer code is already in use.', [
        { field: 'code', rule: 'duplicate_code' },
      ]);
    }
    throw err;
  }

  async function create(ctx: CustomerContext, raw: Record<string, unknown>): Promise<CustomerView> {
    const { value, code: suppliedCode } = validated(raw, true);
    try {
      return await prisma.$transaction(async (tx) => {
        if (suppliedCode) {
          const taken = await tx.customer.findFirst({
            where: { organizationId: ctx.organizationId, code: suppliedCode },
            select: { id: true },
          });
          if (taken) {
            throw new CustomerError('duplicate_code', 'That customer code is already in use.', [
              { field: 'code', rule: 'duplicate_code' },
            ]);
          }
        }
        await assertGstinFree(tx, ctx.organizationId, value.gstin);
        const code = suppliedCode ?? (await nextCode(tx, ctx.organizationId));
        const created = await tx.customer.create({
          data: { organizationId: ctx.organizationId, code, ...dataOf(value) },
        });
        await audit(tx, ctx, 'customer.create', created.id, {
          after: {
            code,
            customerKind: value.customerKind,
            gstStatus: value.gstStatus,
            generatedCode: !suppliedCode,
          },
        });
        return toCustomerView(created);
      });
    } catch (err) {
      return mapUniqueViolation(err);
    }
  }

  /** Flat form of a stored row, as the client would have sent it, used to merge a partial update. */
  function flat(r: Row): Record<string, unknown> {
    const v = toCustomerView(r) as unknown as Record<string, unknown>;
    return Object.fromEntries(
      CUSTOMER_FIELDS.filter((f) => f !== 'code').map((f) => [f, v[f] ?? null]),
    );
  }

  async function update(
    ctx: CustomerContext,
    id: string,
    patch: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<CustomerView> {
    try {
      return await prisma.$transaction(async (tx) => {
        const current = await tx.customer.findFirst({
          where: { id, organizationId: ctx.organizationId },
        });
        if (!current) throw new CustomerError('not_found', 'Customer not found.');
        if (current.version !== expectedVersion) {
          throw new CustomerError('version_conflict', 'The customer was changed by someone else.');
        }
        const merged = { ...flat(current), ...patch };
        // The place of supply follows the address unless the caller sets it explicitly.
        if (
          patch.placeOfSupplyStateCode === undefined &&
          Object.keys(patch).some((k) => ADDRESS_FIELDS.has(k))
        ) {
          delete merged.placeOfSupplyStateCode;
        }
        const { value } = validated(merged, false);
        await assertGstinFree(tx, ctx.organizationId, value.gstin, id);

        const next = dataOf(value) as Record<string, unknown>;
        const before = flat(current);
        const changed = Object.keys(next).filter((k) => {
          const a = before[k] ?? null;
          const b = next[k] ?? null;
          return String(a) !== String(b);
        });
        if (changed.length === 0) return toCustomerView(current); // nothing to save: no version bump, no audit

        const done = await tx.customer.updateMany({
          where: { id, organizationId: ctx.organizationId, version: expectedVersion },
          data: { ...(next as Prisma.CustomerUpdateManyMutationInput), version: { increment: 1 } },
        });
        if (done.count !== 1) {
          throw new CustomerError('version_conflict', 'The customer was changed by someone else.');
        }
        const fresh = await tx.customer.findUniqueOrThrow({ where: { id } });
        const safe = changed.filter((k) => AUDIT_VALUE_FIELDS.has(k));
        await audit(tx, ctx, 'customer.update', id, {
          before: Object.fromEntries(
            safe.map((k) => [
              k,
              before[k] === undefined ? null : (before[k] as string | number | boolean | null),
            ]),
          ) as Prisma.InputJsonObject,
          after: {
            changedFields: changed,
            version: fresh.version,
            ...Object.fromEntries(
              safe.map((k) => [k, (next[k] ?? null) as string | number | boolean | null]),
            ),
          } as Prisma.InputJsonObject,
        });
        return toCustomerView(fresh);
      });
    } catch (err) {
      return mapUniqueViolation(err);
    }
  }

  async function setActive(
    ctx: CustomerContext,
    id: string,
    active: boolean,
    expectedVersion?: number,
  ): Promise<CustomerView> {
    return prisma.$transaction(async (tx) => {
      const current = await tx.customer.findFirst({
        where: { id, organizationId: ctx.organizationId },
      });
      if (!current) throw new CustomerError('not_found', 'Customer not found.');
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new CustomerError('version_conflict', 'The customer was changed by someone else.');
      }
      if (current.isActive === active) return toCustomerView(current); // idempotent
      const done = await tx.customer.updateMany({
        where: { id, organizationId: ctx.organizationId, version: current.version },
        data: { isActive: active, version: { increment: 1 } },
      });
      if (done.count !== 1) {
        throw new CustomerError('version_conflict', 'The customer was changed by someone else.');
      }
      const fresh = await tx.customer.findUniqueOrThrow({ where: { id } });
      await audit(tx, ctx, active ? 'customer.activate' : 'customer.deactivate', id, {
        before: { isActive: !active },
        after: { isActive: active, version: fresh.version },
      });
      return toCustomerView(fresh);
    });
  }

  return { list, get, create, update, setActive };
}

export type CustomerService = ReturnType<typeof createCustomerService>;
