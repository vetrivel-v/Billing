import type { Prisma } from '@commercebill/database';
import { DOCUMENT_TYPES, isDocumentTypeCode, type DocumentTypeCode } from './document-types.js';
import { formatDocumentNumber } from './format.js';
import {
  validateSequenceConfig,
  type Problem,
  type ResetPolicy,
  type SequenceConfig,
} from './validate.js';

/**
 * Transaction client. Every function runs on the CALLER's transaction so a number is allocated in the same
 * database transaction that posts the document: if that transaction rolls back, the counter, the ledger entry
 * and the document all disappear together (ADR-0016).
 */
export type Db = Prisma.TransactionClient;

export type NumberingErrorCode =
  | 'unknown_document_type'
  | 'invalid_configuration'
  | 'duplicate_sequence'
  | 'sequence_not_found'
  | 'sequence_inactive'
  | 'location_required'
  | 'location_not_enabled'
  | 'sequence_exhausted'
  | 'document_already_numbered'
  | 'number_collision'
  | 'start_number_locked'
  | 'stale_version';

export class NumberingError extends Error {
  constructor(
    readonly code: NumberingErrorCode,
    message: string,
    readonly problems: Problem[] = [],
  ) {
    super(message);
    this.name = 'NumberingError';
  }
}

export interface SequenceScope {
  organizationId: string;
  documentType: DocumentTypeCode;
  financialYearId: string;
  /** Required when the organization numbers per location, forbidden otherwise. */
  locationId?: string | null;
}

export interface AllocateOptions {
  /**
   * Identity of the document being posted (its internal id, never its number). Asking again for the same
   * document returns the SAME number instead of consuming another one (safe retries, ADR-0016).
   */
  documentRef: string;
  correlationId?: string | null;
}

export interface AllocatedNumber {
  /** The printed number, frozen in the ledger. */
  number: string;
  sequenceNumber: bigint;
  sequenceId: string;
  documentRef: string;
  /** True when this call found an existing allocation for the same document. */
  reused: boolean;
  allocatedAt: Date;
}

export interface SequenceView extends SequenceConfig {
  id: string;
  organizationId: string;
  locationId: string | null;
  financialYearId: string;
  financialYearLabel: string;
  documentType: string;
  lastNumber: bigint;
  isActive: boolean;
  version: number;
}

export interface Actor {
  userId?: string | null;
  correlationId?: string | null;
  system?: string | null;
}

export interface NumberingOptions {
  appVersion?: string;
  clock?: () => Date;
}

export interface NumberingSettings {
  /** When true, sequences are separate per business location and allocation must name the location. */
  scopeByLocation: boolean;
}

export const NUMBERING_SETTING_KEY = 'numbering';

interface SequenceRow {
  id: string;
  organization_id: string;
  location_id: string | null;
  financial_year_id: string;
  document_type: string;
  prefix: string;
  suffix: string;
  numeric_length: number;
  start_number: bigint;
  last_number: bigint;
  reset_policy: string;
  is_active: boolean;
  version: number;
}

const toConfig = (r: SequenceRow): SequenceConfig => ({
  prefix: r.prefix,
  suffix: r.suffix,
  numericLength: r.numeric_length,
  startNumber: r.start_number,
  resetPolicy: r.reset_policy as ResetPolicy,
});

const collision = () =>
  new NumberingError(
    'number_collision',
    'This number was already issued for the same document type. Check that the format includes the financial year.',
  );

