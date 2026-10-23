import type { Prisma, PrismaClient } from '@commercebill/database';
import type { BusinessProfileSaveResponse, BusinessProfileView } from '@commercebill/shared-types';
import { z } from 'zod';
import { INDIA_STATE_CODES } from './india-state-codes.js';
import { sellerRegistrationProblems } from './seller-rules.js';
import { GST_STATUSES, isValidPinCode } from './validators.js';
import type { Problem } from './schema.js';

/**
 * Business Profile (Settings, Business Profile; ADR-0030).
 *
 * Authoritative model: the LEGAL identity and the GST registration status live on the organization (legal name, trade name, business type,
 * PAN, GST status, GSTIN, state); the ADDRESS and the GST registration of the primary place of business live on the primary location
 * (name, address, city, state, PIN, GSTIN, state code). First-run setup writes the same GSTIN and state to both. Invoicing reads the
 * location's GSTIN/state first and the organization's second; the production gate reads the organization's. So this service never
 * changes one copy alone: a save updates the organization and its primary location in ONE transaction, and a failure changes neither.
 * Additional locations (future) keep their own registrations and are not touched here.
 *
 * Posted invoices carry an immutable copy of the seller taken at posting; nothing here reads or writes it.
 */

export type BusinessProfileErrorCode =
  'not_found' | 'validation_failed' | 'version_conflict' | 'duplicate_location_name';

export class BusinessProfileError extends Error {
  constructor(
    readonly code: BusinessProfileErrorCode,
    message: string,
    readonly problems: Problem[] = [],
  ) {
    super(message);
    this.name = 'BusinessProfileError';
  }
}

export interface BusinessProfileContext {
  userId: string;
  organizationId: string;
  correlationId?: string | null;
}

export interface BusinessProfileHooks {
  /** Test seam: runs inside the save transaction after the organization row changed (a throw must roll everything back). */
  afterOrganizationUpdate?: () => void | Promise<void>;
}

const text = (max: number) => z.string().max(max);

export const businessProfileInputSchema = z.strictObject({
  legalName: text(200),
  tradeName: text(200).nullish(),
  businessType: text(100).nullish(),
  pan: text(10).nullish(),
  gstStatus: z.enum(GST_STATUSES),
  gstin: text(15).nullish(),
  stateCode: text(2),
  location: z.strictObject({
    name: text(100),
    addressLine1: text(200),
    addressLine2: text(200).nullish(),
    city: text(100).nullish(),
    pinCode: text(6).nullish(),
  }),
  expectedVersion: z.int().min(1),
});

interface CleanProfile {
  legalName: string;
  tradeName: string | null;
  businessType: string | null;
  pan: string | null;
  gstStatus: (typeof GST_STATUSES)[number];
  gstin: string | null;
  stateCode: string;
  stateName: string;
  location: {
    name: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string | null;
    pinCode: string | null;
  };
  expectedVersion: number;
}

const clean = (s: string | null | undefined): string | null => {
  const t = s?.normalize('NFC').trim();
  return t ? t : null;
};

/** Server-side validation (the renderer is never trusted). Returns value-free problem codes. */
export function validateBusinessProfile(
  raw: unknown,
): { ok: true; value: CleanProfile } | { ok: false; problems: Problem[] } {
  const parsed = businessProfileInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => ({
        field: i.path.join('.') || 'body',
        rule:
          i.code === 'too_big' ? 'too_long' : i.code === 'invalid_type' ? 'required' : 'invalid',
      })),
    };
  }
  const i = parsed.data;
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });

  const legalName = clean(i.legalName);
  if (!legalName) add('legalName', 'required');
  const pan = clean(i.pan)?.toUpperCase() ?? null;
  const gstin = clean(i.gstin)?.toUpperCase() ?? null;
  const stateCode = i.stateCode.trim();
  for (const p of sellerRegistrationProblems({ gstStatus: i.gstStatus, gstin, pan, stateCode }))
    add(p.field, p.rule);

  const locName = clean(i.location.name);
  if (!locName) add('location.name', 'required');
  const addressLine1 = clean(i.location.addressLine1);
  if (!addressLine1) add('location.addressLine1', 'required');
  const pinCode = clean(i.location.pinCode);
  if (pinCode && !isValidPinCode(pinCode)) add('location.pinCode', 'invalid_pin_code');

  const stateName = INDIA_STATE_CODES[stateCode];
  if (problems.length > 0 || !legalName || !locName || !addressLine1 || !stateName)
    return { ok: false, problems };
  return {
    ok: true,
    value: {
      legalName,
      tradeName: clean(i.tradeName),
      businessType: clean(i.businessType),
      pan,
      gstStatus: i.gstStatus,
      gstin,
      stateCode,
      stateName,
      location: {
        name: locName,
        addressLine1,
        addressLine2: clean(i.location.addressLine2),
        city: clean(i.location.city),
        pinCode,
      },
      expectedVersion: i.expectedVersion,
    },
  };
}

/** Fields whose before/after values are kept in the audit trail (tax-significant identity). Others are recorded by NAME only. */
const TAX_FIELDS = ['pan', 'gstStatus', 'gstin', 'stateCode'] as const;

export interface BusinessProfileServiceOptions {
  prisma: PrismaClient;
  appVersion?: string;
  clock?: () => Date;
  hooks?: BusinessProfileHooks;
}

