// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { AuthProvider } from '../auth.js';
import {
  SAMPLE,
  click,
  field,
  fillAddress,
  fillAdmin,
  fillBusiness,
  fillGst,
  onStep,
  type as typeInto,
  walkToReview,
} from '../test-support/wizard-flow.js';
import {
  apiError,
  installFakeApi,
  type FakeHandler,
  type FakeRequest,
} from '../test-support/fake-api.js';

const REQUIRED_SETUP = { setupRequired: true, draftAvailable: false };
const status =
  (body: object): FakeHandler =>
  () => ({ status: 200, body });

interface Server {
  draft: { data: Record<string, unknown>; version: number } | null;
  saves: FakeRequest[];
  completes: FakeRequest[];
  handlers: Record<string, FakeHandler>;
}

/** A scripted stand-in for the setup endpoints. Records every call so tests can inspect what was sent. */
function server(opts: { draft?: Server['draft']; complete?: FakeHandler } = {}): Server {
  const s: Server = { draft: opts.draft ?? null, saves: [], completes: [], handlers: {} };
  s.handlers = {
    'GET /setup/status': status(REQUIRED_SETUP),
    'GET /setup/draft': () => ({
      status: 200,
      body: { draft: s.draft ? { ...s.draft, savedAt: 'now' } : null, discarded: false },
    }),
    'PUT /setup/draft': (req) => {
      s.saves.push(req);
      const body = req.body as { data: Record<string, unknown> };
      s.draft = { data: body.data, version: (s.draft?.version ?? 0) + 1 };
      return { status: 200, body: { version: s.draft.version, savedAt: 'now' } };
    },
    'POST /setup/complete': async (req) => {
      s.completes.push(req);
      return opts.complete
        ? opts.complete(req)
        : {
            status: 201,
            body: {
              organizationId: 'o',
              administratorUsername: SAMPLE.admin.username,
              nextStep: 'login',
            },
          };
    },
    'GET /health': () => ({ status: 200, body: {} }),
    'GET /health/db': () => ({ status: 200, body: {} }),
  };
  return s;
}

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

// Under a loaded machine (the whole suite runs in parallel) async UI updates can take longer than the 1s default.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('launch', () => {
  it('opens the wizard Welcome step when setup is incomplete', async () => {
    const s = server();
    installFakeApi(s.handlers);
    renderApp();
    expect(await screen.findByRole('heading', { name: 'CommerceBill setup' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start Setup' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    // Honest about what setup does not cover
    expect(screen.getByText(/Bank account and UPI/)).toBeTruthy();
    expect(screen.getByText(/no backups are active yet/)).toBeTruthy();
  });

  it('shows the sign-in page, not the wizard, when setup is complete', async () => {
    installFakeApi({
      ...server().handlers,
      'GET /setup/status': status({ setupRequired: false, draftAvailable: false }),
    });
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'CommerceBill setup' })).toBeNull();
  });

  it('reports a failed draft load with a retry', async () => {
    let fail = true;
    const s = server();
    installFakeApi({
      ...s.handlers,
      'GET /setup/draft': () => {
        if (fail) throw new TypeError('fetch failed');
        return { status: 200, body: { draft: null, discarded: false } };
      },
    });
    renderApp();
    expect((await screen.findByRole('alert')).textContent).toContain('could not reach');
    fail = false;
    click('Try again');
    expect(await screen.findByRole('button', { name: 'Start Setup' })).toBeTruthy();
  });

  it('tells the user when a saved draft had to be discarded', async () => {
    const s = server();
    installFakeApi({
      ...s.handlers,
      'GET /setup/draft': () => ({ status: 200, body: { draft: null, discarded: true } }),
    });
    renderApp();
    expect(await screen.findByText(/could not be used and was discarded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start Setup' })).toBeTruthy();
  });
});

