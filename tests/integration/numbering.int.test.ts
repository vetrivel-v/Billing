import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { PrismaClient } from '@commercebill/database';
import {
  NumberingError,
  createNumberingService,
  type Db,
  type DocumentTypeCode,
  type NumberingErrorCode,
} from '@commercebill/numbering';
import { createFixture, type Fixture } from './auth-fixture.js';

let fx: Fixture;
let prisma: PrismaClient;
const svc = createNumberingService({ appVersion: 'test' });

const tx = <T>(fn: (db: Db) => Promise<T>) =>
  prisma.$transaction(fn, { maxWait: 60_000, timeout: 120_000 });

let counter = 0;
const unique = (p: string) => `${p}-${++counter}`;

async function mkOrg(name = unique('DEMO Numbering Co')) {
  return prisma.organization.create({ data: { legalName: `${name} (fictional)` } });
}
async function mkFy(organizationId: string, label: string, start: string) {
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(
    Date.UTC(s.getUTCFullYear() + 1, s.getUTCMonth(), s.getUTCDate()) - 86_400_000,
  );
  return prisma.financialYear.create({ data: { organizationId, label, startDate: s, endDate: e } });
}
async function mkSeq(
  organizationId: string,
  financialYearId: string,
  documentType: DocumentTypeCode = 'INVOICE',
  over: Partial<Parameters<typeof svc.createSequence>[1]> = {},
) {
  return tx((db) =>
    svc.createSequence(db, {
      organizationId,
      financialYearId,
      documentType,
      prefix: 'INV/{FY}/',
      ...over,
    }),
  );
}
const scopeOf = (
  organizationId: string,
  financialYearId: string,
  documentType: DocumentTypeCode = 'INVOICE',
) => ({
  organizationId,
  financialYearId,
  documentType,
});
const alloc = (
  organizationId: string,
  financialYearId: string,
  ref: string,
  type: DocumentTypeCode = 'INVOICE',
) =>
  tx((db) =>
    svc.allocate(db, scopeOf(organizationId, financialYearId, type), { documentRef: ref }),
  );

