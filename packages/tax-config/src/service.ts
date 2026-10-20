import type { Prisma, PrismaClient } from '@commercebill/database';
import type {
  BillingMode,
  HsnPolicyView,
  HsnSacListResponse,
  HsnSacView,
  TaxCategoryView,
  TaxConfigurationResponse,
  TaxReviewListResponse,
  TaxReviewView,
} from '@commercebill/shared-types';
import {
  ENGINE_VERSION,
  JURISDICTIONS,
  JURISDICTION_REVIEW_STATUS,
  JURISDICTION_RULESET_ID,
  JURISDICTION_RULESET_VERSION,
  ROUNDING_POLICY_ID,
  RULESET_VERSION,
  computeConfigurationFingerprint,
  evaluateProductionGate,
  reviewState,
  sellerConfigurationProblems,
  type CategoryRow,
  type RateRow,
} from '@commercebill/tax-engine';
import {
  REVIEW_NOTICE_TEXT,
  REVIEW_NOTICE_VERSION,
  validateHsnPolicy,
  validateHsnSac,
  validateReviewRequest,
  type Problem,
} from './validate.js';

export type TaxConfigErrorCode =
  | 'not_found'
  | 'validation_failed'
  | 'duplicate_code'
  | 'version_conflict'
  | 'configuration_changed'
  | 'production_not_eligible';

export class TaxConfigError extends Error {
  constructor(
    readonly code: TaxConfigErrorCode,
    message: string,
    readonly problems: Problem[] = [],
  ) {
    super(message);
    this.name = 'TaxConfigError';
  }
}

/** The authenticated caller. The organization ALWAYS comes from the session, never from a request. */
export interface TaxConfigContext {
  userId: string;
  organizationId: string;
  correlationId?: string | null;
}

export interface TaxConfigServiceOptions {
  prisma: PrismaClient;
  appVersion?: string;
  clock?: () => Date;
  /**
   * Whether a verified backup AND restore exists. Task 1.17 provides the real answer; until then it is always false, so the
   * production gate can never be met and only DEMO billing is possible.
   */
  backupRestoreVerified?: (organizationId: string) => Promise<boolean>;
}

const SETTING_HSN = 'hsn_sac_requirement';
const SETTING_MODE = 'billing_mode';

