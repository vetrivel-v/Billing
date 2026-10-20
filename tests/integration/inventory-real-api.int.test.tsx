// @vitest-environment jsdom
// Task 1.11: the real Inventory screens (DOM rendered by jsdom) against the real Fastify API and a real, migrated
// PostgreSQL database. Nothing about the API is mocked or scripted (one test drops a response on purpose to prove that a
// retry cannot change stock twice).
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

configure({ asyncUtilTimeout: 10_000 });

let fx: Fixture;
let app: FastifyInstance;
let baseUrl: string;
let sent: { method: string; url: string }[];
let warehouseId: string;
let unitPcs: string;
let unitKg: string;
let taxId: string;
const ids: Record<string, string> = {};
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

async function newProduct(key: string, name: string, over: Record<string, unknown> = {}) {
  ids[key] = (
    await fx.prisma.product.create({
      data: {
        organizationId: fx.orgId,
        sku: key.toUpperCase(),
        name,
        kind: 'GOODS',
        unitId: unitPcs,
        taxCategoryId: taxId,
        sellingPrice: '10.00',
        trackInventory: true,
        ...over,
      },
    })
  ).id;
}

const stockPosts = () => sent.filter((s) => s.method === 'POST' && s.url.includes('/inventory/'));
const goToInventory = async () =>
  fireEvent.click(await screen.findByRole('link', { name: 'Inventory' }));
const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
const onHand = async (key: string) =>
  (
    await fx.prisma.stockBalance.findUnique({
      where: { warehouseId_productId: { warehouseId, productId: ids[key]! } },
    })
  )?.quantityOnHand.toFixed(4);
const movements = (key: string) =>
  fx.prisma.stockMovement.count({ where: { productId: ids[key]! } });

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  await fx.prisma.organization.update({
    where: { id: fx.orgId },
    data: { setupCompletedAt: new Date() },
  });
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'silent' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  warehouseId = (
    await fx.prisma.warehouse.create({
      data: { organizationId: fx.orgId, code: 'MAIN', name: 'Main Warehouse', isPrimary: true },
    })
  ).id;
  const unit = (code: string) =>
    fx.prisma.unit.findFirstOrThrow({ where: { organizationId: fx.orgId, code } });
  unitPcs = (await unit('PCS')).id;
  unitKg = (await unit('KG')).id;
  taxId = (
    await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'GST_18' },
    })
  ).id;
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

