import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDbHealth, fetchHealth } from './api.js';

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('returns the JSON body for a healthy response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    );
    expect((await fetchHealth()).status).toBe('ok');
  });

  it('accepts a 503 body from /health/db (database down is a valid answer)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'degraded', database: { status: 'down' } }), {
            status: 503,
          }),
      ),
    );
    expect((await fetchDbHealth()).database.status).toBe('down');
  });

  it('throws for other HTTP failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    await expect(fetchHealth()).rejects.toThrow(/500/);
  });
});
