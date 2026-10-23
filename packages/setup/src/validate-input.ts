import {
  checkPassword,
  isValidUsername,
  normalizeUsername,
  type PasswordPolicy,
} from '@commercebill/auth';
import { setupSequencePlan, validateSequenceConfig } from '@commercebill/numbering';
import { INDIA_STATE_CODES } from './india-state-codes.js';
import { sellerRegistrationProblems } from './seller-rules.js';
import { FY_MAX_YEAR, FY_MIN_YEAR, isValidPinCode, parseIsoDate } from './validators.js';
import { problemsFromZod, setupInputSchema, type Problem, type SetupInput } from './schema.js';

export interface ValidatedSetupInput {
  business: {
    legalName: string;
    tradeName: string | null;
    businessType: string | null;
    pan: string | null;
    gstStatus: 'REGISTERED' | 'UNREGISTERED' | 'COMPOSITION';
    gstin: string | null;
    stateCode: string;
    stateName: string;
  };
  location: {
    name: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string | null;
    pinCode: string | null;
  };
  warehouse: { code: string; name: string };
  financialYearStart: Date;
  /** The numbering sequences to create for the first financial year (defaults applied). */
  sequences: ReturnType<typeof setupSequencePlan>;
  administrator: {
    username: string;
    displayName: string;
    email: string | null;
    /** Raw password: held in memory only, handed to the password hasher, never stored or logged. */
    password: string;
  };
}

export type ValidationResult =
  { ok: true; value: ValidatedSetupInput } | { ok: false; problems: Problem[] };

/**
 * Trims surrounding whitespace from every string so pasted values like " 27AAPF... " validate. The password is
 * NEVER trimmed (leading/trailing spaces can be part of a passphrase).
 */
function trimStrings(value: unknown, path: string[]): unknown {
  if (typeof value === 'string') {
    return path.join('.') === 'administrator.password' ? value : value.trim();
  }
  if (Array.isArray(value)) return value.map((v) => trimStrings(v, path));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        trimStrings(v, [...path, k]),
      ]),
    );
  }
  return value;
}

const clean = (s: string | undefined) => {
  const t = s?.normalize('NFC').trim();
  return t ? t : null;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WAREHOUSE_CODE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;

/**
 * Final server-side validation (the renderer is never trusted). Applies only the approved rules: PAN and
 * GSTIN format, GSTIN checksum, GSTIN/state and GSTIN/PAN consistency, GST status rules (registered requires
 * a GSTIN, unregistered must not have one), known state code, PIN format, required fields, financial-year
 * date, username shape and the password policy. Returns value-free problem codes.
 */
export function validateSetupInput(raw: unknown, passwordPolicy: PasswordPolicy): ValidationResult {
  const parsed = setupInputSchema.safeParse(trimStrings(raw, []));
  if (!parsed.success) return { ok: false, problems: problemsFromZod(parsed.error) };
  const input: SetupInput = parsed.data;
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });

  const legalName = clean(input.business.legalName);
  if (!legalName) add('business.legalName', 'required');

  const pan = clean(input.business.pan)?.toUpperCase() ?? null;
  const gstin = clean(input.business.gstin)?.toUpperCase() ?? null;
  const status = input.business.gstStatus;
  const stateCode = input.business.stateCode.trim();
  const stateName = INDIA_STATE_CODES[stateCode];
  // One shared rule set for PAN, GSTIN, GST status and state (also used by the Business Profile and the readiness check).
  for (const p of sellerRegistrationProblems({ gstStatus: status, gstin, pan, stateCode }))
    add(`business.${p.field}`, p.rule);

  const addressLine1 = clean(input.location.addressLine1);
  if (!addressLine1) add('location.addressLine1', 'required');
  const pinCode = clean(input.location.pinCode);
  if (pinCode && !isValidPinCode(pinCode)) add('location.pinCode', 'invalid_pin_code');

  const warehouseCode = clean(input.warehouse?.code)?.toUpperCase() ?? 'MAIN';
  if (!WAREHOUSE_CODE.test(warehouseCode)) add('warehouse.code', 'invalid_warehouse_code');

  const fyStart = parseIsoDate(input.financialYear.startDate.trim());
  if (!fyStart) add('financialYear.startDate', 'invalid_date');
  else if (fyStart.getUTCFullYear() < FY_MIN_YEAR || fyStart.getUTCFullYear() > FY_MAX_YEAR) {
    add('financialYear.startDate', 'date_out_of_range');
  }

  // Document numbering (spec section 17): same rules as the numbering engine itself.
  const sequences = setupSequencePlan(input.numbering);
  const seen = new Set<string>();
  for (const item of sequences) {
    for (const prob of validateSequenceConfig(item.config)) {
      const field =
        prob.field === 'startNumber'
          ? 'numbering.invoiceStartNumber'
          : prob.field === 'numericLength'
            ? 'numbering.numericWidth'
            : `numbering.${item.field}`;
      const key = `${field}:${prob.rule}`;
      if (!seen.has(key)) {
        seen.add(key);
        add(field, prob.rule);
      }
    }
  }

  const username = normalizeUsername(input.administrator.username);
  if (!isValidUsername(username)) add('administrator.username', 'invalid_username');
  const displayName = clean(input.administrator.displayName);
  if (!displayName) add('administrator.displayName', 'required');
  const email = clean(input.administrator.email);
  if (email && !EMAIL.test(email)) add('administrator.email', 'invalid_email');
  const policy = checkPassword(input.administrator.password, { username }, passwordPolicy);
  for (const p of policy.problems) add('administrator.password', p);

  if (
    problems.length > 0 ||
    !legalName ||
    !addressLine1 ||
    !fyStart ||
    !displayName ||
    !stateName
  ) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    value: {
      business: {
        legalName,
        tradeName: clean(input.business.tradeName),
        businessType: clean(input.business.businessType),
        pan,
        gstStatus: status,
        gstin,
        stateCode,
        stateName,
      },
      location: {
        name: clean(input.location.name) ?? 'Head Office',
        addressLine1,
        addressLine2: clean(input.location.addressLine2),
        city: clean(input.location.city),
        pinCode,
      },
      warehouse: { code: warehouseCode, name: clean(input.warehouse?.name) ?? 'Main Warehouse' },
      financialYearStart: fyStart,
      sequences,
      administrator: { username, displayName, email, password: input.administrator.password },
    },
  };
}
