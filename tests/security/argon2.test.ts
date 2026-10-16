import { hash, verify } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';

// OWASP minimum for Argon2id. 2 === Algorithm.Argon2id (const enum, not importable under isolatedModules).
const PARAMS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

describe('Argon2id via @node-rs/argon2 under Node (R-033 spike)', () => {
  it('produces an Argon2id PHC string with the configured parameters and a random salt', async () => {
    const a = await hash('test-password-1', PARAMS);
    const b = await hash('test-password-1', PARAMS);
    expect(a.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain('test-password-1');
  });

  it('verifies correct and rejects wrong passwords, including Unicode', async () => {
    const h = await hash('पासवर्ड-ટેસ્ટ', PARAMS);
    expect(await verify(h, 'पासवर्ड-ટેસ્ટ')).toBe(true);
    expect(await verify(h, 'पासवर्ड')).toBe(false);
    expect(await verify(h, '')).toBe(false);
  });

  it('rejects a malformed hash rather than accepting it', async () => {
    await expect(verify('not-a-hash', 'x')).rejects.toThrow();
  });

  it('is slow enough to resist guessing but fast enough for login (measured, not assumed)', async () => {
    const start = Date.now();
    await hash('timing', PARAMS);
    const ms = Date.now() - start;
    expect(ms).toBeGreaterThan(5); // not trivially cheap
    expect(ms).toBeLessThan(2000); // acceptable interactive login latency on this machine
  });
});
