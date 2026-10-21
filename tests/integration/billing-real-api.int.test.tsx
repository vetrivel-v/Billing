// @vitest-environment jsdom
// Task 1.14: the real Billing screens (DOM rendered by jsdom) against the real Fastify API and a real, migrated PostgreSQL
// database. Nothing about the API is mocked or scripted; two tests wrap fetch only to LOSE an answer or to count calls.
// Fictional data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { postStockMovement } from '@commercebill/inventory-engine';
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
import { setupBillingWorld, type BillingWorld } from './invoice-fixture.js';

configure({ asyncUtilTimeout: 10_000 });

let fx: Fixture;
let app: FastifyInstance;
let baseUrl: string;
let w: BillingWorld;
let logs: string[];
let sent: { method: string; url: string; body: string | undefined }[];
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

const posts = () => sent.filter((s) => s.method === 'POST' && s.url.endsWith('/invoices'));
const previews = () =>
  sent.filter((s) => s.method === 'POST' && s.url.endsWith('/invoices/preview'));
const invoiceCount = () => fx.prisma.salesInvoice.count();
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const totals = () => within(screen.getByLabelText('Invoice totals'));

async function pick(label: string, term: string, option: string | RegExp) {
  const input = screen.getByRole('combobox', { name: label });
  fireEvent.change(input, { target: { value: term } });
  const o = await screen.findByRole('option', { name: option });
  fireEvent.keyDown(input, { key: 'Enter' });
  return o;
}
const pickCustomer = (term: string) => pick('Customer', term, new RegExp(term, 'i'));
const addItem = (term: string) => pick('Add item', term, new RegExp(term, 'i'));
const qty = (name: string, v: string) =>
  fireEvent.change(screen.getByLabelText(`Quantity for ${name}`), { target: { value: v } });
const confirmPos = () => fireEvent.click(screen.getByRole('button', { name: /^Confirm / }));
const preview = async () => {
  const before = previews().length;
  click('Preview');
  await waitFor(() => expect(previews().length).toBe(before + 1));
};
const postButton = () =>
  screen.getByRole('button', { name: /Post demo invoice|Retry posting|Post with updated totals/ });

async function compose(opts: { customer?: string; items?: [string, string][] } = {}) {
  await pickCustomer(opts.customer ?? 'Walk-in');
  for (const [term, q] of opts.items ?? [['Untracked Gadget', '2']]) {
    await addItem(term);
    qty(term, q);
  }
}

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  logs = [];
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    logStream: { write: (m: string) => void logs.push(m) },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  w = await setupBillingWorld(fx);
  await newUser('Administrator', 'ui.admin');
  await newUser('Viewer/Auditor', 'ui.viewer');
  // a role that may compose and preview but not post
  const role = await fx.prisma.role.create({
    data: { organizationId: fx.orgId, name: 'Preview Only' },
  });
  for (const key of [
    'sales.invoice.read',
    'sales.invoice.write',
    'customer.read',
    'product.read',
  ]) {
    const perm = await fx.prisma.permission.findUniqueOrThrow({ where: { key } });
    await fx.prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await newUser('Preview Only', 'ui.nopost');
  // real stock for the tracked product (to prove a DEMO invoice never changes it)
  const admin = await fx.prisma.user.findFirstOrThrow({ where: { username: 'ui.admin' } });
  await fx.prisma.$transaction((tx) =>
    postStockMovement(tx, {
      organizationId: fx.orgId,
      warehouseId: w.warehouseId,
      productId: w.products.tracked,
      movementType: 'OPENING_STOCK',
      quantity: '10',
      businessDate: w.today,
      source: { type: 'OPENING', ref: 'seed', lineRef: '' },
      createdBy: admin.id,
    }),
  );
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
    sent.push({
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body as string | undefined,
    });
    return realFetch(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  delete window.commercebill;
  globalThis.fetch = realFetch;
});

