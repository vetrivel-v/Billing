import { hash, verify } from '@node-rs/argon2';
import type { Argon2Params } from './config.js';

// 2 === Algorithm.Argon2id (const enum, not importable under isolatedModules).
const ARGON2ID = 2;

/** Passwords are NFKC-normalised so visually identical Unicode forms hash and verify identically. */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

const PHC_PATTERN = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;

/**
 * Thin wrapper around the approved Argon2id implementation (ADR-0011). No custom cryptography:
 * hashing, salting (random per hash) and constant-time comparison are done by the library.
 */
export class PasswordHasher {
  constructor(readonly params: Argon2Params) {}

  async hash(password: string): Promise<string> {
    return hash(normalizePassword(password), { algorithm: ARGON2ID, ...this.params });
  }

  /** False for a wrong password AND for a malformed stored hash; never throws for bad input. */
  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, normalizePassword(password));
    } catch {
      return false;
    }
  }

  /** True when the stored hash is not Argon2id with exactly the current parameters. */
  needsRehash(storedHash: string): boolean {
    const m = PHC_PATTERN.exec(storedHash);
    if (!m) return true;
    return (
      Number(m[1]) !== this.params.memoryCost ||
      Number(m[2]) !== this.params.timeCost ||
      Number(m[3]) !== this.params.parallelism
    );
  }
}
