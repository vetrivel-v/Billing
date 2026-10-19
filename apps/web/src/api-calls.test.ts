// @vitest-environment jsdom
import type { DesktopBridge } from '@commercebill/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  ApiUnreachableError,
  LAUNCH_SECRET_HEADER,
  changePassword,
  getMe,
  getSetupStatus,
  login,
  logout,
  resetAccessForTests,
} from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.commercebill;
  resetAccessForTests();
});

const SECRET = 'f'.repeat(64);
const TOKEN = 'T'.repeat(43);

function installBridge() {
  const bridge: DesktopBridge = {
    getAppInfo: async () => ({ name: 'x', version: '0', platform: 'win32' }),
    getApiAccess: async () => ({ baseUrl: 'http://127.0.0.1:5555', secret: SECRET }),
  };
  window.commercebill = bridge;
}

function stub(status: number, body?: unknown) {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('application API client', () => {
  it('sends the launch secret on every call, and the session token only in the Authorization header', async () => {
    installBridge();
    const fetchFn = stub(200, { user: {} });
    await getMe(TOKEN);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:5555/auth/me');
    const headers = init?.headers as Record<string, string>;
    expect(headers[LAUNCH_SECRET_HEADER]).toBe(SECRET);
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(String(url)).not.toContain(TOKEN);
    expect(init?.body).toBeUndefined();
  });

  it('keeps the launch secret and the user session separate: login sends no Authorization header', async () => {
    installBridge();
    const fetchFn = stub(200, { token: TOKEN });
    await login('admin.user', 'pw');
    const [, init] = fetchFn.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers[LAUNCH_SECRET_HEADER]).toBe(SECRET);
    expect(headers.authorization).toBeUndefined();
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ username: 'admin.user', password: 'pw' });
  });

  it('puts passwords in the JSON body of change-password, never in the URL', async () => {
    installBridge();
    const fetchFn = stub(204);
    await expect(changePassword(TOKEN, 'old-pw', 'new-pw')).resolves.toBeUndefined();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:5555/auth/change-password');
    expect(JSON.parse(init?.body as string)).toEqual({
      currentPassword: 'old-pw',
      newPassword: 'new-pw',
    });
  });

  it('returns undefined for 204 (logout) and parses the setup status', async () => {
    installBridge();
    stub(204);
    await expect(logout(TOKEN)).resolves.toBeUndefined();
    stub(200, { setupRequired: false, draftAvailable: false });
    await expect(getSetupStatus()).resolves.toEqual({
      setupRequired: false,
      draftAvailable: false,
    });
  });

  it('turns an error answer into ApiError with status, code and value-free problems, dropping server text', async () => {
    installBridge();
    stub(400, {
      error: {
        code: 'VAL_0001',
        message: 'internal wording that must not reach screens',
        problems: [{ field: 'newPassword', rule: 'too_short' }],
      },
    });
    const err = await changePassword(TOKEN, 'a', 'b').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(400);
    expect(apiErr.code).toBe('VAL_0001');
    expect(apiErr.problems).toEqual([{ field: 'newPassword', rule: 'too_short' }]);
    expect(apiErr.message).not.toContain('internal wording');
  });

  it('copes with an error answer that has no JSON body', async () => {
    installBridge();
    const fn = vi.fn(async () => new Response('<html>oops</html>', { status: 502 }));
    vi.stubGlobal('fetch', fn);
    const err = (await getMe(TOKEN).catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.code).toBeUndefined();
    expect(err.problems).toEqual([]);
  });

  it('reports an unreachable service as ApiUnreachableError', async () => {
    installBridge();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(getSetupStatus()).rejects.toBeInstanceOf(ApiUnreachableError);
  });
});
