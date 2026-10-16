import { describe, expect, it } from 'vitest';
import { EnvValidationError, isLoopbackHost, parseEnv } from './index.js';

const base = { DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db' };

describe('parseEnv', () => {
  it('applies secure defaults', () => {
    const env = parseEnv(base);
    expect(env.API_HOST).toBe('127.0.0.1');
    expect(env.API_PORT).toBe(4310);
    expect(env.NODE_ENV).toBe('development');
    expect(env.WEB_ORIGIN).toEqual(['http://127.0.0.1:5173']);
  });

  it('rejects a non-loopback API_HOST (no LAN exposure)', () => {
    expect(() => parseEnv({ ...base, API_HOST: '0.0.0.0' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...base, API_HOST: '192.168.1.10' })).toThrow(/loopback/);
  });

  it('requires a postgresql DATABASE_URL', () => {
    expect(() => parseEnv({})).toThrow(EnvValidationError);
    expect(() => parseEnv({ DATABASE_URL: 'mysql://x' })).toThrow(/postgresql/);
  });

  it('never echoes secret values in the error message', () => {
    try {
      parseEnv({ DATABASE_URL: 'mysql://user:SuperSecret@host/db' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('SuperSecret');
    }
  });

  it('rejects out-of-range ports and parses multiple origins', () => {
    expect(() => parseEnv({ ...base, API_PORT: '80' })).toThrow(EnvValidationError);
    const env = parseEnv({ ...base, WEB_ORIGIN: 'http://127.0.0.1:5173, http://localhost:5173' });
    expect(env.WEB_ORIGIN).toHaveLength(2);
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', 'localhost', '::1'])('accepts %s', (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });
  it.each(['0.0.0.0', '::', '10.0.0.1', ''])('rejects %s', (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});

describe('LAUNCH_SECRET', () => {
  it('is optional but must be at least 32 characters when present', () => {
    expect(parseEnv(base).LAUNCH_SECRET).toBeUndefined();
    expect(() => parseEnv({ ...base, LAUNCH_SECRET: 'short' })).toThrow(/at least 32/);
    expect(parseEnv({ ...base, LAUNCH_SECRET: 'x'.repeat(32) }).LAUNCH_SECRET).toHaveLength(32);
  });
  it('does not echo a rejected secret value', () => {
    try {
      parseEnv({ ...base, LAUNCH_SECRET: 'tooshort-but-secret' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('tooshort-but-secret');
    }
  });
});
