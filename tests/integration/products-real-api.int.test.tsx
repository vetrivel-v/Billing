// @vitest-environment jsdom
// Task 1.10: the real Products screens (DOM rendered by jsdom) against the real Fastify API and a real, migrated
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
import { seedReference } from '../../prisma/seed/reference/index.js';
import { LAUNCH_SECRET, PASSWORD, createFixture, type Fixture } from './auth-fixture.js';

configure({ asyncUtilTimeout: 10_000 });

let fx: Fixture;
let app: FastifyInstance;
let baseUrl: string;
let logs: string[];
let sent: { method: string; url: string }[];
let unitId: string;
let taxId: string;
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

async function seedProducts(count: number, prefix: string) {
  await fx.prisma.product.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      organizationId: fx.orgId,
      sku: `${prefix}-${String(i + 1).padStart(4, '0')}`,
      name: `${prefix} Item ${String(i + 1).padStart(3, '0')}`,
      kind: i % 10 === 0 ? 'SERVICE' : 'GOODS',
      unitId: i % 10 === 0 ? null : unitId,
      taxCategoryId: taxId,
      sellingPrice: '10.00',
      trackInventory: i % 10 !== 0 && i % 2 === 0,
    })),
  });
}

async function goToProducts() {
  fireEvent.click(await screen.findByRole('link', { name: 'Products' }));
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
  unitId = (
    await fx.prisma.unit.findFirstOrThrow({ where: { organizationId: fx.orgId, code: 'PCS' } })
  ).id;
  taxId = (
    await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'GST_18' },
    })
  ).id;
  await fx.prisma.hsnSacCode.create({
    data: {
      organizationId: fx.orgId,
      code: '8517',
      kind: 'HSN',
      description: 'Telephone sets',
    },
  });
  await fx.prisma.hsnSacCode.create({
    data: {
      organizationId: fx.orgId,
      code: '998314',
      kind: 'SAC',
      description: 'IT consulting',
    },
  });
  await newUser('Administrator', 'ui.admin');
  await newUser('Viewer/Auditor', 'ui.viewer');
  await newUser('Warehouse Operator', 'ui.warehouse');
  await newUser('Billing Operator', 'ui.billing');
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

