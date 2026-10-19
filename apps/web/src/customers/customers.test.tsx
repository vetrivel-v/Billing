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
import { customer } from '../test-support/customer-fixtures.js';
import {
  apiError,
  installFakeApi,
  loginOk,
  meFor,
  type FakeHandler,
  type FakeRequest,
} from '../test-support/fake-api.js';
import { gstinCheckCharacter } from '../../../../packages/setup/src/validators.js';

configure({ asyncUtilTimeout: 5000 });

const WRITE = ['customer.read', 'customer.write'];
const READ = ['customer.read'];
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
const meWith = (permissions: string[]): Record<string, FakeHandler> => ({
  'GET /auth/me': () => ({ status: 200, body: meFor({ permissions }) }),
});

async function open(path: string, permissions: string[], handlers: Record<string, FakeHandler>) {
  const calls = installFakeApi({ ...base, ...meWith(permissions), ...handlers });
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

const listBody = (customers = [customer(), customer()], total = customers.length) => ({
  status: 200,
  body: { customers, total, limit: 25, offset: 0 },
});
const listOf =
  (customers = [customer(), customer()], total = customers.length): FakeHandler =>
  () =>
    listBody(customers, total);
const customerCalls = (calls: FakeRequest[], method = 'GET') =>
  calls.filter((c) => c.method === method && c.path === '/customers');

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

describe('customer list', () => {
  it('shows real rows with code, name, type, GST, state, contact and status, and an Edit link', async () => {
    const rows = [
      customer({
        code: 'CUS-000001',
        legalName: 'Acme Traders',
        displayName: 'Acme',
        customerType: 'B2B',
        gstStatus: 'REGISTERED',
        gstin: '27ABCDE1234F1Z0',
        phone: '9000000001',
        email: 'a@acme.test',
      }),
      customer({ code: 'CUS-000002', legalName: 'Walk-in Person', isActive: false }),
    ];
    await open('/customers', WRITE, { 'GET /customers': listOf(rows) });
    expect(await screen.findByRole('heading', { name: 'Customers' })).toBeTruthy();
    const table = await screen.findByRole('table');
    const text = table.textContent ?? '';
    for (const expected of [
      'CUS-000001',
      'Acme Traders',
      'B2B',
      'Registered',
      '27ABCDE1234F1Z0',
      'Maharashtra',
      '9000000001',
      'a@acme.test',
      'Inactive',
    ]) {
      expect(text).toContain(expected);
    }
    expect(screen.getByRole('link', { name: 'Edit Acme Traders' }).getAttribute('href')).toBe(
      `/customers/${rows[0]!.id}`,
    );
    expect(screen.getByRole('button', { name: 'New customer' })).toBeTruthy();
    expect(screen.getByText('Showing 1-2 of 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull(); // customers are never deleted
  });

  it('shows a loading state, then an error state with a retry', async () => {
    let fail = true;
    const calls = await open('/customers', WRITE, {
      'GET /customers': () => (fail ? apiError(500, 'SYS_0500') : listBody()),
    });
    expect((await screen.findByRole('status')).textContent).toContain('Loading customers');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).not.toContain('SYS_0500');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(customerCalls(calls).length).toBeGreaterThanOrEqual(2);
  });

  it('empty state for a new installation offers New customer to writers only', async () => {
    await open('/customers', WRITE, { 'GET /customers': listOf([], 0) });
    expect(await screen.findByText('No customers yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New customer' }).length).toBeGreaterThan(0);
    cleanup();
    await open('/customers', READ, { 'GET /customers': listOf([], 0) });
    expect(await screen.findByText('No customers yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New customer' })).toBeNull();
    expect(screen.getByText(/appear here once they are added/)).toBeTruthy();
  });

  it('searches on the server (debounced), keeps filters and offers to clear them when nothing matches', async () => {
    const calls = await open('/customers', WRITE, {
      'GET /customers': (req) => (req.query.includes('search=zzz') ? listBody([], 0) : listBody()),
    });
    await screen.findByRole('table');
    expect(customerCalls(calls)[0]!.query).toContain('isActive=true'); // Active is the default view
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'z' } });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zz' } });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No customers match')).toBeTruthy();
    const searched = customerCalls(calls).filter((c) => c.query.includes('search='));
    expect(searched).toHaveLength(1); // three keystrokes, one request
    expect(searched[0]!.query).toContain('search=zzz');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    expect(await screen.findByRole('table')).toBeTruthy();
    expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe('');
  });

  it('sends the status and type filters to the server', async () => {
    const calls = await open('/customers', WRITE, { 'GET /customers': listOf() });
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    await waitFor(() =>
      expect(customerCalls(calls).some((c) => c.query.includes('isActive=false'))).toBe(true),
    );
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
    await waitFor(() => expect(customerCalls(calls).at(-1)!.query).not.toContain('isActive'));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'B2C' } });
    await waitFor(() => expect(customerCalls(calls).at(-1)!.query).toContain('type=B2C'));
  });

  it('pages through results with Previous and Next using server offsets', async () => {
    const page = (offset: number) =>
      Array.from({ length: offset === 0 ? 25 : 5 }, () => customer());
    const calls = await open('/customers', WRITE, {
      'GET /customers': (req) => {
        const offset = Number(new URLSearchParams(req.query).get('offset'));
        const customers = page(offset);
        return { status: 200, body: { customers, total: 30, limit: 25, offset } };
      },
    });
    expect(await screen.findByText('Showing 1-25 of 30')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 26-30 of 30')).toBeTruthy();
    expect(customerCalls(calls).at(-1)!.query).toContain('offset=25');
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Showing 1-25 of 30')).toBeTruthy();
  });

  it('a new search term returns to the first page, and Next right after clearing it still works', async () => {
    const calls = await open('/customers', WRITE, {
      'GET /customers': (req) => {
        const q = new URLSearchParams(req.query);
        const offset = Number(q.get('offset'));
        const searching = q.has('search');
        const total = searching ? 3 : 30;
        const n = searching ? 3 : offset === 0 ? 25 : 5;
        const customers = Array.from({ length: n }, () => customer());
        return { status: 200, body: { customers, total, limit: 25, offset } };
      },
    });
    expect(await screen.findByText('Showing 1-25 of 30')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 26-30 of 30')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'abc' } });
    expect(await screen.findByText('Showing 1-3 of 3')).toBeTruthy(); // back on the first page for the new term
    expect(new URLSearchParams(customerCalls(calls).at(-1)!.query).get('offset')).toBe('0');
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
    expect(await screen.findByText('Showing 1-25 of 30')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // immediately after the term changed back
    expect(await screen.findByText('Showing 26-30 of 30')).toBeTruthy();
  });

  it('a read-only user sees Open instead of Edit and no New customer button', async () => {
    const c = customer({ legalName: 'Readable Co' });
    await open('/customers', READ, { 'GET /customers': listOf([c]) });
    expect(await screen.findByRole('link', { name: 'Open Readable Co' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New customer' })).toBeNull();
  });
});

describe('new customer form', () => {
  const GST = (() => {
    const f = '27ABCDE1234F1Z';
    return `${f}${gstinCheckCharacter(f)}`;
  })();

  async function openForm() {
    const calls = await open('/customers/new', WRITE, {});
    await screen.findByRole('heading', { name: 'New customer' });
    return calls;
  }

  it('is grouped into sections and defaults to B2B / unregistered with no GSTIN field', async () => {
    await openForm();
    for (const title of [
      'Basic details',
      'Tax details',
      'Billing address',
      'Shipping address',
      'Contact',
      'Other details',
    ]) {
      expect(screen.getByRole('region', { name: title })).toBeTruthy();
    }
    expect((screen.getByRole('radio', { name: /^B2B/ }) as HTMLInputElement).checked).toBe(true);
    expect(section('Tax details').queryByLabelText(/^GSTIN/)).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(labelled(section('Basic details'), 'Customer name')),
    );
    expect(section('Basic details').getByText(/Leave blank to generate/)).toBeTruthy();
  });

  it('GST fields are conditional: registered needs a GSTIN, composition may have one, B2C hides them all', async () => {
    await openForm();
    const tax = section('Tax details');
    fireEvent.change(labelled(tax, 'GST registration'), { target: { value: 'REGISTERED' } });
    expect(screen.getByLabelText('GSTIN (required)')).toBeTruthy();
    fireEvent.change(labelled(tax, 'GST registration'), { target: { value: 'COMPOSITION' } });
    expect(screen.getByLabelText('GSTIN (optional)')).toBeTruthy();
    fireEvent.change(labelled(tax, 'GST registration'), { target: { value: 'UNREGISTERED' } });
    expect(tax.queryByLabelText(/^GSTIN/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /^B2C/ }));
    expect(tax.queryByLabelText(/^GST registration/)).toBeNull();
    expect(tax.getByText(/Consumers \(B2C\) are not GST registered/)).toBeTruthy();
  });

  it('validates before sending: required fields, GSTIN rules and state consistency', async () => {
    const calls = await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));
    expect(await screen.findByText('Please fix the following before saving')).toBeTruthy();
    expect(screen.getByText('Customer name: This field is required.')).toBeTruthy();
    expect(screen.getByText('Billing address line 1: This field is required.')).toBeTruthy();
    expect(screen.getByText('Billing state: This field is required.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true'));

    typeIn(section('Basic details'), 'Customer name', 'Acme Traders');
    typeIn(section('Billing address'), 'Address line 1', '1 Road');
    typeIn(section('Billing address'), 'State / union territory', '27');
    fireEvent.change(labelled(section('Tax details'), 'GST registration'), {
      target: { value: 'REGISTERED' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));
    expect(
      (await screen.findAllByText(/Enter the GSTIN of a registered customer/)).length,
    ).toBeGreaterThan(0);
    typeIn(section('Tax details'), 'GSTIN', 'NOT-A-GSTIN');
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));
    expect((await screen.findAllByText(/not in the correct format/)).length).toBeGreaterThan(0);
    typeIn(section('Billing address'), 'State / union territory', '29');
    typeIn(section('Tax details'), 'GSTIN', GST);
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));
    expect((await screen.findAllByText(/must match the billing state/)).length).toBeGreaterThan(0);
    expect(customerCalls(calls, 'POST')).toHaveLength(0); // nothing reached the server
  });

  it('creates a B2B customer, sending only real fields, then returns to the list with a confirmation', async () => {
    const made = customer({ code: 'CUS-000042', legalName: 'Acme Traders' });
    let sent: unknown;
    const calls = await open('/customers/new', WRITE, {
      'POST /customers': (req) => {
        sent = req.body;
        return { status: 201, body: { customer: made } };
      },
      'GET /customers': listOf([made]),
    });
    await screen.findByRole('heading', { name: 'New customer' });
    typeIn(section('Basic details'), 'Customer name', 'Acme Traders');
    typeIn(section('Basic details'), 'Display name', 'Acme');
    fireEvent.change(labelled(section('Tax details'), 'GST registration'), {
      target: { value: 'REGISTERED' },
    });
    typeIn(section('Tax details'), 'GSTIN', GST.toLowerCase());
    typeIn(section('Tax details'), 'PAN', 'abcde1234f');
    typeIn(section('Billing address'), 'Address line 1', '22 Example Street');
    typeIn(section('Billing address'), 'State / union territory', '27');
    typeIn(section('Other details'), 'Credit limit (INR)', '25000');
    typeIn(section('Other details'), 'Payment terms (days)', '30');
    const create = screen.getByRole('button', { name: 'Create customer' });
    fireEvent.click(create);
    fireEvent.click(screen.getByRole('button', { name: 'Saving' })); // a second click while saving is ignored
    expect(await screen.findByText('Customer CUS-000042 (Acme Traders) was created.')).toBeTruthy();
    expect(customerCalls(calls, 'POST')).toHaveLength(1);
    expect(sent).toMatchObject({
      customerType: 'B2B',
      legalName: 'Acme Traders',
      displayName: 'Acme',
      gstStatus: 'REGISTERED',
      gstin: GST,
      pan: 'ABCDE1234F',
      billingAddressLine1: '22 Example Street',
      billingStateCode: '27',
      shippingSameAsBilling: true,
      shippingAddressLine1: null,
      placeOfSupplyStateCode: null, // the server defaults it to the delivery state
      creditLimit: '25000',
      paymentTermsDays: '30',
      email: null,
    });
    expect(sent).not.toHaveProperty('organizationId');
    expect(sent).not.toHaveProperty('id');
    expect(sent).not.toHaveProperty('code'); // blank: generated by the server
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('a B2C customer is always sent as unregistered, without a GSTIN', async () => {
    let sent: Record<string, unknown> = {};
    await open('/customers/new', WRITE, {
      'POST /customers': (req) => {
        sent = req.body as Record<string, unknown>;
        return { status: 201, body: { customer: customer() } };
      },
      'GET /customers': listOf(),
    });
    await screen.findByRole('heading', { name: 'New customer' });
    fireEvent.click(screen.getByRole('radio', { name: /^B2C/ }));
    typeIn(section('Basic details'), 'Customer name', 'Walk-in Person');
    typeIn(section('Billing address'), 'Address line 1', '3 Lane');
    typeIn(section('Billing address'), 'State / union territory', '27');
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));
    await screen.findByRole('table');
    expect(sent).toMatchObject({ customerType: 'B2C', gstStatus: 'UNREGISTERED', gstin: null });
  });

  it('shipping: "same as billing" hides the shipping fields; a different address needs line and state and sets the default place of supply', async () => {
    let sent: Record<string, unknown> = {};
    await open('/customers/new', WRITE, {
      'POST /customers': (req) => {
        sent = req.body as Record<string, unknown>;
        return { status: 201, body: { customer: customer() } };
      },
      'GET /customers': listOf(),
    });
    await screen.findByRole('heading', { name: 'New customer' });
    const ship = section('Shipping address');
    expect(ship.queryByLabelText(/^Address line 1/)).toBeNull();
    fireEvent.click(ship.getByLabelText('Shipping address same as billing'));
    typeIn(section('Basic details'), 'Customer name', 'Two Sites Ltd');
    typeIn(section('Billing address'), 'Address line 1', '1 Head Office Road');
    typeIn(section('Billing address'), 'State / union territory', '27');
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));
    expect(await screen.findByText('Shipping state: This field is required.')).toBeTruthy();
    typeIn(ship, 'Address line 1', '9 Dock Road');
    typeIn(ship, 'State / union territory', '29');
    expect(
      within(
        section('Tax details')
          .getByLabelText(/^Place of supply/)
          .closest('div')!,
      ).getByText('Delivery state (Karnataka)'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));
    await screen.findByRole('table');
    expect(sent).toMatchObject({
      shippingSameAsBilling: false,
      shippingAddressLine1: '9 Dock Road',
      shippingStateCode: '29',
      placeOfSupplyStateCode: null,
    });
  });

  it('shows server rejections safely: a duplicate GSTIN is explained next to the field', async () => {
    await open('/customers/new', WRITE, {
      'POST /customers': () =>
        apiError(409, 'BIZ_0001', [{ field: 'gstin', rule: 'duplicate_gstin' }]),
    });
    await screen.findByRole('heading', { name: 'New customer' });
    typeIn(section('Basic details'), 'Customer name', 'Acme Traders');
    fireEvent.change(labelled(section('Tax details'), 'GST registration'), {
      target: { value: 'REGISTERED' },
    });
    typeIn(section('Tax details'), 'GSTIN', GST);
    typeIn(section('Billing address'), 'Address line 1', '1 Road');
    typeIn(section('Billing address'), 'State / union territory', '27');
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));
    expect(await screen.findByText('This customer clashes with an existing one')).toBeTruthy();
    expect(screen.getAllByText('Another customer already uses this GSTIN.').length).toBeGreaterThan(
      0,
    );
    expect(document.body.textContent).not.toMatch(/BIZ_0001|duplicate_gstin|server wording/);
    expect((labelled(section('Basic details'), 'Customer name') as HTMLInputElement).value).toBe(
      'Acme Traders',
    ); // kept
  });

  it('a user without customer.write cannot open the New customer screen', async () => {
    await open('/customers/new', READ, {});
    expect(await screen.findByText('You do not have access to add customers')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create customer' })).toBeNull();
  });
});

