/**
 * Display helpers for decimal STRINGS. No JavaScript number is ever used for money: the document only shows values that were
 * calculated and stored at posting time.
 */

/** Indian digit grouping ("1234567.5" -> "12,34,567.50"). Anything that is not a plain decimal is returned unchanged. */
export function formatMoney(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return value;
  const [, sign, whole, frac = ''] = m;
  const last3 = whole!.slice(-3);
  const rest = whole!.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${sign}${grouped}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

export const formatRupees = (v: string | null | undefined): string =>
  v === null || v === undefined ? '-' : `₹${formatMoney(v)}`;

/** A GST rate such as "18.0000" shown as "18%". */
export function formatRate(v: string | null | undefined): string {
  if (!v) return '';
  const trimmed = v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
  return `${trimmed}%`;
}

const ONES = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = TENS[Math.floor(n / 10)]!;
  return n % 10 === 0 ? t : `${t} ${ONES[n % 10]}`;
}
function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${ONES[h]} Hundred`);
  if (r > 0) parts.push(below100(r));
  return parts.join(' ');
}

/** Whole rupees in Indian terms (crore, lakh, thousand), exact for any size (BigInt). */
function rupeesInWords(n: bigint): string {
  if (n === 0n) return 'Zero';
  const parts: string[] = [];
  let rest = n;
  const crores = rest / 10_000_000n;
  if (crores > 0n) {
    parts.push(`${rupeesInWords(crores)} Crore`); // crores can exceed 99 ("One Hundred Crore")
    rest %= 10_000_000n;
  }
  for (const [size, name] of [
    [100_000n, 'Lakh'],
    [1_000n, 'Thousand'],
  ] as const) {
    const q = rest / size;
    if (q > 0n) {
      parts.push(`${below100(Number(q))} ${name}`);
      rest %= size;
    }
  }
  if (rest > 0n) parts.push(below1000(Number(rest)));
  return parts.join(' ');
}

/**
 * The grand total in words, derived only from the stored INR string ("1234.50" -> "Rupees One Thousand Two Hundred Thirty Four
 * and Fifty Paise Only"). Display only; it is never a source of any amount. Returns null for anything that is not a
 * non-negative amount with at most two decimals.
 */
export function amountInWords(total: string): string | null {
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(total);
  if (!m) return null;
  const rupees = BigInt(m[1]!);
  const paise = Number((m[2] ?? '').padEnd(2, '0') || '0');
  const r = `Rupees ${rupeesInWords(rupees)}`;
  return paise > 0 ? `${r} and ${below100(paise)} Paise Only` : `${r} Only`;
}
