import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@commercebill/database';
import { createIsolatedDatabase, type IsolatedDatabase } from '@commercebill/test-utilities';
import {
  PERMISSIONS,
  ROLE_TEMPLATES,
  ReferenceSeedError,
  TAX_CATEGORIES,
  UNITS,
  seedReference,
  type SeedStep,
} from '../../prisma/seed/reference/index.js';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const opened: { db: IsolatedDatabase; prisma: PrismaClient }[] = [];

async function freshDb() {
  const db = await createIsolatedDatabase(inject('pgAdminUrl'));
  const prisma = createPrismaClient(db.url);
  opened.push({ db, prisma });
  const org = await prisma.organization.create({ data: { legalName: 'DEMO Seed Co (fictional)' } });
  return { db, prisma, orgId: org.id };
}

afterAll(async () => {
  for (const { db, prisma } of opened) {
    await prisma.$disconnect();
    await db.drop();
  }
});

async function counts(prisma: PrismaClient) {
  return {
    permissions: await prisma.permission.count(),
    roles: await prisma.role.count(),
    role_permissions: await prisma.rolePermission.count(),
    units: await prisma.unit.count(),
    tax_categories: await prisma.taxCategory.count(),
    tax_rates: await prisma.taxRate.count(),
  };
}

const expectedCounts = {
  permissions: PERMISSIONS.length,
  roles: ROLE_TEMPLATES.length,
  role_permissions: ROLE_TEMPLATES.reduce((n, r) => n + r.grants.length, 0),
  units: UNITS.length,
  tax_categories: TAX_CATEGORIES.length,
  tax_rates: TAX_CATEGORIES.length,
};

async function grantsOf(prisma: PrismaClient, orgId: string, role: string): Promise<string[]> {
  const rows = await prisma.rolePermission.findMany({
    where: { role: { organizationId: orgId, name: role } },
    select: { permission: { select: { key: true } } },
  });
  return rows.map((r) => r.permission.key).sort();
}

