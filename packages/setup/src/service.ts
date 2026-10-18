import type { AuthService } from '@commercebill/auth';
import { AuthServiceError } from '@commercebill/auth';
import type { Prisma, PrismaClient } from '@commercebill/database';
import { seedReferenceData } from '@commercebill/reference-data';
import {
  DRAFT_FORMAT_VERSION,
  MAX_DRAFT_BYTES,
  problemsFromZod,
  setupDraftDataSchema,
  storedDraftSchema,
  type Problem,
  type SetupDraftData,
} from './schema.js';
import { validateSetupInput } from './validate-input.js';
import { financialYearBounds } from './validators.js';

export const SETUP_DRAFT_KEY = 'setup.draft';
/** Audit actor for events that happen before any application user exists (distinct from a user's activity). */
export const BOOTSTRAP_ACTOR = 'system:bootstrap';
/** Arbitrary constant identifying the setup advisory lock; transaction-scoped, released on commit/rollback. */
export const SETUP_ADVISORY_LOCK_KEY = 7_241_001_001n;

export type SetupErrorCode = 'already_completed' | 'validation_failed' | 'draft_conflict';

export class SetupError extends Error {
  constructor(
    readonly code: SetupErrorCode,
    message: string,
    readonly problems: Problem[] = [],
  ) {
    super(message);
    this.name = 'SetupError';
  }
}

export type SetupStep =
  | 'lock'
  | 'organization'
  | 'settings'
  | 'location'
  | 'warehouse'
  | 'financial_year'
  | 'reference_data'
  | 'administrator'
  | 'draft_cleanup'
  | 'audit'
  | 'finalize';

export interface SetupHooks {
  /** Called after each step inside the completion transaction. Tests throw to prove all-or-nothing. */
  afterStep?(step: SetupStep): void | Promise<void>;
}

export interface SetupStatus {
  /** Authoritative: derived from organizations.setup_completed_at, never from the draft. */
  setupRequired: boolean;
  /** True only while setup is required AND a valid draft exists. */
  draftAvailable: boolean;
}

export interface DraftView {
  data: SetupDraftData;
  /** Row version for optimistic concurrency. */
  version: number;
  savedAt: string;
}

export interface SetupServiceOptions {
  prisma: PrismaClient;
  auth: AuthService;
  clock?: () => Date;
  appVersion?: string;
  hooks?: SetupHooks;
}

export interface SetupResult {
  organizationId: string;
  administratorUsername: string;
}