const dateText = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
/** Escapes LIKE wildcards in typed text. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => '\\' + ch);

const categoryInclude = { rates: { orderBy: { effectiveFrom: 'asc' } } } as const;
type CategoryWithRates = Prisma.TaxCategoryGetPayload<{ include: typeof categoryInclude }>;

function toCategoryView(c: CategoryWithRates): TaxCategoryView {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    classification: c.classification,
    isActive: c.isActive,
    effectiveFrom: dateText(c.effectiveFrom),
    effectiveTo: dateText(c.effectiveTo),
    origin: c.origin,
    reviewStatus: c.reviewStatus as 'UNREVIEWED' | 'REVIEWED',
    rates: c.rates.map((r) => ({
      id: r.id,
      ratePercent: r.ratePercent.toFixed(4),
      cessPercent: r.cessPercent.toFixed(4),
      effectiveFrom: dateText(r.effectiveFrom)!,
      effectiveTo: dateText(r.effectiveTo),
      origin: r.origin,
      reviewStatus: r.reviewStatus as 'UNREVIEWED' | 'REVIEWED',
    })),
  };
}

const hsnInclude = { reviewer: { select: { displayName: true } } } as const;
type HsnRow = Prisma.HsnSacCodeGetPayload<{ include: typeof hsnInclude }>;

export function toHsnView(r: HsnRow): HsnSacView {
  return {
    id: r.id,
    code: r.code,
    kind: r.kind as 'HSN' | 'SAC',
    description: r.description,
    isActive: r.isActive,
    origin: r.origin,
    reviewStatus: r.reviewStatus as 'UNREVIEWED' | 'REVIEWED',
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    reviewedByName: r.reviewer?.displayName ?? null,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

type ReviewRow = Prisma.TaxConfigurationReviewGetPayload<{
  include: { reviewer: { select: { displayName: true } } };
}>;
const toReviewView = (r: ReviewRow): TaxReviewView => ({
  id: r.id,
  fingerprint: r.fingerprint,
  reviewedByName: r.reviewer.displayName,
  reviewerCapacity: r.reviewerCapacity,
  reviewedAt: r.reviewedAt.toISOString(),
  noticeVersion: r.noticeVersion,
  noticeText: r.noticeText,
  note: r.note,
  engineVersion: r.engineVersion,
  rulesetVersion: r.rulesetVersion,
  jurisdictionRulesetVersion: r.jurisdictionRulesetVersion,
});

export function createTaxConfigService(options: TaxConfigServiceOptions) {
  const { prisma } = options;
  const appVersion = options.appVersion ?? '0.0.0';
  const clock = options.clock ?? (() => new Date());
  const backupVerified = options.backupRestoreVerified ?? (async () => false);

  type Db = PrismaClient | Prisma.TransactionClient;

  async function audit(
    tx: Prisma.TransactionClient,
    ctx: TaxConfigContext,
    action: string,
    entityType: string,
    entityId: string,
    after: Prisma.InputJsonObject,
    before?: Prisma.InputJsonObject,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        category: 'business',
        action,
        entityType,
        entityId,
        ...(before ? { beforeValues: before } : {}),
        afterValues: after,
        appVersion,
        correlationId: ctx.correlationId ?? null,
        occurredAt: clock(),
      },
    });
  }

  async function loadCategories(db: Db, organizationId: string): Promise<CategoryWithRates[]> {
    return db.taxCategory.findMany({
      where: { organizationId },
      orderBy: { code: 'asc' },
      include: categoryInclude,
    });
  }

  function fingerprintOf(categories: CategoryWithRates[]): string {
    const catRows: CategoryRow[] = categories.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      classification: c.classification,
      isActive: c.isActive,
      effectiveFrom: dateText(c.effectiveFrom),
      effectiveTo: dateText(c.effectiveTo),
    }));
    const rateRows: RateRow[] = categories.flatMap((c) =>
      c.rates.map((r) => ({
        id: r.id,
        categoryId: c.id,
        ratePercent: r.ratePercent.toFixed(4),
        cessPercent: r.cessPercent.toFixed(4),
        effectiveFrom: dateText(r.effectiveFrom)!,
        effectiveTo: dateText(r.effectiveTo),
      })),
    );
    return computeConfigurationFingerprint(catRows, rateRows);
  }

  async function currentFingerprint(db: Db, organizationId: string): Promise<string> {
    return fingerprintOf(await loadCategories(db, organizationId));
  }

  async function latestReview(db: Db, organizationId: string) {
    return db.taxConfigurationReview.findFirst({
      where: { organizationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { reviewer: { select: { displayName: true } } },
    });
  }

  async function readSetting(db: Db, organizationId: string, key: string) {
    const row = await db.organizationSetting.findUnique({
      where: { organizationId_key: { organizationId, key } },
    });
    return (row?.value ?? null) as Record<string, unknown> | null;
  }

  async function writeSetting(
    tx: Prisma.TransactionClient,
    organizationId: string,
    key: string,
    value: Prisma.InputJsonObject,
  ): Promise<void> {
    await tx.organizationSetting.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, value },
      update: { value, version: { increment: 1 } },
    });
  }

  async function hsnPolicy(db: Db, organizationId: string): Promise<HsnPolicyView> {
    const v = await readSetting(db, organizationId, SETTING_HSN);
    // No row = the default policy: HSN/SAC is REQUIRED.
    if (!v || typeof v.required !== 'boolean')
      return { required: true, reason: null, changedAt: null };
    return {
      required: v.required,
      reason: typeof v.reason === 'string' ? v.reason : null,
      changedAt: typeof v.changedAt === 'string' ? v.changedAt : null,
    };
  }

  async function billingMode(db: Db, organizationId: string): Promise<BillingMode> {
    const v = await readSetting(db, organizationId, SETTING_MODE);
    return v?.mode === 'PRODUCTION' ? 'PRODUCTION' : 'DEMO'; // DEMO unless production was explicitly (and eligibly) activated
  }

  async function gateFor(db: Db, organizationId: string, state: ReturnType<typeof reviewState>) {
    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const sellerProblems = sellerConfigurationProblems({
      gstStatus: org.gstStatus,
      gstin: org.gstin,
      stateCode: org.stateCode,
    });
    const gate = evaluateProductionGate({
      review: state,
      sellerProblems,
      hsnSacPolicyInForce: true, // a policy always exists (default: required); per-invoice HSN/SAC facts are checked by the engine
      backupRestoreVerified: await backupVerified(organizationId),
    });
    return { gate, sellerProblems, org };
  }

  /**
   * Everything billing needs to know about the tax configuration, read on the given client (pass the posting transaction to
   * read it consistently): the billing mode, the configuration fingerprint, the review state, the production gate, the HSN/SAC
   * policy and the categories/rates in the shape the pure rate selector takes.
   */
  async function billingContext(db: Db, organizationId: string) {
    const categories = await loadCategories(db, organizationId);
    const fingerprint = fingerprintOf(categories);
    const latest = await latestReview(db, organizationId);
    const state = reviewState(latest?.fingerprint ?? null, fingerprint);
    const { gate, sellerProblems } = await gateFor(db, organizationId, state);
    const categoryRows: CategoryRow[] = categories.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      classification: c.classification,
      isActive: c.isActive,
      effectiveFrom: dateText(c.effectiveFrom),
      effectiveTo: dateText(c.effectiveTo),
    }));
    const rateRows: RateRow[] = categories.flatMap((c) =>
      c.rates.map((r) => ({
        id: r.id,
        categoryId: c.id,
        ratePercent: r.ratePercent.toFixed(4),
        cessPercent: r.cessPercent.toFixed(4),
        effectiveFrom: dateText(r.effectiveFrom)!,
        effectiveTo: dateText(r.effectiveTo),
      })),
    );
    return {
      mode: await billingMode(db, organizationId),
      fingerprint,
      review: { state, latestId: latest?.id ?? null },
      gate,
      sellerProblems,
      hsnPolicy: await hsnPolicy(db, organizationId),
      categoryRows,
      rateRows,
    };
  }

  async function getConfiguration(organizationId: string): Promise<TaxConfigurationResponse> {
    const categories = await loadCategories(prisma, organizationId);
    const fingerprint = fingerprintOf(categories);
    const latest = await latestReview(prisma, organizationId);
    const state = reviewState(latest?.fingerprint ?? null, fingerprint);
    const { gate, sellerProblems, org } = await gateFor(prisma, organizationId, state);
    return {
      engine: {
        engineVersion: ENGINE_VERSION,
        rulesetVersion: RULESET_VERSION,
        roundingPolicyId: ROUNDING_POLICY_ID,
      },
      jurisdictions: {
        id: JURISDICTION_RULESET_ID,
        version: JURISDICTION_RULESET_VERSION,
        reviewStatus: JURISDICTION_REVIEW_STATUS,
        entries: JURISDICTIONS.map((j) => ({ code: j.code, name: j.name, kind: j.kind })),
      },
      categories: categories.map(toCategoryView),
      fingerprint,
      review: { state, latest: latest ? toReviewView(latest) : null },
      notice: { version: REVIEW_NOTICE_VERSION, text: REVIEW_NOTICE_TEXT },
      seller: { gstStatus: org.gstStatus, gstin: org.gstin, stateCode: org.stateCode },
      hsnPolicy: await hsnPolicy(prisma, organizationId),
      gate: {
        mode: await billingMode(prisma, organizationId),
        eligible: gate.eligible,
        requirements: gate.requirements,
        sellerProblems,
      },
    };
  }

  async function listReviews(
    organizationId: string,
    o: { limit: number; offset: number },
  ): Promise<TaxReviewListResponse> {
    const [rows, total] = await Promise.all([
      prisma.taxConfigurationReview.findMany({
        where: { organizationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { reviewer: { select: { displayName: true } } },
        take: o.limit,
        skip: o.offset,
      }),
      prisma.taxConfigurationReview.count({ where: { organizationId } }),
    ]);
    return { reviews: rows.map(toReviewView), total, limit: o.limit, offset: o.offset };
  }

  /**
   * Records a review of exactly the configuration the reviewer was looking at. The fingerprint is recomputed inside the
   * transaction (one consistent snapshot, one reviewer at a time); if it no longer equals the one the screen showed, nothing is
   * recorded. This is a business confirmation, not a government verification.
   */
  async function review(
    ctx: TaxConfigContext,
    raw: Record<string, unknown>,
  ): Promise<TaxReviewView> {
    const v = validateReviewRequest(raw);
    if (!v.ok)
      throw new TaxConfigError(
        'validation_failed',
        'The review details are not valid.',
        v.problems,
      );
    if (v.value.noticeVersion !== REVIEW_NOTICE_VERSION) {
      throw new TaxConfigError('validation_failed', 'The review notice is out of date.', [
        { field: 'noticeVersion', rule: 'notice_outdated' },
      ]);
    }
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'tax_review:' + ctx.organizationId}, 0))`;
        const categories = await loadCategories(tx, ctx.organizationId);
        const fingerprint = fingerprintOf(categories);
        if (fingerprint !== v.value.expectedFingerprint) {
          throw new TaxConfigError(
            'configuration_changed',
            'The tax configuration changed after it was shown.',
            [{ field: 'expectedFingerprint', rule: 'configuration_changed' }],
          );
        }
        const created = await tx.taxConfigurationReview.create({
          data: {
            organizationId: ctx.organizationId,
            fingerprint,
            reviewedBy: ctx.userId,
            reviewerCapacity: v.value.capacity,
            reviewedAt: clock(),
            noticeVersion: REVIEW_NOTICE_VERSION,
            noticeText: REVIEW_NOTICE_TEXT,
            note: v.value.note,
            engineVersion: ENGINE_VERSION,
            rulesetVersion: RULESET_VERSION,
            jurisdictionRulesetVersion: JURISDICTION_RULESET_VERSION,
          },
          include: { reviewer: { select: { displayName: true } } },
        });
        // Per-row display marks follow the review (the fingerprint, not these marks, is the gate).
        await tx.taxCategory.updateMany({
          where: { organizationId: ctx.organizationId, reviewStatus: 'UNREVIEWED' },
          data: { reviewStatus: 'REVIEWED' },
        });
        await tx.taxRate.updateMany({
          where: { organizationId: ctx.organizationId, reviewStatus: 'UNREVIEWED' },
          data: { reviewStatus: 'REVIEWED' },
        });
        await audit(tx, ctx, 'tax.configuration.review', 'tax_configuration_review', created.id, {
          fingerprint,
          noticeVersion: REVIEW_NOTICE_VERSION,
          engineVersion: ENGINE_VERSION,
          rulesetVersion: RULESET_VERSION,
          jurisdictionRulesetVersion: JURISDICTION_RULESET_VERSION,
        });
        return toReviewView(created);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  // ------------------------------------------------------------------------------------------ HSN/SAC

  async function listHsn(
    organizationId: string,
    o: {
      search?: string | undefined;
      kind?: 'HSN' | 'SAC' | undefined;
      isActive?: boolean | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<HsnSacListResponse> {
    const term = o.search?.trim() ? escapeLike(o.search.trim()) : undefined;
    const where: Prisma.HsnSacCodeWhereInput = {
      organizationId,
      ...(o.kind ? { kind: o.kind } : {}),
      ...(o.isActive === undefined ? {} : { isActive: o.isActive }),
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
        include: hsnInclude,
        orderBy: [{ code: 'asc' }],
        take: o.limit,
        skip: o.offset,
      }),
      prisma.hsnSacCode.count({ where }),
    ]);
    return { entries: rows.map(toHsnView), total, limit: o.limit, offset: o.offset };
  }

  async function createHsn(
    ctx: TaxConfigContext,
    raw: Record<string, unknown>,
  ): Promise<HsnSacView> {
    const v = validateHsnSac(raw, true);
    if (!v.ok)
      throw new TaxConfigError(
        'validation_failed',
        'The HSN/SAC details are not valid.',
        v.problems,
      );
    return prisma.$transaction(async (tx) => {
      const taken = await tx.hsnSacCode.findUnique({
        where: { organizationId_code: { organizationId: ctx.organizationId, code: v.value.code! } },
        select: { id: true },
      });
      if (taken)
        throw new TaxConfigError('duplicate_code', 'That code already exists.', [
          { field: 'code', rule: 'duplicate_code' },
        ]);
      const created = await tx.hsnSacCode
        .create({
          data: {
            organizationId: ctx.organizationId,
            code: v.value.code!,
            kind: v.value.kind!,
            description: v.value.description ?? null,
            isActive: v.value.isActive ?? true,
            origin: 'USER',
          },
          include: hsnInclude,
        })
        .catch((err: { code?: string }) => {
          if (err?.code === 'P2002')
            throw new TaxConfigError('duplicate_code', 'That code already exists.', [
              { field: 'code', rule: 'duplicate_code' },
            ]);
          throw err;
        });
      await audit(tx, ctx, 'hsn_sac.create', 'hsn_sac_code', created.id, {
        code: created.code,
        kind: created.kind,
        origin: 'USER',
      });
      return toHsnView(created);
    });
  }

  async function updateHsn(
    ctx: TaxConfigContext,
    id: string,
    raw: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<HsnSacView> {
    const v = validateHsnSac(raw, false);
    if (!v.ok)
      throw new TaxConfigError(
        'validation_failed',
        'The HSN/SAC details are not valid.',
        v.problems,
      );
    return prisma.$transaction(async (tx) => {
      const current = await tx.hsnSacCode.findFirst({
        where: { id, organizationId: ctx.organizationId },
        include: hsnInclude,
      });
      if (!current) throw new TaxConfigError('not_found', 'HSN/SAC entry not found.');
      if (current.version !== expectedVersion)
        throw new TaxConfigError('version_conflict', 'This entry was changed by someone else.');
      const problems: Problem[] = [];
      if (v.value.code !== undefined && v.value.code !== current.code)
        problems.push({ field: 'code', rule: 'immutable_field' });
      if (v.value.kind !== undefined && v.value.kind !== current.kind)
        problems.push({ field: 'kind', rule: 'immutable_field' });
      if (problems.length > 0)
        throw new TaxConfigError(
          'validation_failed',
          'The HSN/SAC details are not valid.',
          problems,
        );
      const changed: string[] = [];
      const data: Prisma.HsnSacCodeUpdateManyMutationInput = {};
      if (v.value.description !== undefined && v.value.description !== current.description) {
        data.description = v.value.description;
        changed.push('description');
      }
      if (v.value.isActive !== undefined && v.value.isActive !== current.isActive) {
        data.isActive = v.value.isActive;
        changed.push('isActive');
      }
      if (changed.length === 0) return toHsnView(current);
      const done = await tx.hsnSacCode.updateMany({
        where: { id, organizationId: ctx.organizationId, version: expectedVersion },
        data: { ...data, version: { increment: 1 } },
      });
      if (done.count !== 1)
        throw new TaxConfigError('version_conflict', 'This entry was changed by someone else.');
      const fresh = await tx.hsnSacCode.findUniqueOrThrow({ where: { id }, include: hsnInclude });
      await audit(tx, ctx, 'hsn_sac.update', 'hsn_sac_code', id, {
        changedFields: changed,
        version: fresh.version,
        ...(changed.includes('isActive') ? { isActive: fresh.isActive } : {}),
      });
      return toHsnView(fresh);
    });
  }

  /** A person confirms the entry (display/traceability mark; editing it later drops the mark again). */
  async function reviewHsn(
    ctx: TaxConfigContext,
    id: string,
    expectedVersion: number,
  ): Promise<HsnSacView> {
    return prisma.$transaction(async (tx) => {
      const current = await tx.hsnSacCode.findFirst({
        where: { id, organizationId: ctx.organizationId },
      });
      if (!current) throw new TaxConfigError('not_found', 'HSN/SAC entry not found.');
      if (current.version !== expectedVersion)
        throw new TaxConfigError('version_conflict', 'This entry was changed by someone else.');
      if (current.reviewStatus === 'REVIEWED') {
        const same = await tx.hsnSacCode.findUniqueOrThrow({ where: { id }, include: hsnInclude });
        return toHsnView(same); // already confirmed: nothing to do
      }
      const done = await tx.hsnSacCode.updateMany({
        where: { id, organizationId: ctx.organizationId, version: expectedVersion },
        data: {
          reviewStatus: 'REVIEWED',
          reviewedBy: ctx.userId,
          reviewedAt: clock(),
          version: { increment: 1 },
        },
      });
      if (done.count !== 1)
        throw new TaxConfigError('version_conflict', 'This entry was changed by someone else.');
      const fresh = await tx.hsnSacCode.findUniqueOrThrow({ where: { id }, include: hsnInclude });
      await audit(tx, ctx, 'hsn_sac.review', 'hsn_sac_code', id, {
        code: fresh.code,
        version: fresh.version,
      });
      return toHsnView(fresh);
    });
  }

  // ------------------------------------------------------------------------------------------ policy and mode

  async function setHsnPolicy(
    ctx: TaxConfigContext,
    raw: Record<string, unknown>,
  ): Promise<HsnPolicyView> {
    const v = validateHsnPolicy(raw);
    if (!v.ok)
      throw new TaxConfigError(
        'validation_failed',
        'The HSN/SAC policy details are not valid.',
        v.problems,
      );
    return prisma.$transaction(async (tx) => {
      const before = await hsnPolicy(tx, ctx.organizationId);
      const at = clock().toISOString();
      await writeSetting(tx, ctx.organizationId, SETTING_HSN, {
        required: v.value.required,
        reason: v.value.reason,
        acknowledged: v.value.required ? false : true,
        changedBy: ctx.userId,
        changedAt: at,
      });
      await audit(
        tx,
        ctx,
        'tax.hsn_requirement.change',
        'organization_setting',
        ctx.organizationId,
        { required: v.value.required, reason: v.value.reason, acknowledged: !v.value.required },
        { required: before.required },
      );
      return { required: v.value.required, reason: v.value.reason, changedAt: at };
    });
  }

  /**
   * DEMO is always allowed. PRODUCTION needs the whole gate: a current tax review, a valid regular GST-registered seller,
   * the HSN/SAC policy, and a verified backup/restore (Task 1.17; until then false, so production is never eligible).
   */
  async function setBillingMode(
    ctx: TaxConfigContext,
    mode: unknown,
  ): Promise<{ mode: BillingMode }> {
    if (mode !== 'DEMO' && mode !== 'PRODUCTION')
      throw new TaxConfigError('validation_failed', 'The billing mode is not valid.', [
        { field: 'mode', rule: 'invalid_value' },
      ]);
    return prisma.$transaction(async (tx) => {
      const before = await billingMode(tx, ctx.organizationId);
      if (mode === 'PRODUCTION') {
        const fingerprint = await currentFingerprint(tx, ctx.organizationId);
        const latest = await latestReview(tx, ctx.organizationId);
        const { gate } = await gateFor(
          tx,
          ctx.organizationId,
          reviewState(latest?.fingerprint ?? null, fingerprint),
        );
        if (!gate.eligible) {
          throw new TaxConfigError(
            'production_not_eligible',
            'Production billing is not available yet.',
            gate.requirements
              .filter((r) => !r.met)
              .map((r) => ({ field: r.code, rule: 'requirement_not_met' })),
          );
        }
      }
      await writeSetting(tx, ctx.organizationId, SETTING_MODE, {
        mode,
        changedBy: ctx.userId,
        changedAt: clock().toISOString(),
      });
      await audit(
        tx,
        ctx,
        'billing.mode.change',
        'organization_setting',
        ctx.organizationId,
        { mode },
        { mode: before },
      );
      return { mode };
    });
  }

  return {
    getConfiguration,
    listReviews,
    review,
    listHsn,
    createHsn,
    updateHsn,
    reviewHsn,
    setHsnPolicy,
    setBillingMode,
    currentFingerprint: (organizationId: string) => currentFingerprint(prisma, organizationId),
    billingContext,
  };
}

export type TaxConfigService = ReturnType<typeof createTaxConfigService>;
export type TaxBillingContext = Awaited<ReturnType<TaxConfigService['billingContext']>>;
