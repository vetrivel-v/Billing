import { describe, expect, it } from 'vitest';
import {
  AuthConfigError,
  DEFAULT_AUTH_CONFIG,
  MIN_ARGON2_PARAMS,
  resolveAuthConfig,
  validateAuthConfig,
} from './config.js';
import {
  fingerprint,
  generateSessionToken,
  hashSessionToken,
  looksLikeSessionToken,
} from './tokens.js';

describe('session tokens', () => {
  it('are 256-bit base64url strings, unique, and safe for headers (not URLs by policy)', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSessionToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(looksLikeSessionToken(t)).toBe(true);
    }
  });

  it('are stored only as a SHA-256 hex digest that differs from the token', () => {
    const t = generateSessionToken();
    const h = hashSessionToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    expect(hashSessionToken(t)).toBe(h); // deterministic for lookup
    expect(hashSessionToken(generateSessionToken())).not.toBe(h);
  });

  it('shape check rejects non-strings and malformed values before any database access', () => {
    for (const bad of [
      undefined,
      null,
      42,
      {},
      '',
      'short',
      'x'.repeat(44),
      `${'a'.repeat(42)}!`,
      'a b'.repeat(15),
    ]) {
      expect(looksLikeSessionToken(bad)).toBe(false);
    }
  });

  it('fingerprints are short one-way digests', () => {
    expect(fingerprint('someone')).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint('someone')).toBe(fingerprint('someone'));
    expect(fingerprint('someone')).not.toBe(fingerprint('someone-else'));
  });
});

describe('auth configuration', () => {
  it('defaults are valid and at least as strong as the OWASP floor', () => {
    expect(() => validateAuthConfig(DEFAULT_AUTH_CONFIG)).not.toThrow();
    expect(DEFAULT_AUTH_CONFIG.argon2.memoryCost).toBeGreaterThanOrEqual(
      MIN_ARGON2_PARAMS.memoryCost,
    );
    expect(DEFAULT_AUTH_CONFIG.argon2.timeCost).toBeGreaterThanOrEqual(MIN_ARGON2_PARAMS.timeCost);
  });

  it('merges overrides over the defaults', () => {
    const cfg = resolveAuthConfig({ lockout: { maxFailures: 7 }, session: { idleMinutes: 10 } });
    expect(cfg.lockout).toEqual({ maxFailures: 7, lockMinutes: 15 });
    expect(cfg.session.idleMinutes).toBe(10);
    expect(cfg.session.absoluteHours).toBe(12);
  });

  it('refuses weak hashing unless explicitly allowed for tests', () => {
    const weak = { argon2: { memoryCost: 1024, timeCost: 1 } };
    expect(() => resolveAuthConfig(weak)).toThrow(AuthConfigError);
    expect(() => resolveAuthConfig(weak, { allowWeakHashingForTests: true })).not.toThrow();
  });

  it.each([
    [{ password: { minLength: 4 } }, /minLength/],
    [{ password: { minLength: 20, maxLength: 10 } }, /maxLength/],
    [{ lockout: { maxFailures: 1 } }, /maxFailures/],
    [{ lockout: { lockMinutes: 0 } }, /lockMinutes/],
    [{ session: { absoluteHours: 0 } }, /absoluteHours/],
    [{ session: { idleMinutes: 24 * 60 + 1, absoluteHours: 24 } }, /idleMinutes/],
    [{ session: { touchIntervalSeconds: -1 } }, /touchIntervalSeconds/],
    [{ argon2: { parallelism: 0 } }, /parallelism/],
  ])('rejects unsafe or invalid overrides %j', (override, message) => {
    expect(() => resolveAuthConfig(override as never, { allowWeakHashingForTests: true })).toThrow(
      message,
    );
  });
});