export function createSetupService(options: SetupServiceOptions) {
  const { prisma, auth } = options;
  const clock = options.clock ?? (() => new Date());
  const appVersion = options.appVersion ?? '0.0.0';

  async function isSetupRequired(): Promise<boolean> {
    // The database is the only authority. A draft (or its absence/corruption) never changes this.
    const completed = await prisma.organization.count({
      where: { setupCompletedAt: { not: null } },
    });
    return completed === 0;
  }

  function draftRow() {
    return prisma.applicationSetting.findFirst({
      where: { organizationId: null, key: SETUP_DRAFT_KEY },
    });
  }

  /**
   * Parses a stored draft. Anything that is not exactly the current format (corrupted, tampered, containing
   * unexpected keys such as a password, or written by another version) is rejected; there is intentionally
   * no best-effort recovery. Future format versions add explicit migration branches here.
   */
  function parseStored(value: unknown): SetupDraftData | null {
    const parsed = storedDraftSchema.safeParse(value);
    if (parsed.success) return parsed.data.data;
    // Example of a future migration: if (value.formatVersion === 1) return migrateV1ToV2(value) ...
    return null;
  }

  async function getStatus(): Promise<SetupStatus> {
    if (!(await isSetupRequired())) return { setupRequired: false, draftAvailable: false };
    const row = await draftRow();
    return { setupRequired: true, draftAvailable: Boolean(row && parseStored(row.value)) };
  }

  async function requireSetupOpen(): Promise<void> {
    if (!(await isSetupRequired())) {
      throw new SetupError('already_completed', 'Setup has already been completed.');
    }
  }

  /** Returns the saved draft. A corrupt/incompatible draft is deleted and reported as discarded. */
  async function getDraft(): Promise<{ draft: DraftView | null; discarded: boolean }> {
    await requireSetupOpen();
    const row = await draftRow();
    if (!row) return { draft: null, discarded: false };
    const data = parseStored(row.value);
    if (!data) {
      await prisma.applicationSetting.deleteMany({ where: { id: row.id } });
      return { draft: null, discarded: true };
    }
    return {
      draft: { data, version: row.version, savedAt: row.updatedAt.toISOString() },
      discarded: false,
    };
  }

  /**
   * Saves (replaces) the draft. Optimistic concurrency: the caller passes the version it last saw
   * (omit/0 for the first save); a stale version is a conflict. Only shape and size are validated.
   */
  async function saveDraft(
    raw: unknown,
    expectedVersion = 0,
  ): Promise<{ version: number; savedAt: string }> {
    await requireSetupOpen();
    const parsed = setupDraftDataSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SetupError(
        'validation_failed',
        'The draft is not valid.',
        problemsFromZod(parsed.error),
      );
    }
    const value = { formatVersion: DRAFT_FORMAT_VERSION, data: parsed.data };
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_DRAFT_BYTES) {
      throw new SetupError('validation_failed', 'The draft is too large.', [
        { field: '(root)', rule: 'too_large' },
      ]);
    }
    const conflict = () =>
      new SetupError('draft_conflict', 'The saved draft was changed elsewhere.');
    const row = await draftRow();
    if (!row) {
      if (expectedVersion !== 0) throw conflict();
      try {
        const created = await prisma.applicationSetting.create({
          data: { organizationId: null, key: SETUP_DRAFT_KEY, value },
        });
        return { version: created.version, savedAt: created.updatedAt.toISOString() };
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') throw conflict(); // concurrent first save
        throw err;
      }
    }
    // A corrupt stored draft is simply replaced; a valid one requires the matching version.
    if (parseStored(row.value) && row.version !== expectedVersion) throw conflict();
    const updated = await prisma.applicationSetting.updateMany({
      where: { id: row.id, version: row.version },
      data: { value, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw conflict();
    const fresh = await prisma.applicationSetting.findUniqueOrThrow({ where: { id: row.id } });
    return { version: fresh.version, savedAt: fresh.updatedAt.toISOString() };
  }

  /**
   * Final submission. Validates everything server-side, hashes the password OUTSIDE the transaction, then
   * creates every bootstrap record in ONE transaction. On any failure nothing is persisted, the saved draft
   * is untouched and setup can simply be retried. The administrator is NOT logged in: no session is created.
   */
  async function complete(
    raw: unknown,
    context: { correlationId?: string | null } = {},
  ): Promise<SetupResult> {
    const validation = validateSetupInput(raw, auth.config.password);
    if (!validation.ok) {
      throw new SetupError(
        'validation_failed',
        'The setup information is not valid.',
        validation.problems,
      );
    }
    const input = validation.value;
    // Cheap early refusal so replays do not trigger password hashing.
    await requireSetupOpen();

    let prepared;
    try {
      prepared = await auth.prepareNewUser({
        username: input.administrator.username,
        password: input.administrator.password,
      });
    } catch (err) {
      if (err instanceof AuthServiceError) {
        throw new SetupError('validation_failed', 'The administrator account is not valid.', [
          { field: 'administrator.username', rule: err.code },
        ]);
      }
      throw err;
    }

    const hooks = options.hooks;
    const now = clock();
    const fy = financialYearBounds(input.financialYearStart);

    return prisma.$transaction(
      async (tx: Prisma.TransactionClient): Promise<SetupResult> => {
        const step = async (name: SetupStep) => hooks?.afterStep?.(name);

        // 1. Serialise all setup attempts, then re-check the authoritative state INSIDE the lock so two
        //    simultaneous submissions cannot both pass the check.
        // (executeRaw: the function returns void, which Prisma's queryRaw cannot deserialize.)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETUP_ADVISORY_LOCK_KEY}::bigint)`;
        const alreadyDone = await tx.organization.count({
          where: { setupCompletedAt: { not: null } },
        });
        if (alreadyDone > 0)
          throw new SetupError('already_completed', 'Setup has already been completed.');
        await step('lock');

        // 2. Organization (completion timestamp is set last).
        const org = await tx.organization.create({
          data: {
            legalName: input.business.legalName,
            tradeName: input.business.tradeName,
            businessType: input.business.businessType,
            pan: input.business.pan,
            gstStatus: input.business.gstStatus,
            gstin: input.business.gstin,
            stateCode: input.business.stateCode,
            country: 'IN',
            baseCurrency: 'INR',
            isDemoData: false,
          },
        });
        await step('organization');

        // 3. Organization settings required by later tasks (time zone convention, setup provenance).
        await tx.organizationSetting.createMany({
          data: [
            {
              organizationId: org.id,
              key: 'locale',
              value: { country: 'IN', currency: 'INR', timeZone: 'Asia/Kolkata' },
            },
            {
              organizationId: org.id,
              key: 'setup',
              value: { schemaVersion: 1, completedWithAppVersion: appVersion },
            },
          ],
        });
        await step('settings');

        // 4. Primary business location.
        const location = await tx.businessLocation.create({
          data: {
            organizationId: org.id,
            name: input.location.name,
            addressLine1: input.location.addressLine1,
            addressLine2: input.location.addressLine2,
            city: input.location.city,
            state: input.business.stateName,
            stateCode: input.business.stateCode,
            country: 'IN',
            pinCode: input.location.pinCode,
            gstin: input.business.gstin,
            isPrimary: true,
          },
        });
        await step('location');

        // 5. Primary warehouse.
        await tx.warehouse.create({
          data: {
            organizationId: org.id,
            locationId: location.id,
            code: input.warehouse.code,
            name: input.warehouse.name,
            isPrimary: true,
          },
        });
        await step('warehouse');

        // 6. First financial year.
        await tx.financialYear.create({
          data: { organizationId: org.id, label: fy.label, startDate: fy.start, endDate: fy.end },
        });
        await step('financial_year');

        // 7. Reference data (permissions, the five role templates, units, UNREVIEWED tax placeholders).
        const seeded = await seedReferenceData(tx, { organizationId: org.id });
        await step('reference_data');

        // 8. First Administrator, assigned the seeded "Administrator" role (no duplicate role definitions).
        const admin = await auth.insertUser(
          tx,
          {
            organizationId: org.id,
            username: prepared.username,
            displayName: input.administrator.displayName,
            email: input.administrator.email,
            roleNames: ['Administrator'],
          },
          prepared,
          { system: BOOTSTRAP_ACTOR, correlationId: context.correlationId },
        );
        await step('administrator');

        // 9. The draft is convenience state: remove it with the commit.
        await tx.applicationSetting.deleteMany({
          where: { organizationId: null, key: SETUP_DRAFT_KEY },
        });
        await step('draft_cleanup');

        // 10. Bootstrap audit event. There is no authenticated user, so none is fabricated: userId stays
        //     null and the event is attributed to the system bootstrap actor. No secrets are recorded.
        await tx.auditLog.create({
          data: {
            organizationId: org.id,
            userId: null,
            category: 'security',
            action: 'setup.completed',
            entityType: 'organization',
            entityId: org.id,
            afterValues: {
              actor: BOOTSTRAP_ACTOR,
              administratorUserId: admin.id,
              gstStatus: input.business.gstStatus,
              financialYear: fy.label,
              referenceDataInserted: seeded.created,
            },
            appVersion,
            correlationId: context.correlationId ?? null,
            occurredAt: now,
          },
        });
        await step('audit');

        // 11. Mark setup complete last. From the commit onward the database says setup is done.
        await tx.organization.update({ where: { id: org.id }, data: { setupCompletedAt: now } });
        await step('finalize');

        return { organizationId: org.id, administratorUsername: admin.username };
      },
      { timeout: 60_000 },
    );
  }

  return { isSetupRequired, getStatus, getDraft, saveDraft, complete };
}

export type SetupService = ReturnType<typeof createSetupService>;
