import { hash } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ARGON2_PARAMS } from './config.js';
import { PasswordHasher, normalizePassword } from './password.js';

// Cheap parameters for logic tests; the real defaults are exercised separately below.
const cheap = new PasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });

describe('PasswordHasher (Argon2id)', () => {
  it('produces an Argon2id PHC string and never contains the password', async () => {
    const h = await cheap.hash('correct horse battery staple');
    expect(h.startsWith('$argon2id$v=19$m=1024,t=1,p=1$')).toBe(true);
    expect(h).not.toContain('correct');
  });

  it('uses a random salt: the same password never yields the same hash twice', async () => {
    const [a, b] = await Promise.all([
      cheap.hash('same password 123'),
      cheap.hash('same password 123'),
    ]);
    expect(a).not.toBe(b);
    expect(await cheap.verify(a, 'same password 123')).toBe(true);
    expect(await cheap.verify(b, 'same password 123')).toBe(true);
  });

  it('accepts the right password and rejects wrong, empty and near-miss passwords', async () => {
    const h = await cheap.hash('Tr0ub4dor&3-extra-long');
    expect(await cheap.verify(h, 'Tr0ub4dor&3-extra-long')).toBe(true);
    expect(await cheap.verify(h, 'Tr0ub4dor&3-extra-lon')).toBe(false);
    expect(await cheap.verify(h, 'tr0ub4dor&3-extra-long')).toBe(false);
    expect(await cheap.verify(h, '')).toBe(false);
  });

  it('returns false (does not throw) for a malformed or foreign stored hash', async () => {
    expect(await cheap.verify('not-a-hash', 'x')).toBe(false);
    expect(await cheap.verify('', 'x')).toBe(false);
    expect(
      await cheap.verify('$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', 'x'),
    ).toBe(false);
  });

  it('treats canonically equivalent Unicode (NFKC) as the same password', async () => {
    const h = await cheap.hash('ｐａｓｓｗｏｒｄ-ＴＥＳＴ-12345'); // full-width forms
    expect(await cheap.verify(h, 'password-TEST-12345')).toBe(true);
    expect(normalizePassword('é')).toBe(normalizePassword('é'));
    const hi = await cheap.hash('पासवर्ड-ટેસ્ટ-12345');
    expect(await cheap.verify(hi, 'पासवर्ड-ટેસ્ટ-12345')).toBe(true);
  });

  describe('needsRehash', () => {
    it('is false only for Argon2id hashes with exactly the current parameters', async () => {
      const h = await cheap.hash('rehash-me-please-123');
      expect(cheap.needsRehash(h)).toBe(false);
      const stronger = new PasswordHasher({ memoryCost: 2048, timeCost: 1, parallelism: 1 });
      expect(stronger.needsRehash(h)).toBe(true);
      expect(
        new PasswordHasher({ memoryCost: 1024, timeCost: 2, parallelism: 1 }).needsRehash(h),
      ).toBe(true);
      expect(
        new PasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 2 }).needsRehash(h),
      ).toBe(true);
    });

    it('is true for non-Argon2id or garbage values', async () => {
      expect(cheap.needsRehash('plaintext-password')).toBe(true);
      expect(cheap.needsRehash('$argon2i$v=19$m=1024,t=1,p=1$c2FsdHNhbHQ$aGFzaA')).toBe(true);
      expect(cheap.needsRehash('')).toBe(true);
    });
  });
});

describe('default Argon2id parameters (ADR-0014)', () => {
  it('are the benchmarked values and cost a measurable, interactive-friendly amount of time', async () => {
    expect(DEFAULT_ARGON2_PARAMS).toEqual({ memoryCost: 65536, timeCost: 4, parallelism: 1 });
    const real = new PasswordHasher(DEFAULT_ARGON2_PARAMS);
    const start = performance.now();
    const h = await real.hash('a-reasonably-long-test-passphrase');
    const ms = performance.now() - start;
    expect(h.startsWith('$argon2id$v=19$m=65536,t=4,p=1$')).toBe(true);
    expect(real.needsRehash(h)).toBe(false);
    // Lower bound proves the cost is real (the OWASP-floor spike took ~17 ms); upper bound is a loose
    // sanity check, not a performance claim. Measured median on the dev machine: ~110 ms.
    expect(ms).toBeGreaterThan(40);
    expect(ms).toBeLessThan(3000);
  });

  it('a hash made with the old OWASP-floor spike parameters is flagged for upgrade', async () => {
    const old = await hash('legacy-password-123456', {
      algorithm: 2,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    expect(new PasswordHasher(DEFAULT_ARGON2_PARAMS).needsRehash(old)).toBe(true);
  });
});
