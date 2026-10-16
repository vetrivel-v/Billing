import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { LAUNCH_SECRET_HEADER, isExemptPath, launchSecretMatches } from './launch-secret.js';

const SECRET = 'a'.repeat(16) + 'B'.repeat(16) + '0123456789';
const env = { LOG_LEVEL: 'silent' as const, WEB_ORIGIN: ['http://127.0.0.1:5173'] };

describe('launchSecretMatches', () => {
  it('accepts only the exact secret', () => {
    expect(launchSecretMatches(SECRET, SECRET)).toBe(true);
    expect(launchSecretMatches(SECRET, SECRET + 'x')).toBe(false);
    expect(launchSecretMatches(SECRET, SECRET.slice(0, -1))).toBe(false);
    expect(launchSecretMatches(SECRET, SECRET.replace('a', 'z'))).toBe(false);
    expect(launchSecretMatches(SECRET, undefined)).toBe(false);
    expect(launchSecretMatches(SECRET, ['x'])).toBe(false);
    expect(launchSecretMatches(SECRET, '')).toBe(false);
  });
  it('exempts only liveness', () => {
    expect(isExemptPath('/health')).toBe(true);
    expect(isExemptPath('/health?x=1')).toBe(true);
    expect(isExemptPath('/health/db')).toBe(false);
    expect(isExemptPath('/health/../health/db')).toBe(false);
  });
});

describe('API with a launch secret (R-032 spike)', () => {
  it('rejects requests without the secret using the stable error contract', async () => {
    const app = await buildApp({ env, launchSecret: SECRET });
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_0001');
    expect(res.body).not.toContain(SECRET);
    await app.close();
  });

  it('rejects a wrong secret and accepts the right one', async () => {
    const app = await buildApp({ env, launchSecret: SECRET });
    const bad = await app.inject({
      method: 'GET',
      url: '/health/db',
      headers: { [LAUNCH_SECRET_HEADER]: SECRET.slice(0, -1) + 'X' },
    });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({
      method: 'GET',
      url: '/health/db',
      headers: { [LAUNCH_SECRET_HEADER]: SECRET },
    });
    expect(good.statusCode).toBe(503); // authorised; database simply not configured in this test
    await app.close();
  });

  it('keeps liveness open and protects unknown routes too (no 404 oracle)', async () => {
    const app = await buildApp({ env, launchSecret: SECRET });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/does-not-exist' })).statusCode).toBe(401);
    await app.close();
  });

  it('still answers CORS preflight for the secret header from the allowed origin', async () => {
    const app = await buildApp({ env, launchSecret: SECRET });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health/db',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': LAUNCH_SECRET_HEADER,
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
    await app.close();
  });

  it('is open when no secret is configured (development default)', async () => {
    const app = await buildApp({ env });
    expect((await app.inject({ method: 'GET', url: '/health/db' })).statusCode).toBe(503);
    await app.close();
  });

  async function loggedApp(lines: string[]) {
    const app = await buildApp({
      env: { ...env, LOG_LEVEL: 'trace' as never },
      launchSecret: SECRET,
      logStream: { write: (m) => void lines.push(m) },
    });
    // Deliberately logs headers, as a careless handler might (defence in depth for redaction).
    app.get('/careless', async (req) => {
      req.log.info({ dump: { headers: req.headers } }, 'careless header dump');
      return { ok: true };
    });
    return app;
  }
  const secretHeaders = {
    [LAUNCH_SECRET_HEADER]: SECRET,
    authorization: 'Bearer super-secret-token',
    cookie: 'sid=cookie-secret',
  };

  it('default request logging never contains secrets (R-027 leak test)', async () => {
    const lines: string[] = [];
    const app = await loggedApp(lines);
    await app.inject({ method: 'GET', url: '/health/db', headers: secretHeaders });
    await app.inject({
      method: 'GET',
      url: '/health/db',
      headers: { [LAUNCH_SECRET_HEADER]: 'wrong-secret-value-0123456789abcdef' },
    });
    await app.close();
    const all = lines.join('');
    expect(all.length).toBeGreaterThan(0);
    for (const v of [SECRET, 'super-secret-token', 'cookie-secret', 'wrong-secret-value']) {
      expect(all).not.toContain(v);
    }
  });

  it('redacts secret headers even when a handler logs them explicitly', async () => {
    const lines: string[] = [];
    const app = await loggedApp(lines);
    await app.inject({ method: 'GET', url: '/careless', headers: secretHeaders });
    await app.close();
    const all = lines.join('');
    expect(all).toContain('careless header dump');
    expect(all).toContain('[REDACTED]');
    for (const v of [SECRET, 'super-secret-token', 'cookie-secret']) expect(all).not.toContain(v);
  });
});
