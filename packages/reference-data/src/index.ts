import type { Prisma, PrismaClient } from '@commercebill/database';
import { PERMISSIONS } from './permissions.js';
import { ROLE_TEMPLATES } from './roles.js';
import {
  TAX_CATEGORIES,
  TAX_PLACEHOLDER_EFFECTIVE_FROM,
  TAX_REVIEW_NOTE,
  UNITS,
} from './units-and-tax.js';

export { PERMISSIONS, ROLE_TEMPLATES, UNITS, TAX_CATEGORIES };

export class ReferenceSeedError extends Error {}

export type SeedStep =
  'permissions' | 'roles' | 'role_permissions' | 'units' | 'tax_categories' | 'tax_rates';

export interface SeedHooks {
  /** Called after each step inside the transaction. Tests throw here to prove all-or-nothing behaviour. */
  afterStep?(step: SeedStep): void | Promise<void>;
}

export interface SeedReport {
  organizationId: string;
  /** Rows newly inserted by this run. A second run reports zero everywhere. */
  created: Record<SeedStep, number>;
}

/**
 * Reference seed (Task 1.1). One database transaction; idempotent by insert-if-absent
 * (ON CONFLICT DO NOTHING via skipDuplicates). Existing rows are NEVER updated, deleted or recreated, so
 * administrator customisation, historical tax rates and future-dated rates are untouched.
 *
 * Requires an existing organization (the setup wizard creates it in a later task). Inserts no demo
 * data and touches no transactional tables.
 */
export async function seedReference(
  prisma: PrismaClient,
  options: { organizationId: string; hooks?: SeedHooks },
): Promise<SeedReport> {
  return prisma.$transaction((tx) => seedReferenceData(tx, options), { timeout: 60_000 });
}

/**
 * The seed steps, run on a caller-supplied transaction client. The first-run setup service (Task 1.4) calls
 * this inside its own transaction so reference data and the organization commit or roll back together.
 * Same insert-if-absent semantics as seedReference.
 */
export async function seedReferenceData(
  tx: Prisma.TransactionClient,
  options: { organizationId: string; hooks?: SeedHooks },
): Promise<SeedReport> {
  const { organizationId, hooks } = options;
  const org = await tx.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw new ReferenceSeedError(`Organization ${organizationId} does not exist`);

  const created = {} as Record<SeedStep, number>;
  const step = async (name: SeedStep, run: () => Promise<number>) => {
    created[name] = await run();
    await hooks?.afterStep?.(name);
  };

  // 1. Global permission catalogue.
  await step(
    'permissions',
    async () =>
      (
        await tx.permission.createMany({
          data: PERMISSIONS.map((x) => ({ key: x.key, description: x.description })),
          skipDuplicates: true,
        })
      ).count,
  );

  // 2. Role templates for this organization.
  await step(
    'roles',
    async () =>
      (
        await tx.role.createMany({
          data: ROLE_TEMPLATES.map((r) => ({
            organizationId,
            name: r.name,
            description: r.description,
            isSystem: true,
          })),
          skipDuplicates: true,
        })
      ).count,
  );

  // 3. Role-permission grants (add-only: administrator revocations/extra grants are never reverted
  //    beyond re-adding a missing template grant on a later run).
  await step('role_permissions', async () => {
    const roles = await tx.role.findMany({ where: { organizationId } });
    const perms = await tx.permission.findMany({ select: { id: true, key: true } });
    const permId = new Map(perms.map((x) => [x.key, x.id]));
    const data = ROLE_TEMPLATES.flatMap((t) => {
      const role = roles.find((r) => r.name === t.name);
      if (!role) throw new ReferenceSeedError(`Role ${t.name} missing after insert`);
      return t.grants.map((key) => {
        const id = permId.get(key);
        if (!id) throw new ReferenceSeedError(`Unknown permission key ${key} in role ${t.name}`);
        return { roleId: role.id, permissionId: id };
      });
    });
    return (await tx.rolePermission.createMany({ data, skipDuplicates: true })).count;
  });

  // 4. Default units.
  await step(
    'units',
    async () =>
      (
        await tx.unit.createMany({
          data: UNITS.map((u) => ({ organizationId, ...u })),
          skipDuplicates: true,
        })
      ).count,
  );

  // 5. Tax categories (effective-dated, flagged for review).
  const effectiveFrom = new Date(`${TAX_PLACEHOLDER_EFFECTIVE_FROM}T00:00:00.000Z`);
  await step(
    'tax_categories',
    async () =>
      (
        await tx.taxCategory.createMany({
          data: TAX_CATEGORIES.map((c) => ({
            organizationId,
            code: c.code,
            name: c.name,
            classification: c.classification,
            effectiveFrom,
            origin: 'REFERENCE_SEED',
            reviewStatus: 'UNREVIEWED',
            reviewNote: TAX_REVIEW_NOTE,
          })),
          skipDuplicates: true,
        })
      ).count,
  );

  // 6. Tax rates: exact decimal strings, effective-dated, open-ended, flagged for review.
  await step('tax_rates', async () => {
    const cats = await tx.taxCategory.findMany({ where: { organizationId } });
    const catId = new Map(cats.map((c) => [c.code, c.id]));
    const data = TAX_CATEGORIES.map((c) => {
      const categoryId = catId.get(c.code);
      if (!categoryId) throw new ReferenceSeedError(`Tax category ${c.code} missing after insert`);
      return {
        organizationId,
        categoryId,
        ratePercent: c.ratePercent,
        cessPercent: c.cessPercent,
        effectiveFrom,
        origin: 'REFERENCE_SEED',
        reviewStatus: 'UNREVIEWED',
        reviewNote: TAX_REVIEW_NOTE,
      };
    });
    return (await tx.taxRate.createMany({ data, skipDuplicates: true })).count;
  });

  return { organizationId, created };
}
