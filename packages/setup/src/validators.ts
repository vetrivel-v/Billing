/**
 * Structural validators for Indian business identifiers. They check FORMAT and internal consistency only.
 * Passing them does NOT mean a PAN or GSTIN exists or belongs to the business (spec section 4); that can only
 * be confirmed by the authorities.
 */

export const GST_STATUSES = ['REGISTERED', 'UNREGISTERED', 'COMPOSITION'] as const;
export type GstStatus = (typeof GST_STATUSES)[number];

export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PIN_PATTERN = /^[1-9][0-9]{5}$/;

const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function isValidPanFormat(pan: string): boolean {
  return PAN_PATTERN.test(pan);
}

/**
 * GSTIN check character: mod-36 weighted checksum over the first 14 characters (published GSTN algorithm).
 * Returns undefined for input that is not 14+ characters of [0-9A-Z].
 */
export function gstinCheckCharacter(first14: string): string | undefined {
  if (!/^[0-9A-Z]{14}$/.test(first14)) return undefined;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_ALPHABET.indexOf(first14[i]!);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36];
}

export function isValidGstinChecksum(gstin: string): boolean {
  return gstin.length === 15 && gstinCheckCharacter(gstin.slice(0, 14)) === gstin[14];
}

export type GstinProblem = 'invalid_gstin_format' | 'invalid_gstin_checksum';

export function checkGstinStructure(gstin: string): GstinProblem | null {
  if (!GSTIN_PATTERN.test(gstin)) return 'invalid_gstin_format';
  if (!isValidGstinChecksum(gstin)) return 'invalid_gstin_checksum';
  return null;
}

export function isValidPinCode(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

/** Strict YYYY-MM-DD that is a real calendar date. Returns the date at UTC midnight, or null. */
export function parseIsoDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d)
    return null;
  return date;
}

/** A financial year runs from `start` for exactly one year (the day before its next anniversary). */
export function financialYearBounds(start: Date): { start: Date; end: Date; label: string } {
  const end = new Date(
    Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()) - 86_400_000,
  );
  const sy = start.getUTCFullYear();
  const ey = end.getUTCFullYear();
  const label = sy === ey ? String(sy) : `${sy}-${String(ey).slice(-2)}`;
  return { start, end, label };
}

export const FY_MIN_YEAR = 2000;
export const FY_MAX_YEAR = 2100;
