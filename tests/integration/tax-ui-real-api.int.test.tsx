// @vitest-environment jsdom
// Task 1.12: the real Tax configuration and HSN/SAC screens (DOM rendered by jsdom) against the real Fastify API and a real,
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
const goToTax = async () => fireEvent.click(await screen.findByRole('link', { name: 'Tax' }));

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
  await newUser('Administrator', 'ui.admin');
  await newUser('Viewer/Auditor', 'ui.viewer');
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

describe('tax configuration through the real UI, API and database', () => {
  it('shows the installed categories and rates as unreviewed placeholders, the jurisdiction rules, and that billing is DEMO only', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToTax();
    expect(await screen.findByRole('heading', { name: 'Tax configuration' })).toBeTruthy();
    expect(await screen.findByText('Demo billing only')).toBeTruthy();
    const reqs = within(screen.getByRole('list', { name: 'Production billing requirements' }));
    expect(reqs.getAllByText('Not met').length).toBe(3); // review, seller, backup; the HSN policy is met by default
    expect(
      reqs.getByText(/A backup has been restored and verified \(not available yet\)/),
    ).toBeTruthy();
    expect(screen.getByText('Not reviewed')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Tax categories and effective-dated rates' });
    expect(table.textContent).toContain('GST 18% (placeholder)');
    expect(table.textContent).toContain('18%');
    expect(table.textContent).toContain('01-07-2017 to open');
    expect(table.textContent).toContain('Installed placeholder');
    expect(within(table).getAllByText('Unreviewed')).toHaveLength(8); // one per installed rate
    expect(within(table).getAllByText('Nil rated').length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        /placeholders\. They are not verified against any government source by CommerceBill/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Rule set/).textContent).toMatch(
      /FUB-GST-1-JURISDICTIONS version 1\s*Unreviewed/,
    );
    fireEvent.click(screen.getByText(/Show the \d+ listed places/));
    expect(screen.getByRole('table', { name: 'Jurisdiction rules' }).textContent).toContain(
      'Chandigarh',
    );
    expect(screen.getByRole('table', { name: 'Jurisdiction rules' }).textContent).toContain(
      'CGST + UTGST',
    );
    // honest wording: never a claim of verification or certification
    expect(document.body.textContent).toMatch(/not a legal or tax certification/);
    expect(document.body.textContent).not.toMatch(
      /verified by the government|legally compliant|certified/i,
    );
    expect(writes()).toHaveLength(0);
  }, 120_000);

  it('validates before sending, then records a review of exactly what was shown, and the page says so', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToTax();
    await screen.findByRole('form', { name: 'Confirm tax review' });
    fireEvent.click(screen.getByRole('button', { name: 'Record my review' }));
    expect(await screen.findByText('Please fix the following before confirming')).toBeTruthy();
    expect(screen.getByText('Your capacity: This field is required.')).toBeTruthy();
    expect(screen.getByText('Confirmation: Please tick the box to confirm.')).toBeTruthy();
    expect(writes()).toHaveLength(0);

    typeIn('Your capacity', 'Accountant for Sample Traders');
    typeIn('Note', 'Checked against our own notes');
    fireEvent.click(screen.getByLabelText('I have read and I confirm the statement above'));
    fireEvent.click(screen.getByRole('button', { name: 'Record my review' }));
    expect(
      await screen.findByText('Your review was recorded for the configuration shown on this page.'),
    ).toBeTruthy();
    expect(
      await within(screen.getByRole('region', { name: 'Review status' })).findByText('Reviewed'),
    ).toBeTruthy();
    const row = await fx.prisma.taxConfigurationReview.findFirstOrThrow({
      where: { organizationId: fx.orgId },
      include: { reviewer: true },
    });
    expect(row).toMatchObject({
      reviewerCapacity: 'Accountant for Sample Traders',
      note: 'Checked against our own notes',
      noticeVersion: 'TAXREV-1',
    });
    expect(row.reviewer.username).toBe(users['Administrator']);
    const history = await screen.findByRole('table', { name: 'Review history' });
    expect(history.textContent).toContain('Accountant for Sample Traders');
    expect(history.textContent).toContain('current');
    const gate = within(screen.getByRole('list', { name: 'Production billing requirements' }));
    expect(gate.getAllByText('Met').length).toBe(2); // review + HSN policy
    expect(gate.getAllByText('Not met').length).toBe(2); // seller + backup
  }, 120_000);

  it('a change to the tax configuration makes the review out of date, and says so', async () => {
    const gst5 = await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'GST_5' },
    });
    await fx.prisma.taxCategory.update({ where: { id: gst5.id }, data: { isActive: false } });
    renderApp();
    await signInAs(users['Administrator']!);
    await goToTax();
    expect(await screen.findByText('Review out of date')).toBeTruthy();
    expect(screen.getByText(/has changed since it was last reviewed/)).toBeTruthy();
    await fx.prisma.taxCategory.update({ where: { id: gst5.id }, data: { isActive: true } });
  }, 120_000);

  it('a review of a configuration that changed meanwhile is refused and the page reloads what changed', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToTax();
    await screen.findByRole('form', { name: 'Confirm tax review' });
    const before = await fx.prisma.taxConfigurationReview.count();
    const gst12 = await fx.prisma.taxCategory.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'GST_12' },
    });
    await fx.prisma.taxCategory.update({
      where: { id: gst12.id },
      data: { name: 'GST 12% (edited elsewhere)' },
    });
    typeIn('Your capacity', 'Owner');
    fireEvent.click(screen.getByLabelText('I have read and I confirm the statement above'));
    fireEvent.click(screen.getByRole('button', { name: 'Record my review' }));
    expect(await screen.findByText('Nothing was recorded')).toBeTruthy();
    expect(screen.getAllByText(/changed after it was shown/).length).toBeGreaterThan(0);
    expect(await fx.prisma.taxConfigurationReview.count()).toBe(before);
    await waitFor(() =>
      expect(
        screen.getByRole('table', { name: 'Tax categories and effective-dated rates' }).textContent,
      ).toContain('GST 12% (edited elsewhere)'),
    );
    await fx.prisma.taxCategory.update({
      where: { id: gst12.id },
      data: { name: 'GST 12% (placeholder)' },
    });
  }, 120_000);

  it('production billing cannot be switched on: the reason is explained and the mode stays DEMO', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToTax();
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to production billing' }));
    expect(
      await screen.findByText(
        /Production billing is not available:.*backup has been restored and verified/i,
      ),
    ).toBeTruthy();
    expect(await fx.prisma.organizationSetting.count({ where: { key: 'billing_mode' } })).toBe(0);
    expect(screen.getByText('Demo billing only')).toBeTruthy();
  }, 120_000);

  it('turning the HSN/SAC requirement off needs an acknowledgement and a reason, and can be turned back on', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToTax();
    fireEvent.click(await screen.findByRole('button', { name: 'Do not require HSN/SAC…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off the requirement' }));
    expect(await screen.findByText('Please tick the box to confirm.')).toBeTruthy();
    expect(screen.getByText('This field is required.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('I understand and accept this'));
    typeIn('Reason', 'We have not assigned codes yet');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off the requirement' }));
    expect(await screen.findByText(/not required/)).toBeTruthy();
    expect(screen.getByText(/Reason recorded: We have not assigned codes yet/)).toBeTruthy();
    expect(
      await fx.prisma.auditLog.count({ where: { action: 'tax.hsn_requirement.change' } }),
    ).toBe(1);
    fireEvent.click(await screen.findByRole('button', { name: 'Require HSN/SAC again' }));
    expect(await screen.findByText(/This is the default\./)).toBeTruthy();
  }, 120_000);

  it('a Viewer/Auditor can read the configuration but cannot confirm, switch mode or change the HSN policy', async () => {
    renderApp();
    await signInAs(users['Viewer/Auditor']!);
    await goToTax();
    expect(await screen.findByRole('heading', { name: 'Tax configuration' })).toBeTruthy();
    expect(
      screen.getByText('Only people with the tax review permission can confirm the review.'),
    ).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Confirm tax review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Switch to production billing' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Do not require HSN\/SAC/ })).toBeNull();
    expect(writes()).toHaveLength(0);
  }, 120_000);

  it('a Billing Operator has no Tax entry, and a typed address does not open it', async () => {
    renderApp('/tax');
    await signInAs(users['Billing Operator']!);
    await screen.findByRole('link', { name: 'Customers' });
    expect(screen.queryByRole('link', { name: 'Tax' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tax configuration' })).toBeNull();
    expect(sent.some((s) => s.url.includes('/tax/'))).toBe(false);
  }, 120_000);
});

describe('HSN/SAC maintenance through the real UI', () => {
  const goToHsn = async () => {
    await goToTax();
    fireEvent.click((await screen.findAllByRole('link', { name: 'HSN/SAC codes' }))[0]!);
    await screen.findByRole('heading', { name: 'HSN/SAC codes' });
  };

  it('starts empty, explains that nothing is bundled, and adds a code typed in by a person', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToHsn();
    expect(await screen.findByText('No HSN/SAC codes yet')).toBeTruthy();
    expect(screen.getByText(/does not include an official HSN\/SAC list/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }));
    expect(await screen.findByText('Code: This field is required.')).toBeTruthy();
    typeIn('Code', '85A7');
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }));
    expect(await screen.findByText('Code: Use 2 to 8 digits only.')).toBeTruthy();
    expect(writes()).toHaveLength(0);
    typeIn('Code', '8517');
    typeIn('Description', 'Telephone sets');
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }));
    expect(await screen.findByText('Code 8517 was added.')).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'HSN/SAC codes' });
    expect(table.textContent).toContain('8517');
    expect(table.textContent).toContain('Telephone sets');
    expect(table.textContent).toContain('Unreviewed');
    const row = await fx.prisma.hsnSacCode.findFirstOrThrow({ where: { code: '8517' } });
    expect(row).toMatchObject({
      organizationId: fx.orgId,
      kind: 'HSN',
      origin: 'USER',
      reviewStatus: 'UNREVIEWED',
      isActive: true,
    });
    expect(
      await fx.prisma.auditLog.count({ where: { action: 'hsn_sac.create', entityId: row.id } }),
    ).toBe(1);
  }, 120_000);

  it('refuses a duplicate, edits the description, confirms (and the edit drops the confirmation), deactivates and reactivates', async () => {
    renderApp();
    await signInAs(users['Administrator']!);
    await goToHsn();
    await screen.findByRole('table', { name: 'HSN/SAC codes' });
    fireEvent.click(screen.getByRole('button', { name: 'Add a code' }));
    typeIn('Code', '8517');
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }));
    expect(await screen.findByText('The server could not accept some details')).toBeTruthy();
    expect(screen.getAllByText(/Code: This code is already in your list\./).length).toBeGreaterThan(
      0,
    );
    expect(document.body.textContent).not.toMatch(/duplicate_code|BIZ_0001/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Confirm 8517' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm 8517' })).toBeNull());
    expect(screen.getByRole('table', { name: 'HSN/SAC codes' }).textContent).toContain(
      'Administrator (test)',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit 8517' }));
    expect(screen.getByText(/the code and type cannot be changed/)).toBeTruthy();
    typeIn('Description', 'Telephone sets and parts');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Code 8517 was saved.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Confirm 8517' })).toBeTruthy(); // the confirmation was dropped by the edit
    expect(
      (await fx.prisma.hsnSacCode.findFirstOrThrow({ where: { code: '8517' } })).reviewStatus,
    ).toBe('UNREVIEWED');

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate 8517' }));
    await waitFor(() => expect(screen.queryByText('Telephone sets and parts')).toBeNull()); // hidden from the Active view
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate 8517' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reactivate 8517' })).toBeNull(),
    );
    expect(
      (await fx.prisma.hsnSacCode.findFirstOrThrow({ where: { code: '8517' } })).isActive,
    ).toBe(true);
    expect(await fx.prisma.hsnSacCode.count({ where: { organizationId: fx.orgId } })).toBe(1); // nothing was ever deleted
  }, 120_000);

  it('searches and pages on the server; a Viewer/Auditor can look but not add, edit or confirm', async () => {
    for (let i = 0; i < 30; i++) {
      await fx.prisma.hsnSacCode.create({
        data: {
          organizationId: fx.orgId,
          code: String(300000 + i),
          kind: 'SAC',
          description: `Fictional service ${i}`,
        },
      });
    }
    renderApp();
    await signInAs(users['Administrator']!);
    await goToHsn();
    expect(await screen.findByText('Showing 1-25 of 31')).toBeTruthy();
    expect(screen.getAllByRole('row').length - 1).toBe(25); // the renderer only receives one page
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 26-31 of 31')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'fictional service 17' },
    });
    expect(await screen.findByText('Showing 1-1 of 1')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No codes match')).toBeTruthy();
    cleanup();

    renderApp();
    await signInAs(users['Viewer/Auditor']!);
    await goToHsn();
    await screen.findByRole('table', { name: 'HSN/SAC codes' });
    expect(screen.queryByRole('button', { name: 'Add a code' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Edit|Deactivate|Confirm) / })).toBeNull();
  }, 120_000);
});
