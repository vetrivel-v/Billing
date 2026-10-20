/**
 * Exact decimal arithmetic for the tax engine: scaled BigInt integers, nothing else.
 *
 * NO JavaScript `number` is ever used for money, quantity or rates in this package (a test scans the source to keep it
 * that way). A decimal text is parsed into an integer count of its smallest unit; products of such integers are exact;
 * a division happens only at a NAMED rounding point (roundDiv) and rounds HALF-UP. Every amount in this package is
 * non-negative at a rounding point, so "half-up" and "half away from zero" coincide.
 */

/** Integer power of ten as a BigInt. */
export const pow10 = (n: number): bigint => BigInt('1' + '0'.repeat(n));

export interface Scaled {
  /** The value times 10^scale. */
  units: bigint;
  scale: number;
}

const PLAIN = /^\d+(\.\d+)?$/;

/**
 * Parses a non-negative plain decimal text. Returns null when it is not plain ("1e3", "-1", "1,5", ".5", "5."), has
 * more than `maxScale` decimal places after dropping trailing zeros, or has more than `maxIntegerDigits` integer digits.
 * The result is normalised to exactly `maxScale` places so callers can multiply without tracking scales.
 */
export function parseScaled(text: unknown, maxScale: number, maxIntegerDigits = 16): Scaled | null {
  if (typeof text !== 'string' || !PLAIN.test(text)) return null;
  const [whole = '0', frac = ''] = text.split('.');
  const trimmed = frac.replace(/0+$/, '');
  if (trimmed.length > maxScale) return null;
  const intPart = whole.replace(/^0+(?=\d)/, '');
  if (intPart.length > maxIntegerDigits) return null;
  return { units: BigInt(intPart + trimmed.padEnd(maxScale, '0')), scale: maxScale };
}

/** Half-up integer division of non-negative n by positive d. */
export function roundDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('roundDiv: divisor must be positive');
  if (n < 0n) throw new Error('roundDiv: negative numerators are not used at rounding points');
  return (2n * n + d) / (2n * d);
}

/** Money text with exactly two decimal places from a count of paise (may be negative for round-off only). */
export function formatPaise(paise: bigint): string {
  const neg = paise < 0n;
  const digits = (neg ? -paise : paise).toString().padStart(3, '0');
  return `${neg ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** Percent text from a value in units of 10^-places, trailing zeros removed but at least two decimals kept ("9.00", "0.125"). */
export function formatPercent(units: bigint, places: number): string {
  const digits = units.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  let frac = digits.slice(digits.length - places).replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${whole}.${frac}`;
}

/** Quantity text (up to 4 places) without needless zeros ("2.5", "10"). */
export function formatQuantityUnits(units: bigint): string {
  const digits = units.toString().padStart(5, '0');
  const frac = digits.slice(-4).replace(/0+$/, '');
  return `${digits.slice(0, -4)}${frac ? '.' + frac : ''}`;
}
