// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, render, screen, within } from '@testing-library/react';
import type { StockMovementView, StockRowView } from '@commercebill/shared-types';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { AuthProvider } from '../auth.js';
import {
  apiError,
  installFakeApi,
  loginOk,
  meFor,
  type FakeHandler,
  type FakeRequest,
} from '../test-support/fake-api.js';

configure({ asyncUtilTimeout: 5000 });

const READ = ['inventory.stock.read'];
const WRITE = ['inventory.stock.read', 'inventory.adjustment.create'];
const WAREHOUSE = {
  id: '33333333-3333-4333-8333-333333333333',
  code: 'MAIN',
  name: 'Main Warehouse',
};
const base: Record<string, FakeHandler> = {
  'GET /setup/status': () => ({
    status: 200,
    body: { setupRequired: false, draftAvailable: false },
  }),
  'GET /health': () => ({ status: 200, body: {} }),
  'GET /health/db': () => ({ status: 200, body: {} }),
  'POST /auth/logout': () => ({ status: 204 }),
  'POST /auth/login': () => loginOk(),
};

let n = 0;
const item = (over: Partial<StockRowView> = {}): StockRowView => {
  n += 1;
  return {
    productId: `00000000-0000-4000-8000-${String(n + 7000).padStart(12, '0')}`,
    sku: `ITM-${n}`,
    name: `Fictional Item ${n}`,
    isActive: true,
    unit: { code: 'PCS', name: 'Pieces', decimalPlaces: 0 },
    onHand: '10',
    hasMovements: true,
    ...over,
  };
};
const stockOf =
  (rows: StockRowView[], total = rows.length): FakeHandler =>
  () => ({
    status: 200,
    body: { warehouse: WAREHOUSE, stock: rows, total, limit: 25, offset: 0 },
  });
const movement = (over: Partial<StockMovementView> = {}): StockMovementView => ({
  id: `m-${++n}`,
  productId: 'p',
  productSku: 'ITM-1',
  productName: 'Fictional Item',
  unit: { code: 'PCS', decimalPlaces: 0 },
  warehouseId: WAREHOUSE.id,
  warehouseName: WAREHOUSE.name,
  movementType: 'STOCK_RECEIPT',
  quantityDelta: '4',
  businessDate: '2026-10-02',
  reasonCode: null,
  reference: null,
  note: null,
  createdAt: '2026-10-02T05:00:00.000Z',
  createdByName: 'Asha Rao',
  ...over,
});