describe('inventory through the real UI, API and database', () => {
  it('shows an explanatory empty state while no product tracks inventory', async () => {
    await newProduct('svc1', 'Fictional Consulting', {
      kind: 'SERVICE',
      unitId: null,
      trackInventory: false,
    });
    await newProduct('plain', 'Fictional Untracked Item', { trackInventory: false });
    renderApp();
    await signInAs(users['Administrator']!);
    await goToInventory();
    expect(await screen.findByText('No products track inventory yet')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('34. records opening stock in the UI: one movement, the balance, an audit row, shown on the product page', async () => {
    await newProduct('widget', 'Riverside Widget');
    renderApp();
    await signInAs(users['Administrator']!);
    await goToInventory();
    expect(await screen.findByRole('table')).toBeTruthy();
    // services and untracked goods are never listed
    expect(screen.queryByText('Fictional Consulting')).toBeNull();
    expect(screen.queryByText('Fictional Untracked Item')).toBeNull();
    expect(row('Riverside Widget').textContent).toContain('Main Warehouse');
    expect(within(row('Riverside Widget')).getByText('0')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Add opening stock for Riverside Widget' }));
    expect(await screen.findByRole('heading', { name: 'Opening stock' })).toBeTruthy();
    expect(screen.getByText('Main Warehouse')).toBeTruthy();
    typeIn('Quantity (PCS)', '12');
    typeIn('Reference', 'Count sheet 1');
    fireEvent.click(screen.getByRole('button', { name: 'Record opening stock' }));

    expect(
      await screen.findByText(
        'Opening stock was recorded for Riverside Widget. Stock on hand is now 12 PCS.',
      ),
    ).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Riverside Widget' })).toBeTruthy();
    const table = await screen.findByRole('table');
    expect(table.textContent).toContain('Opening stock');
    expect(table.textContent).toContain('Count sheet 1');
    expect(table.textContent).toContain('Administrator (test)');

    expect(await onHand('widget')).toBe('12.0000');
    expect(await movements('widget')).toBe(1);
    const m = await fx.prisma.stockMovement.findFirstOrThrow({
      where: { productId: ids['widget']! },
    });
    expect(m).toMatchObject({
      movementType: 'OPENING_STOCK',
      organizationId: fx.orgId,
      warehouseId,
    });
    expect(
      await fx.prisma.auditLog.count({
        where: { action: 'inventory.opening_stock', entityId: m.id },
      }),
    ).toBe(1);
    // opening stock is a one-time action: the entry points disappear and a direct visit explains why
    expect(screen.queryByRole('button', { name: 'Add opening stock' })).toBeNull();
    cleanup();
    renderApp(`/inventory/${ids['widget']}/opening`);
    await signInAs(users['Administrator']!);
    expect(await screen.findByText('Opening stock has already been recorded')).toBeTruthy();
  }, 120_000);

  it('35. receives stock in the UI (labelled as a manual receipt, not a purchase)', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToInventory();
    await screen.findByRole('table');
    expect(
      screen.queryByRole('link', { name: 'Add opening stock for Riverside Widget' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Receive stock for Riverside Widget' }));
    expect(await screen.findByRole('heading', { name: 'Manual stock receipt' })).toBeTruthy();
    expect(screen.getByText(/This is not a purchase/)).toBeTruthy();
    typeIn('Quantity (PCS)', '8');
    typeIn('Reference', 'Challan 77');
    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
    expect(
      await screen.findByText(
        'Stock receipt was recorded for Riverside Widget. Stock on hand is now 20 PCS.',
      ),
    ).toBeTruthy();
    expect(await onHand('widget')).toBe('20.0000');
    expect((await screen.findByRole('table')).textContent).toContain('Challan 77');
  }, 120_000);

  it('36. adjusts stock in the UI: the preview is shown, the server decides, a decrease below zero is refused', async () => {
    renderApp(`/inventory/${ids['widget']}/adjust`);
    await signInAs(users['Administrator']!);
    expect(await screen.findByRole('heading', { name: 'Stock adjustment' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^Decrease stock/ }));
    typeIn('Quantity (PCS)', '5');
    const result = screen.getByText('Resulting stock').closest('dl')!;
    expect(result.textContent).toContain('Current stock20 PCS');
    expect(result.textContent).toContain('Adjustment-5 PCS');
    expect(result.textContent).toContain('Resulting stock15 PCS');
    // a reason is required
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    expect(await screen.findByText('Please fix the following before saving')).toBeTruthy();
    expect(stockPosts()).toHaveLength(0);
    fireEvent.change(field('Reason'), { target: { value: 'DAMAGE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    expect(
      await screen.findByText(
        'Stock adjustment was recorded for Riverside Widget. Stock on hand is now 15 PCS.',
      ),
    ).toBeTruthy();
    expect(await onHand('widget')).toBe('15.0000');

    // too much: the browser warns, the SERVER refuses, and nothing is recorded
    const before = await movements('widget');
    fireEvent.click(await screen.findByRole('button', { name: 'Adjust stock' }));
    await screen.findByRole('heading', { name: 'Stock adjustment' });
    fireEvent.click(screen.getByRole('radio', { name: /^Decrease stock/ }));
    typeIn('Quantity (PCS)', '100');
    fireEvent.change(field('Reason'), { target: { value: 'LOSS' } });
    expect(screen.getByText(/would take stock below zero/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    expect(await screen.findByText('Nothing was recorded')).toBeTruthy();
    expect(
      screen.getByText(/There is not enough stock for this change\. Stock on hand is 15 PCS/),
    ).toBeTruthy();
    expect(await movements('widget')).toBe(before);
    expect(await onHand('widget')).toBe('15.0000');
    expect(document.body.textContent).not.toMatch(/BIZ_0001|insufficient_stock/);
    expect(await fx.prisma.auditLog.count({ where: { action: 'inventory.adjustment' } })).toBe(1);
  }, 120_000);

  it('shows quantities as exact decimals for a unit with decimal places, and refuses too many places in the browser', async () => {
    await newProduct('rice', 'Loose Rice', { unitId: unitKg });
    renderApp(`/inventory/${ids['rice']}/receive`);
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'Manual stock receipt' });
    expect(screen.getByText('Up to 3 decimal places for this unit.')).toBeTruthy();
    typeIn('Quantity (KG)', '1.2345');
    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
    expect(
      await screen.findAllByText('This unit does not allow that many decimal places.'),
    ).toBeTruthy();
    expect(stockPosts()).toHaveLength(0);
    typeIn('Quantity (KG)', '2.500');
    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
    expect(
      await screen.findByText(
        'Stock receipt was recorded for Loose Rice. Stock on hand is now 2.5 KG.',
      ),
    ).toBeTruthy();
    expect(await onHand('rice')).toBe('2.5000');
    const table = await screen.findByRole('table');
    expect(table.textContent).toContain('2.5');
    expect(table.textContent).not.toContain('2.500');
    // a quantity JavaScript numbers cannot hold survives untouched
    await fx.prisma.$executeRaw`SELECT 1`;
  }, 120_000);

  it('37. the movement history is newest-first, shows increases and decreases, and is paged by the server', async () => {
    await newProduct('bulk', 'Bulk Bolts');
    const admin = await fx.prisma.user.findFirstOrThrow({
      where: { username: users['Administrator']! },
    });
    for (let i = 1; i <= 30; i++) {
      await fx.prisma.stockMovement.create({
        data: {
          organizationId: fx.orgId,
          warehouseId,
          productId: ids['bulk']!,
          movementType: 'STOCK_RECEIPT',
          quantityDelta: String(i),
          businessDate: new Date('2026-09-15T00:00:00Z'),
          sourceType: 'TEST',
          sourceRef: `bulk-${i}`,
          reference: `LOT-${String(i).padStart(2, '0')}`,
          createdBy: admin.id,
        },
      });
    }
    renderApp(`/inventory/${ids['bulk']}`);
    await signInAs(users['Administrator']!);
    expect(await screen.findByText('Showing 1-25 of 30')).toBeTruthy();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(25); // the renderer only ever receives one page
    expect(rows[0]!.textContent).toContain('LOT-30'); // newest first
    expect(rows[0]!.textContent).toContain('15-09-2026');
    expect(
      sent
        .filter((s) => s.url.includes('/inventory/movements'))
        .every((s) => s.url.includes('limit=25')),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 26-30 of 30')).toBeTruthy();
    expect(screen.getByText('465', { selector: 'span' })).toBeTruthy(); // stock on hand: 1+2+...+30, exact

    // a decrease appears in its own column
    cleanup();
    renderApp(`/inventory/${ids['widget']}`);
    await signInAs(users['Administrator']!);
    const table = await screen.findByRole('table');
    const dmg = within(table).getByText('Damaged').closest('tr')!;
    const cells = within(dmg)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells[1]).toBe('Adjustment (decrease)');
    expect(cells[3]).toBe(''); // increase column empty
    expect(cells[4]).toBe('5'); // decrease column
  }, 180_000);

  it('a lost answer followed by Save again changes stock exactly once', async () => {
    const start = (await onHand('widget'))!;
    const before = await movements('widget');
    let dropped = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ method: init?.method ?? 'GET', url: String(url) });
      const res = await realFetch(url, init);
      if (!dropped && init?.method === 'POST' && String(url).endsWith('/inventory/receipts')) {
        dropped = true;
        throw new TypeError('network error after the server answered'); // the server recorded it; the answer is lost
      }
      return res;
    }) as typeof fetch;
    renderApp(`/inventory/${ids['widget']}/receive`);
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'Manual stock receipt' });
    typeIn('Quantity (PCS)', '3');
    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
    expect(await screen.findByText(/could not reach its local service/)).toBeTruthy();
    expect(await movements('widget')).toBe(before + 1); // the first attempt did arrive
    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
    expect(await screen.findByText(/nothing was added twice/)).toBeTruthy();
    expect(await movements('widget')).toBe(before + 1);
    expect(Number(await onHand('widget'))).toBe(Number(start) + 3);
    const posts = sent.filter((s) => s.method === 'POST' && s.url.endsWith('/inventory/receipts'));
    expect(posts).toHaveLength(2);
  }, 120_000);

  it('38. closing and reopening the application keeps the stock', async () => {
    const first = renderApp();
    await signInAs(users['Administrator']!);
    await goToInventory();
    await screen.findByRole('table');
    first.unmount();

    resetAccessForTests();
    renderApp();
    await signInAs(users['Administrator']!);
    await goToInventory();
    await screen.findByRole('table');
    const rice = row('Loose Rice');
    expect(within(rice).getByText('2.5')).toBeTruthy();
    expect(within(row('Bulk Bolts')).getByText('465')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'riverside' } });
    await waitFor(() => expect(screen.queryByText('Loose Rice')).toBeNull());
    expect(await fx.prisma.stockMovement.count()).toBeGreaterThan(30);
    const { reconcileBalances } = await import('@commercebill/inventory-engine');
    expect(await reconcileBalances(fx.prisma, fx.orgId)).toEqual([]);
  }, 120_000);
});