describe('navigation, permissions and the empty list', () => {
  it('1,2. Billing appears for a permitted user and opens the empty invoice list; New invoice is offered to composers only', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    fireEvent.click(await screen.findByRole('link', { name: 'Billing' }));
    expect(await screen.findByText('No invoices yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'New invoice' })).toBeTruthy();
    cleanup();
    renderApp();
    await signInAs(users['Viewer/Auditor']!);
    fireEvent.click(await screen.findByRole('link', { name: 'Billing' }));
    expect(await screen.findByText('No invoices yet')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New invoice' })).toBeNull();
    cleanup();
    renderApp('/billing/new'); // a typed address does not bypass it
    await signInAs(users['Viewer/Auditor']!);
    expect(await screen.findByText('You do not have permission to create invoices.')).toBeTruthy();
  }, 120_000);
});

describe('composing and previewing', () => {
  it('3-13. customer and product search, lines, quantity and discount checks, explicit place of supply, authoritative preview, no business writes', async () => {
    renderApp('/billing/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'New invoice' });
    expect(screen.getByText('DEMO MODE')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Add item' }).hasAttribute('disabled')).toBe(true);

    await pickCustomer('Walk-in');
    expect(screen.getByTestId('customer-context').textContent).toContain('Walk-in Buyer');
    expect(screen.getByTestId('customer-context').textContent).toContain('Maharashtra');

    await addItem('Untracked Gadget');
    await addItem('Tracked Widget');
    // services are listed but cannot be added, and the reason is shown
    const input = screen.getByRole('combobox', { name: 'Add item' });
    fireEvent.change(input, { target: { value: 'Consulting' } });
    const svc = await screen.findByRole('option', { name: /Consulting/ });
    expect(svc.getAttribute('aria-disabled')).toBe('true');
    expect(svc.textContent).toContain('Services cannot be invoiced yet');
    fireEvent.mouseDown(svc);
    expect(screen.queryByLabelText('Quantity for Consulting')).toBeNull();
    fireEvent.change(input, { target: { value: '' } });

    // quantity checks happen before any request
    qty('Untracked Gadget', '1.5');
    qty('Tracked Widget', '0');
    click('Preview');
    expect(
      await screen.findByText('This unit does not allow that many decimal places.'),
    ).toBeTruthy();
    expect(screen.getByText('Enter a quantity greater than zero.')).toBeTruthy();
    expect(previews()).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByLabelText('Quantity for Untracked Gadget'));

    qty('Untracked Gadget', '2');
    qty('Tracked Widget', '1');
    fireEvent.change(screen.getByLabelText('Discount type for Untracked Gadget'), {
      target: { value: 'PERCENT' },
    });
    fireEvent.change(screen.getByLabelText('Discount percentage for Untracked Gadget'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText('Discount type for Tracked Widget'), {
      target: { value: 'AMOUNT' },
    });
    fireEvent.change(screen.getByLabelText('Discount amount in rupees for Tracked Widget'), {
      target: { value: '5' },
    });
    // the price is read-only: there is no price input
    expect(screen.queryByLabelText(/Rate|Price/i)).toBeNull();

    // the suggested place of supply is NOT a confirmation
    expect(screen.getByText(/Suggested place of supply/)).toBeTruthy();
    expect(screen.queryByTestId('pos-confirmed')).toBeNull();
    const before = {
      inv: await invoiceCount(),
      alloc: await fx.prisma.documentNumberAllocation.count(),
      mv: await fx.prisma.stockMovement.count(),
      audit: await fx.prisma.auditLog.count(),
    };
    await preview();
    expect(
      await screen.findByText(
        'Confirm the place of supply for this transaction, then preview again.',
      ),
    ).toBeTruthy();
    expect((postButton() as HTMLButtonElement).disabled).toBe(true);

    confirmPos();
    expect(await screen.findByTestId('pos-confirmed')).toBeTruthy();
    expect(screen.getAllByText(/Totals are out of date/).length).toBeGreaterThan(0);
    expect((postButton() as HTMLButtonElement).disabled).toBe(true); // confirming edits the candidate: preview again
    await preview();
    await waitFor(() =>
      expect(totals().getByText('Total').nextSibling!.textContent).toBe('₹643.10'),
    );
    expect(totals().getByText('Taxable subtotal').nextSibling!.textContent).toBe('₹545.00');
    expect(totals().getByText('CGST').nextSibling!.textContent).toBe('₹49.05');
    expect(totals().getByText('IGST').nextSibling!.textContent).toBe('₹0.00');
    expect((postButton() as HTMLButtonElement).disabled).toBe(false);

    // previews wrote nothing
    expect({
      inv: await invoiceCount(),
      alloc: await fx.prisma.documentNumberAllocation.count(),
      mv: await fx.prisma.stockMovement.count(),
      audit: await fx.prisma.auditLog.count(),
    }).toEqual(before);

    // any edit makes the preview stale and disables Post
    qty('Untracked Gadget', '3');
    expect((await screen.findAllByText(/Totals are out of date/)).length).toBeGreaterThan(0);
    expect((postButton() as HTMLButtonElement).disabled).toBe(true);
    await preview();
    await waitFor(() =>
      expect(totals().getByText('Total').nextSibling!.textContent).not.toBe('₹643.10'),
    );
    expect((postButton() as HTMLButtonElement).disabled).toBe(false);

    // changing the customer clears the confirmation and the totals
    await pickCustomer('Registered');
    await waitFor(() => expect(screen.queryByTestId('pos-confirmed')).toBeNull());
    expect(screen.getByText(/Preview to see the GST/)).toBeTruthy();
    expect(await invoiceCount()).toBe(before.inv);
  }, 120_000);

  it('16. mixed tax-inclusive and tax-exclusive products are blocked with friendly wording', async () => {
    renderApp('/billing/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'New invoice' });
    await compose({
      items: [
        ['Untracked Gadget', '1'],
        ['Inclusive Gizmo', '1'],
      ],
    });
    confirmPos();
    await preview();
    expect(await screen.findByText(/prices that include GST and some that do not/)).toBeTruthy();
    expect((postButton() as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toMatch(/MIXED_PRICE_BASIS/);
  }, 120_000);

  it('11. billing and shipping in different states need an explicit selection', async () => {
    renderApp('/billing/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'New invoice' });
    await compose({ customer: 'Split Address', items: [['Untracked Gadget', '1']] });
    expect(
      screen.getByText(/Billing: Maharashtra \(27\)\. Shipping: Karnataka \(29\)/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Confirm / })).toBeNull();
    const use = screen.getByRole('button', {
      name: 'Use selected place of supply',
    }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Shipping state/ }));
    fireEvent.click(use);
    expect((await screen.findByTestId('pos-confirmed')).textContent).toContain('Karnataka (29)');
    await preview();
    await waitFor(() => expect((postButton() as HTMLButtonElement).disabled).toBe(false));
  }, 120_000);
});

describe('posting a DEMO invoice', () => {
  it('17-21,27. posts once, shows the DEMO number and the immutable snapshot, leaves real stock alone, survives master changes and a reopen', async () => {
    renderApp('/billing/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'New invoice' });
    await compose({ items: [['Tracked Widget', '3']] });
    confirmPos();
    await preview();
    await waitFor(() => expect((postButton() as HTMLButtonElement).disabled).toBe(false));
    click('Post demo invoice');
    const number = `DEMO/${w.financialYearLabel}/000001`;
    expect(await screen.findByRole('heading', { name: `Invoice ${number}` })).toBeTruthy();
    expect(screen.getByText('DEMO INVOICE')).toBeTruthy();
    expect(
      screen.getByText(/Demo invoice .* was posted\. Your stock was not changed\./),
    ).toBeTruthy();
    expect(screen.getByText('Posted invoices cannot be edited.')).toBeTruthy();
    for (const word of ['Edit', 'Delete', 'Cancel invoice', 'Change (customer|product|price|date)'])
      expect(screen.queryByRole('button', { name: new RegExp(word, 'i') })).toBeNull();
    expect(document.body.textContent).toContain('Walk-in Buyer');
    expect(document.body.textContent).toContain('Tracked Widget');
    expect(await invoiceCount()).toBe(1);
    expect(await fx.prisma.stockMovement.count({ where: { movementType: 'SALES_DISPATCH' } })).toBe(
      0,
    );
    const bal = await fx.prisma.stockBalance.findFirstOrThrow({
      where: { productId: w.products.tracked },
    });
    expect(bal.quantityOnHand.toFixed(4)).toBe('10.0000');

    // the Inventory screen still shows the original stock
    fireEvent.click(screen.getByRole('link', { name: 'Inventory' }));
    const row = (await screen.findByText('Tracked Widget')).closest('tr')!;
    expect(within(row).getByText('10')).toBeTruthy();

    // master data changes later do not alter the posted invoice
    const inv = await fx.prisma.salesInvoice.findFirstOrThrow();
    await fx.prisma.product.update({
      where: { id: w.products.tracked },
      data: { name: 'Renamed Widget', sellingPrice: '999.00' },
    });
    await fx.prisma.customer.update({
      where: { id: w.customers.b2c },
      data: { legalName: 'Renamed Buyer' },
    });
    cleanup();
    renderApp(`/billing/${inv.id}`); // closed and reopened
    await signInAs(users['Administrator']!);
    expect(await screen.findByRole('heading', { name: `Invoice ${number}` })).toBeTruthy();
    expect(document.body.textContent).toContain('Walk-in Buyer');
    expect(document.body.textContent).toContain('Tracked Widget');
    expect(document.body.textContent).not.toContain('Renamed');
    await fx.prisma.product.update({
      where: { id: w.products.tracked },
      data: { name: 'Tracked Widget', sellingPrice: '100.00' },
    });
    await fx.prisma.customer.update({
      where: { id: w.customers.b2c },
      data: { legalName: 'Walk-in Buyer' },
    });
    cleanup();
    renderApp('/billing');
    await signInAs(users['Administrator']!);
    const link = await screen.findByRole('link', { name: `Open invoice ${number}` });
    expect(link.closest('tr')!.textContent).toContain('DEMO');
  }, 180_000);

  it('22. a double click creates exactly one invoice', async () => {
    renderApp('/billing/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'New invoice' });
    await compose();
    confirmPos();
    await preview();
    await waitFor(() => expect((postButton() as HTMLButtonElement).disabled).toBe(false));
    const before = await invoiceCount();
    const b = postButton();
    fireEvent.click(b);
    fireEvent.click(b);
    await screen.findByRole('heading', { name: /^Invoice DEMO\// });
    expect(posts()).toHaveLength(1);
    expect(await invoiceCount()).toBe(before + 1);
  }, 120_000);

  it('23. a lost answer: Retry posting reuses the same entry and resolves to the same invoice and number', async () => {
    renderApp('/billing/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'New invoice' });
    await compose({ items: [['Twelve Percent Item', '1']] });
    confirmPos();
    await preview();
    await waitFor(() => expect((postButton() as HTMLButtonElement).disabled).toBe(false));
    const before = await invoiceCount();
    let dropped = false;
    const wrapped = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await wrapped(url, init);
      if (!dropped && init?.method === 'POST' && String(url).endsWith('/invoices')) {
        dropped = true;
        throw new TypeError('network error after the server answered'); // the invoice WAS posted; the answer is lost
      }
      return res;
    }) as typeof fetch;
    click('Post demo invoice');
    expect(
      await screen.findByText('We could not confirm whether the invoice was posted'),
    ).toBeTruthy();
    expect(await invoiceCount()).toBe(before + 1);
    click('Retry posting');
    expect(await screen.findByText(/had already been posted as DEMO\//)).toBeTruthy();
    expect(await invoiceCount()).toBe(before + 1); // not a second invoice
    const ops = posts().map((p) => (JSON.parse(p.body!) as { operationId: string }).operationId);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toBe(ops[1]);
  }, 120_000);

  it('24. CALCULATION_STALE shows the new totals and needs an explicit second Post', async () => {
    renderApp('/billing/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'New invoice' });
    await compose({ items: [['Five Percent Item', '1']] });
    confirmPos();
    await preview();
    await waitFor(() =>
      expect(totals().getByText('Total').nextSibling!.textContent).toBe('₹210.00'),
    );
    const before = await invoiceCount();
    await fx.prisma.product.update({
      where: { id: w.products.gst5 },
      data: { sellingPrice: '300.00' },
    });
    click('Post demo invoice');
    expect(
      await screen.findByText(
        /Invoice details changed since the last preview\. Review the updated totals before posting\./,
      ),
    ).toBeTruthy();
    expect(await invoiceCount()).toBe(before); // not posted automatically
    await waitFor(() =>
      expect(totals().getByText('Total').nextSibling!.textContent).toBe('₹315.00'),
    );
    click('Post with updated totals');
    await screen.findByRole('heading', { name: /^Invoice DEMO\// });
    expect(await invoiceCount()).toBe(before + 1);
    await fx.prisma.product.update({
      where: { id: w.products.gst5 },
      data: { sellingPrice: '200.00' },
    });
  }, 120_000);
});

describe('printing and saving a posted invoice (Task 1.15)', () => {
  const bridge = (over: Record<string, unknown> = {}) => {
    const calls: { save: unknown[]; print: unknown[] } = { save: [], print: [] };
    window.commercebill = {
      getAppInfo: async () => ({ name: 'test', version: '0', platform: 'test' }),
      getApiAccess: async () => ({ baseUrl, secret: LAUNCH_SECRET }),
      saveInvoicePdf: async (inv: unknown) => {
        calls.save.push(inv);
        return { status: 'saved' as const };
      },
      printInvoice: async (inv: unknown) => {
        calls.print.push(inv);
        return { status: 'cancelled' as const };
      },
      ...over,
    } as never;
    return calls;
  };

  it('Preview / Print shows the posted document with the DEMO marking; Print and Save PDF send only the stored snapshot', async () => {
    const calls = bridge();
    const inv = await fx.prisma.salesInvoice.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const lineBefore = await fx.prisma.salesInvoiceLine.findFirstOrThrow({
      where: { invoiceId: inv.id },
    });
    // the master data has moved on since posting
    await fx.prisma.product.update({
      where: { id: lineBefore.productId },
      data: { name: 'Moved On Product', sellingPrice: '777.00' },
    });
    renderApp(`/billing/${inv.id}`);
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: `Invoice ${inv.documentNumber}` });
    fireEvent.click(screen.getByRole('button', { name: 'Preview / Print' }));
    const frame = (await screen.findByTitle('Invoice preview')) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe(''); // no scripts, no same-origin access
    const doc = frame.getAttribute('srcdoc')!;
    expect(doc).toContain('class="wm"');
    expect(doc).toContain('NOT A PRODUCTION TAX INVOICE');
    expect(doc).toContain(inv.documentNumber);
    expect(doc).not.toContain('Moved On Product');
    expect(doc).not.toContain('777.00');
    expect(posts()).toHaveLength(0); // printing posts nothing: no second invoice is needed to print an old one

    fireEvent.click(screen.getByRole('button', { name: /^Print/ }));
    expect(await screen.findByText('Printing was cancelled.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save PDF' }));
    expect(await screen.findByText('The PDF was saved.')).toBeTruthy();
    expect(calls.print).toHaveLength(1);
    expect(calls.save).toHaveLength(1);
    const sent = calls.save[0] as {
      id: string;
      documentNumber: string;
      lines: { productName: string; unitPrice: string }[];
    };
    expect(sent.id).toBe(inv.id);
    expect(sent.documentNumber).toBe(inv.documentNumber);
    expect(sent.lines[0]!.productName).toBe(lineBefore.productName);
    expect(sent.lines[0]!.unitPrice).not.toBe('777.00');
    expect(document.body.textContent).not.toMatch(/[A-Z]:\|\/Users\//); // no path is ever shown
    await fx.prisma.product.update({
      where: { id: lineBefore.productId },
      data: { name: lineBefore.productName, sellingPrice: '100.00' },
    });
  }, 120_000);

  it('Save PDF from the invoice page works too, and a failure or a cancel is reported plainly', async () => {
    const answers: ('failed' | 'cancelled')[] = ['failed', 'cancelled'];
    bridge({ saveInvoicePdf: async () => ({ status: answers.shift() }) });
    const inv = await fx.prisma.salesInvoice.findFirstOrThrow();
    renderApp(`/billing/${inv.id}`);
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: `Invoice ${inv.documentNumber}` });
    fireEvent.click(screen.getByRole('button', { name: 'Save PDF' }));
    expect(
      await screen.findByText('The PDF could not be created. No file was saved.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save PDF' }));
    expect(await screen.findByText('Saving was cancelled. No file was written.')).toBeTruthy();
  }, 120_000);

  it('outside the desktop app the buttons are disabled with an explanation', async () => {
    window.commercebill = {
      getAppInfo: async () => ({ name: 't', version: '0', platform: 't' }),
      getApiAccess: async () => ({ baseUrl, secret: LAUNCH_SECRET }),
    } as never;
    const inv = await fx.prisma.salesInvoice.findFirstOrThrow();
    renderApp(`/billing/${inv.id}/print`);
    await signInAs(users['Viewer/Auditor']!); // read access is enough to view the document
    await screen.findByTitle('Invoice preview');
    expect((screen.getByRole('button', { name: 'Save PDF' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      screen.getByText('Saving and printing are available in the CommerceBill desktop app.'),
    ).toBeTruthy();
  }, 120_000);

  it('a user without invoice access cannot reach the document', async () => {
    bridge();
    const inv = await fx.prisma.salesInvoice.findFirstOrThrow();
    await newUser('Warehouse Operator', 'ui.warehouse');
    renderApp(`/billing/${inv.id}/print`);
    await signInAs('ui.warehouse');
    expect(await screen.findByText('You do not have access to this area')).toBeTruthy();
    expect(screen.queryByTitle('Invoice preview')).toBeNull();
  }, 120_000);
});

describe('permissions, sessions and logs', () => {
  it('25. a user who may preview but not post cannot post', async () => {
    renderApp('/billing/new');
    await signInAs(users['Preview Only']!);
    await screen.findByRole('heading', { name: 'New invoice' });
    await compose();
    confirmPos();
    await preview();
    await waitFor(() =>
      expect(totals().getByText('Total').nextSibling!.textContent).toBe('₹590.00'),
    );
    expect((postButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('You can preview, but not post.')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  }, 120_000);

  it('26. an expired session returns safely to sign-in', async () => {
    renderApp('/billing/new');
    await signInAs(users['Administrator']!);
    await screen.findByRole('heading', { name: 'New invoice' });
    await compose();
    await fx.prisma.session.deleteMany();
    click('Preview');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  }, 120_000);

  it('28. diagnostic logs carry no customer, search or tax values', async () => {
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(1000);
    for (const secret of [
      'Walk-in',
      'Registered Buyer',
      'Untracked Gadget',
      'Gadget',
      '27AAAAA0000A1Z5',
      'Market Road',
    ])
      expect(text, secret).not.toContain(secret);
  });
});