async function expectCode(p: Promise<unknown>, code: NumberingErrorCode) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected NumberingError ${code}`).toBeInstanceOf(NumberingError);
  expect((err as NumberingError).code).toBe(code);
}

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'), { bare: true });
  prisma = fx.prisma;
  // A stand-in for a "documents" table: it exists only in this test database, to prove that the number and the
  // document commit or roll back together. No business documents exist in the product yet.
  await prisma.$executeRawUnsafe(
    `CREATE TABLE test_posted_docs (id text PRIMARY KEY, status text NOT NULL, number text UNIQUE)`,
  );
}, 120_000);
afterAll(async () => fx?.close());

describe('allocation basics', () => {
  it('issues consecutive numbers whose text comes entirely from the configuration', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    await mkSeq(org.id, fy.id, 'INVOICE', { prefix: 'INV/{FY}/', numericLength: 6 });
    await mkSeq(org.id, fy.id, 'CREDIT_NOTE', {
      prefix: 'CN-',
      suffix: '/{FY}',
      numericLength: 4,
      startNumber: 25,
    });
    const a = await alloc(org.id, fy.id, 'doc-1');
    const b = await alloc(org.id, fy.id, 'doc-2');
    expect([a.number, b.number]).toEqual(['INV/2026-27/000001', 'INV/2026-27/000002']);
    expect([a.sequenceNumber, b.sequenceNumber]).toEqual([1n, 2n]);
    expect(a.reused).toBe(false);
    const cn = await alloc(org.id, fy.id, 'cn-1', 'CREDIT_NOTE');
    expect(cn.number).toBe('CN-0025/2026-27'); // starts at the configured start number, own prefix/suffix/width
  });

  it('records every allocation in an append-only ledger with the number frozen as printed', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    await alloc(org.id, fy.id, 'ledger-doc');
    const rows = await prisma.documentNumberAllocation.findMany({ where: { sequenceId: seq.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: org.id,
      documentType: 'INVOICE',
      sequenceNumber: 1n,
      formattedNumber: 'INV/2026-27/000001',
      documentRef: 'ledger-doc',
    });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE document_number_allocations SET formatted_number = 'X' WHERE id = '${rows[0]!.id}'::uuid`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM document_number_allocations WHERE id = '${rows[0]!.id}'::uuid`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.documentNumberAllocation.delete({ where: { id: rows[0]!.id } }),
    ).rejects.toThrow();
  });

  it('fails clearly, and consumes nothing, for missing, inactive, unknown and malformed requests', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const other = await mkFy(org.id, '2027-28', '2027-04-01');
    const seq = await mkSeq(org.id, fy.id);
    await expectCode(alloc(org.id, other.id, 'x'), 'sequence_not_found'); // no sequence for that year
    await expectCode(alloc(org.id, fy.id, 'x', 'DEBIT_NOTE'), 'sequence_not_found'); // none for that type
    await expectCode(
      tx((db) =>
        svc.allocate(
          db,
          { ...scopeOf(org.id, fy.id), documentType: 'Tax invoice' as never },
          { documentRef: 'x' },
        ),
      ),
      'unknown_document_type',
    );
    await expectCode(alloc(org.id, fy.id, '   '), 'invalid_configuration');
    await expectCode(alloc(org.id, fy.id, 'r'.repeat(201)), 'invalid_configuration');
    await tx((db) =>
      svc.updateSequence(db, { sequenceId: seq.id, expectedVersion: seq.version, isActive: false }),
    );
    await expectCode(alloc(org.id, fy.id, 'x'), 'sequence_inactive');
    const after = await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } });
    expect(after.lastNumber).toBe(0n);
    expect(await prisma.documentNumberAllocation.count({ where: { organizationId: org.id } })).toBe(
      0,
    );
  });

  it('a sequence of another organization is never reachable (organization isolation)', async () => {
    const a = await mkOrg();
    const b = await mkOrg();
    const fyA = await mkFy(a.id, '2026-27', '2026-04-01');
    await mkSeq(a.id, fyA.id);
    await expectCode(alloc(b.id, fyA.id, 'steal'), 'sequence_not_found');
    await expect(mkSeq(b.id, fyA.id)).rejects.toMatchObject({ code: 'invalid_configuration' }); // foreign financial year
  });

  it('refuses to exceed the configured width, leaving the counter untouched', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id, 'INVOICE', { numericLength: 2, startNumber: 98 });
    expect((await alloc(org.id, fy.id, 'a')).number).toBe('INV/2026-27/98');
    expect((await alloc(org.id, fy.id, 'b')).number).toBe('INV/2026-27/99');
    await expectCode(alloc(org.id, fy.id, 'c'), 'sequence_exhausted');
    expect(
      (await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } })).lastNumber,
    ).toBe(99n);
    // Widening the sequence lets numbering continue where it left off.
    const fresh = await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } });
    await tx((db) =>
      svc.updateSequence(db, {
        sequenceId: seq.id,
        expectedVersion: fresh.version,
        numericLength: 4,
      }),
    );
    expect((await alloc(org.id, fy.id, 'c')).number).toBe('INV/2026-27/0100');
  });
});

describe('configuration changes never renumber history', () => {
  it('prefix and width changes affect only later numbers; issued numbers stay exactly as printed', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    const first = [await alloc(org.id, fy.id, 'd1'), await alloc(org.id, fy.id, 'd2')];
    const updated = await tx((db) =>
      svc.updateSequence(db, {
        sequenceId: seq.id,
        expectedVersion: seq.version,
        prefix: 'TAX/{FY}/',
        numericLength: 8,
      }),
    );
    expect(updated.version).toBe(seq.version + 1);
    const later = await alloc(org.id, fy.id, 'd3');
    expect(later.number).toBe('TAX/2026-27/00000003');
    const ledger = await prisma.documentNumberAllocation.findMany({
      where: { sequenceId: seq.id },
      orderBy: { sequenceNumber: 'asc' },
    });
    expect(ledger.map((l) => l.formattedNumber)).toEqual([
      first[0]!.number,
      first[1]!.number,
      later.number,
    ]);
    expect(ledger.slice(0, 2).map((l) => l.formattedNumber)).toEqual([
      'INV/2026-27/000001',
      'INV/2026-27/000002',
    ]);
    // Re-requesting an old document still returns its ORIGINAL number, not a reformatted one.
    expect((await alloc(org.id, fy.id, 'd1')).number).toBe('INV/2026-27/000001');
  });

  it('the start number is frozen once a number is issued (service and database both enforce it)', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id, 'INVOICE', { startNumber: 500 });
    // Before any number is issued it may change.
    const moved = await tx((db) =>
      svc.updateSequence(db, {
        sequenceId: seq.id,
        expectedVersion: seq.version,
        startNumber: 700,
      }),
    );
    expect(moved.startNumber).toBe(700n);
    expect((await alloc(org.id, fy.id, 'x')).number).toBe('INV/2026-27/000700');
    await expectCode(
      tx((db) =>
        svc.updateSequence(db, {
          sequenceId: seq.id,
          expectedVersion: moved.version,
          startNumber: 1,
        }),
      ),
      'start_number_locked',
    );
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE document_sequences SET start_number = 1 WHERE id = '${seq.id}'::uuid`,
      ),
    ).rejects.toThrow(/start number cannot change/);
  });

  it('rejects stale versions, unsafe widths and invalid formats, and audits real changes', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    await alloc(org.id, fy.id, 'a');
    await expectCode(
      tx((db) =>
        svc.updateSequence(db, { sequenceId: seq.id, expectedVersion: 99, prefix: 'X/{FY}/' }),
      ),
      'stale_version',
    );
    await expectCode(
      tx((db) =>
        svc.updateSequence(db, {
          sequenceId: seq.id,
          expectedVersion: seq.version,
          prefix: 'bad prefix',
        }),
      ),
      'invalid_configuration',
    );
    await expectCode(
      tx((db) =>
        svc.updateSequence(db, {
          sequenceId: seq.id,
          expectedVersion: seq.version,
          prefix: 'INV/2026-27/',
        }),
      ),
      'invalid_configuration',
    ); // no {FY}
    await expectCode(
      tx((db) =>
        svc.updateSequence(db, {
          sequenceId: '00000000-0000-4000-8000-000000000000',
          expectedVersion: 1,
        }),
      ),
      'sequence_not_found',
    );
    await tx((db) =>
      svc.updateSequence(
        db,
        { sequenceId: seq.id, expectedVersion: seq.version, suffix: '-A' },
        { userId: null, system: 'test' },
      ),
    );
    const audits = await prisma.auditLog.findMany({
      where: { entityId: seq.id, category: 'configuration' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual([
      'numbering.sequence.created',
      'numbering.sequence.updated',
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/password|token|secret/i);
  });

  it('sequences are never deleted and their identity never changes', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const fy2 = await mkFy(org.id, '2027-28', '2027-04-01');
    const seq = await mkSeq(org.id, fy.id);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM document_sequences WHERE id = '${seq.id}'::uuid`),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(prisma.documentSequence.delete({ where: { id: seq.id } })).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE document_sequences SET financial_year_id = '${fy2.id}'::uuid WHERE id = '${seq.id}'::uuid`,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE document_sequences SET document_type = 'CREDIT_NOTE' WHERE id = '${seq.id}'::uuid`,
      ),
    ).rejects.toThrow(/immutable/);
  });
});

describe('database invariants hold even if application code is bypassed', () => {
  it('the counter cannot skip, repeat or rewind through direct SQL', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    await alloc(org.id, fy.id, 'a');
    await alloc(org.id, fy.id, 'b'); // last = 2
    const set = (n: number) =>
      prisma.$executeRawUnsafe(
        `UPDATE document_sequences SET last_number = ${n} WHERE id = '${seq.id}'::uuid`,
      );
    await expect(set(4)).rejects.toThrow(/exactly one/); // skip
    await expect(set(1)).rejects.toThrow(/exactly one/); // rewind
    await expect(set(0)).rejects.toThrow(/exactly one/); // reset
    await expect(set(2)).resolves.toBeDefined(); // no change is harmless
    expect(
      (await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } })).lastNumber,
    ).toBe(2n);
  });

  it('ledger entries must match their sequence and cannot duplicate a number, a text or a document', async () => {
    const org = await mkOrg();
    const other = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    await alloc(org.id, fy.id, 'a'); // number 1
    const insert = (over: {
      n?: number;
      text?: string;
      ref?: string;
      org?: string;
      type?: string;
    }) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO document_number_allocations (organization_id, sequence_id, document_type, sequence_number, formatted_number, document_ref)
         VALUES ('${over.org ?? org.id}'::uuid, '${seq.id}'::uuid, '${over.type ?? 'INVOICE'}', ${over.n ?? 1}, '${over.text ?? 'T'}', '${over.ref ?? 'r'}')`,
      );
    await expect(insert({ n: 1 })).rejects.toThrow(/unique|duplicate/i); // same sequence number twice
    await expect(insert({ n: 5 })).rejects.toThrow(/does not match its sequence/); // beyond the counter
    await expect(insert({ n: 1, org: other.id })).rejects.toThrow(/does not match its sequence/);
    await expect(insert({ n: 1, type: 'CREDIT_NOTE' })).rejects.toThrow(
      /does not match its sequence/,
    );
    await expect(insert({ n: 0 })).rejects.toThrow();
    await expect(insert({ n: 1, text: 'INV/2026-27/000001', ref: 'z' })).rejects.toThrow(); // text or number already used
  });

  it('a naive read-then-write allocator with NO row lock still cannot commit a duplicate number', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    // Deliberately wrong code: no FOR UPDATE, so several transactions read the same "last" and race.
    const naive = (ref: string) =>
      prisma.$transaction(
        async (db) => {
          const [row] = await db.$queryRaw<
            { last_number: bigint }[]
          >`SELECT last_number FROM document_sequences WHERE id = ${seq.id}::uuid`;
          const next = row!.last_number + 1n;
          await new Promise((r) => setTimeout(r, 25)); // widen the race window
          await db.$executeRaw`UPDATE document_sequences SET last_number = ${next} WHERE id = ${seq.id}::uuid`;
          await db.$executeRaw`INSERT INTO document_number_allocations (organization_id, sequence_id, document_type, sequence_number, formatted_number, document_ref)
                               VALUES (${org.id}::uuid, ${seq.id}::uuid, 'INVOICE', ${next}, ${'NAIVE-' + next}, ${ref})`;
          return next;
        },
        { maxWait: 30_000, timeout: 60_000 },
      );
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => naive(`naive-${i}`)),
    );
    const ledger = await prisma.documentNumberAllocation.findMany({
      where: { sequenceId: seq.id },
      orderBy: { sequenceNumber: 'asc' },
    });
    const numbers = ledger.map((l) => l.sequenceNumber);
    expect(new Set(numbers).size).toBe(numbers.length); // never a duplicate number
    expect(new Set(ledger.map((l) => l.formattedNumber)).size).toBe(ledger.length);
    const current = await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } });
    expect(current.lastNumber).toBe(numbers.at(-1) ?? 0n); // counter matches what was recorded
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(ledger.length);
  });
});

