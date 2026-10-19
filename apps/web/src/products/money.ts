/**
 * Display of rupee amounts from exact decimal STRINGS (as the API returns them). No JavaScript number is involved,
 * so no amount can lose a digit. Uses Indian digit grouping (12,34,567.50).
 */
export function formatInr(amount: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '';
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) return amount; // not a plain decimal: show it as typed rather than guess
  const whole = m[1]!.replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').padEnd(2, '0').slice(0, 2);
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `₹${grouped}.${frac}`;
}