describe('products through the real UI, API and database', () => {
  const BIG = '1234567890123456.78';

  it('33. creates goods in the UI (HSN picked from the real reference list); saved exactly, audited, listed', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToProducts();
    expect(await screen.findByText('No products yet')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'New product' })[0]!);
    await screen.findByRole('heading', { name: 'New product' });

    typeIn(section('Basic details'), 'Product name', 'Riverside Widget');
    typeIn(section('Basic details'), 'Barcode', '8901234567890');
    typeIn(section('Basic details'), 'Description', 'A fictional widget for tests');
    typeIn(section('Classification'), 'HSN code', '85');
    fireEvent.click(await screen.findByRole('button', { name: /8517/ }));
    typeIn(section('Classification'), 'Unit of measure', unitId);
    typeIn(section('Tax'), 'Tax category', taxId);
    typeIn(section('Pricing'), 'Selling price (INR)', BIG);
    typeIn(section('Pricing'), 'MRP (INR)', '9007199254740993.01');
    fireEvent.click(section('Pricing').getByRole('radio', { name: /^Includes GST/ }));
    fireEvent.click(section('Inventory settings').getByLabelText(/^Track inventory/));
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));

    expect(
      await screen.findByText(
        /Product PRD-000001 \(Riverside Widget\) was created\. Stock can be added from Inventory/,
      ),
    ).toBeTruthy();
    const table = await screen.findByRole('table');
    expect(table.textContent).toContain('PRD-000001');
    expect(table.textContent).toContain('8517');
    expect(table.textContent).toContain('₹1,23,45,67,89,01,23,456.78');
    expect(table.textContent).toContain('incl. GST');

    const row = await fx.prisma.product.findFirstOrThrow({
      where: { sku: 'PRD-000001' },
      include: { hsnSacCode: true },
    });
    expect(row).toMatchObject({
      organizationId: fx.orgId,
      kind: 'GOODS',
      name: 'Riverside Widget',
      unitId,
      taxCategoryId: taxId,
      priceIncludesTax: true,
      trackInventory: true,
      barcode: '8901234567890',
      version: 1,
      isActive: true,
    });
    expect(row.hsnSacCode!.code).toBe('8517');
    expect(row.sellingPrice.toFixed(2)).toBe(BIG); // every digit survived the browser, the API and PostgreSQL
    expect(row.mrp!.toFixed(2)).toBe('9007199254740993.01');
    expect(
      await fx.prisma.auditLog.count({ where: { action: 'product.create', entityId: row.id } }),
    ).toBe(1);
    // the products table has no stock or quantity column: Task 1.11's ledger will be the only source of stock
    const cols = (
      await fx.prisma.$queryRaw<
        { column_name: string }[]
      >`SELECT column_name FROM information_schema.columns WHERE table_name = 'products'`
    ).map((c) => c.column_name);
    expect(cols.filter((c) => /qty|quantity|stock/.test(c))).toEqual([]);
  }, 120_000);

  it('creates a service (SAC from the reference list, no unit, never inventory-tracked)', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToProducts();
    fireEvent.click((await screen.findAllByRole('button', { name: 'New product' }))[0]!);
    await screen.findByRole('heading', { name: 'New product' });
    fireEvent.click(screen.getByRole('radio', { name: /^Service/ }));
    expect(section('Inventory settings').queryByLabelText(/^Track inventory/)).toBeNull();
    typeIn(section('Basic details'), 'Product name', 'IT Consulting Hour');
    typeIn(section('Classification'), 'SAC code', '9983');
    fireEvent.click(await screen.findByRole('button', { name: /998314/ }));
    typeIn(section('Tax'), 'Tax category', taxId);
    typeIn(section('Pricing'), 'Selling price (INR)', '1500');
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    await screen.findByText(/was created\./);
    const row = await fx.prisma.product.findFirstOrThrow({
      where: { name: 'IT Consulting Hour' },
      include: { hsnSacCode: true },
    });
    expect(row).toMatchObject({ kind: 'SERVICE', unitId: null, trackInventory: false });
    expect(row.hsnSacCode!.kind).toBe('SAC');
  }, 120_000);

  it('34. edits the product in the UI and the change is persisted with a new version and an audit row', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToProducts();
    fireEvent.click(await screen.findByRole('link', { name: 'Edit Riverside Widget' }));
    expect(await screen.findByRole('heading', { name: 'Riverside Widget' })).toBeTruthy();
    expect((label(section('Basic details'), 'SKU') as HTMLInputElement).readOnly).toBe(true);
    expect((label(section('Pricing'), 'Selling price (INR)') as HTMLInputElement).value).toBe(BIG);
    expect(screen.getByTestId('hsn-selected').textContent).toBe('8517 - Telephone sets');

    typeIn(section('Basic details'), 'Product name', 'Riverside Widget Mk2');
    typeIn(section('Pricing'), 'Selling price (INR)', '1299.50');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Product saved.')).toBeTruthy();
    const row = await fx.prisma.product.findFirstOrThrow({ where: { sku: 'PRD-000001' } });
    expect(row).toMatchObject({ name: 'Riverside Widget Mk2', version: 2 });
    expect(row.sellingPrice.toFixed(2)).toBe('1299.50');
    const audit = await fx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'product.update', entityId: row.id },
    });
    expect(JSON.stringify(audit)).not.toContain('Riverside');
  }, 120_000);

  it('deactivates and reactivates through the UI; the default list hides inactive products; nothing is deleted', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToProducts();
    fireEvent.click(await screen.findByRole('link', { name: 'Edit Riverside Widget Mk2' }));
    await screen.findByRole('heading', { name: 'Riverside Widget Mk2' });
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, deactivate' }));
    expect(await screen.findByText(/This product is inactive/)).toBeTruthy();
    expect(
      (await fx.prisma.product.findFirstOrThrow({ where: { sku: 'PRD-000001' } })).isActive,
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Riverside Widget Mk2')).toBeNull()); // hidden from the Active view
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    fireEvent.click(await screen.findByRole('link', { name: 'Edit Riverside Widget Mk2' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, reactivate' }));
    await waitFor(() => expect(screen.queryByText(/This product is inactive/)).toBeNull());
    expect(
      (await fx.prisma.product.findFirstOrThrow({ where: { sku: 'PRD-000001' } })).isActive,
    ).toBe(true);
    expect(await fx.prisma.product.count()).toBe(2);
  }, 120_000);

  it('35. search, filters and paging run in the database: the renderer only ever receives one page', async () => {
    await seedProducts(60, 'SRCH');
    renderApp();
    await signInAs(users['Administrator']!);
    await goToProducts();
    expect(await screen.findByText('Showing 1-25 of 62')).toBeTruthy(); // 60 seeded + the two real ones
    expect(screen.getAllByRole('row').length - 1).toBe(25);

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'srch item 042' } });
    expect(await screen.findByText('Showing 1-1 of 1')).toBeTruthy();
    const searchCalls = sent.filter(
      (s) => s.url.includes('/products?') && s.url.includes('search='),
    );
    expect(searchCalls).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'SRCH-0007' } });
    expect(await screen.findByText('SRCH Item 007')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'SRCH' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'SERVICE' } });
    expect(await screen.findByText('Showing 1-6 of 6')).toBeTruthy(); // every 10th seeded item is a service
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'GOODS' } });
    fireEvent.change(screen.getByLabelText('Inventory'), { target: { value: 'yes' } });
    expect(await screen.findByText('Showing 1-24 of 24')).toBeTruthy(); // tracked goods: even positions that are not services
    fireEvent.change(screen.getByLabelText('Inventory'), { target: { value: 'no' } });
    expect(await screen.findByText('Showing 1-25 of 30')).toBeTruthy(); // the other goods (54 goods in all)
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Inventory'), { target: { value: '' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 26-50 of 60')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 51-60 of 60')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  }, 180_000);

  it('36. closing and reopening the application keeps the products', async () => {
    const first = renderApp();
    await signInAs(users['Administrator']!);
    await goToProducts();
    await screen.findByRole('table');
    first.unmount();

    resetAccessForTests();
    renderApp();
    await signInAs(users['Administrator']!);
    await goToProducts();
    fireEvent.change(await screen.findByLabelText('Search'), { target: { value: 'Riverside' } });
    fireEvent.click(await screen.findByRole('link', { name: 'Edit Riverside Widget Mk2' }));
    await screen.findByRole('heading', { name: 'Riverside Widget Mk2' });
    expect((label(section('Pricing'), 'Selling price (INR)') as HTMLInputElement).value).toBe(
      '1299.50',
    );
    expect((label(section('Basic details'), 'Barcode') as HTMLInputElement).value).toBe(
      '8901234567890',
    );
    expect(
      (section('Pricing').getByRole('radio', { name: /^Includes GST/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  }, 120_000);

  it('a concurrent change made elsewhere is reported on save and is not overwritten', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToProducts();
    fireEvent.change(await screen.findByLabelText('Search'), { target: { value: 'Riverside' } });
    fireEvent.click(await screen.findByRole('link', { name: 'Edit Riverside Widget Mk2' }));
    await screen.findByRole('heading', { name: 'Riverside Widget Mk2' });
    const loaded = await fx.prisma.product.findFirstOrThrow({ where: { sku: 'PRD-000001' } });

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-commercebill-launch-secret': LAUNCH_SECRET },
      payload: { username: users['Billing Operator'], password: PASSWORD },
    });
    const token = (login.json() as { token: string }).token;
    const other = await app.inject({
      method: 'PATCH',
      url: `/products/${loaded.id}`,
      headers: { 'x-commercebill-launch-secret': LAUNCH_SECRET, authorization: `Bearer ${token}` },
      payload: { expectedVersion: loaded.version, description: 'Saved by someone else' },
    });
    expect(other.statusCode).toBe(200);

    typeIn(section('Basic details'), 'Product name', 'Overwrite Attempt');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This product was changed by someone else')).toBeTruthy();
    const after = await fx.prisma.product.findFirstOrThrow({ where: { sku: 'PRD-000001' } });
    expect(after).toMatchObject({
      name: 'Riverside Widget Mk2',
      description: 'Saved by someone else',
      version: loaded.version + 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() =>
      expect((label(section('Basic details'), 'Description') as HTMLTextAreaElement).value).toBe(
        'Saved by someone else',
      ),
    );
  }, 120_000);

  it('server-side rejections reach the form safely: a duplicate SKU is explained and nothing is created', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToProducts();
    fireEvent.click((await screen.findAllByRole('button', { name: 'New product' }))[0]!);
    await screen.findByRole('heading', { name: 'New product' });
    typeIn(section('Basic details'), 'Product name', 'Duplicate Claimant');
    typeIn(section('Basic details'), 'SKU', 'prd-000001');
    typeIn(section('Classification'), 'Unit of measure', unitId);
    typeIn(section('Tax'), 'Tax category', taxId);
    typeIn(section('Pricing'), 'Selling price (INR)', '10');
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    expect(await screen.findByText('This product clashes with an existing one')).toBeTruthy();
    expect(screen.getAllByText('This SKU is already in use.').length).toBeGreaterThan(0);
    expect(await fx.prisma.product.count({ where: { name: 'Duplicate Claimant' } })).toBe(0);
    expect(document.body.textContent).not.toMatch(/BIZ_0001|duplicate_sku/);
  }, 120_000);
});

