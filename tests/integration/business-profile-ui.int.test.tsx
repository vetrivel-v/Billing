// @vitest-environment jsdom
// Business Profile + Settings + Production Readiness Fix links: the real screens (DOM rendered by jsdom) against the real Fastify API and a real,
// migrated PostgreSQL database. Nothing about the API is mocked or scripted.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { FastifyInstance } from 'fastify';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { App } from '../../apps/web/src/App.js';
import { resetAccessForTests } from '../../apps/web/src/api.js';
import { AuthProvider } from '../../apps/web/src/auth.js';
import { LAUNCH_SECRET, PASSWORD, createFixture, type Fixture } from './auth-fixture.js';
import { SELLER_GSTIN, setupBillingWorld } from './invoice-fixture.js';

configure({ asyncUtilTimeout: 10_000 });

let fx: Fixture;
let app: FastifyInstance;
let baseUrl: string;
let sent: { method: string; url: string }[];
const realFetch = globalThis.fetch;
const users: Record<string, string> = {};

function renderApp(path = '/') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function signInAs(username: string) {
  await screen.findByRole('heading', { name: 'Sign in' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}
const field = (text: string) =>
  screen.getByLabelText(
    new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}( \\((required|optional)\\))?$`),
  );
const typeIn = (text: string, value: string) =>
  fireEvent.change(field(text), { target: { value } });
const writes = () => sent.filter((s) => s.method !== 'GET' && !s.url.includes('/auth/'));

async function newUser(role: string, name: string) {
  await app.authService!.createUser({
    organizationId: fx.orgId,
    username: name,
    displayName: `${role} (test)`,
    password: PASSWORD,
    roleNames: [role],
  });
  users[role] = name;
}
/** The seller starts unregistered and without a GSTIN: the readiness item "Seller GST registration" fails. */
async function resetSeller() {
  await fx.prisma.organization.update({
    where: { id: fx.orgId },
    data: {
      legalName: 'Riverside Prints (fictional)',
      gstStatus: 'UNREGISTERED',
      gstin: null,
      pan: null,
      version: 1,
    },
  });
  await fx.prisma.businessLocation.updateMany({
    where: { organizationId: fx.orgId },
    data: { gstin: null, version: 1 },
  });
}
const sellerItem = () =>
  screen.getByText('Seller GST registration recorded and valid').closest('li')!;

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  await setupBillingWorld(fx, fx.orgId, { sellerName: 'Riverside Prints (fictional)' });
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'silent' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  await newUser('Administrator', 'ui.admin');
  await newUser('Viewer/Auditor', 'ui.viewer');
  await newUser('Billing Operator', 'ui.billing');
}, 180_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await fx?.close();
});

beforeEach(async () => {
  sent = [];
  resetAccessForTests();
  await resetSeller();
  window.commercebill = {
    getAppInfo: async () => ({ name: 'test', version: '0', platform: 'test' }),
    getApiAccess: async () => ({ baseUrl, secret: LAUNCH_SECRET }),
    saveInvoicePdf: async () => ({ status: 'cancelled' }),
    printInvoice: async () => ({ status: 'cancelled' }),
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: init?.method ?? 'GET', url: String(url) });
    return realFetch(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  delete window.commercebill;
  globalThis.fetch = realFetch;
});

describe('Settings landing', () => {
  it('lists only the areas that exist, grouped, for an administrator', async () => {
    renderApp('/settings');
    await signInAs(users['Administrator']!);
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    for (const group of ['Business', 'Tax', 'Data protection', 'System'])
      expect(screen.getByRole('heading', { name: group })).toBeTruthy();
    for (const name of [
      'Business Profile',
      'Tax Configuration',
      'HSN / SAC',
      'Backup & Recovery',
      'About & Diagnostics',
    ])
      expect(screen.getByRole('link', { name })).toBeTruthy();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it('shows no areas to a role that may not open Settings at all', async () => {
    renderApp('/');
    await signInAs(users['Billing Operator']!);
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });
});

describe('Business Profile through the real UI, API and database', () => {
  it('1. loads the persisted seller data', async () => {
    renderApp('/settings/business');
    await signInAs(users['Administrator']!);
    expect(await screen.findByRole('heading', { name: 'Business Profile' })).toBeTruthy();
    await waitFor(() =>
      expect((field('Legal business name') as HTMLInputElement).value).toBe(
        'Riverside Prints (fictional)',
      ),
    );
    expect((field('GST registration status') as HTMLSelectElement).value).toBe('UNREGISTERED');
    expect((field('Address line 1') as HTMLInputElement).value).toBe('12 Market Road');
    expect((field('City') as HTMLInputElement).value).toBe('Mumbai');
    expect(
      screen.getByText(/Not stored yet, so not shown here: Phone number, Email address/),
    ).toBeTruthy();
    expect(screen.getByText(/does not verify it with the GST portal/)).toBeTruthy();
  });

  it('refuses an invalid GSTIN with a plain message and sends nothing; a valid one saves', async () => {
    renderApp('/settings/business');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'Business Profile' });
    await waitFor(() =>
      expect((field('Legal business name') as HTMLInputElement).value).not.toBe(''),
    );
    fireEvent.change(field('GST registration status'), { target: { value: 'REGISTERED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save business profile' }));
    expect(await screen.findByText('Enter the GSTIN of a registered business.')).toBeTruthy();
    typeIn('GSTIN', 'BAD-GSTIN');
    fireEvent.click(screen.getByRole('button', { name: 'Save business profile' }));
    expect(await screen.findByText(/not in the correct format/)).toBeTruthy();
    typeIn('GSTIN', '27AAPFU0939F1ZA');
    fireEvent.click(screen.getByRole('button', { name: 'Save business profile' }));
    expect(await screen.findByText(/wrong check character/)).toBeTruthy();
    expect(writes()).toHaveLength(0);

    typeIn('GSTIN', SELLER_GSTIN.toLowerCase());
    fireEvent.click(screen.getByRole('button', { name: 'Save business profile' }));
    expect(await screen.findByText(/Saved\. Changed: .*GSTIN/)).toBeTruthy();
    expect(
      writes().filter((w) => w.method === 'PUT' && w.url.endsWith('/business-profile')),
    ).toHaveLength(1);
    const org = await fx.prisma.organization.findUniqueOrThrow({ where: { id: fx.orgId } });
    expect(org).toMatchObject({ gstStatus: 'REGISTERED', gstin: SELLER_GSTIN });
  });

  it('14/15. Production Readiness fails on the GST item, its Fix opens Business Profile, and after a valid correction readiness has no seller problem', async () => {
    renderApp('/');
    await signInAs(users['Administrator']!);
    await screen.findByText('Production readiness');
    const item = await waitFor(() => {
      const li = sellerItem();
      expect(li.textContent).toContain('✗');
      return li;
    });
    fireEvent.click(within(item).getByRole('link', { name: /Fix: Seller GST registration/ }));
    expect(await screen.findByRole('heading', { name: 'Business Profile' })).toBeTruthy();
    await waitFor(() =>
      expect((field('Legal business name') as HTMLInputElement).value).not.toBe(''),
    );
    fireEvent.change(field('GST registration status'), { target: { value: 'REGISTERED' } });
    typeIn('GSTIN', SELLER_GSTIN);
    fireEvent.click(screen.getByRole('button', { name: 'Save business profile' }));
    expect(await screen.findByText(/^Saved\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }));
    await screen.findByText('Production readiness');
    await waitFor(() => {
      const li = sellerItem();
      expect(li.textContent).toContain('✓');
      expect(within(li).queryByRole('link', { name: /Fix:/ })).toBeNull();
    });
  });

  it('16/17. the Backup and Tax-review items offer a Fix that opens Backup & Recovery and Tax Configuration', async () => {
    renderApp('/');
    await signInAs(users['Administrator']!);
    await screen.findByText('Production readiness');
    const backup = await waitFor(() =>
      screen.getByText('Backup and recovery verified').closest('li')!,
    );
    fireEvent.click(
      within(backup).getByRole('link', { name: /Fix: Backup and recovery verified/ }),
    );
    expect(await screen.findByRole('heading', { name: 'Backup & Recovery' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }));
    await screen.findByText('Production readiness');
    const tax = await waitFor(() =>
      screen.getByText('Tax configuration reviewed and current').closest('li')!,
    );
    fireEvent.click(within(tax).getByRole('link', { name: /Fix: Tax configuration reviewed/ }));
    expect(await screen.findByRole('heading', { name: 'Tax configuration' })).toBeTruthy();
  });

  it('shows no Fix action for a requirement that is already met (HSN/SAC policy)', async () => {
    renderApp('/');
    await signInAs(users['Administrator']!);
    await screen.findByText('Production readiness');
    const li = await waitFor(() => screen.getByText('HSN/SAC policy set').closest('li')!);
    expect(within(li).queryByRole('link')).toBeNull();
  });

  it('a read-only person sees the profile but no Save button and no editable fields', async () => {
    renderApp('/settings/business');
    await signInAs(users['Viewer/Auditor']!);
    expect(await screen.findByRole('heading', { name: 'Business Profile' })).toBeTruthy();
    expect(
      await screen.findByText('You can view the business profile but not change it.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save business profile' })).toBeNull();
    expect((field('Legal business name') as HTMLInputElement).disabled).toBe(true);
  });

  it('19. a saved change is still there after closing and reopening the application', async () => {
    renderApp('/settings/business');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'Business Profile' });
    await waitFor(() =>
      expect((field('Legal business name') as HTMLInputElement).value).not.toBe(''),
    );
    typeIn('Legal business name', 'Riverside Prints and Gifts (fictional)');
    typeIn('City', 'Pune');
    fireEvent.click(screen.getByRole('button', { name: 'Save business profile' }));
    expect(await screen.findByText(/^Saved\./)).toBeTruthy();
    cleanup();
    sessionStorage.clear();
    resetAccessForTests();
    renderApp('/settings/business');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'Business Profile' });
    await waitFor(() =>
      expect((field('Legal business name') as HTMLInputElement).value).toBe(
        'Riverside Prints and Gifts (fictional)',
      ),
    );
    expect((field('City') as HTMLInputElement).value).toBe('Pune');
  });
});
