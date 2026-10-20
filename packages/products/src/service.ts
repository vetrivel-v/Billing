import type { Prisma, PrismaClient } from '@commercebill/database';
import type {
  HsnSacSearchResponse,
  ProductReferencesResponse,
  ProductView,
} from '@commercebill/shared-types';
import {
  PRODUCT_FIELDS,
  validateProduct,
  type NormalizedProduct,
  type Problem,
} from './validate.js';

export type ProductErrorCode =
  'not_found' | 'validation_failed' | 'duplicate_sku' | 'duplicate_barcode' | 'version_conflict';

export class ProductError extends Error {
  constructor(
    readonly code: ProductErrorCode,
    message: string,
    readonly problems: Problem[] = [],
  ) {
    super(message);
    this.name = 'ProductError';
  }
}

/** The authenticated caller. The organization ALWAYS comes from the session, never from a request. */
export interface ProductContext {
  userId: string;
  organizationId: string;
  correlationId?: string | null;
}

export interface ProductListOptions {
  search?: string | undefined;
  isActive?: boolean | undefined;
  kind?: 'GOODS' | 'SERVICE' | undefined;
  trackInventory?: boolean | undefined;
  limit: number;
  offset: number;
}

const include = { hsnSacCode: true, unit: true, taxCategory: true } as const;
type Row = Prisma.ProductGetPayload<{ include: typeof include }>;

/** Exact decimal text from a Prisma Decimal (never through a JavaScript number). */
const money = (d: { toFixed(dp: number): string }) => d.toFixed(2);

export function toProductView(r: Row): ProductView {
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    description: r.description,
    kind: r.kind as ProductView['kind'],
    hsnSacCodeId: r.hsnSacCodeId,
    hsnSacCode: r.hsnSacCode
      ? {
          code: r.hsnSacCode.code,
          kind: r.hsnSacCode.kind as 'HSN' | 'SAC',
          description: r.hsnSacCode.description,
        }
      : null,
    unitId: r.unitId,
    unit: r.unit
      ? { code: r.unit.code, name: r.unit.name, decimalPlaces: r.unit.decimalPlaces }
      : null,
    taxCategoryId: r.taxCategoryId,
    taxCategory: {
      code: r.taxCategory.code,
      name: r.taxCategory.name,
      classification: r.taxCategory.classification,
    },
    mrp: r.mrp === null ? null : money(r.mrp),
    sellingPrice: money(r.sellingPrice),
    priceIncludesTax: r.priceIncludesTax,
    trackInventory: r.trackInventory,
    barcode: r.barcode,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    version: r.version,
  };
}

/** Audit rows carry changed field NAMES; values only for these (business configuration, no free text or identifiers of people). */
const AUDIT_VALUE_FIELDS = new Set([
  'sellingPrice',
  'mrp',
  'priceIncludesTax',
  'trackInventory',
  'taxCategoryId',
  'unitId',
  'hsnSacCodeId',
  'isActive',
]);

export interface ProductServiceOptions {
  prisma: PrismaClient;
  appVersion?: string;
  clock?: () => Date;
}

