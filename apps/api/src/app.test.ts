import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '@commercebill/shared-types';
import { buildApp } from './app.js';

const env = { LOG_LEVEL: 'silent' as const, WEB_ORIGIN: ['http://127.0.0.1:5173'] };

describe('API health', () => {
  it('GET /health returns ok with version and a correlation id header', async () => {
    const app = await buildApp({ env });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      service: 'commercebill-api',
      version: APP_VERSION,
    });
    expect(res.headers['x-correlation-id']).toBeTruthy();
    await app.close();
  });

  it('GET /health/db reports database down (503) when no database is configured', async () => {
    const app = await buildApp({ env });
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(503);
    expect(res.json().database.status).toBe('down');
    await app.close();
  });

  it('unknown routes return a stable error body without internals', async () => {
    const app = await buildApp({ env });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('SYS_0404');
    expect(body.error.dataSaved).toBe(false);
    expect(body.error.correlationId).toBe(res.headers['x-correlation-id']);
    expect(JSON.stringify(body)).not.toMatch(/stack|node_modules/i);
    await app.close();
  });

  it('sets security headers and restricts CORS to the configured origin', async () => {
    const app = await buildApp({ env });
    const ok = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://127.0.0.1:5173' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    const evil = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});

describe('API error contract', () => {
  async function appWithRoutes() {
    const app = await buildApp({ env });
    app.get('/boom', async () => {
      throw new Error('SELECT * FROM users -- internal detail');
    });
    app.get('/bad', async () => {
      throw Object.assign(new Error('bad input'), { statusCode: 400 });
    });
    app.get('/limited', async () => {
      throw Object.assign(new Error('slow down'), { statusCode: 429 });
    });
    return app;
  }

  it('maps unexpected errors to SYS_0500 without leaking internals', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('SYS_0500');
    expect(res.body).not.toContain('SELECT');
    await app.close();
  });

  it('maps client errors to VAL_0001', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({ method: 'GET', url: '/bad' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VAL_0001');
    await app.close();
  });

  it('maps 429 to AUTH_0003', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({ method: 'GET', url: '/limited' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('AUTH_0003');
    await app.close();
  });
});
