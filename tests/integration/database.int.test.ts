import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPrismaClient, pingDatabase, type PrismaClient } from '@commercebill/database';
import { createIsolatedDatabase, type IsolatedDatabase } from '@commercebill/test-utilities';
import { buildApp } from '../../apps/api/src/app.js';

let db: IsolatedDatabase;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await createIsolatedDatabase(inject('pgAdminUrl'));
  prisma = createPrismaClient(db.url);
});

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.drop();
});

describe('initial migration', () => {
  it('connects and applies the foundation schema to an empty database', async () => {
    expect(await pingDatabase(prisma)).toBe(true);
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    const names = tables.map((t) => t.table_name);
    for (const t of [
      'organizations',
      'users',
      'roles',
      'document_sequences',
      'tax_rates',
      'audit_logs',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('enforces organization-scoped uniqueness and check constraints', async () => {
    const org = await prisma.organization.create({
      data: { legalName: 'DEMO Pvt Ltd (fictional)' },
    });
    await prisma.unit.create({ data: { organizationId: org.id, code: 'PCS', name: 'Pieces' } });
    await expect(
      prisma.unit.create({ data: { organizationId: org.id, code: 'PCS', name: 'Dup' } }),
    ).rejects.toThrow();
    await expect(
      prisma.unit.create({
        data: { organizationId: org.id, code: 'X', name: 'X', decimalPlaces: 9 },
      }),
    ).rejects.toThrow();
  });

  it('stores money-style values as exact decimals', async () => {
    const org = await prisma.organization.create({
      data: { legalName: 'DEMO Decimal Co (fictional)' },
    });
    const cat = await prisma.taxCategory.create({
      data: { organizationId: org.id, code: 'GST18', name: 'GST 18%', classification: 'STANDARD' },
    });
    const rate = await prisma.taxRate.create({
      data: {
        organizationId: org.id,
        categoryId: cat.id,
        ratePercent: '18.0000',
        effectiveFrom: new Date('2026-04-01'),
      },
    });
    expect(rate.ratePercent.toString()).toBe('18');
    await expect(
      prisma.taxRate.create({
        data: {
          organizationId: org.id,
          categoryId: cat.id,
          ratePercent: '101',
          effectiveFrom: new Date('2027-01-01'),
        },
      }),
    ).rejects.toThrow();
  });

  it('audit_logs is append-only: UPDATE and DELETE are rejected', async () => {
    const row = await prisma.auditLog.create({
      data: { category: 'system', action: 'phase0.test', appVersion: '0.0.1' },
    });
    await expect(
      prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } }),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE audit_logs SET action = 'tampered' WHERE id = '${row.id}'::uuid`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${row.id}'::uuid`),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE audit_logs')).rejects.toThrow(
      /append-only/,
    );
    expect(await prisma.auditLog.count({ where: { id: row.id } })).toBe(1);
  });

  it('prevents duplicate document sequences even when location is NULL', async () => {
    const org = await prisma.organization.create({
      data: { legalName: 'DEMO Seq Co (fictional)' },
    });
    const fy = await prisma.financialYear.create({
      data: {
        organizationId: org.id,
        label: '2026-27',
        startDate: new Date('2026-04-01'),
        endDate: new Date('2027-03-31'),
      },
    });
    const data = {
      organizationId: org.id,
      financialYearId: fy.id,
      documentType: 'INVOICE',
      prefix: 'INV/2026-27/',
    };
    await prisma.documentSequence.create({ data });
    await expect(prisma.documentSequence.create({ data })).rejects.toThrow();
  });
});

describe('API /health/db with a real database', () => {
  it('reports the database as ok', async () => {
    const app = await buildApp({
      env: { LOG_LEVEL: 'silent', WEB_ORIGIN: ['http://127.0.0.1:5173'] },
      prisma,
    });
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(200);
    expect(res.json().database.status).toBe('ok');
    await app.close();
  });
});