describe('roles and organization isolation in the real UI', () => {
  it('a Viewer/Auditor and a Warehouse Operator can look but not change; a Billing Operator can edit', async () => {
    for (const role of ['Viewer/Auditor', 'Warehouse Operator']) {
      renderApp();
      await signInAs(users[role]!);
      await goToProducts();
      await screen.findByRole('table');
      expect(screen.queryByRole('button', { name: 'New product' })).toBeNull();
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'Riverside' } });
      fireEvent.click(await screen.findByRole('link', { name: 'Open Riverside Widget Mk2' }));
      expect(await screen.findByText('You have read-only access to products.')).toBeTruthy();
      expect((label(section('Basic details'), 'Product name') as HTMLInputElement).disabled).toBe(
        true,
      );
      expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
      cleanup();
    }
    renderApp();
    await signInAs(users['Billing Operator']!);
    await goToProducts();
    expect(await screen.findByRole('button', { name: 'New product' })).toBeTruthy();
  }, 180_000);

  it("another organization's products are invisible in search (a direct link is covered by the API tests: 404)", async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToProducts();
    await screen.findByRole('table');
    // The second organization is created AFTER sign-in: the sign-in screen has no organization chooser.
    const org = await fx.prisma.organization.create({
      data: { legalName: 'DEMO Other Co (fictional)' },
    });
    await seedReference(fx.prisma, { organizationId: org.id });
    const unitB = await fx.prisma.unit.findFirstOrThrow({
      where: { organizationId: org.id, code: 'PCS' },
    });
    const taxB = await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: org.id, code: 'GST_18' },
    });
    await fx.prisma.product.create({
      data: {
        organizationId: org.id,
        sku: 'OTHERORG-1',
        name: 'OTHERORG Secret Gadget',
        kind: 'GOODS',
        unitId: unitB.id,
        taxCategoryId: taxB.id,
        sellingPrice: '5.00',
      },
    });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'OTHERORG' } });
    expect(await screen.findByText('No products match')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/OTHERORG Secret/);
  }, 120_000);
});

describe('no pricing or catalogue data in the server logs', () => {
  it('names, prices, barcodes and search terms typed in the UI never appear in the logs', async () => {
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(1000);
    for (const secret of [
      'Riverside',
      '1234567890123456.78',
      '1299.50',
      '8901234567890',
      'srch item 042',
      PASSWORD,
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});
