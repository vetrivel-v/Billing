// @vitest-environment jsdom
import type { DesktopBridge } from '@commercebill/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiRequestError,
  LAUNCH_SECRET_HEADER,
  fetchDbHealth,
  fetchHealth,
  resetAccessForTests,
} from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.commercebill;
  resetAccessForTests();
});

const SECRET = 'e'.repeat(64);

function installBridge(): DesktopBridge {
  const bridge: DesktopBridge = {
    getAppInfo: async () => ({ name: 'x', version: '0', platform: 'win32' }),
    getApiAccess: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:5555', secret: SECRET })),
  };
  window.commercebill = bridge;
  return bridge;
}

function stubFetch(status = 200, body: unknown = { status: 'ok' }) {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('api client without the Electron bridge (web development)', () => {
  it('returns the JSON body and sends no secret header', async () => {
    const fetchFn = stubFetch();
    expect((await fetchHealth()).status).toBe('ok');
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4310/health');
    expect(init?.headers).toEqual({});
  });

  it('accepts a 503 body from /health/db (database down is a valid answer)', async () => {
    stubFetch(503, { status: 'degraded', database: { status: 'down' } });
    expect((await fetchDbHealth()).database.status).toBe('down');
  });

  it('throws ApiRequestError for other HTTP failures', async () => {
    stubFetch(500, {});
    await expect(fetchHealth()).rejects.toMatchObject({ name: 'ApiRequestError', status: 500 });
  });
});

describe('api client inside the Electron shell (P1-SEC-01)', () => {
  it('uses the bridge URL and sends the launch secret on protected routes', async () => {
    const bridge = installBridge();
    const fetchFn = stubFetch(200, { status: 'ok', database: { status: 'ok' } });
    await fetchDbHealth();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:5555/health/db');
    expect(init?.headers).toEqual({ [LAUNCH_SECRET_HEADER]: SECRET });
    expect(bridge.getApiAccess).toHaveBeenCalledTimes(1);
  });

  it('does not send the secret on the liveness route', async () => {
    installBridge();
    const fetchFn = stubFetch();
    await fetchHealth();
    expect(fetchFn.mock.calls[0]![1]?.headers).toEqual({});
  });

  it('asks the bridge once and reuses the result', async () => {
    const bridge = installBridge();
    stubFetch(200, { status: 'ok', database: { status: 'ok' } });
    await fetchHealth();
    await fetchDbHealth();
    expect(bridge.getApiAccess).toHaveBeenCalledTimes(1);
  });

  it('surfaces a rejected secret as ApiRequestError(401)', async () => {
    installBridge();
    stubFetch(401, { error: { code: 'AUTH_0001' } });
    const err = await fetchDbHealth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(401);
  });

  it('does not cache a failed bridge call', async () => {
    const getApiAccess = vi
      .fn()
      .mockRejectedValueOnce(new Error('service not ready'))
      .mockResolvedValue({ baseUrl: 'http://127.0.0.1:5555', secret: SECRET });
    window.commercebill = {
      getAppInfo: async () => ({ name: '', version: '', platform: '' }),
      getApiAccess,
    };
    stubFetch();
    await expect(fetchHealth()).rejects.toThrow('service not ready');
    await expect(fetchHealth()).resolves.toMatchObject({ status: 'ok' });
  });
});