export function createNumberingService(options: NumberingOptions = {}) {
  const clock = options.clock ?? (() => new Date());
  const appVersion = options.appVersion ?? '0.0.0';

  async function audit(
    db: Db,
    entry: {
      action: string;
      organizationId: string;
      entityId: string;
      before?: Prisma.InputJsonObject;
      after?: Prisma.InputJsonObject;
      actor?: Actor;
    },
  ): Promise<void> {
    await db.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        userId: entry.actor?.userId ?? null,
        category: 'configuration',
        action: entry.action,
        entityType: 'document_sequence',
        entityId: entry.entityId,
        beforeValues: entry.before,
        afterValues:
          entry.after || entry.actor?.system
            ? {
                ...(entry.after ?? {}),
                ...(entry.actor?.system ? { actor: entry.actor.system } : {}),
              }
            : undefined,
        appVersion,
        correlationId: entry.actor?.correlationId ?? null,
        occurredAt: clock(),
      },
    });
  }

  const describe = (c: SequenceConfig): Prisma.InputJsonObject => ({
    prefix: c.prefix,
    suffix: c.suffix,
    numericLength: c.numericLength,
    startNumber: c.startNumber.toString(),
    resetPolicy: c.resetPolicy,
  });

  async function getSettings(db: Db, organizationId: string): Promise<NumberingSettings> {
    const row = await db.organizationSetting.findUnique({
      where: { organizationId_key: { organizationId, key: NUMBERING_SETTING_KEY } },
    });
    const value = row?.value as { scopeByLocation?: unknown } | null | undefined;
    return { scopeByLocation: value?.scopeByLocation === true };
  }

  async function lockSequence(db: Db, scope: SequenceScope): Promise<SequenceRow | null> {
    // FOR UPDATE: concurrent transactions queue on this row, so each sees the previous one's committed
    // counter. This is the PostgreSQL lock that guarantees uniqueness - there is no in-process lock.
    const rows =
      scope.locationId == null
        ? await db.$queryRaw<SequenceRow[]>`
            SELECT id, organization_id, location_id, financial_year_id, document_type, prefix, suffix,
                   numeric_length, start_number, last_number, reset_policy, is_active, version
              FROM document_sequences
             WHERE organization_id = ${scope.organizationId}::uuid
               AND financial_year_id = ${scope.financialYearId}::uuid
               AND document_type = ${scope.documentType}
               AND location_id IS NULL
               FOR UPDATE`
        : await db.$queryRaw<SequenceRow[]>`
            SELECT id, organization_id, location_id, financial_year_id, document_type, prefix, suffix,
                   numeric_length, start_number, last_number, reset_policy, is_active, version
              FROM document_sequences
             WHERE organization_id = ${scope.organizationId}::uuid
               AND financial_year_id = ${scope.financialYearId}::uuid
               AND document_type = ${scope.documentType}
               AND location_id = ${scope.locationId}::uuid
               FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * Allocates the next permanent number for a document that is being POSTED, on the caller's transaction.
   * Drafts must NOT call this: a draft carries only its internal id, and the permanent number is allocated
   * when the document is posted, so abandoned drafts never consume numbers (spec section 17).
   *
   * Policy (ADR-0016): the counter update and the ledger row are part of the caller's transaction. If it rolls
   * back, both vanish and the number is simply issued to the next document - no gap is created by failures.
   * A committed allocation is permanent and is never reissued, even if its document is later cancelled.
   */
  async function allocate(
    db: Db,
    scope: SequenceScope,
    allocateOptions: AllocateOptions,
  ): Promise<AllocatedNumber> {
    if (!isDocumentTypeCode(scope.documentType)) {
      throw new NumberingError('unknown_document_type', 'Unknown document type.');
    }
    const documentRef = allocateOptions.documentRef?.trim();
    if (!documentRef || documentRef.length > 200) {
      throw new NumberingError('invalid_configuration', 'A document reference is required.', [
        { field: 'documentRef', rule: 'required' },
      ]);
    }
    const settings = await getSettings(db, scope.organizationId);
    if (settings.scopeByLocation && !scope.locationId) {
      throw new NumberingError(
        'location_required',
        'This organization numbers documents per location.',
      );
    }
    if (!settings.scopeByLocation && scope.locationId) {
      throw new NumberingError('location_not_enabled', 'Per-location numbering is not enabled.');
    }

    const seq = await lockSequence(db, scope);
    if (!seq)
      throw new NumberingError(
        'sequence_not_found',
        'No numbering sequence is configured for this document.',
      );

    // Idempotent retry: the same document always gets the same number.
    const existing = await db.documentNumberAllocation.findUnique({
      where: {
        organizationId_documentType_documentRef: {
          organizationId: scope.organizationId,
          documentType: scope.documentType,
          documentRef,
        },
      },
    });
    if (existing) {
      if (existing.sequenceId !== seq.id) {
        throw new NumberingError(
          'document_already_numbered',
          'This document already has a number from a different sequence.',
        );
      }
      return {
        number: existing.formattedNumber,
        sequenceNumber: existing.sequenceNumber,
        sequenceId: seq.id,
        documentRef,
        reused: true,
        allocatedAt: existing.allocatedAt,
      };
    }

    if (!seq.is_active)
      throw new NumberingError('sequence_inactive', 'This numbering sequence is inactive.');

    const next = seq.last_number === 0n ? seq.start_number : seq.last_number + 1n;
    if (next.toString().length > seq.numeric_length) {
      throw new NumberingError(
        'sequence_exhausted',
        'The numbering sequence has reached its maximum width.',
      );
    }
    const fy = await db.financialYear.findUniqueOrThrow({
      where: { id: seq.financial_year_id },
      select: { label: true },
    });
    const number = formatDocumentNumber({
      prefix: seq.prefix,
      suffix: seq.suffix,
      numericLength: seq.numeric_length,
      number: next,
      financialYearLabel: fy.label,
    });

    // Precise error for the common misconfiguration (two years producing the same text), found before any write.
    const clash = await db.documentNumberAllocation.findUnique({
      where: {
        organizationId_documentType_formattedNumber: {
          organizationId: scope.organizationId,
          documentType: scope.documentType,
          formattedNumber: number,
        },
      },
    });
    if (clash) throw collision();

    await db.documentSequence.update({ where: { id: seq.id }, data: { lastNumber: next } });
    try {
      const row = await db.documentNumberAllocation.create({
        data: {
          organizationId: scope.organizationId,
          sequenceId: seq.id,
          documentType: scope.documentType,
          sequenceNumber: next,
          formattedNumber: number,
          documentRef,
          correlationId: allocateOptions.correlationId ?? null,
          allocatedAt: clock(),
        },
      });
      return {
        number,
        sequenceNumber: next,
        sequenceId: seq.id,
        documentRef,
        reused: false,
        allocatedAt: row.allocatedAt,
      };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        // Only reachable under a race with another sequence (the pre-check above handles the normal case).
        const e = err as { message?: string; meta?: unknown; cause?: unknown };
        const text = `${e.message ?? ''} ${JSON.stringify(e.meta ?? {})} ${JSON.stringify(e.cause ?? {})}`;
        if (text.includes('formatted_number') || text.includes('document_type_f_key'))
          throw collision();
        throw new NumberingError(
          'document_already_numbered',
          'This document already has a number.',
        );
      }
      throw err;
    }
  }

  async function createSequence(
    db: Db,
    input: {
      organizationId: string;
      financialYearId: string;
      documentType: string;
      locationId?: string | null;
      prefix: string;
      suffix?: string;
      numericLength?: number;
      startNumber?: bigint | number;
      resetPolicy?: ResetPolicy;
    },
    actor: Actor = {},
  ): Promise<SequenceView> {
    if (!isDocumentTypeCode(input.documentType)) {
      throw new NumberingError('unknown_document_type', 'Unknown document type.');
    }
    const config: SequenceConfig = {
      prefix: input.prefix,
      suffix: input.suffix ?? '',
      numericLength: input.numericLength ?? 6,
      startNumber: BigInt(input.startNumber ?? 1),
      resetPolicy: input.resetPolicy ?? 'FINANCIAL_YEAR',
    };
    const problems = validateSequenceConfig(config);
    if (problems.length > 0) {
      throw new NumberingError(
        'invalid_configuration',
        'The numbering configuration is not valid.',
        problems,
      );
    }
    const fy = await db.financialYear.findFirst({
      where: { id: input.financialYearId, organizationId: input.organizationId },
    });
    if (!fy)
      throw new NumberingError('invalid_configuration', 'Financial year not found.', [
        { field: 'financialYearId', rule: 'not_found' },
      ]);
    if (input.locationId) {
      const loc = await db.businessLocation.findFirst({
        where: { id: input.locationId, organizationId: input.organizationId },
      });
      if (!loc)
        throw new NumberingError('invalid_configuration', 'Location not found.', [
          { field: 'locationId', rule: 'not_found' },
        ]);
    }
    try {
      const row = await db.documentSequence.create({
        data: {
          organizationId: input.organizationId,
          financialYearId: input.financialYearId,
          locationId: input.locationId ?? null,
          documentType: input.documentType,
          prefix: config.prefix,
          suffix: config.suffix,
          numericLength: config.numericLength,
          startNumber: config.startNumber,
          resetPolicy: config.resetPolicy,
        },
      });
      await audit(db, {
        action: 'numbering.sequence.created',
        organizationId: input.organizationId,
        entityId: row.id,
        after: { documentType: input.documentType, financialYear: fy.label, ...describe(config) },
        actor,
      });
      return viewOf(row, fy.label);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new NumberingError(
          'duplicate_sequence',
          'A sequence already exists for this document type, year and location.',
        );
      }
      throw err;
    }
  }

  function viewOf(
    row: {
      id: string;
      organizationId: string;
      locationId: string | null;
      financialYearId: string;
      documentType: string;
      prefix: string;
      suffix: string;
      numericLength: number;
      startNumber: bigint;
      lastNumber: bigint;
      resetPolicy: string;
      isActive: boolean;
      version: number;
    },
    financialYearLabel: string,
  ): SequenceView {
    return {
      id: row.id,
      organizationId: row.organizationId,
      locationId: row.locationId,
      financialYearId: row.financialYearId,
      financialYearLabel,
      documentType: row.documentType,
      prefix: row.prefix,
      suffix: row.suffix,
      numericLength: row.numericLength,
      startNumber: row.startNumber,
      resetPolicy: row.resetPolicy as ResetPolicy,
      lastNumber: row.lastNumber,
      isActive: row.isActive,
      version: row.version,
    };
  }

  /**
   * Changes the configuration of a sequence. Only FUTURE numbers are affected: numbers already issued are frozen
   * in the allocation ledger and are never renumbered. The start number can only change before the first number
   * is issued. Uses optimistic concurrency (expectedVersion) on top of the row lock.
   */
  async function updateSequence(
    db: Db,
    input: {
      sequenceId: string;
      expectedVersion: number;
      prefix?: string;
      suffix?: string;
      numericLength?: number;
      startNumber?: bigint | number;
      resetPolicy?: ResetPolicy;
      isActive?: boolean;
    },
    actor: Actor = {},
  ): Promise<SequenceView> {
    const rows = await db.$queryRaw<SequenceRow[]>`
      SELECT id, organization_id, location_id, financial_year_id, document_type, prefix, suffix,
             numeric_length, start_number, last_number, reset_policy, is_active, version
        FROM document_sequences WHERE id = ${input.sequenceId}::uuid FOR UPDATE`;
    const current = rows[0];
    if (!current) throw new NumberingError('sequence_not_found', 'Sequence not found.');
    if (current.version !== input.expectedVersion) {
      throw new NumberingError(
        'stale_version',
        'The sequence was changed elsewhere. Reload and try again.',
      );
    }
    const before = toConfig(current);
    const after: SequenceConfig = {
      prefix: input.prefix ?? before.prefix,
      suffix: input.suffix ?? before.suffix,
      numericLength: input.numericLength ?? before.numericLength,
      startNumber: input.startNumber === undefined ? before.startNumber : BigInt(input.startNumber),
      resetPolicy: input.resetPolicy ?? before.resetPolicy,
    };
    if (current.last_number > 0n && after.startNumber !== before.startNumber) {
      throw new NumberingError(
        'start_number_locked',
        'The start number cannot change after numbers have been issued.',
      );
    }
    const problems = validateSequenceConfig(after);
    if (current.last_number.toString().length > after.numericLength && current.last_number > 0n) {
      problems.push({ field: 'numericLength', rule: 'width_below_issued_numbers' });
    }
    if (problems.length > 0) {
      throw new NumberingError(
        'invalid_configuration',
        'The numbering configuration is not valid.',
        problems,
      );
    }
    const row = await db.documentSequence.update({
      where: { id: current.id },
      data: {
        prefix: after.prefix,
        suffix: after.suffix,
        numericLength: after.numericLength,
        startNumber: after.startNumber,
        resetPolicy: after.resetPolicy,
        isActive: input.isActive ?? current.is_active,
        version: { increment: 1 },
      },
      include: { financialYear: { select: { label: true } } },
    });
    await audit(db, {
      action: 'numbering.sequence.updated',
      organizationId: current.organization_id,
      entityId: current.id,
      before: { ...describe(before), isActive: current.is_active },
      after: { ...describe(after), isActive: row.isActive },
      actor,
    });
    return viewOf(row, row.financialYear.label);
  }

  async function listSequences(
    db: Db,
    filter: {
      organizationId: string;
      financialYearId?: string;
      documentType?: string;
      includeInactive?: boolean;
    },
  ): Promise<SequenceView[]> {
    const rows = await db.documentSequence.findMany({
      where: {
        organizationId: filter.organizationId,
        ...(filter.financialYearId ? { financialYearId: filter.financialYearId } : {}),
        ...(filter.documentType ? { documentType: filter.documentType } : {}),
        ...(filter.includeInactive === false ? { isActive: true } : {}),
      },
      include: { financialYear: { select: { label: true, startDate: true } } },
      orderBy: [{ financialYear: { startDate: 'asc' } }, { documentType: 'asc' }],
    });
    return rows.map((r) => viewOf(r, r.financialYear.label));
  }

  /**
   * Starts numbering for a new financial year by deriving sequences from the previous year's ACTIVE ones.
   * FINANCIAL_YEAR reset -> restarts at 1; NEVER -> continues after the previous year's last number. The previous
   * year's sequences and all issued numbers are untouched. Idempotent: sequences that already exist are skipped.
   */
  async function openFinancialYear(
    db: Db,
    input: { organizationId: string; fromFinancialYearId: string; toFinancialYearId: string },
    actor: Actor = {},
  ): Promise<{ created: SequenceView[]; skipped: number }> {
    if (input.fromFinancialYearId === input.toFinancialYearId) {
      throw new NumberingError('invalid_configuration', 'The two financial years must differ.');
    }
    const previous = await db.$queryRaw<SequenceRow[]>`
      SELECT id, organization_id, location_id, financial_year_id, document_type, prefix, suffix,
             numeric_length, start_number, last_number, reset_policy, is_active, version
        FROM document_sequences
       WHERE organization_id = ${input.organizationId}::uuid
         AND financial_year_id = ${input.fromFinancialYearId}::uuid
         AND is_active
       ORDER BY id
         FOR UPDATE`;
    const created: SequenceView[] = [];
    let skipped = 0;
    for (const p of previous) {
      const exists = await db.documentSequence.findFirst({
        where: {
          organizationId: input.organizationId,
          financialYearId: input.toFinancialYearId,
          documentType: p.document_type,
          locationId: p.location_id,
        },
      });
      if (exists) {
        skipped++;
        continue;
      }
      const startNumber =
        p.reset_policy === 'NEVER'
          ? p.last_number === 0n
            ? p.start_number
            : p.last_number + 1n
          : 1n;
      created.push(
        await createSequence(
          db,
          {
            organizationId: input.organizationId,
            financialYearId: input.toFinancialYearId,
            documentType: p.document_type,
            locationId: p.location_id,
            prefix: p.prefix,
            suffix: p.suffix,
            numericLength: p.numeric_length,
            startNumber,
            resetPolicy: p.reset_policy as ResetPolicy,
          },
          actor,
        ),
      );
    }
    return { created, skipped };
  }

  /**
   * Gap report over the allocation ledger: numbers between the start number and the counter that were never
   * recorded. With transactional allocation this is empty; a non-empty result means the invariants were bypassed.
   */
  async function findGaps(
    db: Db,
    sequenceId: string,
  ): Promise<{ lastNumber: bigint; issued: number; missing: bigint[] }> {
    const seq = await db.documentSequence.findUniqueOrThrow({ where: { id: sequenceId } });
    const issued = await db.documentNumberAllocation.count({ where: { sequenceId } });
    if (seq.lastNumber === 0n) return { lastNumber: 0n, issued, missing: [] };
    const missing = await db.$queryRaw<{ n: bigint }[]>`
      SELECT g AS n
        FROM generate_series(${seq.startNumber}::bigint, ${seq.lastNumber}::bigint) AS g
        LEFT JOIN document_number_allocations a ON a.sequence_id = ${sequenceId}::uuid AND a.sequence_number = g
       WHERE a.id IS NULL
       ORDER BY g
       LIMIT 1000`;
    return { lastNumber: seq.lastNumber, issued, missing: missing.map((m) => m.n) };
  }

  return {
    getSettings,
    allocate,
    createSequence,
    updateSequence,
    listSequences,
    openFinancialYear,
    findGaps,
  };
}

export type NumberingService = ReturnType<typeof createNumberingService>;

// ---------------------------------------------------------------------------------------------------------
// First-run setup helpers

export interface SetupNumberingInput {
  invoicePrefix?: string;
  invoiceStartNumber?: number;
  creditNotePrefix?: string;
  debitNotePrefix?: string;
  purchasePrefix?: string;
  paymentPrefix?: string;
  demoInvoicePrefix?: string;
  demoPaymentPrefix?: string;
  numericWidth?: number;
}

export const SETUP_PREFIX_FIELDS = {
  invoicePrefix: 'INVOICE',
  demoInvoicePrefix: 'DEMO_INVOICE',
  creditNotePrefix: 'CREDIT_NOTE',
  debitNotePrefix: 'DEBIT_NOTE',
  purchasePrefix: 'PURCHASE_ORDER',
  paymentPrefix: 'PAYMENT_RECEIPT',
  demoPaymentPrefix: 'DEMO_PAYMENT_RECEIPT',
} as const satisfies Record<string, DocumentTypeCode>;

/** The sequences first-run setup creates for the first financial year, from the (optional) wizard answers. */
export function setupSequencePlan(input: SetupNumberingInput = {}): {
  documentType: DocumentTypeCode;
  field: keyof typeof SETUP_PREFIX_FIELDS;
  config: SequenceConfig;
}[] {
  return (Object.keys(SETUP_PREFIX_FIELDS) as (keyof typeof SETUP_PREFIX_FIELDS)[]).map((field) => {
    const documentType = SETUP_PREFIX_FIELDS[field];
    return {
      documentType,
      field,
      config: {
        prefix: input[field] ?? DOCUMENT_TYPES[documentType].defaultPrefix,
        suffix: '',
        numericLength: input.numericWidth ?? 6,
        startNumber: BigInt(documentType === 'INVOICE' ? (input.invoiceStartNumber ?? 1) : 1),
        resetPolicy: 'FINANCIAL_YEAR' as const,
      },
    };
  });
}
