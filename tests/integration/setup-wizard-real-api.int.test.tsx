// @vitest-environment jsdom
// Task 1.8: the real setup wizard (DOM rendered by jsdom) against the real Fastify API and a real, migrated
// PostgreSQL database that starts with NO organization. Nothing about the API is mocked or scripted.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FastifyInstance } from 'fastify';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { App } from '../../apps/web/src/App.js';
import { resetAccessForTests } from '../../apps/web/src/api.js';
import { AuthProvider } from '../../apps/web/src/auth.js';
import {
  SAMPLE,
  click,
  field,
  fillAdmin,
  onStep,
  type as typeInto,
  walkToReview,
} from '../../apps/web/src/test-support/wizard-flow.js';
import { LAUNCH_SECRET, createFixture, type Fixture } from './auth-fixture.js';

let fx: Fixture;
let app: FastifyInstance;
let baseUrl: string;
let logs: string[];
interface Sent {
  method: string;
  url: string;
  body: string;
}
let sent: Sent[];
const realFetch = globalThis.fetch;
const PASSWORD = SAMPLE.admin.password;

function renderApp() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const orgCount = () => fx.prisma.organization.count();
const bridge = () => ({
  getAppInfo: async () => ({ name: 'test', version: '0', platform: 'test' }),
  getApiAccess: async () => ({ baseUrl, secret: LAUNCH_SECRET }),
});

beforeEach(async () => {
  logs = [];
  sent = [];
  fx = await createFixture(inject('pgAdminUrl'), { bare: true });
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    logStream: { write: (m: string) => void logs.push(m) },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  resetAccessForTests();
  window.commercebill = bridge();
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      method: init?.method ?? 'GET',
      url: String(url),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return realFetch(url, init);
  }) as typeof fetch;
}, 120_000);

afterEach(async () => {
  cleanup();
  globalThis.fetch = realFetch;
  delete window.commercebill;
  localStorage.clear();
  sessionStorage.clear();
  await fx?.close();
});

/** Draft saves are asynchronous: wait until the server holds the administrator step's save. */
const draftSettled = () =>
  waitFor(async () => {
    const row = await fx.prisma.applicationSetting.findFirst({ where: { organizationId: null } });
    expect(JSON.stringify(row?.value ?? '')).toContain(SAMPLE.admin.username);
  });

const completes = () =>
  sent.filter((s) => s.method === 'POST' && s.url.endsWith('/setup/complete'));

