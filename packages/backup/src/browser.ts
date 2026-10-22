// Browser-safe subset: the passphrase rules (no Node APIs, no database).
export const MIN_PASSPHRASE = 12;
export const MAX_PASSPHRASE = 200;

export function passphraseProblem(p: string, confirm?: string): string | null {
  if (p === '') return 'required';
  if (p.trim() === '') return 'blank';
  if (p.length < MIN_PASSPHRASE) return 'too_short';
  if (p.length > MAX_PASSPHRASE) return 'too_long';
  if (confirm !== undefined && confirm !== p) return 'mismatch';
  return null;
}