async function open(path: string, permissions: string[], handlers: Record<string, FakeHandler>) {
  const calls = installFakeApi({
    ...base,
    'GET /auth/me': () => ({ status: 200, body: meFor({ permissions }) }),
    ...handlers,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'Sign in' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'asha.rao' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-password-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  return calls;
}
const field = (text: string) =>
  screen.getByLabelText(
    new RegExp(`^${text.replace(/[()]/g, '\\$&')}( \\((required|optional)\\))?$`),
  );
const stockCalls = (calls: FakeRequest[]) =>
  calls.filter((c) => c.method === 'GET' && c.path === '/inventory/stock');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('inventory list', () => {
  it('shows quantity, unit and warehouse per tracked product, with exact decimals', async () => {
    const rows = [
      item({
        name: 'Loose Rice',
        onHand: '2.5',
        unit: { code: 'KG', name: 'Kilogram', decimalPlaces: 3 },
      }),
      item({ name: 'Bolts', onHand: '1234567' }),
    ];
    await open('/inventory', READ, { 'GET /inventory/stock': stockOf(rows) });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(table.textContent).toContain('2.5');
    expect(table.textContent).toContain('12,34,567');
    expect(table.textContent).toContain('Main Warehouse');
    expect(screen.getByText(/Stock on hand in Main Warehouse/)).toBeTruthy();
  });

  it('read-only users see Movements only; writers also see the stock actions, and opening stock only before any movement', async () => {
    const rows = [
      item({ name: 'Old Stock' }),
      item({ name: 'New Stock', hasMovements: false, onHand: '0' }),
    ];
    await open('/inventory', READ, { 'GET /inventory/stock': stockOf(rows) });
    await screen.findByRole('table');
    expect(screen.queryByRole('link', { name: /^(Receive|Adjust|Add opening)/ })).toBeNull();
    expect(screen.getAllByRole('link', { name: /^View movements/ })).toHaveLength(2);
    cleanup();

    await open('/inventory', WRITE, { 'GET /inventory/stock': stockOf(rows) });
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'Add opening stock for New Stock' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add opening stock for Old Stock' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Receive stock for Old Stock' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Adjust stock for Old Stock' })).toBeTruthy();
  });

  it('explains an empty inventory and an empty search, and offers to clear the search', async () => {
    let empty = true;
    const calls = await open('/inventory', READ, {
      'GET /inventory/stock': (req) =>
        empty || req.query.includes('search=zzz')
          ? {
              status: 200,
              body: { warehouse: WAREHOUSE, stock: [], total: 0, limit: 25, offset: 0 },
            }
          : stockOf([item()])(req),
    });
    expect(await screen.findByText('No products track inventory yet')).toBeTruthy();
    empty = false;
    cleanup();
    await open('/inventory', READ, {
      'GET /inventory/stock': (req) =>
        req.query.includes('search=zzz')
          ? {
              status: 200,
              body: { warehouse: WAREHOUSE, stock: [], total: 0, limit: 25, offset: 0 },
            }
          : stockOf([item()])(req),
    });
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No stock items match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    await screen.findByRole('table');
    expect(calls).toBeTruthy();
  });

  it('sends search, status and paging to the server; the renderer holds only one page', async () => {
    const calls = await open('/inventory', READ, {
      'GET /inventory/stock': () => ({
        status: 200,
        body: { warehouse: WAREHOUSE, stock: [item()], total: 60, limit: 25, offset: 0 },
      }),
    });
    expect(await screen.findByText('Showing 1-1 of 60')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
    await screen.findByRole('table');
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByRole('table');
    const last = stockCalls(calls).at(-1)!;
    expect(last.query).toContain('limit=25');
    expect(last.query).toContain('offset=25');
    expect(last.query).not.toContain('isActive');
  });

  it('reports a failed load and retries', async () => {
    let fail = true;
    await open('/inventory', READ, {
      'GET /inventory/stock': (req) =>
        fail ? { status: 500, body: undefined } : stockOf([item({ name: 'Recovered' })])(req),
    });
    expect(await screen.findByText(/Something went wrong/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Recovered')).toBeTruthy();
  });
});

describe('product stock page', () => {
  const row = item({
    name: 'Detail Item',
    onHand: '7.5',
    unit: { code: 'KG', name: 'Kilogram', decimalPlaces: 3 },
  });
  const path = `/inventory/${row.productId}`;
  const handlers = (movements: StockMovementView[]): Record<string, FakeHandler> => ({
    'GET /inventory/stock': stockOf([row]),
    'GET /inventory/movements': () => ({
      status: 200,
      body: { movements, total: movements.length, limit: 25, offset: 0 },
    }),
  });

  it('shows stock on hand, the immutable history with increases and decreases, and the actions for writers', async () => {
    await open(
      path,
      WRITE,
      handlers([
        movement({
          quantityDelta: '-2',
          movementType: 'ADJUSTMENT_DECREASE',
          reasonCode: 'DAMAGE',
          note: 'Dropped pallet',
        }),
        movement({ quantityDelta: '9.5', movementType: 'OPENING_STOCK', reference: 'Sheet 1' }),
      ]),
    );
    expect(await screen.findByRole('heading', { name: 'Detail Item' })).toBeTruthy();
    expect(screen.getByText('7.5', { selector: 'span' })).toBeTruthy();
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('Damaged');
    expect(rows[0]!.textContent).toContain('Dropped pallet');
    expect(within(rows[0]!).getAllByRole('cell')[4]!.textContent).toBe('2');
    expect(within(rows[1]!).getAllByRole('cell')[3]!.textContent).toBe('9.5');
    expect(rows[1]!.textContent).toContain('02-10-2026');
    expect(screen.getByRole('button', { name: 'Receive stock' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Adjust stock' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add opening stock' })).toBeNull(); // history exists
  });

  it('is read-only without the write permission, explains an empty history, and flags an inactive product', async () => {
    const inactive = { ...row, isActive: false, hasMovements: false };
    await open(path, READ, {
      'GET /inventory/stock': stockOf([inactive]),
      'GET /inventory/movements': () => ({
        status: 200,
        body: { movements: [], total: 0, limit: 25, offset: 0 },
      }),
    });
    expect(await screen.findByText('No movements yet')).toBeTruthy();
    expect(screen.getByText(/Movements will appear here/)).toBeTruthy();
    expect(screen.getByText(/This product is inactive/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /stock$/ })).toBeNull();
  });

  it('says so when the product has no stock record or the load fails', async () => {
    await open(path, READ, {
      'GET /inventory/stock': () => ({
        status: 200,
        body: { warehouse: WAREHOUSE, stock: [], total: 0, limit: 1, offset: 0 },
      }),
      'GET /inventory/movements': () => ({
        status: 200,
        body: { movements: [], total: 0, limit: 25, offset: 0 },
      }),
    });
    expect(await screen.findByText('This product has no stock record')).toBeTruthy();
    cleanup();
    await open(path, READ, {
      'GET /inventory/stock': () => ({ status: 500, body: undefined }),
      'GET /inventory/movements': () => ({ status: 500, body: undefined }),
    });
    expect(await screen.findByText('The stock could not be loaded')).toBeTruthy();
  });

  it('reports a failed movement load and retries', async () => {
    let fail = true;
    await open(path, READ, {
      'GET /inventory/stock': stockOf([row]),
      'GET /inventory/movements': () =>
        fail
          ? { status: 500, body: undefined }
          : {
              status: 200,
              body: {
                movements: [movement({ reference: 'Back again' })],
                total: 1,
                limit: 25,
                offset: 0,
              },
            },
    });
    expect(await screen.findByText(/Something went wrong/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Back again')).toBeTruthy();
  });
});

describe('stock operation form', () => {
  const row = item({ name: 'Form Item', onHand: '5' });
  const listing = (rows: StockRowView[] = [row]) => ({ 'GET /inventory/stock': stockOf(rows) });
  const reply = (over: Record<string, unknown> = {}) => ({
    movement: movement(),
    onHand: '9',
    replayed: false,
    ...over,
  });

  it('sends the typed quantity as text with one operation id, then returns to the product', async () => {
    const calls = await open(`/inventory/${row.productId}/receive`, WRITE, {
      ...listing(),
      'POST /inventory/receipts': () => ({ status: 201, body: reply() }),
      'GET /inventory/movements': () => ({
        status: 200,
        body: { movements: [], total: 0, limit: 25, offset: 0 },
      }),
    });
    await screen.findByRole('heading', { name: 'Manual stock receipt' });
    fireEvent.change(field('Quantity (PCS)'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
    expect(
      await screen.findByText(
        /Stock receipt was recorded for Form Item\. Stock on hand is now 9 PCS\./,
      ),
    ).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/inventory/receipts')!;
    expect(post.body).toMatchObject({
      quantity: '4',
      productId: row.productId,
      warehouseId: WAREHOUSE.id,
    });
    expect(typeof (post.body as Record<string, unknown>).quantity).toBe('string');
    expect((post.body as Record<string, unknown>).operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).not.toHaveProperty('organizationId');
  });

  it('a second click while saving, or right after success, cannot send a second request', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls = await open(`/inventory/${row.productId}/receive`, WRITE, {
      ...listing(),
      'POST /inventory/receipts': async () => {
        await gate;
        return { status: 201, body: reply() };
      },
      'GET /inventory/movements': () => ({
        status: 200,
        body: { movements: [], total: 0, limit: 25, offset: 0 },
      }),
    });
    await screen.findByRole('heading', { name: 'Manual stock receipt' });
    fireEvent.change(field('Quantity (PCS)'), { target: { value: '4' } });
    const submit = screen.getByRole('button', { name: 'Record receipt' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.submit(screen.getByRole('form', { name: 'Manual stock receipt' }));
    release();
    await screen.findByText(/Stock receipt was recorded/);
    expect(
      calls.filter((c) => c.method === 'POST' && c.path === '/inventory/receipts'),
    ).toHaveLength(1);
  });

  it('keeps the same operation id for an unchanged retry and starts a new one after an edit', async () => {
    let attempts = 0;
    const calls = await open(`/inventory/${row.productId}/receive`, WRITE, {
      ...listing(),
      'POST /inventory/receipts': () =>
        ++attempts < 4 ? apiError(500, 'SYS_0500') : { status: 201, body: reply() },
      'GET /inventory/movements': () => ({
        status: 200,
        body: { movements: [], total: 0, limit: 25, offset: 0 },
      }),
    });
    await screen.findByRole('heading', { name: 'Manual stock receipt' });
    fireEvent.change(field('Quantity (PCS)'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
    await screen.findByText(/Something went wrong/);
    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
    await screen.findByText(/Something went wrong/);
    fireEvent.change(field('Quantity (PCS)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
    await screen.findByText(/Something went wrong/);
    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
    await screen.findByText(/Stock receipt was recorded/);
    const ops = calls
      .filter((c) => c.method === 'POST' && c.path === '/inventory/receipts')
      .map((c) => (c.body as Record<string, unknown>).operationId);
    expect(ops).toHaveLength(4);
    expect(ops[0]).toBe(ops[1]); // unchanged retry: same entry
    expect(ops[2]).not.toBe(ops[1]); // an edit makes it a new entry
    expect(ops[2]).toBe(ops[3]);
  });

  it('maps a refused decrease to the quantity field with the current stock, and shows nothing technical', async () => {
    await open(`/inventory/${row.productId}/adjust`, WRITE, {
      ...listing(),
      'POST /inventory/adjustments': () =>
        apiError(409, 'BIZ_0001', [{ field: 'quantity', rule: 'insufficient_stock' }]),
    });
    await screen.findByRole('heading', { name: 'Stock adjustment' });
    fireEvent.click(screen.getByRole('radio', { name: /^Decrease stock/ }));
    fireEvent.change(field('Quantity (PCS)'), { target: { value: '9' } });
    fireEvent.change(field('Reason'), { target: { value: 'LOSS' } });
    expect(screen.getByText(/would take stock below zero/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    expect(await screen.findByText('Nothing was recorded')).toBeTruthy();
    expect(screen.getAllByText(/Stock on hand is 5 PCS/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/BIZ_0001|insufficient_stock|server wording/);
  });

  it('shows server field problems and a generic message for other failures', async () => {
    let mode: 'fields' | 'down' = 'fields';
    await open(`/inventory/${row.productId}/adjust`, WRITE, {
      ...listing(),
      'POST /inventory/adjustments': () =>
        mode === 'fields'
          ? apiError(400, 'VAL_0001', [
              { field: 'productId', rule: 'inventory_not_tracked' },
              { field: 'note', rule: 'too_long' },
            ])
          : apiError(500, 'SYS_0500'),
    });
    await screen.findByRole('heading', { name: 'Stock adjustment' });
    fireEvent.change(field('Quantity (PCS)'), { target: { value: '1' } });
    fireEvent.change(field('Reason'), { target: { value: 'FOUND' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    expect(await screen.findByText('The server could not accept some details')).toBeTruthy();
    expect(screen.getByText('Product: This product does not track inventory.')).toBeTruthy();
    expect(screen.getByText('This is too long.')).toBeTruthy();
    mode = 'down';
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    expect(await screen.findByText(/Something went wrong/)).toBeTruthy();
  });

  it('opening stock that already exists points to an adjustment; no write permission means no form', async () => {
    await open(`/inventory/${row.productId}/opening`, WRITE, listing());
    expect(await screen.findByText('Opening stock has already been recorded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Adjust stock' }));
    expect(await screen.findByRole('heading', { name: 'Stock adjustment' })).toBeTruthy();
    cleanup();
    await open(`/inventory/${row.productId}/receive`, READ, listing());
    expect(await screen.findByText('You do not have access to change stock')).toBeTruthy();
  });

  it('shows the product, warehouse and a live preview for a decrease', async () => {
    await open(`/inventory/${row.productId}/adjust`, WRITE, listing());
    await screen.findByRole('heading', { name: 'Stock adjustment' });
    expect(screen.getByText('Main Warehouse')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^Decrease stock/ }));
    fireEvent.change(field('Quantity (PCS)'), { target: { value: '2' } });
    const result = screen.getByText('Resulting stock').closest('dl')!;
    expect(result.textContent).toContain('Adjustment-2 PCS');
    expect(result.textContent).toContain('Resulting stock3 PCS');
    fireEvent.click(screen.getByRole('radio', { name: /^Increase stock/ }));
    expect(screen.getByText('Resulting stock').closest('dl')!.textContent).toContain(
      'Resulting stock7 PCS',
    );
    fireEvent.change(field('Reason'), { target: { value: 'OTHER' } });
    expect(field('Note')).toBeTruthy(); // required when the reason is Other
    expect(screen.getByLabelText('Note (required)')).toBeTruthy();
  });

  it('cannot reach a product that cannot hold stock, nor an unknown action', async () => {
    await open(`/inventory/${row.productId}/receive`, WRITE, listing([]));
    expect(await screen.findByText('This product cannot hold stock')).toBeTruthy();
    cleanup();
    await open(`/inventory/${row.productId}/receive`, WRITE, {
      'GET /inventory/stock': () => ({ status: 500, body: undefined }),
    });
    expect(await screen.findByText('The product could not be loaded')).toBeTruthy();
    cleanup();
    await open(`/inventory/${row.productId}/teleport`, WRITE, listing());
    expect(await screen.findByText('Page not found')).toBeTruthy();
  });
});