describe('transactional allocation (same transaction as the document)', () => {
  const post = async (db: Db, orgId: string, fyId: string, id: string) => {
    const n = await svc.allocate(db, scopeOf(orgId, fyId), { documentRef: id });
    await db.$executeRaw`INSERT INTO test_posted_docs (id, status, number) VALUES (${id}, 'posted', ${n.number})`;
    return n;
  };

  it('commit: the document carries exactly the number the ledger recorded', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    await mkSeq(org.id, fy.id);
    const n = await tx((db) => post(db, org.id, fy.id, 'doc-commit'));
    const rows = await prisma.$queryRaw<
      { number: string }[]
    >`SELECT number FROM test_posted_docs WHERE id = 'doc-commit'`;
    expect(rows[0]!.number).toBe(n.number);
    expect(
      (
        await prisma.documentNumberAllocation.findFirstOrThrow({
          where: { documentRef: 'doc-commit' },
        })
      ).formattedNumber,
    ).toBe(n.number);
  });

  it('rollback after allocation: no document, no ledger row, counter unchanged; the number is simply issued next', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    await alloc(org.id, fy.id, 'before'); // 1
    await expect(
      tx(async (db) => {
        await post(db, org.id, fy.id, 'doc-rolled-back'); // would be 2, document inserted
        throw new Error('later step failed'); // e.g. the stock or journal posting failed
      }),
    ).rejects.toThrow('later step failed');
    expect(
      await prisma.$queryRaw`SELECT 1 FROM test_posted_docs WHERE id = 'doc-rolled-back'`,
    ).toHaveLength(0);
    expect(
      await prisma.documentNumberAllocation.count({ where: { documentRef: 'doc-rolled-back' } }),
    ).toBe(0);
    expect(
      (await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } })).lastNumber,
    ).toBe(1n);
    // Documented policy: a rolled-back allocation leaves no trace and no gap.
    expect((await alloc(org.id, fy.id, 'after')).number).toBe('INV/2026-27/000002');
    expect((await tx((db) => svc.findGaps(db, seq.id))).missing).toEqual([]);
  });

  it('drafts consume no numbers: only posting allocates', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    // 5 drafts are saved with internal ids only.
    for (let i = 0; i < 5; i++) {
      await prisma.$executeRaw`INSERT INTO test_posted_docs (id, status, number) VALUES (${'draft-' + org.id + i}, 'draft', NULL)`;
    }
    expect(
      (await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } })).lastNumber,
    ).toBe(0n);
    // Posting one of them allocates the first permanent number.
    const n = await tx((db) =>
      svc.allocate(db, scopeOf(org.id, fy.id), { documentRef: 'draft-' + org.id + 3 }),
    );
    expect(n.number).toBe('INV/2026-27/000001');
    expect(
      (await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } })).lastNumber,
    ).toBe(1n);
  });
});