describe('edit, deactivate and read-only', () => {
  const existing = () =>
    customer({
      code: 'CUS-000007',
      legalName: 'Existing Buyer',
      customerType: 'B2B',
      gstStatus: 'REGISTERED',
      gstin: '27ABCDE1234F1Z0',
      pan: 'ABCDE1234F',
      phone: '9000000007',
      version: 3,
    });

  it('loads the customer, keeps the code read-only, and saves with the version it loaded', async () => {
    const c = existing();
    const patches: Record<string, unknown>[] = [];
    await open(`/customers/${c.id}`, WRITE, {
      [`GET /customers/${c.id}`]: () => ({ status: 200, body: { customer: c } }),
      [`PATCH /customers/${c.id}`]: (req) => {
        patches.push(req.body as Record<string, unknown>);
        const v = (req.body as { expectedVersion: number }).expectedVersion + 1;
        return {
          status: 200,
          body: {
            customer: {
              ...c,
              legalName: (req.body as { legalName: string }).legalName,
              version: v,
            },
          },
        };
      },
    });
    expect(await screen.findByRole('heading', { name: 'Existing Buyer' })).toBeTruthy();
    expect((labelled(section('Basic details'), 'Customer name') as HTMLInputElement).value).toBe(
      'Existing Buyer',
    );
    const code = labelled(section('Basic details'), 'Customer code') as HTMLInputElement;
    expect(code.value).toBe('CUS-000007');
    expect(code.readOnly).toBe(true);
    expect((labelled(section('Tax details'), 'GSTIN') as HTMLInputElement).value).toBe(
      '27ABCDE1234F1Z0',
    );

    typeIn(section('Basic details'), 'Customer name', 'Renamed Buyer');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Customer saved.')).toBeTruthy();
    expect(patches[0]).toMatchObject({
      expectedVersion: 3,
      legalName: 'Renamed Buyer',
      gstin: '27ABCDE1234F1Z0',
    });
    expect(patches[0]).not.toHaveProperty('code');
    typeIn(section('Basic details'), 'Customer name', 'Renamed Again');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toMatchObject({ expectedVersion: 4 }); // the version moved on after the first save
  });

  it('explains a concurrent change (409) without overwriting, and Reload brings back the latest', async () => {
    const c = existing();
    let latest = { ...c, legalName: 'Changed By Someone Else', version: 4 };
    let reads = 0;
    await open(`/customers/${c.id}`, WRITE, {
      [`GET /customers/${c.id}`]: () => ({
        status: 200,
        body: { customer: reads++ === 0 ? c : latest },
      }),
      [`PATCH /customers/${c.id}`]: () => apiError(409, 'DB_0002'),
    });
    await screen.findByRole('heading', { name: 'Existing Buyer' });
    typeIn(section('Basic details'), 'Customer name', 'My Edit');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This customer was changed by someone else')).toBeTruthy();
    expect(screen.getByText(/nothing was overwritten/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/DB_0002/);
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() =>
      expect((labelled(section('Basic details'), 'Customer name') as HTMLInputElement).value).toBe(
        'Changed By Someone Else',
      ),
    );
    expect(screen.queryByText('This customer was changed by someone else')).toBeNull();
    latest = { ...latest };
  });

  it('deactivates after confirmation and reactivates, using the current version; nothing is deleted', async () => {
    const c = existing();
    let state = { ...c };
    const toggles: { path: string; body: unknown }[] = [];
    await open(`/customers/${c.id}`, WRITE, {
      [`GET /customers/${c.id}`]: () => ({ status: 200, body: { customer: state } }),
      [`POST /customers/${c.id}/deactivate`]: (req) => {
        toggles.push({ path: req.path, body: req.body });
        state = { ...state, isActive: false, version: state.version + 1 };
        return { status: 200, body: { customer: state } };
      },
      [`POST /customers/${c.id}/activate`]: (req) => {
        toggles.push({ path: req.path, body: req.body });
        state = { ...state, isActive: true, version: state.version + 1 };
        return { status: 200, body: { customer: state } };
      },
    });
    await screen.findByRole('heading', { name: 'Existing Buyer' });
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('Deactivate this customer?')).toBeTruthy();
    expect(screen.getByText(/Nothing is deleted/)).toBeTruthy();
    expect(toggles).toHaveLength(0); // not yet
    fireEvent.click(screen.getByRole('button', { name: 'Yes, deactivate' }));
    expect(await screen.findByText(/This customer is inactive/)).toBeTruthy();
    expect(toggles[0]).toEqual({
      path: `/customers/${c.id}/deactivate`,
      body: { expectedVersion: 3 },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, reactivate' }));
    await waitFor(() => expect(screen.queryByText(/This customer is inactive/)).toBeNull());
    expect(toggles[1]).toEqual({
      path: `/customers/${c.id}/activate`,
      body: { expectedVersion: 4 },
    });
  });

  it('read-only users see every detail but cannot change anything', async () => {
    const c = existing();
    await open(`/customers/${c.id}`, READ, {
      [`GET /customers/${c.id}`]: () => ({ status: 200, body: { customer: c } }),
    });
    expect(await screen.findByText('You have read-only access to customers.')).toBeTruthy();
    expect((labelled(section('Basic details'), 'Customer name') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((labelled(section('Basic details'), 'Customer name') as HTMLInputElement).value).toBe(
      'Existing Buyer',
    );
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });

  it('says so when the customer does not exist (or belongs to another organization)', async () => {
    await open('/customers/00000000-0000-4000-8000-0000000000ff', WRITE, {
      'GET /customers/00000000-0000-4000-8000-0000000000ff': () => apiError(404, 'SYS_0404'),
    });
    expect(await screen.findByText('Customer not found')).toBeTruthy();
    expect(document.body.textContent).not.toContain('SYS_0404');
  });
});

describe('navigation', () => {
  it('Customers is a real sidebar link for users with customer.read and hidden without it', async () => {
    await open('/', READ, { 'GET /customers': listOf() });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Customers' }).getAttribute('href')).toBe(
      '/customers',
    );
    cleanup();
    await open('/', [], {});
    const nav2 = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav2).queryByText('Customers')).toBeNull();
  });

  it('a typed /customers path without customer.read shows the access message, not data', async () => {
    const calls = await open('/customers', [], {});
    expect(await screen.findByText('You do not have access to this area')).toBeTruthy();
    expect(customerCalls(calls)).toHaveLength(0);
  });
});
