// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { AuthProvider } from './auth.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { LOGIN_FAILED, LOGIN_LOCKOUT_NOTICE } from './messages.js';
import {
  TOKEN,
  apiError,
  installFakeApi,
  loginOk,
  meFor,
  type FakeHandler,
} from './test-support/fake-api.js';

const HEALTH = { status: 'ok', service: 'commercebill-api', version: '0.0.1', time: 'now' };
const base: Record<string, FakeHandler> = {
  'GET /setup/status': () => ({
    status: 200,
    body: { setupRequired: false, draftAvailable: false },
  }),
  'GET /health': () => ({ status: 200, body: HEALTH }),
  'GET /health/db': () => ({ status: 200, body: { ...HEALTH, database: { status: 'ok' } } }),
  'POST /auth/logout': () => ({ status: 204 }),
};

function renderApp(path = '/') {
  return render(
    <ErrorBoundary>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ErrorBoundary>,
  );
}

async function signIn(username = 'asha.rao', password = 'a-long-password-1') {
  await screen.findByRole('heading', { name: 'Sign in' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

function submitPasswordChange(current: string, next: string, confirm: string, label: string) {
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: confirm } });
  fireEvent.click(screen.getAllByRole('button', { name: label }).at(-1)!);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('launch check', () => {
  it('shows a start-up state, then the sign-in page on a configured installation', async () => {
    installFakeApi(base);
    renderApp();
    expect(screen.getByRole('status').textContent).toContain('Starting CommerceBill');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('System status')).toBeNull(); // the Phase 0 status page is gone
  });

  it('tells the user honestly when setup is required (the wizard is a later task)', async () => {
    installFakeApi({
      ...base,
      'GET /setup/status': () => ({
        status: 200,
        body: { setupRequired: true, draftAvailable: false },
      }),
    });
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Setup required' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('offers to retry when the service is unreachable, without technical text', async () => {
    let up = false;
    installFakeApi({
      ...base,
      'GET /setup/status': () => {
        if (!up) throw new TypeError('fetch failed');
        return { status: 200, body: { setupRequired: false, draftAvailable: false } };
      },
    });
    renderApp();
    expect(await screen.findByRole('heading', { name: 'CommerceBill is not ready' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('fetch failed');
    up = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('signing in', () => {
  it('shows the dashboard with real /auth/me data and keeps the token out of storage, URL and DOM', async () => {
    const calls = installFakeApi({
      ...base,
      'POST /auth/login': () => loginOk(),
      'GET /auth/me': () => ({
        status: 200,
        body: meFor({ roles: ['Accountant', 'Viewer/Auditor'], organizationName: 'Test Traders' }),
      }),
    });
    renderApp();
    await signIn();
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByText('Welcome, Asha Rao.')).toBeTruthy();
    expect(screen.getByText('Accountant, Viewer/Auditor')).toBeTruthy();
    expect(screen.getAllByText('Test Traders').length).toBeGreaterThan(0);
    expect(screen.getByText('Business figures are not available yet')).toBeTruthy();

    // the session token is only ever sent as an Authorization header, and only in memory
    const me = calls.find((c) => c.path === '/auth/me')!;
    expect(me.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(document.documentElement.outerHTML).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('shows a loading state while signing in and ignores a second submit', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    let logins = 0;
    installFakeApi({
      ...base,
      'POST /auth/login': async () => {
        logins++;
        await gate;
        return loginOk();
      },
      'GET /auth/me': () => ({ status: 200, body: meFor() }),
    });
    renderApp();
    await signIn();
    const busy = await screen.findByRole('button', { name: 'Signing in' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(busy);
    release?.();
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(logins).toBe(1);
  });

  it('shows the same generic failure for any 401 and clears the password field', async () => {
    installFakeApi({ ...base, 'POST /auth/login': () => apiError(401, 'AUTH_0001') });
    renderApp();
    await signIn('no.such.user', 'whatever-password');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(LOGIN_FAILED);
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Password')));
    expect(document.body.textContent).not.toContain('AUTH_0001');
    expect(document.body.textContent).not.toMatch(/unknown user|does not exist|no such user/i);
  });

  it('gives lockout feedback after repeated failures - identically for unknown and known usernames', async () => {
    installFakeApi({ ...base, 'POST /auth/login': () => apiError(401, 'AUTH_0001') });
    renderApp();
    const texts: string[] = [];
    for (const name of ['no.such.user', 'asha.rao']) {
      for (let i = 0; i < 5; i++) {
        await signIn(name, `wrong-password-${i}`);
        await waitFor(() =>
          expect(screen.queryByRole('button', { name: 'Signing in' })).toBeNull(),
        );
        await screen.findAllByRole('alert');
      }
      texts.push(
        screen
          .getAllByRole('alert')
          .map((a) => a.textContent)
          .join('|'),
      );
    }
    expect(texts[0]).toContain(LOGIN_LOCKOUT_NOTICE);
    expect(texts[0]).toBe(texts[1]);
  });

  it('does not show the lockout notice before the threshold', async () => {
    installFakeApi({ ...base, 'POST /auth/login': () => apiError(401, 'AUTH_0001') });
    renderApp();
    for (let i = 0; i < 4; i++) {
      await signIn('asha.rao', `wrong-password-${i}`);
      await screen.findByRole('alert');
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Signing in' })).toBeNull());
    }
    expect(screen.queryByText(LOGIN_LOCKOUT_NOTICE)).toBeNull();
  });

  it('explains rate limiting and an unreachable service in plain words', async () => {
    let mode: 'rate' | 'down' = 'rate';
    installFakeApi({
      ...base,
      'POST /auth/login': () => {
        if (mode === 'down') throw new TypeError('fetch failed');
        return apiError(429, 'AUTH_0003');
      },
    });
    renderApp();
    await signIn();
    expect((await screen.findByRole('alert')).textContent).toContain('Too many attempts');
    mode = 'down';
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Signing in' })).toBeNull());
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'again-again-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('could not reach its local service'),
    );
    expect(document.body.textContent).not.toContain('fetch failed');
  });

  it('does not submit an empty form', async () => {
    const calls = installFakeApi(base);
    renderApp();
    await screen.findByRole('heading', { name: 'Sign in' });
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);
    expect(calls.some((c) => c.path === '/auth/login')).toBe(false);
  });
});

describe('forced password change (AUTH_0004)', () => {
  function forcedHandlers(changeHandler: FakeHandler) {
    let must = true;
    return {
      ...base,
      'POST /auth/login': () => loginOk({ mustChangePassword: true }),
      'GET /auth/me': () => ({ status: 200, body: meFor({ mustChangePassword: must }) }),
      'POST /auth/change-password': async (req) => {
        const res = await changeHandler(req);
        if (res.status === 204) must = false;
        return res;
      },
    } satisfies Record<string, FakeHandler>;
  }
  const FORCED = 'Change password and continue';

  it('shows only the change-password screen (no navigation) until the change succeeds', async () => {
    installFakeApi(forcedHandlers(() => ({ status: 204 })));
    renderApp('/customers');
    await signIn();
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();

    submitPasswordChange(
      'temp-password-123',
      'a-brand-new-passphrase',
      'a-brand-new-passphrase',
      FORCED,
    );
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Choose a new password' })).toBeNull();
  });

  it('validates locally: mismatch, empty and same-as-current make no request', async () => {
    const calls = installFakeApi(forcedHandlers(() => ({ status: 204 })));
    renderApp();
    await signIn();
    await screen.findByRole('heading', { name: 'Choose a new password' });
    submitPasswordChange('temp-password-123', 'a-brand-new-passphrase', 'different-one-1', FORCED);
    expect(await screen.findByText('The two new passwords do not match.')).toBeTruthy();
    submitPasswordChange('temp-password-123', 'temp-password-123', 'temp-password-123', FORCED);
    expect(await screen.findByText(/different from the current one/)).toBeTruthy();
    submitPasswordChange('', '', '', FORCED);
    expect(await screen.findByText('Enter your current password.')).toBeTruthy();
    expect(calls.some((c) => c.path === '/auth/change-password')).toBe(false);
  });

  it('maps server problems to field messages and never shows codes', async () => {
    installFakeApi(
      forcedHandlers((req) => {
        const body = req.body as { currentPassword: string };
        return body.currentPassword === 'wrong-temp-password'
          ? apiError(400, 'VAL_0001', [
              { field: 'currentPassword', rule: 'current_password_incorrect' },
            ])
          : apiError(400, 'VAL_0001', [
              { field: 'newPassword', rule: 'too_short' },
              { field: 'newPassword', rule: 'common_password' },
            ]);
      }),
    );
    renderApp();
    await signIn();
    await screen.findByRole('heading', { name: 'Choose a new password' });
    submitPasswordChange(
      'wrong-temp-password',
      'a-brand-new-passphrase',
      'a-brand-new-passphrase',
      FORCED,
    );
    expect(await screen.findByText('The current password is not correct.')).toBeTruthy();
    submitPasswordChange('temp-password-123', 'short', 'short', FORCED);
    expect(await screen.findByText(/at least 12 characters/)).toBeTruthy();
    expect(screen.getByText(/too common/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/VAL_0001|too_short|current_password_incorrect/);
    expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('');
  });

  it('lets the user sign out instead', async () => {
    installFakeApi(forcedHandlers(() => ({ status: 204 })));
    renderApp();
    await signIn();
    await screen.findByRole('heading', { name: 'Choose a new password' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('You have been signed out.')).toBeTruthy();
  });
});

describe('voluntary password change inside the shell', () => {
  it('is reachable from the header and shows a success message', async () => {
    installFakeApi({
      ...base,
      'POST /auth/login': () => loginOk(),
      'GET /auth/me': () => ({ status: 200, body: meFor() }),
      'POST /auth/change-password': () => ({ status: 204 }),
    });
    renderApp();
    await signIn();
    await screen.findByRole('heading', { name: 'Dashboard' });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await screen.findByRole('heading', { name: 'Change password' });
    submitPasswordChange(
      'old-passphrase-1',
      'new-passphrase-22',
      'new-passphrase-22',
      'Change password',
    );
    expect(await screen.findByText(/Your password was changed/)).toBeTruthy();
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe('');
  });

  it('reports a rate limit without leaving the page', async () => {
    installFakeApi({
      ...base,
      'POST /auth/login': () => loginOk(),
      'GET /auth/me': () => ({ status: 200, body: meFor() }),
      'POST /auth/change-password': () => apiError(429, 'AUTH_0003'),
    });
    renderApp('/account/password');
    await signIn();
    await screen.findByRole('heading', { name: 'Change password' });
    submitPasswordChange(
      'old-passphrase-1',
      'new-passphrase-22',
      'new-passphrase-22',
      'Change password',
    );
    expect((await screen.findByRole('alert')).textContent).toContain('Too many attempts');
  });
});

describe('sign-out, expiry and revocation', () => {
  const session: Record<string, FakeHandler> = {
    ...base,
    'POST /auth/login': () => loginOk(),
    'GET /auth/me': () => ({ status: 200, body: meFor() }),
  };

  it('sign-out revokes the session, clears the shell and no later request carries the token', async () => {
    const calls = installFakeApi(session);
    renderApp();
    await signIn();
    await screen.findByRole('heading', { name: 'Dashboard' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('You have been signed out.')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.path === '/auth/logout')).toBe(true));
    expect(calls.find((c) => c.path === '/auth/logout')!.headers.authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(document.documentElement.outerHTML).not.toContain('Asha Rao');
  });

  it('a 401 on an in-session request ends the session with an honest "ended" message', async () => {
    installFakeApi({ ...session, 'POST /auth/change-password': () => apiError(401, 'AUTH_0001') });
    renderApp('/account/password');
    await signIn();
    await screen.findByRole('heading', { name: 'Change password' });
    submitPasswordChange(
      'old-passphrase-1',
      'new-passphrase-22',
      'new-passphrase-22',
      'Change password',
    );
    expect(await screen.findByText(/session has ended/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });

  describe('timers', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    });

    it('signs out locally when the absolute session lifetime passes', async () => {
      const me = meFor({ sessionExpiresAt: new Date(Date.now() + 60_000).toISOString() });
      installFakeApi({ ...session, 'GET /auth/me': () => ({ status: 200, body: me }) });
      renderApp();
      await signIn();
      await screen.findByRole('heading', { name: 'Dashboard' });
      await act(async () => {
        vi.advanceTimersByTime(75_000);
      });
      expect(await screen.findByText(/session expired/)).toBeTruthy();
    });

    it('signs out after the idle timeout without user activity, and tells the server', async () => {
      const calls = installFakeApi({
        ...session,
        'GET /auth/me': () => ({ status: 200, body: meFor({ idleTimeoutSeconds: 120 }) }),
      });
      renderApp();
      await signIn();
      await screen.findByRole('heading', { name: 'Dashboard' });
      await act(async () => {
        vi.advanceTimersByTime(150_000);
      });
      expect(await screen.findByText(/session expired/)).toBeTruthy();
      expect(calls.some((c) => c.path === '/auth/logout')).toBe(true);
    });

    it('user activity keeps the session alive with a keep-alive request', async () => {
      const calls = installFakeApi({
        ...session,
        'GET /auth/me': () => ({ status: 200, body: meFor({ idleTimeoutSeconds: 300 }) }),
      });
      renderApp();
      await signIn();
      await screen.findByRole('heading', { name: 'Dashboard' });
      const before = calls.filter((c) => c.path === '/auth/me').length;
      for (let i = 0; i < 6; i++) {
        await act(async () => {
          fireEvent.keyDown(window, { key: 'a' });
          vi.advanceTimersByTime(30_000);
        });
      }
      expect(calls.filter((c) => c.path === '/auth/me').length).toBeGreaterThan(before);
      expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    });

    it('a keep-alive that finds the session revoked returns to sign-in', async () => {
      let revoked = false;
      installFakeApi({
        ...session,
        'GET /auth/me': () =>
          revoked
            ? apiError(401, 'AUTH_0001')
            : { status: 200, body: meFor({ idleTimeoutSeconds: 300 }) },
      });
      renderApp();
      await signIn();
      await screen.findByRole('heading', { name: 'Dashboard' });
      revoked = true;
      await act(async () => {
        fireEvent.keyDown(window, { key: 'a' });
        vi.advanceTimersByTime(120_000);
      });
      expect(await screen.findByText(/session has ended/)).toBeTruthy();
    });
  });
});

describe('permission-driven navigation', () => {
  function withPermissions(permissions: string[], roles: string[] = ['Anything']) {
    installFakeApi({
      ...base,
      'POST /auth/login': () => loginOk(),
      'GET /auth/me': () => ({ status: 200, body: meFor({ permissions, roles }) }),
    });
  }
  const ALL = [
    'customer.read',
    'product.read',
    'inventory.stock.read',
    'sales.invoice.read',
    'org.settings.read',
  ];

  it('shows Dashboard plus only the entries the permission set allows; the rest are "Coming soon", not links', async () => {
    withPermissions(['customer.read', 'sales.invoice.read']);
    renderApp();
    await signIn();
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(nav.textContent).toContain('Dashboard');
    expect(nav.textContent).toContain('Customers');
    expect(nav.textContent).toContain('Billing');
    expect(nav.textContent).not.toContain('Products');
    expect(nav.textContent).not.toContain('Inventory');
    expect(nav.textContent).not.toContain('Settings');
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Customers/ })).toBeNull();
    expect(within(nav).getAllByText('Coming soon')).toHaveLength(2);
  });

  it('authorises from permissions, never from a role name', async () => {
    withPermissions([], ['Administrator']);
    renderApp();
    await signIn();
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(nav.textContent).toBe('Dashboard');
  });

  it('shows every module entry to a user holding all the permissions, whatever the role is called', async () => {
    withPermissions(ALL, ['Some custom role']);
    renderApp();
    await signIn();
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    for (const label of ['Customers', 'Products', 'Inventory', 'Billing', 'Settings']) {
      expect(nav.textContent).toContain(label);
    }
    expect(within(nav).getAllByText('Coming soon')).toHaveLength(5);
  });

  it('a typed path without permission says so; with permission says Coming soon; unknown is not found', async () => {
    withPermissions(['customer.read']);
    renderApp('/products');
    await signIn();
    expect(await screen.findByText('You do not have access to this area')).toBeTruthy();
    cleanup();
    withPermissions(['customer.read']);
    renderApp('/customers');
    await signIn();
    expect(await screen.findByRole('heading', { name: 'Coming soon' })).toBeTruthy();
    cleanup();
    withPermissions([]);
    renderApp('/nowhere');
    await signIn();
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });

  it('shows an honest empty message when the user has no module access, and invents no figures', async () => {
    withPermissions([], []);
    renderApp();
    await signIn();
    expect(await screen.findByText('Your account has no module access yet.')).toBeTruthy();
    expect(screen.getByText('None assigned')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/₹|revenue/i);
  });
});

describe('ErrorBoundary', () => {
  it('shows a safe message without leaking the error text', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Boom(): never {
      throw new Error('secret-internal-detail');
    }
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).not.toContain('secret-internal-detail');
  });

  it('renders children when nothing fails', () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeTruthy();
  });
});
