// @vitest-environment jsdom
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
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { AuthProvider } from '../auth.js';
import {
  TAX_18,
  UNIT_KG,
  UNIT_PCS,
  product,
  references,
} from '../test-support/product-fixtures.js';
import {
  apiError,
  installFakeApi,
  loginOk,
  meFor,
  type FakeHandler,
  type FakeRequest,
} from '../test-support/fake-api.js';

configure({ asyncUtilTimeout: 5000 });

const WRITE = ['product.read', 'product.write'];
const READ = ['product.read'];
const base: Record<string, FakeHandler> = {
  'GET /setup/status': () => ({
    status: 200,
    body: { setupRequired: false, draftAvailable: false },
  }),
  'GET /health': () => ({ status: 200, body: {} }),
  'GET /health/db': () => ({ status: 200, body: {} }),
  'POST /auth/logout': () => ({ status: 204 }),
  'POST /auth/login': () => loginOk(),
  'GET /products/references': () => ({ status: 200, body: references() }),
};

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

const listBody = (products = [product(), product()], total = products.length) => ({
  status: 200,
  body: { products, total, limit: 25, offset: 0 },
});
const listOf =
  (products = [product(), product()], total = products.length): FakeHandler =>
  () =>
    listBody(products, total);
const listCalls = (calls: FakeRequest[], method = 'GET') =>
  calls.filter((c) => c.method === method && c.path === '/products');