describe('reference seed: inserts', () => {
  it('inserts the full reference set for an existing organization', async () => {
    const { prisma, orgId } = await freshDb();
    const report = await seedReference(prisma, { organizationId: orgId });
    expect(report.created).toEqual(expectedCounts);
    expect(await counts(prisma)).toEqual(expectedCounts);
  });

  it('refuses an organization that does not exist and inserts nothing, not even global permissions', async () => {
    const { prisma } = await freshDb();
    await expect(
      seedReference(prisma, { organizationId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toBeInstanceOf(ReferenceSeedError);
    expect((await counts(prisma)).permissions).toBe(0);
  });
});

describe('reference seed: idempotency (A)', () => {
  it('a second run inserts nothing, keeps identical counts and keeps the same row ids', async () => {
    const { prisma, orgId } = await freshDb();
    await seedReference(prisma, { organizationId: orgId });
    const idsBefore = (
      await prisma.role.findMany({ select: { id: true }, orderBy: { name: 'asc' } })
    ).map((r) => r.id);
    const second = await seedReference(prisma, { organizationId: orgId });
    expect(Object.values(second.created).every((n) => n === 0)).toBe(true);
    expect(await counts(prisma)).toEqual(expectedCounts);
    const idsAfter = (
      await prisma.role.findMany({ select: { id: true }, orderBy: { name: 'asc' } })
    ).map((r) => r.id);
    expect(idsAfter).toEqual(idsBefore); // not deleted and recreated
  });

  it('has no duplicates by natural key', async () => {
    const { prisma, orgId } = await freshDb();
    await seedReference(prisma, { organizationId: orgId });
    await seedReference(prisma, { organizationId: orgId });
    const dup = async (table: string, cols: string) =>
      (
        await prisma.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM (SELECT 1 FROM ${table} GROUP BY ${cols} HAVING count(*) > 1) d`,
        )
      )[0]?.n;
    expect(await dup('permissions', 'key')).toBe(0n);
    expect(await dup('roles', 'organization_id, name')).toBe(0n);
    expect(await dup('units', 'organization_id, code')).toBe(0n);
    expect(await dup('tax_categories', 'organization_id, code')).toBe(0n);
    expect(await dup('tax_rates', 'category_id, effective_from')).toBe(0n);
  });

  it('does not overwrite or remove existing data on re-run (units, extra grants, future tax rates)', async () => {
    const { prisma, orgId } = await freshDb();
    await seedReference(prisma, { organizationId: orgId });

    await prisma.unit.update({
      where: { organizationId_code: { organizationId: orgId, code: 'PCS' } },
      data: { name: 'Pieces (renamed by user)' },
    });
    // Administrator customisation: grant one extra permission to Viewer/Auditor.
    const viewer = await prisma.role.findFirstOrThrow({
      where: { organizationId: orgId, name: 'Viewer/Auditor' },
    });
    const exportPerm = await prisma.permission.findUniqueOrThrow({
      where: { key: 'report.export' },
    });
    await prisma.rolePermission.create({
      data: { roleId: viewer.id, permissionId: exportPerm.id },
    });
    // A future-dated rate added by a user, plus a closed historical row.
    const gst18 = await prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: orgId, code: 'GST_18' },
    });
    await prisma.taxRate.create({
      data: {
        organizationId: orgId,
        categoryId: gst18.id,
        ratePercent: '18.0000',
        effectiveFrom: new Date('2027-04-01'),
        origin: 'USER',
      },
    });
    const ratesBefore = await prisma.taxRate.findMany({
      orderBy: [{ categoryId: 'asc' }, { effectiveFrom: 'asc' }],
    });

    await seedReference(prisma, { organizationId: orgId });

    expect(
      (
        await prisma.unit.findUniqueOrThrow({
          where: { organizationId_code: { organizationId: orgId, code: 'PCS' } },
        })
      ).name,
    ).toBe('Pieces (renamed by user)');
    expect(await grantsOf(prisma, orgId, 'Viewer/Auditor')).toContain('report.export');
    const ratesAfter = await prisma.taxRate.findMany({
      orderBy: [{ categoryId: 'asc' }, { effectiveFrom: 'asc' }],
    });
    expect(ratesAfter).toEqual(ratesBefore); // every historical and future row byte-identical
  });
});

describe('reference seed: transaction safety (B)', () => {
  const steps: SeedStep[] = [
    'permissions',
    'roles',
    'role_permissions',
    'units',
    'tax_categories',
    'tax_rates',
  ];

  it.each(steps)(
    'a failure after step "%s" leaves no partial reference data',
    async (failAfter) => {
      const { prisma, orgId } = await freshDb();
      await expect(
        seedReference(prisma, {
          organizationId: orgId,
          hooks: {
            afterStep(step) {
              if (step === failAfter) throw new Error('injected failure');
            },
          },
        }),
      ).rejects.toThrow('injected failure');
      expect(await counts(prisma)).toEqual({
        permissions: 0,
        roles: 0,
        role_permissions: 0,
        units: 0,
        tax_categories: 0,
        tax_rates: 0,
      });
    },
  );

  it('a failed re-run leaves previously seeded data exactly as it was', async () => {
    const { prisma, orgId } = await freshDb();
    await seedReference(prisma, { organizationId: orgId });
    await expect(
      seedReference(prisma, {
        organizationId: orgId,
        hooks: {
          afterStep(step) {
            if (step === 'units') throw new Error('injected failure');
          },
        },
      }),
    ).rejects.toThrow('injected failure');
    expect(await counts(prisma)).toEqual(expectedCounts);
  });
});

describe('reference seed: role/permission matrix (C)', () => {
  let prisma: PrismaClient;
  let orgId: string;
  const g = (role: string) => grantsOf(prisma, orgId, role);

  beforeAll(async () => {
    ({ prisma, orgId } = await freshDb());
    await seedReference(prisma, { organizationId: orgId });
  });

  it('Administrator receives every defined permission', async () => {
    const all = (await prisma.permission.findMany({ select: { key: true } }))
      .map((p) => p.key)
      .sort();
    expect(all.length).toBe(PERMISSIONS.length);
    expect(await g('Administrator')).toEqual(all);
  });

  it('Warehouse Operator receives no cost, margin, valuation or accounting permission', async () => {
    const keys = await g('Warehouse Operator');
    expect(keys.length).toBeGreaterThan(0);
    for (const forbidden of [
      'product.cost.read',
      'product.margin.read',
      'inventory.valuation.read',
      'report.financial.read',
      'expense.read',
      'purchase.read',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(
      keys.filter((k) => /^accounting\.|cost|margin|valuation|financial|profit/.test(k)),
    ).toEqual([]);
    // Positive control: it does receive its operational permissions.
    expect(keys).toEqual(
      expect.arrayContaining([
        'inventory.pick',
        'inventory.pack',
        'inventory.ship',
        'inventory.return.receive',
      ]),
    );
  });

  it('Billing Operator has no period-unlock, posted-document deletion or integration-credential permission', async () => {
    const keys = await g('Billing Operator');
    expect(keys).not.toContain('accounting.period.unlock');
    expect(keys).not.toContain('sales.document.delete_posted');
    expect(keys).not.toContain('integration.credentials.manage');
    expect(
      keys.filter((k) => /^accounting\.|^integration\.|^security\.|^backup\./.test(k)),
    ).toEqual([]);
    expect(keys).toEqual(expect.arrayContaining(['sales.invoice.post', 'sales.payment.record']));
  });

  it('Viewer/Auditor has no write, admin or export permission by default', async () => {
    const keys = await g('Viewer/Auditor');
    expect(keys.length).toBeGreaterThan(0);
    // Independent of the catalogue metadata: every key must be a read verb or the print verb.
    for (const k of keys) expect(k.split('.').pop(), k).toMatch(/^(read|print)$/);
    expect(
      keys.filter((k) =>
        /export|import|manage|write|post|cancel|record|create|approve|unlock|lock|restore/.test(k),
      ),
    ).toEqual([]);
  });

  it('Viewer/Auditor gets an export permission only when explicitly granted, and the grant survives a re-run', async () => {
    const { prisma: p2, orgId: o2 } = await freshDb();
    await seedReference(p2, { organizationId: o2 });
    const exportKeys = PERMISSIONS.filter((x) => x.kind === 'export').map((x) => x.key);
    expect(exportKeys.length).toBeGreaterThan(0);
    const before = await grantsOf(p2, o2, 'Viewer/Auditor');
    for (const k of exportKeys) expect(before).not.toContain(k);

    const viewer = await p2.role.findFirstOrThrow({
      where: { organizationId: o2, name: 'Viewer/Auditor' },
    });
    const perm = await p2.permission.findUniqueOrThrow({ where: { key: 'customer.export' } });
    await p2.rolePermission.create({ data: { roleId: viewer.id, permissionId: perm.id } });
    await seedReference(p2, { organizationId: o2 });
    const after = await grantsOf(p2, o2, 'Viewer/Auditor');
    expect(after).toContain('customer.export');
    expect(after.filter((k) => exportKeys.includes(k))).toEqual(['customer.export']);
  });

  it('Accountant receives no security-administration permission', async () => {
    const keys = await g('Accountant');
    expect(keys.filter((k) => k.startsWith('security.'))).toEqual([]);
    expect(keys).not.toContain('accounting.period.unlock');
    expect(keys).toEqual(
      expect.arrayContaining([
        'accounting.journal.post',
        'report.gst.read',
        'report.financial.read',
      ]),
    );
  });

  it('marks all five roles as system roles belonging to the organization', async () => {
    const roles = await prisma.role.findMany({ where: { organizationId: orgId } });
    expect(roles).toHaveLength(5);
    expect(roles.every((r) => r.isSystem)).toBe(true);
  });
});

describe('reference seed: tax data (D) and units (E)', () => {
  it('stores exact decimals, effective dates and an explicit accountant-review marker', async () => {
    const { prisma, orgId } = await freshDb();
    await seedReference(prisma, { organizationId: orgId });
    const rates = await prisma.taxRate.findMany({
      where: { organizationId: orgId },
      include: { category: true },
    });
    expect(rates).toHaveLength(TAX_CATEGORIES.length);
    const gst18 = rates.find((r) => r.category.code === 'GST_18')!;
    expect(gst18.ratePercent.toString()).toBe('18');
    expect(gst18.cessPercent.toString()).toBe('0');
    for (const r of rates) {
      expect(r.effectiveFrom).toBeInstanceOf(Date);
      expect(r.effectiveTo).toBeNull(); // open-ended: a future rate is added as a new row
      expect(r.origin).toBe('REFERENCE_SEED');
      expect(r.reviewStatus).toBe('UNREVIEWED');
      expect(r.reviewNote).toMatch(/authorized accountant or tax professional/);
      expect(r.reviewNote).toMatch(/not a guaranteed current statutory rate/i);
    }
    const cats = await prisma.taxCategory.findMany({ where: { organizationId: orgId } });
    for (const c of cats) {
      expect(c.effectiveFrom).toBeInstanceOf(Date);
      expect(c.origin).toBe('REFERENCE_SEED');
      expect(c.reviewStatus).toBe('UNREVIEWED');
    }
  });

  it('keeps a historical rate intact when a newer rate is added for the same category', async () => {
    const { prisma, orgId } = await freshDb();
    await seedReference(prisma, { organizationId: orgId });
    const cat = await prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: orgId, code: 'GST_12' },
    });
    const old = await prisma.taxRate.findFirstOrThrow({ where: { categoryId: cat.id } });
    // Close the old row and add a successor - the only supported way to change a rate.
    await prisma.taxRate.update({
      where: { id: old.id },
      data: { effectiveTo: new Date('2027-03-31') },
    });
    await prisma.taxRate.create({
      data: {
        organizationId: orgId,
        categoryId: cat.id,
        ratePercent: '5.0000',
        effectiveFrom: new Date('2027-04-01'),
      },
    });
    await seedReference(prisma, { organizationId: orgId });
    const rows = await prisma.taxRate.findMany({
      where: { categoryId: cat.id },
      orderBy: { effectiveFrom: 'asc' },
    });
    expect(rows.map((r) => r.ratePercent.toString())).toEqual(['12', '5']);
    expect(rows[0]!.effectiveTo?.toISOString().slice(0, 10)).toBe('2027-03-31');
  });

  it('rejects an overlapping duplicate start date and a rate over 100 at the database level', async () => {
    const { prisma, orgId } = await freshDb();
    await seedReference(prisma, { organizationId: orgId });
    const cat = await prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: orgId, code: 'GST_5' },
    });
    const existing = await prisma.taxRate.findFirstOrThrow({ where: { categoryId: cat.id } });
    await expect(
      prisma.taxRate.create({
        data: {
          organizationId: orgId,
          categoryId: cat.id,
          ratePercent: '6',
          effectiveFrom: existing.effectiveFrom,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.taxRate.create({
        data: {
          organizationId: orgId,
          categoryId: cat.id,
          ratePercent: '101',
          effectiveFrom: new Date('2030-01-01'),
        },
      }),
    ).rejects.toThrow();
  });

  it('creates the default units with stable unique codes', async () => {
    const { prisma, orgId } = await freshDb();
    await seedReference(prisma, { organizationId: orgId });
    const units = await prisma.unit.findMany({ where: { organizationId: orgId } });
    expect(units.map((u) => u.code).sort()).toEqual(UNITS.map((u) => u.code).sort());
    expect(units.find((u) => u.code === 'KG')?.decimalPlaces).toBe(3);
  });
});

describe('reference vs demo (F) and the CLI', () => {
  async function tableCounts(prisma: PrismaClient) {
    const r = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(
      `SELECT 'users' t, count(*) n FROM users UNION ALL SELECT 'warehouses', count(*) FROM warehouses
       UNION ALL SELECT 'financial_years', count(*) FROM financial_years
       UNION ALL SELECT 'document_sequences', count(*) FROM document_sequences
       UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs
       UNION ALL SELECT 'business_locations', count(*) FROM business_locations
       UNION ALL SELECT 'organizations', count(*) FROM organizations`,
    );
    return Object.fromEntries(r.map((x) => [x.t, Number(x.n)]));
  }

  it('reference seeding adds no demo, user, stock, document or accounting data', async () => {
    const { prisma, orgId } = await freshDb();
    const before = await tableCounts(prisma);
    await seedReference(prisma, { organizationId: orgId });
    expect(await tableCounts(prisma)).toEqual(before);
    expect(before.organizations).toBe(1);
    // The customers table exists since Task 1.9, but reference seeding must never put a customer in it.
    expect(await prisma.customer.count()).toBe(0);
    // The products table exists since Task 1.10, but reference seeding must never put a product in it.
    expect(await prisma.product.count()).toBe(0);
    // No table for invoices/payments/stock/journals exists yet.
    const tables = (
      await prisma.$queryRaw<
        { table_name: string }[]
      >`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`
    ).map((t) => t.table_name);
    for (const t of ['invoices', 'payments', 'inventory_movements', 'journal_entries']) {
      expect(tables).not.toContain(t);
    }
  });

  function runSeedCli(url: string, ...args: string[]) {
    return spawnSync(process.execPath, ['--import', 'tsx', 'prisma/seed/seed.ts', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url },
      timeout: 120_000,
    });
  }

  it('CLI "demo" is a no-op', async () => {
    const { db, prisma } = await freshDb();
    const r = runSeedCli(db.url, 'demo');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No-op/);
    expect(await counts(prisma)).toEqual({
      permissions: 0,
      roles: 0,
      role_permissions: 0,
      units: 0,
      tax_categories: 0,
      tax_rates: 0,
    });
  });

  it('CLI "reference" seeds the single existing organization, and fails cleanly with none', async () => {
    const { db, prisma } = await freshDb();
    const ok = runSeedCli(db.url, 'reference');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/UNREVIEWED placeholders/);
    expect(await counts(prisma)).toEqual(expectedCounts);
    const again = runSeedCli(db.url, 'reference');
    expect(again.status).toBe(0);
    expect(await counts(prisma)).toEqual(expectedCounts);

    const empty = await createIsolatedDatabase(inject('pgAdminUrl'));
    const emptyPrisma = createPrismaClient(empty.url);
    opened.push({ db: empty, prisma: emptyPrisma });
    const bad = runSeedCli(empty.url, 'reference');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/No organization exists/);
    expect(await counts(emptyPrisma)).toEqual({
      permissions: 0,
      roles: 0,
      role_permissions: 0,
      units: 0,
      tax_categories: 0,
      tax_rates: 0,
    });
  });
});
