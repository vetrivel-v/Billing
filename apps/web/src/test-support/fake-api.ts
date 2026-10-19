// Test-only: a scripted stand-in for the local API used by component tests. It is NOT shipped and never used by the app.
import type { MeResponse } from '@commercebill/shared-types';
import { vi } from 'vitest';

export interface FakeRequest {
  method: string;
  path: string;
  /** The query string, e.g. "?search=ab&limit=25" (empty when none). */
  query: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
}

export type FakeHandler = (req: FakeRequest) => FakeResponse | Promise<FakeResponse>;

export const TOKEN = 'Q'.repeat(43);

export function meFor(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user: {
      id: '11111111-1111-4111-8111-111111111111',
      username: 'asha.rao',
      displayName: 'Asha Rao',
      organizationId: '22222222-2222-4222-8222-222222222222',
    },
    organizationName: 'Test Traders',
    roles: ['Accountant'],
    permissions: [],
    mustChangePassword: false,
    sessionExpiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
    idleTimeoutSeconds: 1800,
    ...overrides,
  };
}

export const apiError = (status: number, code: string, problems?: unknown): FakeResponse => ({
  status,
  body: {
    error: { code, message: 'server wording', dataSaved: false, correlationId: 'c', problems },
  },
});

/**
 * Installs a fetch stub. Handlers are keyed "METHOD /path"; an unhandled call fails the test loudly instead of
 * silently succeeding. Returns the recorded calls.
 */
export function installFakeApi(handlers: Record<string, FakeHandler>) {
  const calls: FakeRequest[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const req: FakeRequest = {
      method: init?.method ?? 'GET',
      path: u.pathname,
      query: u.search,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    const handler = handlers[`${req.method} ${req.path}`];
    if (!handler) throw new Error(`Unhandled fake API call: ${req.method} ${req.path}`);
    const res = await handler(req);
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
    });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

export const loginOk = (overrides: { mustChangePassword?: boolean } = {}): FakeResponse => ({
  status: 200,
  body: {
    token: TOKEN,
    expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
    idleTimeoutSeconds: 1800,
    mustChangePassword: overrides.mustChangePassword ?? false,
    user: { id: 'u', username: 'asha.rao', displayName: 'Asha Rao', organizationId: 'o' },
  },
});
