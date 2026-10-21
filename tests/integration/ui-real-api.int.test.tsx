// @vitest-environment jsdom
// Browser-level test: the real React application (DOM rendered by jsdom) talks over real HTTP to the real Fastify API
// backed by a real, migrated PostgreSQL database. Nothing about the API is mocked or scripted.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FastifyInstance } from 'fastify';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { App } from '../../apps/web/src/App.js';
import { resetAccessForTests } from '../../apps/web/src/api.js';
import { AuthProvider } from '../../apps/web/src/auth.js';
import { LOGIN_FAILED, LOGIN_LOCKOUT_NOTICE } from '../../apps/web/src/messages.js';
import { MODULES } from '../../apps/web/src/nav.js';
import { LAUNCH_SECRET, PASSWORD, createFixture, type Fixture } from './auth-fixture.js';

const TEMP = 'Temporary lantern 4412 mosaic';
const NEW_PW = 'Velvet anchor orbit 7731';

let fx: Fixture;
let app: FastifyInstance;
let baseUrl: string;
/** Every Authorization header the browser code sent: lets the tests learn the real token without it being in the DOM. */
let sentTokens: string[];
const realFetch = globalThis.fetch;

async function newUser(
  roleName: string,
  opts: { mustChangePassword?: boolean; password?: string } = {},
) {
  const username = `ui.${Math.random().toString(16).slice(2, 8)}`;
  const u = await app.authService!.createUser({
    organizationId: fx.orgId,
    username,
    displayName: `UI ${roleName} (test)`,
    password: opts.password ?? PASSWORD,
    roleNames: [roleName],
    ...(opts.mustChangePassword ? { mustChangePassword: true } : {}),
  });
  return { id: u.id, username };
}

function renderApp() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function signIn(username: string, password: string) {
  await screen.findByRole('heading', { name: 'Sign in' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

const idle = () =>
  waitFor(() => expect(screen.queryByRole('button', { name: 'Signing in' })).toBeNull());

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  await fx.prisma.organization.update({
    where: { id: fx.orgId },
    data: { setupCompletedAt: new Date() },
  });
  app = await fx.makeApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await fx?.close();
});

beforeEach(() => {
  sentTokens = [];
  resetAccessForTests();
  // The same bridge the Electron preload exposes: loopback URL and the per-launch secret.
  window.commercebill = {
    getAppInfo: async () => ({ name: 'test', version: '0', platform: 'test' }),
    getApiAccess: async () => ({ baseUrl, secret: LAUNCH_SECRET }),
    saveInvoicePdf: async () => ({ status: 'cancelled' }),
    printInvoice: async () => ({ status: 'cancelled' }),
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (auth) sentTokens.push(auth.replace('Bearer ', ''));
    return realFetch(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  delete window.commercebill;
  globalThis.fetch = realFetch;
});

describe('login and shell against the real API', () => {
  it('signs an Administrator in and shows real organization, roles and permission-derived navigation', async () => {
    const admin = await newUser('Administrator');
    renderApp();
    await signIn(admin.username, PASSWORD);
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getAllByText('DEMO Auth Co (fictional)').length).toBeGreaterThan(0);
    expect(screen.getByText('Administrator')).toBeTruthy();
    expect(screen.getAllByText('UI Administrator (test)', { exact: false }).length).toBeGreaterThan(
      0,
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const label of ['Customers', 'Products', 'Inventory', 'Billing', 'Settings']) {
      expect(nav.textContent).toContain(label);
    }
    // Customers, Products, Inventory, Tax and Billing are built modules (links); only Settings is still "Coming soon".
    expect(within(nav).getAllByText('Coming soon')).toHaveLength(1);
    expect(within(nav).getByRole('link', { name: 'Customers' })).toBeTruthy();
    // The live service-status card is real data from /health and /health/db.
    expect(await screen.findByTestId('api-status')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('db-status').textContent).toBe('ok'));
  });

  it('derives the navigation of every role template from the permissions the server returned', async () => {
    for (const role of ['Accountant', 'Billing Operator', 'Warehouse Operator', 'Viewer/Auditor']) {
      const u = await newUser(role);
      const { unmount } = renderApp();
      await signIn(u.username, PASSWORD);
      await screen.findByRole('heading', { name: 'Dashboard' });
      const token = sentTokens.at(-1)!;
      const me = (await (
        await realFetch(`${baseUrl}/auth/me`, {
          headers: {
            authorization: `Bearer ${token}`,
            'x-commercebill-launch-secret': LAUNCH_SECRET,
          },
        })
      ).json()) as { permissions: string[] };
      const expected = MODULES.filter(
        (m) => !m.permission || me.permissions.includes(m.permission),
      ).map((m) => m.label);
      const nav = screen.getByRole('navigation', { name: 'Main' });
      const shown = [...nav.querySelectorAll('li')].map((li) =>
        (li.textContent ?? '').replace('Coming soon', ''),
      );
      expect(shown, role).toEqual(expected);
      unmount();
    }
  });

  it('shows one generic failure for a wrong password, an unknown user and a disabled account', async () => {
    const u = await newUser('Viewer/Auditor');
    const disabled = await newUser('Viewer/Auditor');
    await fx.prisma.user.update({ where: { id: disabled.id }, data: { isActive: false } });
    const seen: string[] = [];
    renderApp();
    for (const [name, pw] of [
      [u.username, 'wrong password entirely'],
      ['no.such.person', PASSWORD],
      [disabled.username, PASSWORD],
    ] as const) {
      await signIn(name, pw);
      await idle();
      seen.push((await screen.findAllByRole('alert'))[0]!.textContent ?? '');
    }
    expect(new Set(seen)).toEqual(new Set([LOGIN_FAILED]));
  });

  it('after real repeated failures the account is locked server-side, the UI says so generically, and the right password is refused', async () => {
    const u = await newUser('Viewer/Auditor');
    renderApp();
    for (let i = 0; i < 5; i++) {
      await signIn(u.username, `wrong password ${i}`);
      await idle();
    }
    expect(screen.getByText(LOGIN_LOCKOUT_NOTICE)).toBeTruthy();
    const row = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.lockedUntil).not.toBeNull();
    await signIn(u.username, PASSWORD); // correct, but locked
    await idle();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('keeps the real session token out of the DOM, URL and browser storage', async () => {
    const u = await newUser('Viewer/Auditor');
    renderApp();
    await signIn(u.username, PASSWORD);
    await screen.findByRole('heading', { name: 'Dashboard' });
    const token = sentTokens.at(-1)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(document.documentElement.outerHTML).not.toContain(token);
    expect(window.location.href).not.toContain(token);
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(document.documentElement.outerHTML).not.toContain(PASSWORD);
  });
});

describe('forced password change against the real API', () => {
  it('blocks everything until the temporary password is replaced, then the new password works and the old one does not', async () => {
    const u = await newUser('Viewer/Auditor', { mustChangePassword: true, password: TEMP });
    renderApp();
    await signIn(u.username, TEMP);
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();

    // The server itself refuses other routes for this session (AUTH_0004), whatever the UI shows.
    const token = sentTokens.at(-1)!;
    const blocked = await realFetch(`${baseUrl}/users`, {
      headers: { authorization: `Bearer ${token}`, 'x-commercebill-launch-secret': LAUNCH_SECRET },
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('AUTH_0004');

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: TEMP } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: NEW_PW } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: NEW_PW } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password and continue' }));
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy();

    const row = await fx.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.mustChangePassword).toBe(false);
    const login = (pw: string) =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'x-commercebill-launch-secret': LAUNCH_SECRET },
        payload: { username: u.username, password: pw },
      });
    expect((await login(NEW_PW)).statusCode).toBe(200);
    expect((await login(TEMP)).statusCode).toBe(401);
  });

  it('shows the real policy and wrong-current-password problems without technical text', async () => {
    const u = await newUser('Viewer/Auditor', { mustChangePassword: true, password: TEMP });
    renderApp();
    await signIn(u.username, TEMP);
    await screen.findByRole('heading', { name: 'Choose a new password' });
    const fill = (c: string, n: string) => {
      fireEvent.change(screen.getByLabelText('Current password'), { target: { value: c } });
      fireEvent.change(screen.getByLabelText('New password'), { target: { value: n } });
      fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: n } });
      fireEvent.click(screen.getByRole('button', { name: 'Change password and continue' }));
    };
    fill('not the temporary password', NEW_PW);
    expect(await screen.findByText('The current password is not correct.')).toBeTruthy();
    fill(TEMP, 'short-1');
    expect(await screen.findByText(/at least 12 characters/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/VAL_0001|too_short|current_password_incorrect/);
  });
});

