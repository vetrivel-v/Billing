import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes from the OS CSPRNG, base64url (43 chars). Sent only in the Authorization header. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hex of the token. The database stores only this value, so a database leak does not reveal
 * usable tokens. A fast hash is appropriate here because tokens carry 256 bits of entropy (unlike
 * passwords, which are hashed with Argon2id).
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Cheap shape check so garbage input never reaches the database. */
export function looksLikeSessionToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** Short one-way fingerprint for audit records (never the value itself). */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}