describe('navigation and validation', () => {
  it('moves forward and back, with visible progress and focus on the new heading', async () => {
    installFakeApi(server().handlers);
    renderApp();
    await screen.findByRole('heading', { name: 'CommerceBill setup' });
    click('Start Setup');
    await fillBusiness();
    expect(screen.getByText('Step 2 of 8')).toBeTruthy();
    const current = screen
      .getByRole('navigation', { name: 'Setup progress' })
      .querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain('Business details');
    click('Continue');
    await fillAddress();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Address & location' }),
      ),
    );
    click('Back');
    await onStep('Business details');
    expect((field('Legal business name') as HTMLInputElement).value).toBe(SAMPLE.legalName);
  });

  it('blocks Continue on missing required fields and explains each, inline and in a summary', async () => {
    installFakeApi(server().handlers);
    renderApp();
    await screen.findByRole('heading', { name: 'CommerceBill setup' });
    click('Start Setup');
    await onStep('Business details');
    click('Continue');
    expect(await screen.findByText('Please fix the following before continuing')).toBeTruthy();
    // the summary names the field; the message also sits under the input
    expect(screen.getByText('Legal business name: This field is required.')).toBeTruthy();
    expect(screen.getByText('This field is required.')).toBeTruthy();
    expect(field('Legal business name').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Business details' })).toBeTruthy(); // did not advance
    await waitFor(() => expect(document.activeElement).toBe(field('Legal business name')));
  });

  it('validates PAN format on the Business step', async () => {
    installFakeApi(server().handlers);
    renderApp();
    await screen.findByRole('heading', { name: 'CommerceBill setup' });
    click('Start Setup');
    await onStep('Business details');
    typeInto('Legal business name', 'X Traders');
    typeInto('PAN', 'bad');
    click('Continue');
    expect((await screen.findAllByText(/ABCDE1234F/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Business details' })).toBeTruthy();
  });

  it('GST step: the GSTIN field is conditional on the registration status', async () => {
    installFakeApi(server().handlers);
    renderApp();
    await walkToReview();
    click(/Edit GST/);
    await onStep('GST registration');
    // registered: GSTIN required
    expect(field('GSTIN')).toBeTruthy();
    expect(screen.getByText(/placeholders and have not been verified/)).toBeTruthy();
    expect(
      screen.getByText(/should be reviewed before using CommerceBill for real transactions/),
    ).toBeTruthy();
    typeInto('GSTIN', '');
    click('Continue');
    expect(
      (await screen.findAllByText(/Enter the GSTIN of a registered business/)).length,
    ).toBeGreaterThan(0);
    // unregistered: field disappears and any GSTIN is cleared
    typeInto('GSTIN', SAMPLE.gstin);
    fireEvent.click(screen.getByRole('radio', { name: /^Not registered/ }));
    expect(screen.queryByLabelText(/^GSTIN/)).toBeNull();
    // composition: optional
    fireEvent.click(screen.getByRole('radio', { name: /^Composition scheme/ }));
    expect(screen.getByLabelText(/^GSTIN \(optional\)/)).toBeTruthy();
    expect((field('GSTIN') as HTMLInputElement).value).toBe(''); // cleared when it was "unregistered"
    click('Continue');
    await onStep('Financial year');
  });

  it('GST step: shows the default place of supply from the chosen state', async () => {
    installFakeApi(server().handlers);
    renderApp();
    await walkToReview();
    click(/Edit GST/);
    await onStep('GST registration');
    expect(screen.getByText(/Maharashtra \(27\)/)).toBeTruthy();
  });

  it('Financial year step shows the resulting year and rejects an impossible date', async () => {
    installFakeApi(server().handlers);
    renderApp();
    await walkToReview();
    click(/Edit Financial year/);
    await onStep('Financial year');
    typeInto('First day of the financial year', '2026-04-01');
    expect(screen.getByText('Financial year 2026-27')).toBeTruthy();
    typeInto('First day of the financial year', '2026-02-30');
    expect(screen.getByText(/Enter a valid date to see the financial year/)).toBeTruthy();
    click('Continue');
    expect((await screen.findAllByText('Enter a valid date.')).length).toBeGreaterThan(0);
  });

  it('Invoice numbering shows a live example that never touches the server', async () => {
    const s = server();
    const calls = installFakeApi(s.handlers);
    renderApp();
    await walkToReview();
    click(/Edit Invoice numbering/);
    await onStep('Invoice numbering');
    expect(screen.getByTestId('invoice-preview').textContent).toBe('INV/2026-27/000001');
    const before = calls.length;
    typeInto('Invoice prefix', 'TAX/{FY}/');
    typeInto('First invoice number', '17');
    typeInto('Number width (digits)', '4');
    expect(screen.getByTestId('invoice-preview').textContent).toBe('TAX/2026-27/0017');
    expect(screen.getByText(/No number is used until an invoice is posted/)).toBeTruthy();
    expect(calls.length).toBe(before); // typing and previewing made no request at all
    typeInto('Invoice prefix', 'TAX/');
    expect(screen.queryByTestId('invoice-preview')).toBeNull();
    expect(screen.getByText(/Fix the numbering fields/)).toBeTruthy();
  });

  it('Administrator step: password confirmation and length are checked', async () => {
    installFakeApi(server().handlers);
    renderApp();
    await walkToReview();
    click(/Edit Administrator/);
    await onStep('Administrator');
    typeInto('Confirm password', 'a different one entirely');
    click('Continue');
    expect((await screen.findAllByText('The two passwords do not match.')).length).toBeGreaterThan(
      0,
    );
    typeInto('Password', 'short');
    typeInto('Confirm password', 'short');
    click('Continue');
    expect((await screen.findAllByText(/at least 12 characters/)).length).toBeGreaterThan(0);
  });

  it('the password field has a show/hide control and the right autocomplete hints', async () => {
    installFakeApi(server().handlers);
    renderApp();
    await screen.findByRole('heading', { name: 'CommerceBill setup' });
    click('Start Setup');
    await fillBusiness();
    click('Continue');
    await fillAddress();
    click('Continue');
    await fillGst();
    click('Continue');
    await onStep('Financial year');
    click('Continue');
    await onStep('Invoice numbering');
    click('Continue');
    await onStep('Administrator');
    const pw = field('Password') as HTMLInputElement;
    expect(pw.type).toBe('password');
    expect(pw.autocomplete).toBe('new-password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(pw.type).toBe('text');
  });
});

describe('draft and resume', () => {
  it('saves non-secret fields as the user continues, and never the password', async () => {
    const s = server();
    installFakeApi(s.handlers);
    renderApp();
    await walkToReview();
    expect(s.saves.length).toBeGreaterThanOrEqual(6);
    const all = JSON.stringify(s.saves.map((r) => r.body));
    expect(all).not.toContain(SAMPLE.admin.password);
    expect(all.toLowerCase()).not.toContain('password');
    const last = s.saves.at(-1)!.body as {
      data: Record<string, Record<string, unknown>>;
      expectedVersion: number;
    };
    expect(last.data.business).toMatchObject({
      legalName: SAMPLE.legalName,
      gstStatus: 'REGISTERED',
      gstin: SAMPLE.gstin,
    });
    expect(last.data.administrator).toEqual({
      displayName: SAMPLE.admin.displayName,
      username: SAMPLE.admin.username,
      email: SAMPLE.admin.email,
    });
    // optimistic concurrency: each save carries the version returned by the previous one
    expect(s.saves.map((r) => (r.body as { expectedVersion: number }).expectedVersion)).toEqual(
      s.saves.map((_, i) => i),
    );
    expect(screen.getByText('Progress saved on this computer.')).toBeTruthy();
  });

  it('a save failure never blocks progress', async () => {
    const s = server();
    installFakeApi({ ...s.handlers, 'PUT /setup/draft': () => apiError(500, 'SYS_0500') });
    renderApp();
    await screen.findByRole('heading', { name: 'CommerceBill setup' });
    click('Start Setup');
    await fillBusiness();
    click('Continue');
    await onStep('Address & location');
    expect(
      await screen.findByText(/could not be saved; your entries are still on screen/),
    ).toBeTruthy();
  });

  it('closing and reopening offers Resume; resume restores non-secret fields but not the password', async () => {
    const s = server();
    installFakeApi(s.handlers);
    const first = renderApp();
    await walkToReview();
    first.unmount(); // "close the application": all in-memory state, including the password, is gone

    installFakeApi({
      ...s.handlers,
      'GET /setup/status': status({ setupRequired: true, draftAvailable: true }),
    });
    renderApp();
    expect(await screen.findByText('You have a saved draft')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start Setup' })).toBeNull();
    click('Resume Setup');
    // everything except the password is complete, so it lands where the password is entered again
    await onStep('Administrator');
    expect((field('Administrator name') as HTMLInputElement).value).toBe(SAMPLE.admin.displayName);
    expect((field('Username') as HTMLInputElement).value).toBe(SAMPLE.admin.username);
    expect((field('Password') as HTMLInputElement).value).toBe('');
    expect((field('Confirm password') as HTMLInputElement).value).toBe('');
    click('Back');
    await onStep('Invoice numbering');
    click('Back');
    click('Back');
    await onStep('GST registration');
    expect((field('GSTIN') as HTMLInputElement).value).toBe(SAMPLE.gstin);
    expect(document.documentElement.outerHTML).not.toContain(SAMPLE.admin.password);
  });

  it('Start Over needs confirmation and then discards the draft', async () => {
    const s = server({
      draft: { data: { business: { legalName: 'Old Draft Co' } }, version: 3 },
    });
    installFakeApi({
      ...s.handlers,
      'GET /setup/status': status({ setupRequired: true, draftAvailable: true }),
    });
    renderApp();
    await screen.findByText('You have a saved draft');
    click('Start Over');
    expect(await screen.findByText('Start over?')).toBeTruthy();
    expect(s.saves).toHaveLength(0); // nothing discarded yet
    click('Keep my draft');
    expect(screen.queryByText('Start over?')).toBeNull();
    expect(s.saves).toHaveLength(0);
    click('Start Over');
    click('Yes, discard and start over');
    await onStep('Business details');
    expect((field('Legal business name') as HTMLInputElement).value).toBe('');
    expect(s.saves).toHaveLength(1);
    expect(s.saves[0]!.body as { data: unknown; expectedVersion: number }).toEqual({
      data: {},
      expectedVersion: 3,
    });
  });
});

describe('review and completion', () => {
  it('review groups the details, never shows the password and offers Edit per section', async () => {
    installFakeApi(server().handlers);
    renderApp();
    await walkToReview();
    for (const title of [
      'Business',
      'Address',
      'GST',
      'Financial year',
      'Invoice numbering',
      'Administrator',
    ]) {
      expect(screen.getByRole('region', { name: title })).toBeTruthy();
    }
    expect(screen.getByText('Entered (hidden)')).toBeTruthy();
    expect(screen.getByText(SAMPLE.legalName)).toBeTruthy();
    expect(screen.getByText('INV/2026-27/000001')).toBeTruthy();
    expect(
      screen.getByText(
        /Review these details carefully. Completing setup will create the initial business and administrator./,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Nothing is claimed as active for these/)).toBeTruthy();
    expect(document.documentElement.outerHTML).not.toContain(SAMPLE.admin.password);
    expect(
      document.querySelectorAll('input[type="password"], input[type="text"][name*="password"]')
        .length,
    ).toBe(0);
  });

  it('a double click on Complete Setup submits exactly once', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const s = server({
      complete: async () => {
        await gate;
        return {
          status: 201,
          body: {
            organizationId: 'o',
            administratorUsername: SAMPLE.admin.username,
            nextStep: 'login',
          },
        };
      },
    });
    installFakeApi(s.handlers);
    renderApp();
    await walkToReview();
    const button = screen.getByRole('button', { name: 'Complete Setup' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Completing setup' }));
    expect(screen.getByRole('button', { name: 'Completing setup' }).getAttribute('aria-busy')).toBe(
      'true',
    );
    release?.();
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(s.completes).toHaveLength(1);
  });

  it('success shows the sign-in page with the new username, creates NO session and clears the password', async () => {
    const s = server();
    const calls = installFakeApi(s.handlers);
    renderApp();
    await walkToReview();
    click('Complete Setup');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(
      screen.getByText(/Setup is complete. Sign in with the administrator account/),
    ).toBeTruthy();
    expect((field('Username') as HTMLInputElement).value).toBe(SAMPLE.admin.username);
    expect((field('Password') as HTMLInputElement).value).toBe('');
    // the username is filled: focus moves to the password (an effect that runs just after the heading appears)
    await waitFor(() => expect(document.activeElement).toBe(field('Password')));
    // no authentication call of any kind was made, and the completion body held the password exactly once
    expect(calls.some((c) => c.path.startsWith('/auth/'))).toBe(false);
    expect(s.completes).toHaveLength(1);
    expect(s.completes[0]!.body).toMatchObject({
      administrator: { username: SAMPLE.admin.username, password: SAMPLE.admin.password },
      business: { gstStatus: 'REGISTERED', stateCode: '27', gstin: SAMPLE.gstin },
      financialYear: { startDate: '2026-04-01' },
      numbering: { invoicePrefix: 'INV/{FY}/', invoiceStartNumber: 1, numericWidth: 6 },
    });
    expect(document.documentElement.outerHTML).not.toContain(SAMPLE.admin.password);
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(calls.every((c) => !c.path.includes(SAMPLE.admin.password))).toBe(true);
  });

  it('shows a server validation error safely, keeps the entries and moves to the step that owns it', async () => {
    const s = server({
      complete: () =>
        apiError(400, 'VAL_0001', [
          { field: 'business.gstin', rule: 'gstin_pan_mismatch' },
          { field: 'administrator.password', rule: 'common_password' },
        ]),
    });
    installFakeApi(s.handlers);
    renderApp();
    await walkToReview();
    click('Complete Setup');
    expect(await screen.findByText('The server could not accept some details')).toBeTruthy();
    await onStep('GST registration');
    expect(screen.getAllByText(/does not match the PAN you entered/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(
      /VAL_0001|gstin_pan_mismatch|common_password|server wording/,
    );
    expect((field('GSTIN') as HTMLInputElement).value).toBe(SAMPLE.gstin); // entries retained
    click('Continue');
    await onStep('Financial year');
    click('Continue');
    click('Continue');
    await onStep('Administrator');
    expect((field('Password') as HTMLInputElement).value).toBe(''); // a rejected password is not kept
    expect((field('Username') as HTMLInputElement).value).toBe(SAMPLE.admin.username);
  });

  it('local validation stops an incomplete submission before any request is made', async () => {
    const s = server();
    installFakeApi(s.handlers);
    renderApp();
    await screen.findByRole('heading', { name: 'CommerceBill setup' });
    click('Start Setup');
    await fillBusiness();
    click('Continue');
    await fillAddress();
    click('Continue');
    await fillGst();
    click('Continue');
    await onStep('Financial year');
    click('Continue');
    await onStep('Invoice numbering');
    click('Continue');
    await fillAdmin();
    click('Continue');
    await onStep('Review & complete');
    click(/Edit Administrator/);
    await onStep('Administrator');
    typeInto('Password', '');
    typeInto('Confirm password', '');
    // jump straight to Review through the steps with empty password: Continue is refused on this step
    click('Continue');
    expect(await screen.findByText('Please fix the following before continuing')).toBeTruthy();
    expect(s.completes).toHaveLength(0);
  });

  it('an "already completed" answer closes the wizard and offers sign-in', async () => {
    const s = server({ complete: () => apiError(409, 'BIZ_0001') });
    installFakeApi(s.handlers);
    renderApp();
    await walkToReview();
    click('Complete Setup');
    expect(await screen.findByText('Setup is already complete')).toBeTruthy();
    installFakeApi({
      ...s.handlers,
      'GET /setup/status': status({ setupRequired: false, draftAvailable: false }),
    });
    click('Go to sign in');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });

  it('rate limits and an unreachable service get plain wording, and the form stays', async () => {
    let mode: 'rate' | 'down' = 'rate';
    const s = server({
      complete: () => {
        if (mode === 'down') throw new TypeError('fetch failed');
        return apiError(429, 'AUTH_0003');
      },
    });
    installFakeApi(s.handlers);
    renderApp();
    await walkToReview();
    click('Complete Setup');
    expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
    mode = 'down';
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Completing setup' })).toBeNull(),
    );
    click('Complete Setup');
    expect(await screen.findByText(/could not reach its local service/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('fetch failed');
    expect(screen.getByRole('region', { name: 'Business' })).toBeTruthy();
  });
});
