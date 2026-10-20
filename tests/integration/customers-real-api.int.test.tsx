// @vitest-environment jsdom
// Task 1.9: the real Customers screens (DOM rendered by jsdom) against the real Fastify API and a real, migrated
// PostgreSQL database. Nothing about the API is mocked or scripted.
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
import { gstinCheckCharacter } from '../../packages/setup/src/validators.js';
import { seedReference } from '../../prisma/seed/reference/index.js';
import { LAUNCH_SECRET, PASSWORD, createFixture, type Fixture } from './auth-fixture.js';

configure({ asyncUtilTimeout: 10_000 });

let fx: Fixture;
let app: FastifyInstance;
let baseUrl: string;
let logs: string[];
let sent: { method: string; url: string }[];
const realFetch = globalThis.fetch;
const users: Record<string, string> = {};

const gstin = (pan: string) => {
  const f = `27${pan}1Z`;
  return `${f}${gstinCheckCharacter(f)}`;
};

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

const section = (name: string) => within(screen.getByRole('region', { name }));
const label = (scope: ReturnType<typeof within>, text: string) =>
  scope.getByLabelText(
    new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}( \\((required|optional)\\))?$`),
  );
const typeIn = (scope: ReturnType<typeof within>, text: string, value: string) =>
  fireEvent.change(label(scope, text), { target: { value } });

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

async function seedCustomers(count: number, prefix: string, organizationId = fx.orgId) {
  await fx.prisma.customer.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      organizationId,
      code: `${prefix}-${String(i + 1).padStart(4, '0')}`,
      customerKind: 'INDIVIDUAL',
      legalName: `${prefix} Customer ${String(i + 1).padStart(3, '0')}`,
      billingAddressLine1: '1 Seed Street',
      billingStateCode: '27',
      placeOfSupplyStateCode: '27',
    })),
  });
}

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  await fx.prisma.organization.update({
    where: { id: fx.orgId },
    data: { setupCompletedAt: new Date() },
  });
  logs = [];
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    logStream: { write: (m: string) => void logs.push(m) },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  await newUser('Administrator', 'ui.admin');
  await newUser('Viewer/Auditor', 'ui.viewer');
  await newUser('Warehouse Operator', 'ui.warehouse');
}, 180_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await fx?.close();
});

beforeEach(() => {
  sent = [];
  resetAccessForTests();
  window.commercebill = {
    getAppInfo: async () => ({ name: 'test', version: '0', platform: 'test' }),
    getApiAccess: async () => ({ baseUrl, secret: LAUNCH_SECRET }),
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

describe('customers through the real UI, API and database', () => {
  const PAN = 'AAUPR1234K';

  it('25. creates a customer in the UI; it is saved by the real API, audited, and shown in the list', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    fireEvent.click(await screen.findByRole('link', { name: 'Customers' }));
    expect(await screen.findByText('No customers yet')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'New customer' })[0]!);
    await screen.findByRole('heading', { name: 'New customer' });

    typeIn(section('Basic details'), 'Customer name', 'Riverside Traders Pvt Ltd');
    typeIn(section('Basic details'), 'Display name', 'Riverside');
    fireEvent.change(label(section('Tax details'), 'GST registration'), {
      target: { value: 'REGISTERED' },
    });
    typeIn(section('Tax details'), 'GSTIN', gstin(PAN));
    typeIn(section('Tax details'), 'PAN', PAN);
    typeIn(section('Billing address'), 'Address line 1', '22 River Road');
    typeIn(section('Billing address'), 'City', 'Pune');
    typeIn(section('Billing address'), 'State / union territory', '27');
    typeIn(section('Billing address'), 'PIN code', '411001');
    typeIn(section('Contact'), 'Phone', '9812345678');
    typeIn(section('Contact'), 'Email', 'accounts@riverside.test');
    typeIn(section('Other details'), 'Credit limit (INR)', '75000');
    typeIn(section('Other details'), 'Payment terms (days)', '45');
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));

    expect(
      await screen.findByText(/Customer CUS-000001 \(Riverside Traders Pvt Ltd\) was created\./),
    ).toBeTruthy();
    const table = await screen.findByRole('table');
    expect(table.textContent).toContain('CUS-000001');
    expect(table.textContent).toContain('Riverside Traders Pvt Ltd');
    expect(table.textContent).toContain(gstin(PAN));

    const row = await fx.prisma.customer.findFirstOrThrow({ where: { code: 'CUS-000001' } });
    expect(row).toMatchObject({
      organizationId: fx.orgId,
      customerKind: 'BUSINESS',
      legalName: 'Riverside Traders Pvt Ltd',
      gstStatus: 'REGISTERED',
      gstin: gstin(PAN),
      billingStateCode: '27',
      placeOfSupplyStateCode: '27',
      paymentTermsDays: 45,
      version: 1,
      isActive: true,
    });
    expect(row.creditLimit!.toFixed(2)).toBe('75000.00');
    expect(
      await fx.prisma.auditLog.count({ where: { action: 'customer.create', entityId: row.id } }),
    ).toBe(1);
  }, 120_000);

  it('26. edits the customer in the UI and the change is persisted with a new version', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    fireEvent.click(await screen.findByRole('link', { name: 'Customers' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Edit Riverside Traders Pvt Ltd' }));
    expect(await screen.findByRole('heading', { name: 'Riverside Traders Pvt Ltd' })).toBeTruthy();
    expect((label(section('Basic details'), 'Customer code') as HTMLInputElement).readOnly).toBe(
      true,
    );
    expect((label(section('Contact'), 'Phone') as HTMLInputElement).value).toBe('9812345678');

    typeIn(section('Basic details'), 'Customer name', 'Riverside Traders LLP');
    typeIn(section('Contact'), 'Phone', '9900112233');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Customer saved.')).toBeTruthy();

    const row = await fx.prisma.customer.findFirstOrThrow({ where: { code: 'CUS-000001' } });
    expect(row).toMatchObject({
      legalName: 'Riverside Traders LLP',
      phone: '9900112233',
      version: 2,
      code: 'CUS-000001',
    });
    const audit = await fx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'customer.update', entityId: row.id },
    });
    expect(JSON.stringify(audit)).not.toContain('9900112233');
  }, 120_000);

  it('deactivates and reactivates through the UI; the default list hides inactive customers', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    fireEvent.click(await screen.findByRole('link', { name: 'Customers' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Edit Riverside Traders LLP' }));
    await screen.findByRole('heading', { name: 'Riverside Traders LLP' });
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, deactivate' }));
    expect(await screen.findByText(/This customer is inactive/)).toBeTruthy();
    expect(
      (await fx.prisma.customer.findFirstOrThrow({ where: { code: 'CUS-000001' } })).isActive,
    ).toBe(false);
    expect(await fx.prisma.customer.count({ where: { code: 'CUS-000001' } })).toBe(1); // never deleted

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('No customers yet')).toBeTruthy(); // default view = Active only
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    expect(await screen.findByText('Riverside Traders LLP')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Edit Riverside Traders LLP' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, reactivate' }));
    await waitFor(() => expect(screen.queryByText(/This customer is inactive/)).toBeNull());
    expect(
      (await fx.prisma.customer.findFirstOrThrow({ where: { code: 'CUS-000001' } })).isActive,
    ).toBe(true);
  }, 120_000);

  it('27. search and paging run in the database: the renderer only ever receives one page', async () => {
    await seedCustomers(60, 'SRCH');
    renderApp();
    await signInAs(users['Administrator']!);
    fireEvent.click(await screen.findByRole('link', { name: 'Customers' }));
    expect(await screen.findByText('Showing 1-25 of 61')).toBeTruthy(); // 60 seeded + the real one
    expect(screen.getAllByRole('row').length - 1).toBe(25); // never more than one page in the DOM

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'srch customer 042' } });
    expect(await screen.findByText('Showing 1-1 of 1')).toBeTruthy();
    expect(screen.getByText('SRCH Customer 042')).toBeTruthy();
    const searchCalls = sent.filter(
      (s) => s.url.includes('/customers?') && s.url.includes('search='),
    );
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]!.url).toContain('limit=25');

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'SRCH-0007' } }); // by code
    expect(await screen.findByText('SRCH Customer 007')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
    expect(await screen.findByText('Showing 1-25 of 61')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 26-50 of 61')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 51-61 of 61')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  }, 120_000);

  it('28. closing and reopening the application keeps the customer data', async () => {
    const first = renderApp();
    await signInAs(users['Administrator']!);
    fireEvent.click(await screen.findByRole('link', { name: 'Customers' }));
    await screen.findByRole('table');
    first.unmount(); // the window is closed: everything held in memory is gone

    resetAccessForTests();
    renderApp();
    await signInAs(users['Administrator']!);
    fireEvent.click(await screen.findByRole('link', { name: 'Customers' }));
    fireEvent.change(await screen.findByLabelText('Search'), { target: { value: 'Riverside' } });
    expect(await screen.findByText('Riverside Traders LLP')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Edit Riverside Traders LLP' }));
    await screen.findByRole('heading', { name: 'Riverside Traders LLP' });
    expect((label(section('Contact'), 'Phone') as HTMLInputElement).value).toBe('9900112233');
    expect((label(section('Tax details'), 'GSTIN') as HTMLInputElement).value).toBe(gstin(PAN));
    expect(
      (label(section('Other details'), 'Payment terms (days)') as HTMLInputElement).value,
    ).toBe('45');
  }, 120_000);

  it('a concurrent change made elsewhere is reported on save and is not overwritten', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    fireEvent.click(await screen.findByRole('link', { name: 'Customers' }));
    fireEvent.change(await screen.findByLabelText('Search'), { target: { value: 'Riverside' } });
    fireEvent.click(await screen.findByRole('link', { name: 'Edit Riverside Traders LLP' }));
    await screen.findByRole('heading', { name: 'Riverside Traders LLP' });
    const loaded = await fx.prisma.customer.findFirstOrThrow({ where: { code: 'CUS-000001' } });

    // someone else saves a newer version first
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-commercebill-launch-secret': LAUNCH_SECRET },
      payload: { username: users['Administrator'], password: PASSWORD },
    });
    const token = (login.json() as { token: string }).token;
    const other = await app.inject({
      method: 'PATCH',
      url: `/customers/${loaded.id}`,
      headers: { 'x-commercebill-launch-secret': LAUNCH_SECRET, authorization: `Bearer ${token}` },
      payload: { expectedVersion: loaded.version, notes: 'Saved by someone else' },
    });
    expect(other.statusCode).toBe(200);

    typeIn(section('Basic details'), 'Customer name', 'Overwrite Attempt Ltd');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This customer was changed by someone else')).toBeTruthy();
    const after = await fx.prisma.customer.findFirstOrThrow({ where: { code: 'CUS-000001' } });
    expect(after).toMatchObject({
      legalName: 'Riverside Traders LLP',
      notes: 'Saved by someone else',
      version: loaded.version + 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() =>
      expect((label(section('Basic details'), 'Customer name') as HTMLInputElement).value).toBe(
        'Riverside Traders LLP',
      ),
    );
    expect((label(section('Other details'), 'Notes') as HTMLTextAreaElement).value).toBe(
      'Saved by someone else',
    );
  }, 120_000);

  it('server-side rejections reach the form safely: a duplicate GSTIN is explained and nothing is created', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    fireEvent.click(await screen.findByRole('link', { name: 'Customers' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'New customer' }))[0]!);
    await screen.findByRole('heading', { name: 'New customer' });
    typeIn(section('Basic details'), 'Customer name', 'Duplicate Claimant');
    fireEvent.change(label(section('Tax details'), 'GST registration'), {
      target: { value: 'REGISTERED' },
    });
    typeIn(section('Tax details'), 'GSTIN', gstin(PAN));
    typeIn(section('Tax details'), 'PAN', PAN);
    typeIn(section('Billing address'), 'Address line 1', '1 Road');
    typeIn(section('Billing address'), 'State / union territory', '27');
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));
    expect(await screen.findByText('This customer clashes with an existing one')).toBeTruthy();
    expect(screen.getAllByText('Another customer already uses this GSTIN.').length).toBeGreaterThan(
      0,
    );
    expect(await fx.prisma.customer.count({ where: { legalName: 'Duplicate Claimant' } })).toBe(0);
    expect(document.body.textContent).not.toMatch(/BIZ_0001|duplicate_gstin/);
  }, 120_000);
});

describe('roles and organization isolation in the real UI', () => {
  it('a Viewer/Auditor can look but not change; a Warehouse Operator does not see Customers at all', async () => {
    renderApp();
    await signInAs(users['Viewer/Auditor']!);
    fireEvent.click(await screen.findByRole('link', { name: 'Customers' }));
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'New customer' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'Riverside' } });
    fireEvent.click(await screen.findByRole('link', { name: 'Open Riverside Traders LLP' }));
    expect(await screen.findByText('You have read-only access to customers.')).toBeTruthy();
    expect((label(section('Basic details'), 'Customer name') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    cleanup();

    renderApp();
    await signInAs(users['Warehouse Operator']!);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByText('Customers')).toBeNull();
    cleanup();
    sent = [];
    renderApp('/customers');
    await signInAs(users['Warehouse Operator']!);
    expect(await screen.findByText('You do not have access to this area')).toBeTruthy();
    expect(sent.some((s) => s.url.includes('/customers'))).toBe(false); // no request was even made
  }, 120_000);

  it("another organization's customers are invisible in search (a direct link is covered by the API tests: 404)", async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    fireEvent.click(await screen.findByRole('link', { name: 'Customers' }));
    await screen.findByRole('table');
    // The second organization is created AFTER sign-in: the sign-in screen has no organization chooser, and a
    // desktop installation has exactly one organization. The signed-in session is bound to the first.
    const org = await fx.prisma.organization.create({
      data: { legalName: 'DEMO Other Co (fictional)' },
    });
    await seedReference(fx.prisma, { organizationId: org.id });
    await seedCustomers(3, 'OTHERORG', org.id);
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'OTHERORG' } });
    expect(await screen.findByText('No customers match')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/OTHERORG Customer/);
  }, 120_000);
});

describe('no personal data in the server logs', () => {
  it('names, phone numbers, GSTINs and search terms typed in the UI never appear in the logs', async () => {
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(1000);
    for (const secret of [
      'Riverside',
      '9812345678',
      '9900112233',
      'accounts@riverside.test',
      gstin('AAUPR1234K'),
      'srch customer 042',
      PASSWORD,
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});