export function createBusinessProfileService(options: BusinessProfileServiceOptions) {
  const { prisma } = options;
  const clock = options.clock ?? (() => new Date());
  const appVersion = options.appVersion ?? '0.0.0';
  const hooks = options.hooks ?? {};
  type Db = PrismaClient | Prisma.TransactionClient;

  async function load(db: Db, organizationId: string) {
    const org = await db.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new BusinessProfileError('not_found', 'Business not found.');
    const location = await db.businessLocation.findFirst({
      where: { organizationId, isPrimary: true, isActive: true },
    });
    if (!location)
      throw new BusinessProfileError('not_found', 'Primary business location not found.');
    return { org, location };
  }

  function view(
    org: NonNullable<Awaited<ReturnType<typeof load>>>['org'],
    location: NonNullable<Awaited<ReturnType<typeof load>>>['location'],
    canEdit: boolean,
  ): BusinessProfileView {
    return {
      legalName: org.legalName,
      tradeName: org.tradeName,
      businessType: org.businessType,
      pan: org.pan,
      gstStatus: org.gstStatus,
      gstin: org.gstin,
      stateCode: org.stateCode ?? '',
      stateName: (org.stateCode && INDIA_STATE_CODES[org.stateCode]) || '',
      country: org.country,
      location: {
        name: location.name,
        addressLine1: location.addressLine1,
        addressLine2: location.addressLine2,
        city: location.city,
        pinCode: location.pinCode,
      },
      version: org.version,
      updatedAt: org.updatedAt.toISOString(),
      canEdit,
    };
  }

  async function get(organizationId: string, canEdit: boolean): Promise<BusinessProfileView> {
    const { org, location } = await load(prisma, organizationId);
    return view(org, location, canEdit);
  }

  async function save(
    ctx: BusinessProfileContext,
    raw: unknown,
  ): Promise<BusinessProfileSaveResponse> {
    const v = validateBusinessProfile(raw);
    if (!v.ok)
      throw new BusinessProfileError(
        'validation_failed',
        'Some details need correcting.',
        v.problems,
      );
    const next = v.value;

    return prisma.$transaction(async (tx) => {
      const { org, location } = await load(tx, ctx.organizationId);
      if (org.version !== next.expectedVersion)
        throw new BusinessProfileError(
          'version_conflict',
          'The business profile was changed by someone else.',
        );

      const before = {
        legalName: org.legalName,
        tradeName: org.tradeName,
        businessType: org.businessType,
        pan: org.pan,
        gstStatus: org.gstStatus,
        gstin: org.gstin,
        stateCode: org.stateCode ?? '',
        'location.name': location.name,
        'location.addressLine1': location.addressLine1,
        'location.addressLine2': location.addressLine2,
        'location.city': location.city,
        'location.pinCode': location.pinCode,
      };
      const after = {
        legalName: next.legalName,
        tradeName: next.tradeName,
        businessType: next.businessType,
        pan: next.pan,
        gstStatus: next.gstStatus,
        gstin: next.gstin,
        stateCode: next.stateCode,
        'location.name': next.location.name,
        'location.addressLine1': next.location.addressLine1,
        'location.addressLine2': next.location.addressLine2,
        'location.city': next.location.city,
        'location.pinCode': next.location.pinCode,
      };
      const changedFields = (Object.keys(after) as (keyof typeof after)[]).filter(
        (k) => before[k] !== after[k],
      );
      if (changedFields.length === 0) return { profile: view(org, location, true), changedFields };

      if (next.location.name !== location.name) {
        const clash = await tx.businessLocation.findFirst({
          where: {
            organizationId: ctx.organizationId,
            name: next.location.name,
            id: { not: location.id },
          },
          select: { id: true },
        });
        if (clash)
          throw new BusinessProfileError(
            'duplicate_location_name',
            'That location name is already used.',
            [{ field: 'location.name', rule: 'duplicate' }],
          );
      }

      // The organization and its primary location change together, or not at all.
      const updated = await tx.organization.updateMany({
        where: { id: org.id, version: org.version },
        data: {
          legalName: next.legalName,
          tradeName: next.tradeName,
          businessType: next.businessType,
          pan: next.pan,
          gstStatus: next.gstStatus,
          gstin: next.gstin,
          stateCode: next.stateCode,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1)
        throw new BusinessProfileError(
          'version_conflict',
          'The business profile was changed by someone else.',
        );
      await hooks.afterOrganizationUpdate?.();
      await tx.businessLocation.update({
        where: { id: location.id },
        data: {
          name: next.location.name,
          addressLine1: next.location.addressLine1,
          addressLine2: next.location.addressLine2,
          city: next.location.city,
          pinCode: next.location.pinCode,
          state: next.stateName,
          stateCode: next.stateCode,
          gstin: next.gstin,
          version: { increment: 1 },
        },
      });

      const taxChanged = TAX_FIELDS.filter((f) => changedFields.includes(f));
      const beforeValues: Record<string, string | null> = {};
      const afterValues: Record<string, string | string[] | null> = { changedFields };
      for (const f of taxChanged) {
        beforeValues[f] = before[f];
        afterValues[f] = after[f];
      }
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          category: 'business',
          action: 'organization.profile.update',
          entityType: 'organization',
          entityId: org.id,
          beforeValues: beforeValues as Prisma.InputJsonObject,
          afterValues: afterValues as Prisma.InputJsonObject,
          appVersion,
          correlationId: ctx.correlationId ?? null,
          occurredAt: clock(),
        },
      });

      const fresh = await load(tx, ctx.organizationId);
      return { profile: view(fresh.org, fresh.location, true), changedFields };
    });
  }

  return { get, save };
}

export type BusinessProfileService = ReturnType<typeof createBusinessProfileService>;