describe('retries and idempotency', () => {
  it('the same document always gets the same number and consumes the sequence only once', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    const first = await alloc(org.id, fy.id, 'retry-doc');
    const again = await alloc(org.id, fy.id, ' retry-doc '); // retry after commit (reference is trimmed)
    expect(again).toMatchObject({ number: first.number, sequenceNumber: 1n, reused: true });
    const inOneTx = await tx(async (db) => {
      const a = await svc.allocate(db, scopeOf(org.id, fy.id), { documentRef: 'two-in-one' });
      const b = await svc.allocate(db, scopeOf(org.id, fy.id), { documentRef: 'two-in-one' });
      return [a, b];
    });
    expect(inOneTx.map((x) => [x.number, x.reused])).toEqual([
      ['INV/2026-27/000002', false],
      ['INV/2026-27/000002', true],
    ]);
    expect(
      (await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } })).lastNumber,
    ).toBe(2n);
  });

  it('ten simultaneous requests for the SAME document produce one number and nine reuses', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => alloc(org.id, fy.id, 'same-doc')),
    );
    expect(new Set(results.map((r) => r.number)).size).toBe(1);
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect(
      (await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } })).lastNumber,
    ).toBe(1n);
    expect(await prisma.documentNumberAllocation.count({ where: { sequenceId: seq.id } })).toBe(1);
  });

  it('different document types may share a reference; one document cannot be numbered from two years', async () => {
    const org = await mkOrg();
    const fy1 = await mkFy(org.id, '2026-27', '2026-04-01');
    const fy2 = await mkFy(org.id, '2027-28', '2027-04-01');
    await mkSeq(org.id, fy1.id, 'INVOICE');
    await mkSeq(org.id, fy2.id, 'INVOICE');
    await mkSeq(org.id, fy1.id, 'CREDIT_NOTE', { prefix: 'CN/{FY}/' });
    const inv = await alloc(org.id, fy1.id, 'shared-ref', 'INVOICE');
    const cn = await alloc(org.id, fy1.id, 'shared-ref', 'CREDIT_NOTE');
    expect([inv.number, cn.number]).toEqual(['INV/2026-27/000001', 'CN/2026-27/000001']);
    await expectCode(alloc(org.id, fy2.id, 'shared-ref', 'INVOICE'), 'document_already_numbered');
    expect(
      (await prisma.documentSequence.findFirstOrThrow({ where: { financialYearId: fy2.id } }))
        .lastNumber,
    ).toBe(0n);
  });

  it('a retry of the SAME document after its transaction rolled back receives the number the failed attempt would have had', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    await alloc(org.id, fy.id, 'before'); // number 1
    await expect(
      tx(async (db) => {
        const attempt = await svc.allocate(db, scopeOf(org.id, fy.id), {
          documentRef: 'retry-after-rollback',
        });
        expect(attempt.number).toBe('INV/2026-27/000002'); // what the failed attempt was given
        throw new Error('posting failed after numbering');
      }),
    ).rejects.toThrow('posting failed after numbering');
    // The failed attempt left nothing behind.
    expect(
      await prisma.documentNumberAllocation.count({
        where: { documentRef: 'retry-after-rollback' },
      }),
    ).toBe(0);
    expect(
      (await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } })).lastNumber,
    ).toBe(1n);
    // The retry of the same document is treated as a first allocation and gets that same number: no gap.
    const retry = await alloc(org.id, fy.id, 'retry-after-rollback');
    expect(retry).toMatchObject({
      number: 'INV/2026-27/000002',
      sequenceNumber: 2n,
      reused: false,
    });
    // A further retry (the response was lost) now reuses it.
    expect(await alloc(org.id, fy.id, 'retry-after-rollback')).toMatchObject({
      number: 'INV/2026-27/000002',
      reused: true,
    });
    expect(
      (await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } })).lastNumber,
    ).toBe(2n);
    expect((await tx((db) => svc.findGaps(db, seq.id))).missing).toEqual([]);
  });

  it('simultaneous requests for one document against TWO financial years issue exactly one number', async () => {
    const org = await mkOrg();
    const fy1 = await mkFy(org.id, '2026-27', '2026-04-01');
    const fy2 = await mkFy(org.id, '2027-28', '2027-04-01');
    const s1 = await mkSeq(org.id, fy1.id);
    const s2 = await mkSeq(org.id, fy2.id);
    const attempts = [fy1.id, fy2.id, fy1.id, fy2.id, fy1.id, fy2.id, fy1.id, fy2.id].map((fyId) =>
      alloc(org.id, fyId, 'two-years-one-document'),
    );
    const settled = await Promise.allSettled(attempts);
    // The sequences are different rows, so the requests do not queue on one lock; the database's unique
    // (organization, type, document) constraint decides the winner and every loser is rolled back cleanly.
    const ledger = await prisma.documentNumberAllocation.findMany({
      where: { documentRef: 'two-years-one-document' },
    });
    expect(ledger).toHaveLength(1);
    const winner = ledger[0]!;
    for (const r of settled) {
      if (r.status === 'fulfilled') expect(r.value.number).toBe(winner.formattedNumber);
      else {
        expect(r.reason).toBeInstanceOf(NumberingError);
        expect((r.reason as NumberingError).code).toBe('document_already_numbered');
      }
    }
    expect(settled.some((r) => r.status === 'fulfilled')).toBe(true);
    // Only the winning year's counter moved; the losers' increments were rolled back (no consumed numbers).
    const [c1, c2] = (
      await Promise.all(
        [s1, s2].map((s) => prisma.documentSequence.findUniqueOrThrow({ where: { id: s.id } })),
      )
    ).map((s) => s.lastNumber);
    expect([c1, c2].sort()).toEqual([0n, 1n]);
    expect(winner.sequenceNumber).toBe(1n);
  }, 120_000);

  it('a retry returns the original number even after the sequence was deactivated', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    const first = await alloc(org.id, fy.id, 'late-retry');
    await tx((db) =>
      svc.updateSequence(db, { sequenceId: seq.id, expectedVersion: seq.version, isActive: false }),
    );
    expect((await alloc(org.id, fy.id, 'late-retry')).number).toBe(first.number);
    await expectCode(alloc(org.id, fy.id, 'brand-new'), 'sequence_inactive');
  });
});

