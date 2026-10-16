import { timingSafeEqual } from 'node:crypto';

export const LAUNCH_SECRET_HEADER = 'x-commercebill-launch-secret';
export const MIN_LAUNCH_SECRET_LENGTH = 32;

/** Routes reachable without the launch secret: liveness only (no data, no version-sensitive detail). */
export const LAUNCH_SECRET_EXEMPT_PATHS: readonly string[] = ['/health'];

/**
 * Constant-time comparison. Hashing is unnecessary; we pad to equal length so the comparison time does not
 * depend on where the first difference is, and reject length differences without leaking more than length.
 */
export function launchSecretMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isExemptPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return LAUNCH_SECRET_EXEMPT_PATHS.includes(path);
}