export function createProductService(options: ProductServiceOptions) {
  const { prisma } = options;
  const appVersion = options.appVersion ?? '0.0.0';
  const clock = options.clock ?? (() => new Date());

  async function audit(
    tx: Prisma.TransactionClient,
    ctx: ProductContext,
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
        entityType: 'product',
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
    o: ProductListOptions,
  ): Promise<{ products: ProductView[]; total: number }> {
    // LIKE wildcards in the typed text are literal characters: escape them so "%" or "_" cannot match everything.
    const term = o.search?.trim().replace(/[\\%_]/g, (ch) => '\\' + ch);
    const where: Prisma.ProductWhereInput = {
      organizationId,
      ...(o.isActive === undefined ? {} : { isActive: o.isActive }),
      ...(o.kind ? { kind: o.kind } : {}),
      ...(o.trackInventory === undefined ? {} : { trackInventory: o.trackInventory }),
      ...(term
        ? {
            OR: [
              { sku: { contains: term, mode: 'insensitive' } },
              { name: { contains: term, mode: 'insensitive' } },
              { barcode: { contains: term } },
              { hsnSacCode: { code: { startsWith: term } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include,
        orderBy: [{ name: 'asc' }, { sku: 'asc' }],
        take: o.limit,
        skip: o.offset,
      }),
      prisma.product.count({ where }),
    ]);
    return { products: rows.map(toProductView), total };
  }

  async function get(organizationId: string, id: string): Promise<ProductView> {
    const row = await prisma.product.findFirst({ where: { id, organizationId }, include });
    if (!row) throw new ProductError('not_found', 'Product not found.');
    return toProductView(row);
  }

  /** Units and tax categories of THIS organization (active only) for the product form. */
  async function references(organizationId: string): Promise<ProductReferencesResponse> {
    const [units, taxCategories, hsnSacTotal] = await Promise.all([
      prisma.unit.findMany({ where: { organizationId, isActive: true }, orderBy: { code: 'asc' } }),
      prisma.taxCategory.findMany({
        where: { organizationId, isActive: true },
        orderBy: { code: 'asc' },
      }),
      prisma.hsnSacCode.count(),
    ]);
    return {
      units: units.map((u) => ({
        id: u.id,
        code: u.code,
        name: u.name,
        decimalPlaces: u.decimalPlaces,
      })),
      taxCategories: taxCategories.map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        classification: t.classification,
      })),
      hsnSacTotal,
    };
  }

  /** HSN/SAC reference lookup (a global reference list): prefix search on the code, text search on the description. */
  async function searchHsn(o: {
    kind?: 'HSN' | 'SAC' | undefined;
    search?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<HsnSacSearchResponse> {
    const term = o.search?.trim().replace(/[\\%_]/g, (ch) => '\\' + ch);
    const where: Prisma.HsnSacCodeWhereInput = {
      ...(o.kind ? { kind: o.kind } : {}),
      ...(term
        ? {
            OR: [
              { code: { startsWith: term } },
              { description: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.hsnSacCode.findMany({
        where,
        orderBy: { code: 'asc' },
        take: o.limit,
        skip: o.offset,
      }),
      prisma.hsnSacCode.count({ where }),
    ]);
    return {
      codes: rows.map((r) => ({
        id: r.id,
        code: r.code,
        kind: r.kind as 'HSN' | 'SAC',
        description: r.description,
      })),
      total,
    };
  }

  /** The next free generated SKU (PRD-000001...). Runs in the creating transaction on a locked counter row. */
  async function nextSku(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const [row] = await tx.$queryRaw<{ last_number: bigint }[]>`
        INSERT INTO product_code_counters (organization_id, last_number, updated_at)
        VALUES (${organizationId}::uuid, 1, now())
        ON CONFLICT (organization_id)
        DO UPDATE SET last_number = product_code_counters.last_number + 1, updated_at = now()
        RETURNING last_number`;
      const sku = `PRD-${String(row!.last_number).padStart(6, '0')}`;
      // A SKU typed by hand may already use this number: skip it.
      if (!(await tx.product.findFirst({ where: { organizationId, sku }, select: { id: true } })))
        return sku;
    }
    throw new Error('Could not allocate a SKU');
  }

  const dataOf = (v: NormalizedProduct) => ({
    name: v.name,
    description: v.description,
    kind: v.kind,
    hsnSacCodeId: v.hsnSacCodeId,
    unitId: v.unitId,
    taxCategoryId: v.taxCategoryId,
    mrp: v.mrp,
    sellingPrice: v.sellingPrice,
    priceIncludesTax: v.priceIncludesTax,
    trackInventory: v.trackInventory,
    barcode: v.barcode,
  });

  function validated(raw: Record<string, unknown>, allowSku: boolean) {
    const result = validateProduct(raw, allowSku);
    if (!result.ok)
      throw new ProductError(
        'validation_failed',
        'The product details are not valid.',
        result.problems,
      );
    return result;
  }

  /**
   * Reference checks that need the database. Existence and ownership are always checked (another organization's
   * unit looks exactly like an unknown one). A reference that is no longer ACTIVE is refused only when the product is
   * newly pointed at it, so a product keeps working after its unit or category is retired.
   */
  async function checkReferences(
    tx: Prisma.TransactionClient,
    organizationId: string,
    v: NormalizedProduct,
    current?: { unitId: string | null; taxCategoryId: string; hsnSacCodeId: string | null },
  ): Promise<void> {
    const problems: Problem[] = [];
    if (v.unitId) {
      const unit = await tx.unit.findFirst({ where: { id: v.unitId, organizationId } });
      if (!unit) problems.push({ field: 'unitId', rule: 'unknown_reference' });
      else if (!unit.isActive && current?.unitId !== v.unitId)
        problems.push({ field: 'unitId', rule: 'inactive_reference' });
    }
    const tax = await tx.taxCategory.findFirst({ where: { id: v.taxCategoryId, organizationId } });
    if (!tax) problems.push({ field: 'taxCategoryId', rule: 'unknown_reference' });
    else if (!tax.isActive && current?.taxCategoryId !== v.taxCategoryId) {
      problems.push({ field: 'taxCategoryId', rule: 'inactive_reference' });
    }
    if (v.hsnSacCodeId) {
      const code = await tx.hsnSacCode.findUnique({ where: { id: v.hsnSacCodeId } });
      if (!code) problems.push({ field: 'hsnSacCodeId', rule: 'unknown_reference' });
      else if ((v.kind === 'GOODS' ? 'HSN' : 'SAC') !== code.kind) {
        problems.push({
          field: 'hsnSacCodeId',
          rule: v.kind === 'GOODS' ? 'goods_need_hsn' : 'services_need_sac',
        });
      }
    }
    if (problems.length > 0) {
      throw new ProductError('validation_failed', 'The product details are not valid.', problems);
    }
  }

  async function assertBarcodeFree(
    tx: Prisma.TransactionClient,
    organizationId: string,
    barcode: string | null,
    exceptId?: string,
  ): Promise<void> {
    if (!barcode) return;
    const clash = await tx.product.findFirst({
      where: { organizationId, barcode, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) {
      throw new ProductError('duplicate_barcode', 'Another product already uses this barcode.', [
        { field: 'barcode', rule: 'duplicate_barcode' },
      ]);
    }
  }

  /**
   * A product with stock movements keeps its unit and keeps tracking inventory (Task 1.11): changing either would
   * change the meaning of, or hide, quantities already recorded. The database enforces the same rule by trigger.
   */
  async function assertStockHistoryKept(
    tx: Prisma.TransactionClient,
    id: string,
    current: { unitId: string | null; trackInventory: boolean },
    v: NormalizedProduct,
  ): Promise<void> {
    const unitChanged = v.unitId !== current.unitId;
    const untracked = current.trackInventory && !v.trackInventory;
    if (!unitChanged && !untracked) return;
    if (!(await tx.stockMovement.findFirst({ where: { productId: id }, select: { id: true } })))
      return;
    throw new ProductError('validation_failed', 'The product details are not valid.', [
      ...(unitChanged ? [{ field: 'unitId', rule: 'unit_has_stock_history' }] : []),
      ...(untracked ? [{ field: 'trackInventory', rule: 'tracking_has_stock_history' }] : []),
    ]);
  }

  /** A unique violation raised by a concurrent writer after our pre-checks. */
  function mapUniqueViolation(err: unknown): never {
    const e = err as { code?: string; message?: string };
    if (e?.code === 'P2002') {
      if (/barcode/i.test(String(e.message ?? ''))) {
        throw new ProductError('duplicate_barcode', 'Another product already uses this barcode.', [
          { field: 'barcode', rule: 'duplicate_barcode' },
        ]);
      }
      throw new ProductError('duplicate_sku', 'That SKU is already in use.', [
        { field: 'sku', rule: 'duplicate_sku' },
      ]);
    }
    throw err;
  }

  async function create(ctx: ProductContext, raw: Record<string, unknown>): Promise<ProductView> {
    const { value, sku: suppliedSku } = validated(raw, true);
    try {
      return await prisma.$transaction(async (tx) => {
        if (suppliedSku) {
          const taken = await tx.product.findFirst({
            where: { organizationId: ctx.organizationId, sku: suppliedSku },
            select: { id: true },
          });
          if (taken) {
            throw new ProductError('duplicate_sku', 'That SKU is already in use.', [
              { field: 'sku', rule: 'duplicate_sku' },
            ]);
          }
        }
        await checkReferences(tx, ctx.organizationId, value);
        await assertBarcodeFree(tx, ctx.organizationId, value.barcode);
        const sku = suppliedSku ?? (await nextSku(tx, ctx.organizationId));
        const created = await tx.product.create({
          data: { organizationId: ctx.organizationId, sku, ...dataOf(value) },
          include,
        });
        await audit(tx, ctx, 'product.create', created.id, {
          after: {
            sku,
            kind: value.kind,
            trackInventory: value.trackInventory,
            generatedSku: !suppliedSku,
          },
        });
        return toProductView(created);
      });
    } catch (err) {
      return mapUniqueViolation(err);
    }
  }

  /** Flat form of a stored row, as the client would have sent it, used to merge a partial update. */
  function flat(r: Row): Record<string, unknown> {
    const v = toProductView(r) as unknown as Record<string, unknown>;
    return Object.fromEntries(
      PRODUCT_FIELDS.filter((f) => f !== 'sku').map((f) => [f, v[f] ?? null]),
    );
  }

  async function update(
    ctx: ProductContext,
    id: string,
    patch: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<ProductView> {
    try {
      return await prisma.$transaction(async (tx) => {
        const current = await tx.product.findFirst({
          where: { id, organizationId: ctx.organizationId },
          include,
        });
        if (!current) throw new ProductError('not_found', 'Product not found.');
        if (current.version !== expectedVersion) {
          throw new ProductError('version_conflict', 'The product was changed by someone else.');
        }
        if (patch.kind !== undefined && patch.kind !== current.kind) {
          throw new ProductError('validation_failed', 'The product details are not valid.', [
            { field: 'kind', rule: 'kind_cannot_change' },
          ]);
        }
        const { value } = validated({ ...flat(current), ...patch }, false);
        await checkReferences(tx, ctx.organizationId, value, current);
        await assertBarcodeFree(tx, ctx.organizationId, value.barcode, id);
        await assertStockHistoryKept(tx, id, current, value);

        const next = dataOf(value) as Record<string, unknown>;
        const before = flat(current);
        const changed = Object.keys(next).filter(
          (k) => String(before[k] ?? null) !== String(next[k] ?? null),
        );
        if (changed.length === 0) return toProductView(current); // nothing to save: no version bump, no audit

        const done = await tx.product.updateMany({
          where: { id, organizationId: ctx.organizationId, version: expectedVersion },
          data: { ...(next as Prisma.ProductUpdateManyMutationInput), version: { increment: 1 } },
        });
        if (done.count !== 1)
          throw new ProductError('version_conflict', 'The product was changed by someone else.');
        const fresh = await tx.product.findUniqueOrThrow({ where: { id }, include });
        const safe = changed.filter((k) => AUDIT_VALUE_FIELDS.has(k));
        const pick = (src: Record<string, unknown>) =>
          Object.fromEntries(
            safe.map((k) => [k, (src[k] ?? null) as string | number | boolean | null]),
          );
        await audit(tx, ctx, 'product.update', id, {
          before: pick(before) as Prisma.InputJsonObject,
          after: {
            changedFields: changed,
            version: fresh.version,
            ...pick(next),
          } as Prisma.InputJsonObject,
        });
        return toProductView(fresh);
      });
    } catch (err) {
      return mapUniqueViolation(err);
    }
  }

  async function setActive(
    ctx: ProductContext,
    id: string,
    active: boolean,
    expectedVersion?: number,
  ): Promise<ProductView> {
    return prisma.$transaction(async (tx) => {
      const current = await tx.product.findFirst({
        where: { id, organizationId: ctx.organizationId },
        include,
      });
      if (!current) throw new ProductError('not_found', 'Product not found.');
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new ProductError('version_conflict', 'The product was changed by someone else.');
      }
      if (current.isActive === active) return toProductView(current); // idempotent
      const done = await tx.product.updateMany({
        where: { id, organizationId: ctx.organizationId, version: current.version },
        data: { isActive: active, version: { increment: 1 } },
      });
      if (done.count !== 1)
        throw new ProductError('version_conflict', 'The product was changed by someone else.');
      const fresh = await tx.product.findUniqueOrThrow({ where: { id }, include });
      await audit(tx, ctx, active ? 'product.activate' : 'product.deactivate', id, {
        before: { isActive: !active },
        after: { isActive: active, version: fresh.version },
      });
      return toProductView(fresh);
    });
  }

  return { list, get, create, update, setActive, references, searchHsn };
}

export type ProductService = ReturnType<typeof createProductService>;