const section = (name: string) => within(screen.getByRole('region', { name }));
const labelled = (scope: ReturnType<typeof within>, label: string) =>
  scope.getByLabelText(
    new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}( \\((required|optional)\\))?$`),
  );
const typeIn = (scope: ReturnType<typeof within>, label: string, value: string) =>
  fireEvent.change(labelled(scope, label), { target: { value } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('product list', () => {
  it('shows real rows: SKU, name, type, HSN/SAC, unit, price with its GST basis, inventory and status', async () => {
    const rows = [
      product({
        sku: 'PRD-000001',
        name: 'Fictional Phone',
        barcode: '8901234567890',
        hsnSacCodeId: 'h',
        hsnSacCode: { code: '8517', kind: 'HSN', description: null },
        sellingPrice: '118000.00',
        priceIncludesTax: true,
        trackInventory: true,
      }),
      product({
        sku: 'PRD-000002',
        name: 'Fictional Consulting',
        kind: 'SERVICE',
        unitId: null,
        unit: null,
        sellingPrice: '1000.00',
        isActive: false,
      }),
    ];
    await open('/products', WRITE, { 'GET /products': listOf(rows) });
    const table = await screen.findByRole('table');
    const text = table.textContent ?? '';
    for (const expected of [
      'PRD-000001',
      'Fictional Phone',
      '8901234567890',
      'Goods',
      '8517',
      'PCS',
      '₹1,18,000.00',
      'incl. GST',
      'Tracked',
      'Service',
      '₹1,000.00',
      '+ GST',
      'Not tracked',
      'Inactive',
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(screen.getByRole('link', { name: 'Edit Fictional Phone' }).getAttribute('href')).toBe(
      `/products/${rows[0]!.id}`,
    );
    expect(screen.getByRole('button', { name: 'New product' })).toBeTruthy();
    expect(screen.getByText('Showing 1-2 of 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    expect(text).not.toMatch(/cgst|sgst|igst|stock/i); // no fake tax breakdown, no stock figures
  });

  it('loading, error with retry, empty (writers vs readers) and no-match states', async () => {
    let fail = true;
    const calls = await open('/products', WRITE, {
      'GET /products': () => (fail ? apiError(500, 'SYS_0500') : listBody()),
    });
    expect((await screen.findByRole('status')).textContent).toContain('Loading products');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).not.toContain('SYS_0500');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(listCalls(calls).length).toBeGreaterThanOrEqual(2);
    cleanup();

    await open('/products', WRITE, { 'GET /products': listOf([], 0) });
    expect(await screen.findByText('No products yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New product' }).length).toBeGreaterThan(0);
    cleanup();
    await open('/products', READ, { 'GET /products': listOf([], 0) });
    expect(await screen.findByText(/appear here once they are added/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New product' })).toBeNull();
  });

  it('searches on the server (debounced) and offers to clear when nothing matches', async () => {
    const calls = await open('/products', WRITE, {
      'GET /products': (req) => (req.query.includes('search=zzz') ? listBody([], 0) : listBody()),
    });
    await screen.findByRole('table');
    expect(listCalls(calls)[0]!.query).toContain('isActive=true');
    for (const v of ['z', 'zz', 'zzz'])
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: v } });
    expect(await screen.findByText('No products match')).toBeTruthy();
    const searched = listCalls(calls).filter((c) => c.query.includes('search='));
    expect(searched).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('sends the status, type and inventory filters to the server', async () => {
    const calls = await open('/products', WRITE, { 'GET /products': listOf() });
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    await waitFor(() =>
      expect(listCalls(calls).some((c) => c.query.includes('isActive=false'))).toBe(true),
    );
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
    await waitFor(() => expect(listCalls(calls).at(-1)!.query).not.toContain('isActive'));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'SERVICE' } });
    await waitFor(() => expect(listCalls(calls).at(-1)!.query).toContain('kind=SERVICE'));
    fireEvent.change(screen.getByLabelText('Inventory'), { target: { value: 'yes' } });
    await waitFor(() => expect(listCalls(calls).at(-1)!.query).toContain('tracked=true'));
    fireEvent.change(screen.getByLabelText('Inventory'), { target: { value: 'no' } });
    await waitFor(() => expect(listCalls(calls).at(-1)!.query).toContain('tracked=false'));
  });

  it('pages with server offsets', async () => {
    const calls = await open('/products', WRITE, {
      'GET /products': (req) => {
        const offset = Number(new URLSearchParams(req.query).get('offset'));
        const products = Array.from({ length: offset === 0 ? 25 : 5 }, () => product());
        return { status: 200, body: { products, total: 30, limit: 25, offset } };
      },
    });
    expect(await screen.findByText('Showing 1-25 of 30')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 26-30 of 30')).toBeTruthy();
    expect(listCalls(calls).at(-1)!.query).toContain('offset=25');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Showing 1-25 of 30')).toBeTruthy();
  });

  it('a new search term returns to the first page, and Next right after clearing it still works', async () => {
    const calls = await open('/products', WRITE, {
      'GET /products': (req) => {
        const q = new URLSearchParams(req.query);
        const offset = Number(q.get('offset'));
        const searching = q.has('search');
        const total = searching ? 3 : 30;
        const n = searching ? 3 : offset === 0 ? 25 : 5;
        const products = Array.from({ length: n }, () => product());
        return { status: 200, body: { products, total, limit: 25, offset } };
      },
    });
    expect(await screen.findByText('Showing 1-25 of 30')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 26-30 of 30')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'abc' } });
    expect(await screen.findByText('Showing 1-3 of 3')).toBeTruthy(); // back on the first page for the new term
    expect(new URLSearchParams(listCalls(calls).at(-1)!.query).get('offset')).toBe('0');
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
    expect(await screen.findByText('Showing 1-25 of 30')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // immediately after the term changed back
    expect(await screen.findByText('Showing 26-30 of 30')).toBeTruthy();
  });

  it('a read-only user sees Open instead of Edit and no New product button', async () => {
    await open('/products', READ, { 'GET /products': listOf([product({ name: 'Readable' })]) });
    expect(await screen.findByRole('link', { name: 'Open Readable' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New product' })).toBeNull();
  });
});

describe('new product form', () => {
  const openForm = (handlers: Record<string, FakeHandler> = {}) =>
    open('/products/new', WRITE, handlers).then(async (calls) => {
      await screen.findByRole('heading', { name: 'New product' });
      return calls;
    });

  it('is grouped into sections, defaults to goods and loads real reference lists', async () => {
    await openForm();
    for (const t of ['Basic details', 'Classification', 'Tax', 'Pricing', 'Inventory settings']) {
      expect(screen.getByRole('region', { name: t })).toBeTruthy();
    }
    expect((screen.getByRole('radio', { name: /^Goods/ }) as HTMLInputElement).checked).toBe(true);
    const unit = labelled(section('Classification'), 'Unit of measure') as HTMLSelectElement;
    expect([...unit.options].map((o) => o.textContent)).toEqual([
      'Choose a unit…',
      'PCS - Pieces',
      'KG - Kilogram',
    ]);
    const tax = labelled(section('Tax'), 'Tax category') as HTMLSelectElement;
    expect([...tax.options].map((o) => o.textContent)).toEqual([
      'Choose a tax category…',
      'GST 18%',
      'GST 5%',
    ]);
    await waitFor(() =>
      expect(document.activeElement).toBe(labelled(section('Basic details'), 'Product name')),
    );
    expect(section('Tax').getByText(/placeholders and have not been verified/)).toBeTruthy();
    expect(section('Inventory settings').getByLabelText(/^Track inventory/)).toBeTruthy();
  });

  it('services: unit optional, inventory toggle hidden, switching the type clears the HSN/SAC choice', async () => {
    await openForm();
    fireEvent.click(screen.getByRole('radio', { name: /^Service/ }));
    expect(labelled(section('Classification'), 'Unit of measure')).toBeTruthy();
    expect(screen.getByText(/Services do not track inventory/)).toBeTruthy();
    expect(section('Inventory settings').queryByLabelText(/^Track inventory/)).toBeNull();
    expect(section('Classification').getByLabelText(/SAC code/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^Goods/ }));
    expect(section('Classification').getByLabelText(/HSN code/)).toBeTruthy();
  });

  it('echoes the price with its GST basis and never invents a tax breakdown', async () => {
    await openForm();
    const pricing = section('Pricing');
    expect(pricing.getByText(/Enter a selling price/)).toBeTruthy();
    typeIn(pricing, 'Selling price (INR)', '1000');
    expect(pricing.getByText('₹1,000.00')).toBeTruthy();
    expect(pricing.getByText(/\+ applicable GST/)).toBeTruthy();
    fireEvent.click(pricing.getByRole('radio', { name: /^Includes GST/ }));
    typeIn(pricing, 'Selling price (INR)', '1180');
    expect(pricing.getByText('₹1,180.00')).toBeTruthy();
    expect(pricing.getByText(/inclusive of GST/)).toBeTruthy();
    expect(pricing.getByText(/worked out when a document is created/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Pricing' }).textContent).not.toMatch(
      /₹1,000\.00.*inclusive|180\.00 GST|CGST|SGST|IGST/i,
    );
  });

  it('validates before sending: required fields and money rules, with no request made', async () => {
    const calls = await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    expect(await screen.findByText('Please fix the following before saving')).toBeTruthy();
    for (const m of [
      'Product name: This field is required.',
      'Unit of measure: This field is required.',
      'Tax category: This field is required.',
      'Selling price: This field is required.',
    ]) {
      expect(screen.getByText(m), m).toBeTruthy();
    }
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true'));
    typeIn(section('Basic details'), 'Product name', 'Widget');
    typeIn(section('Classification'), 'Unit of measure', UNIT_PCS);
    typeIn(section('Tax'), 'Tax category', TAX_18);
    typeIn(section('Pricing'), 'Selling price (INR)', '10.999');
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    expect((await screen.findAllByText(/at most two decimal places/)).length).toBeGreaterThan(0);
    typeIn(section('Pricing'), 'Selling price (INR)', '-5');
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    expect((await screen.findAllByText(/cannot be negative/)).length).toBeGreaterThan(0);
    expect(listCalls(calls, 'POST')).toHaveLength(0);
  });

  it('creates goods sending prices as exact text, then returns to the list with the stock hint', async () => {
    const made = product({ sku: 'PRD-000042', name: 'Fictional Widget', trackInventory: true });
    let sent: Record<string, unknown> = {};
    const calls = await openForm({
      'POST /products': (req) => {
        sent = req.body as Record<string, unknown>;
        return { status: 201, body: { product: made } };
      },
      'GET /products': listOf([made]),
    });
    typeIn(section('Basic details'), 'Product name', 'Fictional Widget');
    typeIn(section('Basic details'), 'Barcode', '8901234567890');
    typeIn(section('Classification'), 'Unit of measure', UNIT_KG);
    typeIn(section('Tax'), 'Tax category', TAX_18);
    typeIn(section('Pricing'), 'Selling price (INR)', '1234567890123456.78');
    typeIn(section('Pricing'), 'MRP (INR)', '9007199254740993.01');
    fireEvent.click(section('Inventory settings').getByLabelText(/^Track inventory/));
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    fireEvent.click(screen.getByRole('button', { name: 'Saving' })); // a second click while saving is ignored
    expect(
      await screen.findByText(
        /Product PRD-000042 \(Fictional Widget\) was created\. Stock can be added from Inventory/,
      ),
    ).toBeTruthy();
    expect(listCalls(calls, 'POST')).toHaveLength(1);
    expect(sent).toMatchObject({
      kind: 'GOODS',
      name: 'Fictional Widget',
      unitId: UNIT_KG,
      taxCategoryId: TAX_18,
      sellingPrice: '1234567890123456.78', // exact text: a number would have lost digits
      mrp: '9007199254740993.01',
      priceIncludesTax: false,
      trackInventory: true,
      barcode: '8901234567890',
      hsnSacCodeId: null,
    });
    for (const k of ['organizationId', 'id', 'sku', 'quantity', 'stock', 'costPrice'])
      expect(sent).not.toHaveProperty(k);
  });

  it('a late second click (after the request was sent) cannot submit twice', async () => {
    const calls = await openForm({
      'POST /products': () => ({ status: 201, body: { product: product() } }),
      'GET /products': listOf(),
    });
    typeIn(section('Basic details'), 'Product name', 'Widget');
    typeIn(section('Classification'), 'Unit of measure', UNIT_PCS);
    typeIn(section('Tax'), 'Tax category', TAX_18);
    typeIn(section('Pricing'), 'Selling price (INR)', '10');
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Saving' })); // arrives asynchronously, after the first click
    await screen.findByRole('table');
    expect(listCalls(calls, 'POST')).toHaveLength(1);
  });

  it('creates a service without a unit and never tracks inventory', async () => {
    let sent: Record<string, unknown> = {};
    await openForm({
      'POST /products': (req) => {
        sent = req.body as Record<string, unknown>;
        return {
          status: 201,
          body: { product: product({ kind: 'SERVICE', unitId: null, unit: null }) },
        };
      },
      'GET /products': listOf(),
    });
    fireEvent.click(screen.getByRole('radio', { name: /^Service/ }));
    typeIn(section('Basic details'), 'Product name', 'Installation visit');
    typeIn(section('Tax'), 'Tax category', TAX_18);
    typeIn(section('Pricing'), 'Selling price (INR)', '500');
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    await screen.findByRole('table');
    expect(sent).toMatchObject({
      kind: 'SERVICE',
      unitId: null,
      trackInventory: false,
      sellingPrice: '500',
    });
    expect(screen.queryByText(/Stock can be added/)).toBeNull();
  });

  it('HSN/SAC: an empty reference list is explained; a populated one is searched on the server and the picked id is sent', async () => {
    await openForm({
      'GET /products/references': () => ({ status: 200, body: references({ hsnSacTotal: 0 }) }),
    });
    expect(await screen.findByText(/Your HSN\/SAC list is empty/)).toBeTruthy();
    expect(section('Classification').queryByLabelText(/HSN code/)).toBeNull();
    cleanup();

    let sent: Record<string, unknown> = {};
    const calls = await openForm({
      'GET /products/references/hsn-sac': (req) => ({
        status: 200,
        body: req.query.includes('search=85')
          ? {
              codes: [
                {
                  id: '30000000-0000-4000-8000-000000008517',
                  code: '8517',
                  kind: 'HSN',
                  description: 'Telephone sets',
                },
              ],
              total: 1,
            }
          : { codes: [], total: 0 },
      }),
      'POST /products': (req) => {
        sent = req.body as Record<string, unknown>;
        return { status: 201, body: { product: product() } };
      },
      'GET /products': listOf(),
    });
    const cls = section('Classification');
    typeIn(cls, 'HSN code', '85');
    fireEvent.click(await screen.findByRole('button', { name: /8517/ }));
    expect(screen.getByTestId('hsn-selected').textContent).toBe('8517 - Telephone sets');
    const hsnCall = calls.find((c) => c.path === '/products/references/hsn-sac')!;
    expect(hsnCall.query).toContain('kind=HSN');
    typeIn(section('Basic details'), 'Product name', 'Phone');
    typeIn(cls, 'Unit of measure', UNIT_PCS);
    typeIn(section('Tax'), 'Tax category', TAX_18);
    typeIn(section('Pricing'), 'Selling price (INR)', '100');
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    await screen.findByRole('table');
    expect(sent).toMatchObject({ hsnSacCodeId: '30000000-0000-4000-8000-000000008517' });
    expect(JSON.stringify(sent)).not.toContain('Telephone'); // only the id travels
  });

  it('shows server rejections safely: a duplicate SKU is explained next to the field', async () => {
    await openForm({
      'POST /products': () => apiError(409, 'BIZ_0001', [{ field: 'sku', rule: 'duplicate_sku' }]),
    });
    typeIn(section('Basic details'), 'Product name', 'Widget');
    typeIn(section('Basic details'), 'SKU', 'abc-1');
    typeIn(section('Classification'), 'Unit of measure', UNIT_PCS);
    typeIn(section('Tax'), 'Tax category', TAX_18);
    typeIn(section('Pricing'), 'Selling price (INR)', '10');
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    expect(await screen.findByText('This product clashes with an existing one')).toBeTruthy();
    expect(screen.getAllByText('This SKU is already in use.').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/BIZ_0001|duplicate_sku|server wording/);
    expect((labelled(section('Basic details'), 'Product name') as HTMLInputElement).value).toBe(
      'Widget',
    );
    expect((labelled(section('Basic details'), 'SKU') as HTMLInputElement).value).toBe('ABC-1'); // upper-cased as typed
  });

  it('reference lists that fail to load give a retry, not a broken form', async () => {
    let fail = true;
    await open('/products/new', WRITE, {
      'GET /products/references': () =>
        fail ? apiError(500, 'SYS_0500') : { status: 200, body: references() },
    });
    expect(await screen.findByText(/units and tax categories could not be loaded/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'New product' })).toBeTruthy();
  });

  it('a user without product.write cannot open the New product screen', async () => {
    await open('/products/new', READ, {});
    expect(await screen.findByText('You do not have access to add products')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create product' })).toBeNull();
  });
});

describe('edit, deactivate and read-only', () => {
  const existing = () =>
    product({
      sku: 'PRD-000007',
      name: 'Existing Widget',
      sellingPrice: '1180.00',
      priceIncludesTax: true,
      trackInventory: true,
      barcode: '123456',
      version: 3,
    });

  it('loads the product, keeps SKU and type read-only, and saves with the version it loaded', async () => {
    const p = existing();
    const patches: Record<string, unknown>[] = [];
    await open(`/products/${p.id}`, WRITE, {
      [`GET /products/${p.id}`]: () => ({ status: 200, body: { product: p } }),
      [`PATCH /products/${p.id}`]: (req) => {
        patches.push(req.body as Record<string, unknown>);
        const b = req.body as { expectedVersion: number; name: string; sellingPrice: string };
        return {
          status: 200,
          body: {
            product: {
              ...p,
              name: b.name,
              sellingPrice: b.sellingPrice,
              version: b.expectedVersion + 1,
            },
          },
        };
      },
    });
    expect(await screen.findByRole('heading', { name: 'Existing Widget' })).toBeTruthy();
    const sku = labelled(section('Basic details'), 'SKU') as HTMLInputElement;
    expect(sku.value).toBe('PRD-000007');
    expect(sku.readOnly).toBe(true);
    expect(screen.getByText('(cannot be changed)')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^Goods/ })).toBeNull();
    expect((labelled(section('Pricing'), 'Selling price (INR)') as HTMLInputElement).value).toBe(
      '1180.00',
    );
    expect(
      (section('Pricing').getByRole('radio', { name: /^Includes GST/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);

    typeIn(section('Basic details'), 'Product name', 'Renamed Widget');
    typeIn(section('Pricing'), 'Selling price (INR)', '1250.50');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Product saved.')).toBeTruthy();
    expect(patches[0]).toMatchObject({
      expectedVersion: 3,
      name: 'Renamed Widget',
      sellingPrice: '1250.50',
    });
    for (const k of ['sku', 'organizationId']) expect(patches[0]).not.toHaveProperty(k);
    typeIn(section('Basic details'), 'Product name', 'Renamed Again');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toMatchObject({ expectedVersion: 4 });
  });

  it('explains a concurrent change (409) without overwriting; Reload brings back the latest', async () => {
    const p = existing();
    const latest = { ...p, name: 'Changed By Someone Else', version: 4 };
    let reads = 0;
    await open(`/products/${p.id}`, WRITE, {
      [`GET /products/${p.id}`]: () => ({
        status: 200,
        body: { product: reads++ === 0 ? p : latest },
      }),
      [`PATCH /products/${p.id}`]: () => apiError(409, 'DB_0002'),
    });
    await screen.findByRole('heading', { name: 'Existing Widget' });
    typeIn(section('Basic details'), 'Product name', 'My Edit');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This product was changed by someone else')).toBeTruthy();
    expect(screen.getByText(/nothing was overwritten/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/DB_0002/);
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() =>
      expect((labelled(section('Basic details'), 'Product name') as HTMLInputElement).value).toBe(
        'Changed By Someone Else',
      ),
    );
  });

  it('deactivates after confirmation and reactivates, using the current version; nothing is deleted', async () => {
    const p = existing();
    let state = { ...p };
    const toggles: { path: string; body: unknown }[] = [];
    await open(`/products/${p.id}`, WRITE, {
      [`GET /products/${p.id}`]: () => ({ status: 200, body: { product: state } }),
      [`POST /products/${p.id}/deactivate`]: (req) => {
        toggles.push({ path: req.path, body: req.body });
        state = { ...state, isActive: false, version: state.version + 1 };
        return { status: 200, body: { product: state } };
      },
      [`POST /products/${p.id}/activate`]: (req) => {
        toggles.push({ path: req.path, body: req.body });
        state = { ...state, isActive: true, version: state.version + 1 };
        return { status: 200, body: { product: state } };
      },
    });
    await screen.findByRole('heading', { name: 'Existing Widget' });
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('Deactivate this product?')).toBeTruthy();
    expect(toggles).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, deactivate' }));
    expect(await screen.findByText(/This product is inactive/)).toBeTruthy();
    expect(toggles[0]).toEqual({
      path: `/products/${p.id}/deactivate`,
      body: { expectedVersion: 3 },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, reactivate' }));
    await waitFor(() => expect(screen.queryByText(/This product is inactive/)).toBeNull());
    expect(toggles[1]).toEqual({
      path: `/products/${p.id}/activate`,
      body: { expectedVersion: 4 },
    });
  });

  it('read-only users see every detail but cannot change anything', async () => {
    const p = existing();
    await open(`/products/${p.id}`, READ, {
      [`GET /products/${p.id}`]: () => ({ status: 200, body: { product: p } }),
    });
    expect(await screen.findByText('You have read-only access to products.')).toBeTruthy();
    const name = labelled(section('Basic details'), 'Product name') as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(name.value).toBe('Existing Widget');
    expect((labelled(section('Pricing'), 'Selling price (INR)') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });

  it('a product keeps its retired unit and tax category visible and selectable as "(inactive)"', async () => {
    const p = product({
      unitId: 'u-old',
      unit: { code: 'OLD', name: 'Old unit', decimalPlaces: 0 },
      taxCategoryId: 't-old',
      taxCategory: { code: 'OLD', name: 'Old category', classification: 'STANDARD' },
    });
    await open(`/products/${p.id}`, WRITE, {
      [`GET /products/${p.id}`]: () => ({ status: 200, body: { product: p } }),
    });
    await screen.findByRole('heading', { name: p.name });
    const unit = labelled(section('Classification'), 'Unit of measure') as HTMLSelectElement;
    expect(unit.value).toBe('u-old');
    expect([...unit.options].some((o) => o.textContent === 'OLD - Old unit (inactive)')).toBe(true);
    const tax = labelled(section('Tax'), 'Tax category') as HTMLSelectElement;
    expect([...tax.options].some((o) => o.textContent === 'Old category (inactive)')).toBe(true);
  });

  it('says so when the product does not exist (or belongs to another organization)', async () => {
    const id = '00000000-0000-4000-8000-0000000000ff';
    await open(`/products/${id}`, WRITE, {
      [`GET /products/${id}`]: () => apiError(404, 'SYS_0404'),
    });
    expect(await screen.findByText('Product not found')).toBeTruthy();
    expect(document.body.textContent).not.toContain('SYS_0404');
  });
});

describe('navigation', () => {
  it('Products is a real sidebar link for users with product.read and hidden without it', async () => {
    await open('/', READ, { 'GET /products': listOf() });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Products' }).getAttribute('href')).toBe(
      '/products',
    );
    cleanup();
    await open('/', [], {});
    expect(
      within(await screen.findByRole('navigation', { name: 'Main' })).queryByText('Products'),
    ).toBeNull();
  });

  it('a typed /products path without product.read shows the access message and makes no product request', async () => {
    const calls = await open('/products', [], {});
    expect(await screen.findByText('You do not have access to this area')).toBeTruthy();
    expect(listCalls(calls)).toHaveLength(0);
  });
});
