import { z } from 'zod';

/**
 * Structural shapes for the setup wizard. Unknown keys are REJECTED (strict objects): that is the main
 * control keeping passwords, hashes, tokens and secrets out of the saved draft.
 */

const text = (max: number) => z.string().max(max);

export const GST_STATUSES = ['REGISTERED', 'UNREGISTERED', 'COMPOSITION'] as const;

const businessShape = {
  legalName: text(200),
  tradeName: text(200),
  businessType: text(100),
  pan: text(10),
  gstStatus: z.enum(GST_STATUSES),
  gstin: text(15),
  stateCode: text(2),
};
const locationShape = {
  name: text(100),
  addressLine1: text(200),
  addressLine2: text(200),
  city: text(100),
  pinCode: text(6),
};
const warehouseShape = { code: text(30), name: text(100) };
const financialYearShape = { startDate: text(10) };
const administratorIdentityShape = {
  username: text(64),
  displayName: text(100),
  email: text(254),
};

/** Final submission. `administrator.password` exists ONLY here, never in the draft. */
export const setupInputSchema = z.strictObject({
  business: z.strictObject({
    legalName: businessShape.legalName.min(1),
    tradeName: businessShape.tradeName.optional(),
    businessType: businessShape.businessType.optional(),
    pan: businessShape.pan.optional(),
    gstStatus: businessShape.gstStatus,
    gstin: businessShape.gstin.optional(),
    stateCode: businessShape.stateCode.min(1),
  }),
  location: z.strictObject({
    name: locationShape.name.optional(),
    addressLine1: locationShape.addressLine1.min(1),
    addressLine2: locationShape.addressLine2.optional(),
    city: locationShape.city.optional(),
    pinCode: locationShape.pinCode.optional(),
  }),
  warehouse: z
    .strictObject({ code: warehouseShape.code.optional(), name: warehouseShape.name.optional() })
    .optional(),
  financialYear: z.strictObject({ startDate: financialYearShape.startDate.min(1) }),
  administrator: z.strictObject({
    username: administratorIdentityShape.username.min(1),
    displayName: administratorIdentityShape.displayName.min(1),
    email: administratorIdentityShape.email.optional(),
    password: z.string().min(1).max(256),
  }),
});
export type SetupInput = z.infer<typeof setupInputSchema>;

/**
 * Draft = convenience state for resuming the wizard. Every field is optional and only shape/length is
 * checked (people save half-finished forms); business rules run again at completion. No password field
 * exists: sending one is a validation error, not silently dropped.
 */
export const setupDraftDataSchema = z.strictObject({
  business: z
    .strictObject({
      legalName: businessShape.legalName.optional(),
      tradeName: businessShape.tradeName.optional(),
      businessType: businessShape.businessType.optional(),
      pan: businessShape.pan.optional(),
      gstStatus: businessShape.gstStatus.optional(),
      gstin: businessShape.gstin.optional(),
      stateCode: businessShape.stateCode.optional(),
    })
    .optional(),
  location: z
    .strictObject({
      name: locationShape.name.optional(),
      addressLine1: locationShape.addressLine1.optional(),
      addressLine2: locationShape.addressLine2.optional(),
      city: locationShape.city.optional(),
      pinCode: locationShape.pinCode.optional(),
    })
    .optional(),
  warehouse: z
    .strictObject({ code: warehouseShape.code.optional(), name: warehouseShape.name.optional() })
    .optional(),
  financialYear: z.strictObject({ startDate: financialYearShape.startDate.optional() }).optional(),
  administrator: z
    .strictObject({
      username: administratorIdentityShape.username.optional(),
      displayName: administratorIdentityShape.displayName.optional(),
      email: administratorIdentityShape.email.optional(),
    })
    .optional(),
});
export type SetupDraftData = z.infer<typeof setupDraftDataSchema>;

/** Stored form of the draft. `formatVersion` lets a future release migrate or discard old drafts. */
export const DRAFT_FORMAT_VERSION = 1;
export const storedDraftSchema = z.strictObject({
  formatVersion: z.literal(DRAFT_FORMAT_VERSION),
  data: setupDraftDataSchema,
});
export type StoredDraft = z.infer<typeof storedDraftSchema>;

/** Maximum serialized draft size in bytes. */
export const MAX_DRAFT_BYTES = 16 * 1024;

export interface Problem {
  /** Dotted field path, e.g. "business.gstin". Never contains the submitted value. */
  field: string;
  /** Stable rule code, e.g. "invalid_pan_format". */
  rule: string;
}

/** Converts zod issues to value-free problems (zod messages can echo input in some cases, so use codes). */
export function problemsFromZod(error: z.ZodError): Problem[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    rule: issue.code === 'unrecognized_keys' ? 'unknown_field' : issue.code,
  }));
}