describe('first-run setup wizard against the real API', () => {
  it('a fresh database launches the wizard, and the whole journey works end to end', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'CommerceBill setup' });
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(await orgCount()).toBe(0);

    await walkToReview();
    await draftSettled();

    // The server holds a draft with the non-secret fields and NO password, in any form.
    const rows = await fx.prisma.applicationSetting.findMany({ where: { organizationId: null } });
    expect(rows).toHaveLength(1);
    const draftJson = JSON.stringify(rows[0]!.value);
    expect(draftJson).toContain(SAMPLE.legalName);
    expect(draftJson).toContain(SAMPLE.admin.username);
    expect(draftJson).not.toContain(PASSWORD);
    expect(draftJson.toLowerCase()).not.toContain('password');

    click('Complete Setup');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByText(/Setup is complete/)).toBeTruthy();
    expect((field('Username') as HTMLInputElement).value).toBe(SAMPLE.admin.username);

    // Everything was created atomically by the real server...
    expect(await orgCount()).toBe(1);
    const org = await fx.prisma.organization.findFirstOrThrow();
    expect(org.legalName).toBe(SAMPLE.legalName);
    expect(org.setupCompletedAt).not.toBeNull();
    expect(await fx.prisma.businessLocation.count()).toBe(1);
    expect(await fx.prisma.warehouse.count()).toBe(1);
    expect(await fx.prisma.financialYear.count()).toBe(1);
    expect(await fx.prisma.documentSequence.count()).toBe(6);
    const invoice = await fx.prisma.documentSequence.findFirstOrThrow({
      where: { documentType: 'INVOICE' },
    });
    expect(invoice.prefix).toBe('INV/{FY}/');
    const admin = await fx.prisma.user.findFirstOrThrow({
      where: { username: SAMPLE.admin.username },
    });
    expect(admin.mustChangePassword).toBe(false);
    // ...with NO session and no automatic sign-in, and the saved draft is gone.
    expect(await fx.prisma.session.count()).toBe(0);
    expect(sent.some((s) => s.url.includes('/auth/'))).toBe(false);
    expect(await fx.prisma.applicationSetting.count({ where: { organizationId: null } })).toBe(0);

    // The administrator now signs in explicitly.
    typeInto('Password', PASSWORD);
    click('Sign in');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    // the shell shows the trade name when there is one
    expect(screen.getAllByText(SAMPLE.tradeName).length).toBeGreaterThan(0);
    expect(await fx.prisma.session.count()).toBe(1);

    // Nothing sensitive leaked anywhere the browser or the server could keep it.
    const saves = sent.filter((s) => s.method === 'PUT');
    expect(saves.length).toBeGreaterThanOrEqual(6);
    expect(saves.map((s) => s.body).join('')).not.toContain(PASSWORD);
    expect(sent.map((s) => s.url).join('\n')).not.toContain(PASSWORD);
    expect(sent.map((s) => s.url).join('\n')).not.toContain(encodeURIComponent(PASSWORD));
    expect(logs.join('').length).toBeGreaterThan(100);
    expect(logs.join('')).not.toContain(PASSWORD);
    expect(document.documentElement.outerHTML).not.toContain(PASSWORD);
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain(PASSWORD);
    const audit = JSON.stringify(await fx.prisma.auditLog.findMany());
    expect(audit).not.toContain(PASSWORD);
  }, 120_000);

  it('closing during the wizard and reopening resumes the draft - without the password', async () => {
    const first = renderApp();
    await walkToReview();
    await draftSettled();
    first.unmount(); // the window is closed: all in-memory state, including the password, is gone

    resetAccessForTests();
    renderApp();
    expect(await screen.findByText('You have a saved draft')).toBeTruthy();
    click('Resume Setup');
    await onStep('Administrator');
    expect((field('Administrator name') as HTMLInputElement).value).toBe(SAMPLE.admin.displayName);
    expect((field('Username') as HTMLInputElement).value).toBe(SAMPLE.admin.username);
    expect((field('Password') as HTMLInputElement).value).toBe('');
    expect((field('Confirm password') as HTMLInputElement).value).toBe('');
    click('Back');
    click('Back');
    click('Back');
    click('Back');
    await onStep('Address & location');
    expect((field('Address line 1') as HTMLInputElement).value).toBe(SAMPLE.addressLine1);
    expect((field('State / union territory') as HTMLSelectElement).value).toBe(SAMPLE.stateCode);
    expect(await orgCount()).toBe(0); // resuming creates nothing
  }, 120_000);

  it('Start Over discards the real draft only after confirmation', async () => {
    const first = renderApp();
    await walkToReview();
    await draftSettled();
    first.unmount();
    resetAccessForTests();
    renderApp();
    await screen.findByText('You have a saved draft');
    click('Start Over');
    await screen.findByText('Start over?');
    expect(
      JSON.stringify(
        (await fx.prisma.applicationSetting.findFirstOrThrow({ where: { organizationId: null } }))
          .value,
      ),
    ).toContain(SAMPLE.legalName);
    click('Yes, discard and start over');
    await onStep('Business details');
    await waitFor(async () => {
      const row = await fx.prisma.applicationSetting.findFirstOrThrow({
        where: { organizationId: null },
      });
      expect(JSON.stringify(row.value)).not.toContain(SAMPLE.legalName);
    });
    expect((field('Legal business name') as HTMLInputElement).value).toBe('');
  }, 120_000);

  it('a double click on Complete Setup creates exactly one organization', async () => {
    renderApp();
    await walkToReview();
    const button = screen.getByRole('button', { name: 'Complete Setup' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(completes()).toHaveLength(1);
    expect(await orgCount()).toBe(1);
    expect(await fx.prisma.user.count({ where: { username: SAMPLE.admin.username } })).toBe(1);
  }, 120_000);

  it('shows a server-side validation error safely, creates nothing, and succeeds after the fix', async () => {
    renderApp();
    // contains the username: passes the wizard's quick checks, refused by the server's authoritative policy
    await walkToReview(`${SAMPLE.admin.username}-2026-extra`);
    click('Complete Setup');
    expect(await screen.findByText('The server could not accept some details')).toBeTruthy();
    await onStep('Administrator');
    expect(screen.getAllByText('Do not include your username.').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(
      /VAL_0001|contains_username|administrator\.password/,
    );
    expect(await orgCount()).toBe(0); // nothing created
    expect((field('Password') as HTMLInputElement).value).toBe(''); // the rejected password was dropped
    expect((field('Username') as HTMLInputElement).value).toBe(SAMPLE.admin.username); // the rest was kept
    await fillAdmin(); // enter a good one
    click('Continue');
    await onStep('Review & complete');
    click('Complete Setup');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(await orgCount()).toBe(1);
    expect(completes()).toHaveLength(2);
  }, 120_000);

  it('completed setup cannot reopen the bootstrap wizard or the bootstrap endpoints', async () => {
    const body = {
      business: { legalName: 'Already Done Co', gstStatus: 'UNREGISTERED', stateCode: '27' },
      location: { addressLine1: '1 Road' },
      financialYear: { startDate: '2026-04-01' },
      administrator: { username: 'first.admin', displayName: 'First Admin', password: PASSWORD },
    };
    const headers = { 'x-commercebill-launch-secret': LAUNCH_SECRET };
    expect(
      (await app.inject({ method: 'POST', url: '/setup/complete', headers, payload: body }))
        .statusCode,
    ).toBe(201);

    renderApp();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'CommerceBill setup' })).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/setup/draft', headers })).statusCode).toBe(
      409,
    );
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/setup/draft',
          headers,
          payload: { data: {}, expectedVersion: 0 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'POST', url: '/setup/complete', headers, payload: body }))
        .statusCode,
    ).toBe(409);
    expect(await orgCount()).toBe(1);
  }, 120_000);

  it('a second window finishing first: the wizard says setup is already complete', async () => {
    renderApp();
    await walkToReview();
    const headers = { 'x-commercebill-launch-secret': LAUNCH_SECRET };
    const rival = await app.inject({
      method: 'POST',
      url: '/setup/complete',
      headers,
      payload: {
        business: { legalName: 'Rival Co', gstStatus: 'UNREGISTERED', stateCode: '27' },
        location: { addressLine1: '2 Road' },
        financialYear: { startDate: '2026-04-01' },
        administrator: { username: 'rival.admin', displayName: 'Rival', password: PASSWORD },
      },
    });
    expect(rival.statusCode).toBe(201);
    click('Complete Setup');
    expect(await screen.findByText('Setup is already complete')).toBeTruthy();
    expect(await orgCount()).toBe(1);
    expect((await fx.prisma.organization.findFirstOrThrow()).legalName).toBe('Rival Co');
    click('Go to sign in');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  }, 120_000);
});
