/**
 * Exact stock quantities. A quantity is a decimal STRING end to end (client -> API -> numeric(18,4)); nothing here (or
 * anywhere that decides stock) converts it through a JavaScript number. Pure functions, safe for the browser.
 *
 * Precision (ADR-0022): the ledger stores 4 decimal places. A unit of measure may allow fewer (PCS 0, KG 3); a value
 * with more places than the unit allows is REFUSED, never rounded.
 */

/** Decimal places the ledger can store. */
export const QUANTITY_SCALE = 4;
/** Integer digits allowed in one movement (a balance column has 14). */
export const QUANTITY_MAX_INTEGER_DIGITS = 12;

export type QuantityRule =
  | 'required'
  | 'invalid_quantity'
  | 'quantity_must_be_positive'
  | 'unsupported_precision'
  | 'too_many_decimals'
  | 'quantity_too_large';

const PLAIN = /^\d+(\.\d+)?$/;

/**
 * Validates a positive quantity against the unit's decimal places and returns its canonical text (no leading zeros, no
 * trailing zeros, no exponent): "007.50" -> "7.5". Numbers are NOT accepted: only text keeps every digit.
 */
export function parseQuantity(
  raw: unknown,
  unitDecimalPlaces: number = QUANTITY_SCALE,
): { ok: true; value: string } | { ok: false; rule: QuantityRule } {
  if (raw === undefined || raw === null || raw === '') return { ok: false, rule: 'required' };
  if (typeof raw !== 'string') return { ok: false, rule: 'invalid_quantity' };
  const s = raw.trim();
  if (s === '') return { ok: false, rule: 'required' };
  if (/^-\d/.test(s) && PLAIN.test(s.slice(1)))
    return { ok: false, rule: 'quantity_must_be_positive' };
  if (!PLAIN.test(s)) return { ok: false, rule: 'invalid_quantity' };
  const [whole = '0', frac = ''] = s.split('.');
  const places = frac.replace(/0+$/, '').length;
  if (places > QUANTITY_SCALE) return { ok: false, rule: 'unsupported_precision' };
  if (places > Math.min(unitDecimalPlaces, QUANTITY_SCALE)) {
    return { ok: false, rule: 'too_many_decimals' };
  }
  const intPart = whole.replace(/^0+(?=\d)/, '');
  if (intPart.length > QUANTITY_MAX_INTEGER_DIGITS)
    return { ok: false, rule: 'quantity_too_large' };
  const fracPart = frac.replace(/0+$/, '');
  if (/^0*$/.test(intPart) && fracPart === '')
    return { ok: false, rule: 'quantity_must_be_positive' };
  return { ok: true, value: fracPart ? `${intPart}.${fracPart}` : intPart };
}

/** Scaled integer (value x 10^4) of a canonical or database decimal text. BigInt keeps every digit. */
function toScaled(text: string): bigint {
  const neg = text.startsWith('-');
  const [whole = '0', frac = ''] = (neg ? text.slice(1) : text).split('.');
  const n = BigInt(whole + frac.padEnd(QUANTITY_SCALE, '0').slice(0, QUANTITY_SCALE));
  return neg ? -n : n;
}

function fromScaled(n: bigint): string {
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(QUANTITY_SCALE + 1, '0');
  const whole = digits.slice(0, -QUANTITY_SCALE);
  const frac = digits.slice(-QUANTITY_SCALE).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Exact sum of two quantity texts, as canonical text. Used by the UI preview only; the server always recomputes. */
export function addQuantities(a: string, b: string): string {
  return fromScaled(toScaled(a) + toScaled(b));
}

/** Exact comparison: negative, zero or positive like a - b. */
export function compareQuantities(a: string, b: string): number {
  const d = toScaled(a) - toScaled(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** Canonical text of a database/decimal value: trailing zeros removed ("2.5000" -> "2.5", "10.0000" -> "10"). */
export function canonicalQuantity(text: string): string {
  return fromScaled(toScaled(text));
}

/**
 * Display form: exact value without needless zeros, integer part in Indian grouping ("12,34,567.25"). A sign is kept.
 * Non-decimal input is echoed unchanged rather than guessed at.
 */
export function formatQuantity(text: string | null | undefined): string {
  if (text === null || text === undefined || text === '') return '';
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text;
  const c = canonicalQuantity(text);
  const neg = c.startsWith('-');
  const [whole = '0', frac] = (neg ? c.slice(1) : c).split('.');
  const grouped =
    whole.length <= 3
      ? whole
      : whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3);
  return `${neg ? '-' : ''}${grouped}${frac ? '.' + frac : ''}`;
}