describe('concurrency', () => {
  it('40 parallel transactions on one sequence get 40 distinct consecutive numbers', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => alloc(org.id, fy.id, `par-${i}`)),
    );
    const numbers = results.map((r) => Number(r.sequenceNumber)).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(new Set(results.map((r) => r.number)).size).toBe(40);
    const row = await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } });
    expect(row.lastNumber).toBe(40n); // advanced exactly once per successful allocation
    expect(await prisma.documentNumberAllocation.count({ where: { sequenceId: seq.id } })).toBe(40);
    expect((await tx((db) => svc.findGaps(db, seq.id))).missing).toEqual([]);
  }, 120_000);

  it('rolled-back transactions among the parallel ones leave no gap and no duplicate', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        tx(async (db) => {
          const n = await svc.allocate(db, scopeOf(org.id, fy.id), { documentRef: `mix-${i}` });
          if (i % 3 === 0) throw new Error('rolled back');
          return n;
        }),
      ),
    );
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    expect(ok).toHaveLength(20);
    const row = await prisma.documentSequence.findUniqueOrThrow({ where: { id: seq.id } });
    expect(row.lastNumber).toBe(20n);
    const numbers = (
      await prisma.documentNumberAllocation.findMany({ where: { sequenceId: seq.id } })
    )
      .map((l) => Number(l.sequenceNumber))
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect((await tx((db) => svc.findGaps(db, seq.id))).missing).toEqual([]);
  }, 120_000);

  it('organizations, financial years and document types never interfere with each other', async () => {
    const orgs = [await mkOrg(), await mkOrg()];
    const types: DocumentTypeCode[] = ['INVOICE', 'CREDIT_NOTE'];
    const plan: { org: string; fy: string; type: DocumentTypeCode; seq: string }[] = [];
    for (const org of orgs) {
      for (const [label, start] of [
        ['2026-27', '2026-04-01'],
        ['2027-28', '2027-04-01'],
      ] as const) {
        const fy = await mkFy(org.id, label, start);
        for (const type of types) {
          const seq = await mkSeq(org.id, fy.id, type, { prefix: `${type.slice(0, 2)}/{FY}/` });
          plan.push({ org: org.id, fy: fy.id, type, seq: seq.id });
        }
      }
    }
    expect(plan).toHaveLength(8);
    const jobs = plan.flatMap((p) =>
      Array.from({ length: 12 }, (_, i) =>
        alloc(p.org, p.fy, `${p.seq}-${i}`, p.type).then((r) => ({ p, r })),
      ),
    );
    const done = await Promise.all(jobs);
    for (const p of plan) {
      const mine = done
        .filter((d) => d.p.seq === p.seq)
        .map((d) => Number(d.r.sequenceNumber))
        .sort((a, b) => a - b);
      expect(mine, p.seq).toEqual(Array.from({ length: 12 }, (_, i) => i + 1)); // each sequence: exactly 1..12
      expect(
        (await prisma.documentSequence.findUniqueOrThrow({ where: { id: p.seq } })).lastNumber,
      ).toBe(12n);
    }
    // Every printed number is globally unique per organization and document type.
    const all = await prisma.documentNumberAllocation.findMany({
      where: { organizationId: { in: orgs.map((o) => o.id) } },
    });
    const keys = all.map((a) => `${a.organizationId}|${a.documentType}|${a.formattedNumber}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(all).toHaveLength(96);
  }, 180_000);
});

describe('financial years', () => {
  it('a new year gets its own sequence; the previous year is untouched and still queryable', async () => {
    const org = await mkOrg();
    const fy1 = await mkFy(org.id, '2026-27', '2026-04-01');
    const fy2 = await mkFy(org.id, '2027-28', '2027-04-01');
    await mkSeq(org.id, fy1.id);
    await mkSeq(org.id, fy1.id, 'CREDIT_NOTE', { prefix: 'CN/{FY}/' });
    for (let i = 0; i < 3; i++) await alloc(org.id, fy1.id, `y1-${i}`);
    const before = await tx((db) =>
      svc.listSequences(db, { organizationId: org.id, financialYearId: fy1.id }),
    );

    const opened = await tx((db) =>
      svc.openFinancialYear(db, {
        organizationId: org.id,
        fromFinancialYearId: fy1.id,
        toFinancialYearId: fy2.id,
      }),
    );
    expect(opened.created.map((c) => c.documentType).sort()).toEqual(['CREDIT_NOTE', 'INVOICE']);
    expect(opened.skipped).toBe(0);

    expect((await alloc(org.id, fy2.id, 'y2-0')).number).toBe('INV/2027-28/000001'); // restarts at 1, new year label
    expect((await alloc(org.id, fy1.id, 'y1-late')).number).toBe('INV/2026-27/000004'); // old year continues independently
    const after = await tx((db) =>
      svc.listSequences(db, { organizationId: org.id, financialYearId: fy1.id }),
    );
    expect(after.find((s) => s.documentType === 'INVOICE')!.prefix).toBe(
      before.find((s) => s.documentType === 'INVOICE')!.prefix,
    );
    expect(after.find((s) => s.documentType === 'INVOICE')!.lastNumber).toBe(4n);
    const all = await tx((db) => svc.listSequences(db, { organizationId: org.id }));
    expect(all.map((s) => `${s.financialYearLabel}:${s.documentType}`)).toEqual([
      '2026-27:CREDIT_NOTE',
      '2026-27:INVOICE',
      '2027-28:CREDIT_NOTE',
      '2027-28:INVOICE',
    ]);
    // Historical postings never changed.
    expect(
      (await prisma.documentNumberAllocation.findFirstOrThrow({ where: { documentRef: 'y1-0' } }))
        .formattedNumber,
    ).toBe('INV/2026-27/000001');
  });

  it('opening a year is idempotent, and changing the new year does not touch the old one', async () => {
    const org = await mkOrg();
    const fy1 = await mkFy(org.id, '2026-27', '2026-04-01');
    const fy2 = await mkFy(org.id, '2027-28', '2027-04-01');
    await mkSeq(org.id, fy1.id);
    const input = {
      organizationId: org.id,
      fromFinancialYearId: fy1.id,
      toFinancialYearId: fy2.id,
    };
    expect((await tx((db) => svc.openFinancialYear(db, input))).created).toHaveLength(1);
    const again = await tx((db) => svc.openFinancialYear(db, input));
    expect(again).toMatchObject({ created: [], skipped: 1 });
    const [s2] = await tx((db) =>
      svc.listSequences(db, { organizationId: org.id, financialYearId: fy2.id }),
    );
    await tx((db) =>
      svc.updateSequence(db, {
        sequenceId: s2!.id,
        expectedVersion: s2!.version,
        prefix: 'NEW/{FY}/',
        numericLength: 7,
      }),
    );
    const [s1] = await tx((db) =>
      svc.listSequences(db, { organizationId: org.id, financialYearId: fy1.id }),
    );
    expect([s1!.prefix, s1!.numericLength]).toEqual(['INV/{FY}/', 6]);
    await expectCode(
      tx((db) => svc.openFinancialYear(db, { ...input, toFinancialYearId: fy1.id })),
      'invalid_configuration',
    );
  });

  it('reset policy NEVER continues the numbering across years; FINANCIAL_YEAR restarts it', async () => {
    const org = await mkOrg();
    const fy1 = await mkFy(org.id, '2026-27', '2026-04-01');
    const fy2 = await mkFy(org.id, '2027-28', '2027-04-01');
    await mkSeq(org.id, fy1.id, 'INVOICE', { prefix: 'INV/', resetPolicy: 'NEVER' });
    await mkSeq(org.id, fy1.id, 'CREDIT_NOTE', {
      prefix: 'CN/{FY}/',
      resetPolicy: 'FINANCIAL_YEAR',
    });
    for (let i = 0; i < 5; i++) {
      await alloc(org.id, fy1.id, `i-${i}`, 'INVOICE');
      await alloc(org.id, fy1.id, `c-${i}`, 'CREDIT_NOTE');
    }
    await tx((db) =>
      svc.openFinancialYear(db, {
        organizationId: org.id,
        fromFinancialYearId: fy1.id,
        toFinancialYearId: fy2.id,
      }),
    );
    expect((await alloc(org.id, fy2.id, 'i-next', 'INVOICE')).number).toBe('INV/000006'); // continues, text stays unique
    expect((await alloc(org.id, fy2.id, 'c-next', 'CREDIT_NOTE')).number).toBe('CN/2027-28/000001'); // restarts
  });

  it('a sequence format that would repeat across years fails at the database before any document is posted', async () => {
    const org = await mkOrg();
    const fy1 = await mkFy(org.id, '2026-27', '2026-04-01');
    const fy2 = await mkFy(org.id, '2027-28', '2027-04-01');
    // Created directly, bypassing the configuration rules, with the same literal text for both years.
    for (const fy of [fy1, fy2]) {
      await prisma.documentSequence.create({
        data: {
          organizationId: org.id,
          financialYearId: fy.id,
          documentType: 'INVOICE',
          prefix: 'INV/',
          numericLength: 6,
        },
      });
    }
    expect((await alloc(org.id, fy1.id, 'a')).number).toBe('INV/000001');
    await expectCode(alloc(org.id, fy2.id, 'b'), 'number_collision');
    const second = await prisma.documentSequence.findFirstOrThrow({
      where: { financialYearId: fy2.id },
    });
    expect(second.lastNumber).toBe(0n); // the failed allocation consumed nothing
  });
});

describe('business locations (an optional extra dimension)', () => {
  it('requires a location only when the organization numbers per location, and keeps them independent', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const mumbai = await prisma.businessLocation.create({
      data: { organizationId: org.id, name: 'Mumbai', addressLine1: 'x' },
    });
    const delhi = await prisma.businessLocation.create({
      data: { organizationId: org.id, name: 'Delhi', addressLine1: 'y' },
    });
    await mkSeq(org.id, fy.id); // organization-wide sequence
    // Not enabled: a location is rejected rather than silently ignored.
    await expectCode(
      tx((db) =>
        svc.allocate(
          db,
          { ...scopeOf(org.id, fy.id), locationId: mumbai.id },
          { documentRef: 'x' },
        ),
      ),
      'location_not_enabled',
    );
    expect((await alloc(org.id, fy.id, 'org-wide')).number).toBe('INV/2026-27/000001');

    await prisma.organizationSetting.create({
      data: { organizationId: org.id, key: 'numbering', value: { scopeByLocation: true } },
    });
    await mkSeq(org.id, fy.id, 'INVOICE', { locationId: mumbai.id, prefix: 'MUM/{FY}/' });
    await mkSeq(org.id, fy.id, 'INVOICE', { locationId: delhi.id, prefix: 'DEL/{FY}/' });
    await expectCode(alloc(org.id, fy.id, 'no-loc'), 'location_required');
    const at = (loc: string, ref: string) =>
      tx((db) =>
        svc.allocate(db, { ...scopeOf(org.id, fy.id), locationId: loc }, { documentRef: ref }),
      );
    expect((await at(mumbai.id, 'm1')).number).toBe('MUM/2026-27/000001');
    expect((await at(delhi.id, 'd1')).number).toBe('DEL/2026-27/000001');
    expect((await at(mumbai.id, 'm2')).number).toBe('MUM/2026-27/000002');
    await expect(mkSeq(org.id, fy.id, 'INVOICE', { locationId: mumbai.id })).rejects.toMatchObject({
      code: 'duplicate_sequence',
    });
  });

  it('rejects a duplicate organization-wide sequence (NULL location is covered by the partial unique index)', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    await mkSeq(org.id, fy.id);
    await expect(mkSeq(org.id, fy.id)).rejects.toMatchObject({ code: 'duplicate_sequence' });
  });
});

describe('gap report', () => {
  it('is empty for a healthy sequence and exposes numbers missing from the ledger if invariants were bypassed', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    for (let i = 0; i < 5; i++) await alloc(org.id, fy.id, `g-${i}`);
    expect(await tx((db) => svc.findGaps(db, seq.id))).toMatchObject({
      lastNumber: 5n,
      issued: 5,
      missing: [],
    });
    // Simulate corruption the way only a superuser could (triggers disabled for the session).
    await prisma.$transaction(async (db) => {
      await db.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await db.$executeRawUnsafe(
        `DELETE FROM document_number_allocations WHERE sequence_id = '${seq.id}'::uuid AND sequence_number IN (2, 4)`,
      );
    });
    expect(await tx((db) => svc.findGaps(db, seq.id))).toMatchObject({
      lastNumber: 5n,
      issued: 3,
      missing: [2n, 4n],
    });
  });

  it('an unused sequence has no gaps', async () => {
    const org = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const seq = await mkSeq(org.id, fy.id);
    expect(await tx((db) => svc.findGaps(db, seq.id))).toEqual({
      lastNumber: 0n,
      issued: 0,
      missing: [],
    });
  });
});

describe('configuration input rules', () => {
  it('createSequence rejects invalid formats, unknown types, foreign locations and reports problem codes only', async () => {
    const org = await mkOrg();
    const other = await mkOrg();
    const fy = await mkFy(org.id, '2026-27', '2026-04-01');
    const foreignLoc = await prisma.businessLocation.create({
      data: { organizationId: other.id, name: 'Elsewhere', addressLine1: 'z' },
    });
    const make = (over: Record<string, unknown>) =>
      tx((db) =>
        svc.createSequence(db, {
          organizationId: org.id,
          financialYearId: fy.id,
          documentType: 'INVOICE',
          prefix: 'INV/{FY}/',
          ...over,
        } as never),
      );
    await expectCode(make({ prefix: 'with space {FY}' }), 'invalid_configuration');
    await expectCode(make({ prefix: 'INV/' }), 'invalid_configuration'); // yearly reset needs {FY}
    await expectCode(make({ numericLength: 0 }), 'invalid_configuration');
    await expectCode(make({ startNumber: 0 }), 'invalid_configuration');
    await expectCode(make({ documentType: 'Tax invoice' }), 'unknown_document_type');
    await expectCode(make({ locationId: foreignLoc.id }), 'invalid_configuration');
    const err = (await make({ prefix: 'secret value' }).catch((e: unknown) => e)) as NumberingError;
    expect(err.problems).toEqual([{ field: 'prefix', rule: 'invalid_prefix' }]);
    expect(JSON.stringify(err.problems)).not.toContain('secret');
    expect(await prisma.documentSequence.count({ where: { organizationId: org.id } })).toBe(0);
  });
});
