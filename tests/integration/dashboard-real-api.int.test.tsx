// @vitest-environment jsdom
// Task 1.18: the Dashboard screen against the real API and database. DEMO figures are labelled DEMO and kept apart from real ones; each role
// sees only the sections its permissions allow; failures use plain wording. Fictional data only.
import { randomUUID } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FastifyInstance } from 'fastify';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { App } from '../../apps/web/src/App.js';
import { resetAccessForTests } from '../../apps/web/src/api.js';
import { AuthProvider } from '../../apps/web/src/auth.js';
import {
  LAUNCH_SECRET,
  PASSWORD,
  call,
  createFixture,
  createRoleUsers,
  type Fixture,
} from './auth-fixture.js';
import { body, previewAndPost, setupBillingWorld } from './invoice-fixture.js';

let fx: Fixture;
let app: FastifyInstance;
let baseUrl: string;
const realFetch = globalThis.fetch;
const USERS: Record<string, string> = {
  Administrator: 'admin.user',
  Accountant: 'accountant.user',
  'Billing Operator': 'billing.user',
  'Warehouse Operator': 'warehouse.user',
  'Viewer/Auditor': 'viewer.user',
};

function renderApp(path = '/') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function signIn(username: string) {
  await screen.findByRole('heading', { name: 'Sign in' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'Dashboard' });
}

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  app = await fx.makeApp();
  const tokens = await createRoleUsers(app, fx.orgId);
  const w = await setupBillingWorld(fx);
  const r = await previewAndPost(
    app,
    tokens['Administrator']!,
    body(w, {}, [{ productId: w.products.untracked, quantity: '2' }]),
  );
  const inv = (r.post.json as unknown as { invoice: { id: string } }).invoice;
  await call(app, 'POST', '/payments', {
    token: tokens['Administrator']!,
    body: {
      mode: 'DEMO',
      invoiceId: inv.id,
      amount: '200',
      method: 'CASH',
      operationId: randomUUID(),
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 240_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  await fx?.close();
});
beforeEach(() => {
  resetAccessForTests();
  window.commercebill = {
    getAppInfo: async () => ({ name: 'test', version: '0', platform: 'test' }),
    getApiAccess: async () => ({ baseUrl, secret: LAUNCH_SECRET }),
    saveInvoicePdf: async () => ({ status: 'cancelled' }),
    printInvoice: async () => ({ status: 'cancelled' }),
    chooseBackupDestination: async () => ({ status: 'cancelled' }),
    chooseRestoreFile: async () => ({ status: 'cancelled' }),
  };
});
afterEach(() => {
  cleanup();
  delete window.commercebill;
  globalThis.fetch = realFetch;
});

describe('Dashboard against the real API', () => {
  it('shows DEMO figures labelled DEMO, no real figures, the recent documents, the readiness checklist and the honest wording', async () => {
    renderApp();
    await signIn(USERS['Administrator']!);
    const demo = await screen.findByRole('region', { name: 'Demo figures' });
    expect(within(demo).getByText('DEMO sales today')).toBeTruthy();
    expect(demo.textContent).toContain('₹590.00');
    expect(demo.textContent).toContain('₹390.00'); // 590 - 200 outstanding
    expect(demo.textContent).toContain('₹200.00'); // payments received today
    expect(screen.queryByRole('region', { name: 'Real figures' })).toBeNull();
    expect(screen.getByText(/CommerceBill is in DEMO mode/)).toBeTruthy();
    const recent = screen.getByRole('region', { name: 'Recent invoices' });
    expect(recent.textContent).toContain('DEMO/');
    expect(screen.getByRole('region', { name: 'Recent payments' }).textContent).toContain('DPAY/');
    const ready = screen.getByRole('region', { name: 'Production readiness' });
    expect(ready.textContent).toContain('NOT READY');
    expect(ready.textContent).toContain('not a GST or legal certification');
    expect(document.body.textContent).not.toMatch(/profit|margin|revenue|cost of goods/i);
    // a recent invoice opens the invoice
    fireEvent.click(within(recent).getByRole('link', { name: /DEMO\// }));
    expect(await screen.findByRole('heading', { name: /^Invoice DEMO\// })).toBeTruthy();
  }, 120_000);

  it('shows each role only the sections its permissions allow', async () => {
    renderApp();
    await signIn(USERS['Warehouse Operator']!);
    await screen.findByRole('region', { name: 'Stock' });
    expect(screen.queryByRole('region', { name: 'Demo figures' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Recent invoices' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Recent payments' })).toBeNull();
    cleanup();
    resetAccessForTests();
    renderApp();
    await signIn(USERS['Billing Operator']!);
    await screen.findByRole('region', { name: 'Demo figures' });
    expect(screen.queryByRole('region', { name: 'Production readiness' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Backup and recovery' })).toBeNull();
  }, 120_000);

  it('a failed summary says so in plain words and shows no figures', async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/dashboard/summary'))
        throw new TypeError('connect ECONNREFUSED 127.0.0.1:1 SELECT * FROM x');
      return realFetch(url, init);
    }) as typeof fetch;
    renderApp();
    await signIn(USERS['Administrator']!);
    await waitFor(() =>
      expect(screen.getByText(/The business figures could not be loaded/)).toBeTruthy(),
    );
    expect(document.body.textContent).not.toMatch(/ECONNREFUSED|SELECT|TypeError/);
    expect(screen.queryByRole('region', { name: 'Demo figures' })).toBeNull();
  }, 120_000);

  it('no screen shows raw technical wording when the service fails: SQL, Prisma, constraint names and stack traces never reach a person', async () => {
    const nasty = {
      error: {
        code: 'SYS_0500',
        message:
          'PrismaClientKnownRequestError: Invalid prisma.customer.findMany() invocation: SELECT "id" FROM "customers" violates foreign key constraint "sales_invoices_customer_id_fkey" at Object.<anonymous> (C:\\repo\\node_modules\\x.js:1:1)',
        dataSaved: false,
        correlationId: 'c0ffee',
      },
    };
    const screens = [
      '/',
      '/customers',
      '/products',
      '/inventory',
      '/tax',
      '/tax/hsn-sac',
      '/billing',
      '/payments',
      '/receivables',
      '/settings/backup',
    ];
    for (const path of screens) {
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        const isData = !/\/(auth|setup|health)/.test(u);
        if (method === 'GET' && isData)
          return new Response(JSON.stringify(nasty), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        return realFetch(url, init);
      }) as typeof fetch;
      resetAccessForTests();
      renderApp(path);
      await signIn(USERS['Administrator']!).catch(async () => {
        // already on the signed-in screen (the first page is the dashboard)
      });
      await waitFor(
        () =>
          expect(document.body.textContent).toMatch(
            /could not|went wrong|Try again|not be loaded|Nothing was changed/i,
          ),
        { timeout: 15_000 },
      );
      const t = document.body.textContent ?? '';
      expect(t, path).not.toMatch(
        /Prisma|SELECT|constraint|_fkey|findMany|node_modules|Object\.<anonymous>|SYS_0500|c0ffee/,
      );
      cleanup();
    }
  }, 300_000);
});
