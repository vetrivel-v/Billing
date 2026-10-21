// @vitest-environment jsdom
// Task 1.16: the real payment and receivable screens (DOM rendered by jsdom) against the real Fastify API and a real, migrated
// PostgreSQL database. Nothing about the API is mocked; two tests wrap fetch only to LOSE an answer or to count calls.
// Demo invoices are posted first; the organization is then switched to PRODUCTION through the approved injected gate fact so a
// production invoice exists for one flow. Fictional data only.
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
import { LAUNCH_SECRET, PASSWORD, call, createFixture, type Fixture } from './auth-fixture.js';
import { body, previewAndPost, setupBillingWorld, type BillingWorld } from './invoice-fixture.js';

configure({ asyncUtilTimeout: 10_000 });

let fx: Fixture;
let app: FastifyInstance;
let baseUrl: string;
let w: BillingWorld;
let logs: string[];
let sent: { method: string; url: string; body: string | undefined }[];
const realFetch = globalThis.fetch;
const users: Record<string, string> = {};
const inv: Record<string, { id: string; number: string }> = {};
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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
const posts = () => sent.filter((s) => s.method === 'POST' && s.url.endsWith('/payments'));
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const payments = () => fx.prisma.payment.count();
const amount = (v: string) =>
  fireEvent.change(screen.getByLabelText(/^Amount received/), { target: { value: v } });
const fill = (label: RegExp, v: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value: v } });
const summary = () => within(screen.getByLabelText('Payment summary'));
const openInvoice = async (key: string, as = 'Administrator') => {
  renderApp(`/billing/${inv[key]!.id}`);
  await signInAs(users[as]!);
  await screen.findByRole('heading', { name: `Invoice ${inv[key]!.number}` });
};

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  logs = [];
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    logStream: { write: (m: string) => void logs.push(m) },
    backupRestoreVerified: async () => true,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  w = await setupBillingWorld(fx);
  await newUser('Administrator', 'ui.admin');
  await newUser('Viewer/Auditor', 'ui.viewer');
  await newUser('Warehouse Operator', 'ui.warehouse');
  const token = (
    await call(app, 'POST', '/auth/login', {
      body: { username: 'ui.admin', password: PASSWORD, organizationId: fx.orgId },
    })
  ).json.token as string;
  const post = async (
    key: string,
    mode: 'DEMO' | 'PRODUCTION',
    customerId: string,
    qty: string,
  ) => {
    const r = await previewAndPost(
      app,
      token,
      body(w, { mode, customerId }, [{ productId: w.products.untracked, quantity: qty }]),
    );
    expect(r.post.status, JSON.stringify(r.post.json)).toBe(201);
    const i = (r.post.json as unknown as Json).invoice as Json;
    inv[key] = { id: i.id, number: i.documentNumber };
  };
  // demo invoices of 1,180.00 (4 x 250 at 18%)
  await post('demoA', 'DEMO', w.customers.b2b, '4');
  await post('demoB', 'DEMO', w.customers.b2b, '4');
  await post('demoC', 'DEMO', w.customers.b2c, '4');
  await post('demoD', 'DEMO', w.customers.b2c, '4');
  // switch to PRODUCTION (approved injected gate fact) for one production invoice
  const cfg = (await call(app, 'GET', '/tax/configuration', { token })).json as unknown as Json;
  await call(app, 'POST', '/tax/configuration/reviews', {
    token,
    body: {
      capacity: 'Accountant for the business',
      note: 'Fictional test review',
      acknowledged: true,
      noticeVersion: cfg.notice.version,
      expectedFingerprint: cfg.fingerprint,
    },
  });
  expect(
    (await call(app, 'POST', '/tax/billing-mode', { token, body: { mode: 'PRODUCTION' } })).status,
  ).toBe(200);
  await post('prod', 'PRODUCTION', w.customers.b2b, '4');
}, 300_000);

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