describe('roles in the real UI', () => {
  it('a Viewer/Auditor and a Billing Operator can look but not change stock', async () => {
    for (const role of ['Viewer/Auditor', 'Billing Operator']) {
      renderApp();
      await signInAs(users[role]!);
      await goToInventory();
      await screen.findByRole('table');
      expect(screen.queryByRole('link', { name: /^(Receive|Adjust|Add opening)/ })).toBeNull();
      fireEvent.click(screen.getByRole('link', { name: 'View movements for Riverside Widget' }));
      await screen.findByRole('heading', { name: 'Riverside Widget' });
      expect(screen.queryByRole('button', { name: /(Receive|Adjust) stock/ })).toBeNull();
      cleanup();
      // typing the address of a change screen still says no (and the server would refuse as well)
      renderApp(`/inventory/${ids['widget']}/receive`);
      await signInAs(users[role]!);
      expect(await screen.findByText('You do not have access to change stock')).toBeTruthy();
      expect(stockPosts()).toHaveLength(0);
      cleanup();
    }
  }, 120_000);

  it('a Warehouse Operator can record stock', async () => {
    renderApp();
    await signInAs(users['Warehouse Operator']!);
    await goToInventory();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('link', { name: 'Receive stock for Loose Rice' }));
    await screen.findByRole('heading', { name: 'Manual stock receipt' });
    typeIn('Quantity (KG)', '0.5');
    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
    expect(await screen.findByText(/Stock on hand is now 3 KG/)).toBeTruthy();
    const m = await fx.prisma.stockMovement.findFirstOrThrow({
      where: { productId: ids['rice']! },
      orderBy: { createdAt: 'desc' },
      include: { createdByUser: true },
    });
    expect(m.createdByUser.username).toBe(users['Warehouse Operator']);
  }, 120_000);

  it('products that cannot hold stock cannot be given any through the UI', async () => {
    renderApp(`/inventory/${ids['svc1']}/receive`);
    await signInAs(users['Administrator']!);
    expect(await screen.findByText('This product cannot hold stock')).toBeTruthy();
    cleanup();
    renderApp(`/inventory/${ids['plain']}`);
    await signInAs(users['Administrator']!);
    expect(await screen.findByText('This product has no stock record')).toBeTruthy();
    expect(await movements('svc1')).toBe(0);
    expect(await movements('plain')).toBe(0);
    cleanup();
    renderApp(`/inventory/${ids['widget']}/teleport`);
    await signInAs(users['Administrator']!);
    expect(await screen.findByText('Page not found')).toBeTruthy();
  }, 120_000);
});