describe('sign-out and revocation against the real API', () => {
  it('sign-out revokes the session on the server', async () => {
    const u = await newUser('Viewer/Auditor');
    renderApp();
    await signIn(u.username, PASSWORD);
    await screen.findByRole('heading', { name: 'Dashboard' });
    const token = sentTokens.at(-1)!;
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('You have been signed out.')).toBeTruthy();
    await waitFor(async () => {
      const r = await realFetch(`${baseUrl}/auth/me`, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-commercebill-launch-secret': LAUNCH_SECRET,
        },
      });
      expect(r.status).toBe(401);
    });
  });

  it('a session revoked by an administrator is noticed on the next request and the user is returned to sign-in', async () => {
    const u = await newUser('Viewer/Auditor');
    renderApp();
    await signIn(u.username, PASSWORD);
    await screen.findByRole('heading', { name: 'Dashboard' });
    await fx.prisma.session.updateMany({
      where: { userId: u.id },
      data: { revokedAt: new Date() },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await screen.findByRole('heading', { name: 'Change password' });
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: NEW_PW } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: NEW_PW } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Change password' }).at(-1)!);
    expect(await screen.findByText(/session has ended/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    // and nothing was changed by the refused request
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: { 'x-commercebill-launch-secret': LAUNCH_SECRET },
          payload: { username: u.username, password: PASSWORD },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('launch check against the real API', () => {
  it('shows the setup wizard for a database with no completed setup (no sign-in offered)', async () => {
    const empty = await createFixture(inject('pgAdminUrl'), { bare: true });
    const emptyApp = await empty.makeApp();
    try {
      await emptyApp.listen({ host: '127.0.0.1', port: 0 });
      const addr = emptyApp.server.address();
      const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resetAccessForTests();
      window.commercebill = {
        getAppInfo: async () => ({ name: 'test', version: '0', platform: 'test' }),
        getApiAccess: async () => ({ baseUrl: url, secret: LAUNCH_SECRET }),
      };
      renderApp();
      expect(await screen.findByRole('heading', { name: 'CommerceBill setup' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    } finally {
      cleanup();
      await empty.close();
    }
  });

  it('shows the sign-in page, not the Phase 0 status page, for a configured installation', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(
      screen.queryByText('Phase 0 foundation shell. Billing features arrive in Phase 1.'),
    ).toBeNull();
  });

  it('reports an unreachable service with a retry button', async () => {
    resetAccessForTests();
    window.commercebill = {
      getAppInfo: async () => ({ name: 'test', version: '0', platform: 'test' }),
      getApiAccess: async () => ({ baseUrl: 'http://127.0.0.1:9', secret: LAUNCH_SECRET }),
    };
    renderApp();
    expect(await screen.findByRole('heading', { name: 'CommerceBill is not ready' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