describe('navigation and permissions', () => {
  it('Payments and Receivables appear for users with sales.payment.read, and not for a warehouse operator', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    expect(await screen.findByRole('link', { name: 'Payments' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Receivables' })).toBeTruthy();
    cleanup();
    renderApp();
    await signInAs(users['Warehouse Operator']!);
    await screen.findByRole('link', { name: 'Dashboard' });
    expect(screen.queryByRole('link', { name: 'Payments' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Receivables' })).toBeNull();
  }, 120_000);

  it('a viewer can read payments but has no Record payment action, and a typed address does not bypass it', async () => {
    await openInvoice('demoA', 'Viewer/Auditor');
    expect(screen.getByTestId('payment-section')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Record (demo )?payment/ })).toBeNull();
    cleanup();
    renderApp(`/billing/${inv.demoA!.id}/payment`);
    await signInAs(users['Viewer/Auditor']!);
    expect(await screen.findByText('You do not have permission to record payments.')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  }, 120_000);
});

describe('recording DEMO payments', () => {
  it('34,36. records a partial demo payment through the real UI; paid and balance are the server’s; everything is marked DEMO', async () => {
    await openInvoice('demoA');
    expect(screen.getByText('Demo payments (not real money)')).toBeTruthy();
    expect(summary().getByText('Demo paid').nextSibling!.textContent).toBe('₹0.00');
    expect(summary().getByText('Demo balance').nextSibling!.textContent).toBe('₹1,180.00');
    click('Record demo payment');
    expect(await screen.findByText('DEMO PAYMENT')).toBeTruthy();
    expect(
      screen.getByText(/not a real receipt and does not\s+represent any money received/),
    ).toBeTruthy();
    expect(
      within(screen.getByLabelText('Invoice balance')).getByText('Demo balance').nextSibling!
        .textContent,
    ).toBe('₹1,180.00');
    amount('500');
    click('Record demo payment');
    expect(
      await screen.findByText(/Demo payment DPAY\/.* was recorded\. It is not real money\./),
    ).toBeTruthy();
    await waitFor(() =>
      expect(summary().getByText('Demo paid').nextSibling!.textContent).toBe('₹500.00'),
    );
    expect(summary().getByText('Demo balance').nextSibling!.textContent).toBe('₹680.00');
    expect(screen.getByText('Partly paid')).toBeTruthy();
    const row = (await screen.findByText(/^DPAY\//)).closest('tr')!;
    expect(row.textContent).toContain('DEMO');
    expect(row.textContent).toContain('₹500.00');
    const p = await fx.prisma.payment.findFirstOrThrow({ include: { allocations: true } });
    expect(p).toMatchObject({ isDemo: true, documentType: 'DEMO_PAYMENT_RECEIPT', method: 'CASH' });
    expect(p.amount.toFixed(2)).toBe('500.00');
    expect(p.allocations).toHaveLength(1);
    expect(screen.getByText(/cannot be edited or deleted/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Edit|Delete|Reverse)/ })).toBeNull();
  }, 120_000);

  it('refuses a payment beyond the balance with the server’s balance, and records nothing', async () => {
    renderApp(`/billing/${inv.demoA!.id}/payment`);
    await signInAs(users['Administrator']!);
    await screen.findByText('DEMO PAYMENT');
    const before = await payments();
    amount('700');
    click('Record demo payment');
    expect(
      await screen.findByText(
        /The amount is more than the balance due \(₹680\.00\)\. Nothing was recorded\./,
      ),
    ).toBeTruthy();
    expect(await payments()).toBe(before);
    expect(document.body.textContent).not.toMatch(/AMOUNT_EXCEEDS_BALANCE|BIZ_0001/);
  }, 120_000);

  it('checks the form before sending: amount, method reference, card numbers', async () => {
    renderApp(`/billing/${inv.demoB!.id}/payment`);
    await signInAs(users['Administrator']!);
    await screen.findByText('DEMO PAYMENT');
    amount('0');
    click('Record demo payment');
    expect(await screen.findByText('Enter an amount greater than zero.')).toBeTruthy();
    amount('1.234');
    click('Record demo payment');
    expect(await screen.findByText('Use at most two decimal places.')).toBeTruthy();
    amount('10');
    fill(/^Payment method/, 'UPI');
    click('Record demo payment');
    expect(await screen.findByText('This payment method needs a reference.')).toBeTruthy();
    fill(/^Payment method/, 'CARD');
    fill(/^Reference/, '4111 1111 1111 1111');
    click('Record demo payment');
    expect(await screen.findByText(/looks like a card number/)).toBeTruthy();
    expect(posts()).toHaveLength(0);
  }, 120_000);

  it('22. a double click records exactly one payment', async () => {
    renderApp(`/billing/${inv.demoB!.id}/payment`);
    await signInAs(users['Administrator']!);
    await screen.findByText('DEMO PAYMENT');
    const before = await payments();
    amount('100');
    const b = screen.getByRole('button', { name: 'Record demo payment' });
    fireEvent.click(b);
    fireEvent.click(b);
    await screen.findByText(/Demo payment DPAY\/.* was recorded/);
    expect(posts()).toHaveLength(1);
    expect(await payments()).toBe(before + 1);
  }, 120_000);

  it('23. a lost answer: Retry reuses the same entry and resolves to the same payment', async () => {
    renderApp(`/billing/${inv.demoC!.id}/payment`);
    await signInAs(users['Administrator']!);
    await screen.findByText('DEMO PAYMENT');
    const before = await payments();
    let dropped = false;
    const wrapped = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await wrapped(url, init);
      if (!dropped && init?.method === 'POST' && String(url).endsWith('/payments')) {
        dropped = true;
        throw new TypeError('network error after the server answered'); // the payment WAS recorded; the answer is lost
      }
      return res;
    }) as typeof fetch;
    amount('250');
    fill(/^Payment method/, 'UPI');
    fill(/^Reference/, 'UPI-LOST-1');
    click('Record demo payment');
    expect(
      await screen.findByText('We could not confirm whether the payment was recorded'),
    ).toBeTruthy();
    expect(await payments()).toBe(before + 1);
    click('Retry');
    expect(await screen.findByText(/had already been recorded as DPAY\//)).toBeTruthy();
    expect(await payments()).toBe(before + 1); // not a second payment
    const ops = posts().map((p) => (JSON.parse(p.body!) as { operationId: string }).operationId);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toBe(ops[1]);
  }, 120_000);

  it('settling exactly marks the invoice paid; the record page then says so and the list shows it', async () => {
    renderApp(`/billing/${inv.demoA!.id}/payment`);
    await signInAs(users['Administrator']!);
    await screen.findByText('DEMO PAYMENT');
    amount('680.00');
    click('Record demo payment');
    await screen.findByText(/Demo payment DPAY\/.* was recorded/);
    await waitFor(() => expect(screen.getByText('Paid')).toBeTruthy());
    expect(summary().getByText('Demo balance').nextSibling!.textContent).toBe('₹0.00');
    expect(screen.queryByRole('button', { name: /Record (demo )?payment/ })).toBeNull();
    cleanup();
    renderApp(`/billing/${inv.demoA!.id}/payment`);
    await signInAs(users['Administrator']!);
    expect(await screen.findByText('This invoice is fully paid.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Record demo payment' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    renderApp('/billing');
    await signInAs(users['Administrator']!);
    const row = (
      await screen.findByRole('link', { name: `Open invoice ${inv.demoA!.number}` })
    ).closest('tr')!;
    expect(row.textContent).toContain('Demo paid');
    expect(row.textContent).toContain('₹0.00'); // balance
  }, 120_000);
});

describe('production payment through the real UI (controlled test gate)', () => {
  it('records a production payment: no DEMO wording, a PAY number, the real balance, and receivables follow', async () => {
    await openInvoice('prod');
    expect(screen.queryByText('Demo payments (not real money)')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Payments' })).toBeTruthy();
    expect(summary().getByText('Balance due').nextSibling!.textContent).toBe('₹1,180.00');
    click('Record payment');
    await screen.findByRole('heading', { name: 'Record payment' });
    expect(screen.queryByText('DEMO PAYMENT')).toBeNull();
    amount('300');
    fill(/^Payment method/, 'BANK_TRANSFER');
    fill(/^Reference/, 'NEFT-UTR-555');
    click('Record payment');
    expect(await screen.findByText(/Payment PAY\/.* of ₹300\.00 was recorded\./)).toBeTruthy();
    await waitFor(() =>
      expect(summary().getByText('Balance due').nextSibling!.textContent).toBe('₹880.00'),
    );
    expect(summary().getByText('Paid').nextSibling!.textContent).toBe('₹300.00');
    const p = await fx.prisma.payment.findFirstOrThrow({ where: { isDemo: false } });
    expect(p).toMatchObject({
      documentType: 'PAYMENT_RECEIPT',
      method: 'BANK_TRANSFER',
      reference: 'NEFT-UTR-555',
    });
  }, 120_000);
});

describe('receivables and the payment list', () => {
  it('35. the customer view shows invoiced, paid and outstanding; production and demo are never mixed', async () => {
    renderApp('/receivables');
    await signInAs(users['Administrator']!);
    const link = await screen.findByRole('link', {
      name: 'Receivables of Registered Buyer Pvt Ltd',
    });
    const row = link.closest('tr')!;
    expect(row.textContent).toContain('₹1,180.00'); // invoiced (one production invoice)
    expect(row.textContent).toContain('₹300.00'); // paid
    expect(row.textContent).toContain('₹880.00'); // outstanding
    expect(screen.queryByRole('link', { name: 'Receivables of Walk-in Buyer' })).toBeNull(); // only demo invoices
    fireEvent.click(link);
    await screen.findByRole('heading', { name: 'Registered Buyer Pvt Ltd' });
    const totals = within(screen.getByLabelText('Customer totals'));
    expect(totals.getByText('Outstanding').nextSibling!.textContent).toBe('₹880.00');
    expect(screen.getByText('Partly paid')).toBeTruthy();
    cleanup();
    renderApp('/receivables');
    await signInAs(users['Administrator']!);
    await screen.findByRole('link', { name: 'Receivables of Registered Buyer Pvt Ltd' });
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'demo' } });
    expect(await screen.findByText('DEMO figures')).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: 'Receivables of Registered Buyer Pvt Ltd' }).closest('tr')!
          .textContent,
      ).toContain('₹2,360.00'),
    );
    const demoRow = screen
      .getByRole('link', { name: 'Receivables of Registered Buyer Pvt Ltd' })
      .closest('tr')!;
    expect(demoRow.textContent).toContain('₹2,360.00'); // two demo invoices
    expect(demoRow.textContent).toContain('₹1,280.00'); // demo paid: demoA settled (1,180) plus 100 on demoB
    expect(demoRow.textContent).toContain('₹1,080.00'); // demo outstanding
    expect(demoRow.textContent).not.toContain('₹300.00');
  }, 120_000);

  it('the payment list shows demo and production payments with their type, and filters by type and search', async () => {
    renderApp('/payments');
    await signInAs(users['Administrator']!);
    await screen.findByRole('table');
    expect(screen.getAllByText('DEMO').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Production').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'production' } });
    await waitFor(() => expect(screen.queryByText(/^DPAY\//)).toBeNull());
    expect(screen.getByText(/^PAY\//)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzz-no-such' } });
    expect(await screen.findByText('No payments match')).toBeTruthy();
  }, 120_000);

  it('37. closed and reopened, the payment and the balance are unchanged', async () => {
    await openInvoice('prod');
    await waitFor(() =>
      expect(summary().getByText('Paid').nextSibling!.textContent).toBe('₹300.00'),
    );
    expect(await screen.findByText(/^PAY\//)).toBeTruthy();
  }, 120_000);
});

describe('logs', () => {
  it('22. diagnostic logs carry no payment references, notes, amounts or customer names', async () => {
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(1000);
    for (const secret of [
      'NEFT-UTR-555',
      'UPI-LOST-1',
      '4111 1111 1111 1111',
      '4111111111111111',
      'Registered Buyer',
      'Walk-in',
    ])
      expect(text, secret).not.toContain(secret);
  });
});
