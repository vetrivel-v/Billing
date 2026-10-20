// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  HsnSacView,
  TaxConfigurationResponse,
  TaxReviewListResponse,
} from '@commercebill/shared-types';
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
} from '../test-support/fake-api.js';

configure({ asyncUtilTimeout: 5000 });

const READ = ['tax.config.read'];
const ALL = ['tax.config.read', 'tax.config.update', 'tax.config.review'];
const FP = 'a'.repeat(64);
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

const config = (over: Partial<TaxConfigurationResponse> = {}): TaxConfigurationResponse => ({
  engine: {
    engineVersion: '1.0.0',
    rulesetVersion: 'FUB-GST-1',
    roundingPolicyId: 'HALF_UP_PAISE_V1',
  },
  jurisdictions: {
    id: 'FUB-GST-1-JURISDICTIONS',
    version: '1',
    reviewStatus: 'UNREVIEWED',
    entries: [{ code: '27', name: 'Maharashtra', kind: 'STATE' }],
  },
  categories: [
    {
      id: 'c1',
      code: 'GST_18',
      name: 'GST 18% (placeholder)',
      classification: 'STANDARD',
      isActive: true,
      effectiveFrom: null,
      effectiveTo: null,
      origin: 'REFERENCE_SEED',
      reviewStatus: 'UNREVIEWED',
      rates: [
        {
          id: 'r1',
          ratePercent: '18.0000',
          cessPercent: '0.0000',
          effectiveFrom: '2017-07-01',
          effectiveTo: '2026-09-30',
          origin: 'REFERENCE_SEED',
          reviewStatus: 'UNREVIEWED',
        },
        {
          id: 'r2',
          ratePercent: '12.5000',
          cessPercent: '1.0000',
          effectiveFrom: '2026-10-01',
          effectiveTo: null,
          origin: 'USER',
          reviewStatus: 'REVIEWED',
        },
      ],
    },
    {
      id: 'c2',
      code: 'EXEMPT',
      name: 'Exempt',
      classification: 'EXEMPT',
      isActive: false,
      effectiveFrom: null,
      effectiveTo: null,
      origin: 'USER',
      reviewStatus: 'UNREVIEWED',
      rates: [],
    },
  ],
  fingerprint: FP,
  review: { state: 'NONE', latest: null },
  notice: {
    version: 'TAXREV-1',
    text: 'I confirm the configuration. This is not a legal or tax certification.',
  },
  seller: { gstStatus: 'REGISTERED', gstin: '27ABCDE1234F1Z5', stateCode: '27' },
  hsnPolicy: { required: true, reason: null, changedAt: null },
  gate: {
    mode: 'DEMO',
    eligible: false,
    requirements: [
      { code: 'TAX_REVIEW_CURRENT', met: false },
      { code: 'SELLER_REGISTERED_VALID', met: false },
      { code: 'HSN_SAC_POLICY', met: true },
      { code: 'BACKUP_RESTORE_VERIFIED', met: false },
    ],
    sellerProblems: ['SELLER_NOT_SUPPORTED', 'SELLER_GSTIN_MISSING', 'SELLER_GSTIN_STATE_MISMATCH'],
  },
  ...over,
});
const reviewView = {
  id: 'rv1',
  fingerprint: FP,
  reviewedByName: 'Asha Rao',
  reviewerCapacity: 'Owner',
  reviewedAt: '2026-10-20T09:30:00.000Z',
  noticeVersion: 'TAXREV-1',
  noticeText: 'I confirm',
  note: 'All good',
  engineVersion: '1.0.0',
  rulesetVersion: 'FUB-GST-1',
  jurisdictionRulesetVersion: '1',
};
const noReviews: TaxReviewListResponse = { reviews: [], total: 0, limit: 10, offset: 0 };

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('tax configuration page', () => {
  const page = (
    cfg: TaxConfigurationResponse,
    reviews = noReviews,
  ): Record<string, FakeHandler> => ({
    'GET /tax/configuration': () => ({ status: 200, body: cfg }),
    'GET /tax/configuration/reviews': () => ({ status: 200, body: reviews }),
  });

  it('shows rates with their windows, cess as unsupported, inactive categories, and placeholder wording', async () => {
    await open('/tax', READ, page(config()));
    const table = await screen.findByRole('table', {
      name: 'Tax categories and effective-dated rates',
    });
    expect(table.textContent).toContain('18%');
    expect(table.textContent).toContain('12.5%');
    expect(table.textContent).toContain('01-07-2017 to 30-09-2026');
    expect(table.textContent).toContain('01-10-2026 to open');
    expect(table.textContent).toContain('cess 1.0000 (not supported)');
    expect(table.textContent).toContain('(inactive)');
    expect(table.textContent).toContain('Exempt');
    expect(table.textContent).toContain('no rate');
    expect(within(table).getAllByText('Reviewed')).toHaveLength(1);
    expect(screen.getByText(/placeholders\./)).toBeTruthy();
  });

  it('lists the unmet gate requirements and each seller problem in words; read-only users cannot act', async () => {
    await open('/tax', READ, page(config()));
    await screen.findByText('Demo billing only');
    const reqs = within(screen.getByRole('list', { name: 'Production billing requirements' }));
    expect(reqs.getAllByText('Not met')).toHaveLength(3);
    expect(reqs.getAllByText('Met')).toHaveLength(1);
    expect(screen.getByText(/composition and unregistered sellers are not supported/)).toBeTruthy();
    expect(
      screen.getByText('The business GSTIN is missing or not in a valid format.'),
    ).toBeTruthy();
    expect(
      screen.getByText('The business GSTIN does not start with the business state code.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Only people with the tax review permission can confirm the review.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /production/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Do not require/ })).toBeNull();
    expect(screen.getByText('No reviews yet')).toBeTruthy();
  });

  it('says whether the review is current or out of date, and who made it', async () => {
    await open(
      '/tax',
      READ,
      page(config({ review: { state: 'CURRENT', latest: reviewView } }), {
        reviews: [reviewView],
        total: 1,
        limit: 10,
        offset: 0,
      }),
    );
    expect(
      await within(await screen.findByRole('region', { name: 'Review status' })).findByText(
        'Reviewed',
      ),
    ).toBeTruthy();
    expect(screen.getAllByText(/Asha Rao/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('(Owner)').length).toBe(1);
    expect(screen.getByText('All good')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Review history' }).textContent).toContain('current');
    cleanup();
    await open('/tax', READ, page(config({ review: { state: 'STALE', latest: reviewView } })));
    expect(await screen.findByText('Review out of date')).toBeTruthy();
    expect(screen.getByText(/needs to be reviewed again before production/)).toBeTruthy();
  });

  it('sends the fingerprint and notice version the page showed, with the typed capacity', async () => {
    let sent: Record<string, unknown> = {};
    await open('/tax', ALL, {
      ...page(config()),
      'POST /tax/configuration/reviews': (req) => {
        sent = req.body as Record<string, unknown>;
        return { status: 201, body: { review: reviewView } };
      },
    });
    await screen.findByRole('form', { name: 'Confirm tax review' });
    expect(screen.getByText(/This is not a legal or tax certification\./)).toBeTruthy();
    fireEvent.change(field('Your capacity'), { target: { value: ' Owner ' } });
    fireEvent.click(screen.getByLabelText('I have read and I confirm the statement above'));
    fireEvent.click(screen.getByRole('button', { name: 'Record my review' }));
    expect(
      await screen.findByText('Your review was recorded for the configuration shown on this page.'),
    ).toBeTruthy();
    expect(sent).toEqual({
      capacity: 'Owner',
      note: null,
      acknowledged: true,
      noticeVersion: 'TAXREV-1',
      expectedFingerprint: FP,
    });
  });

  it('explains a refused review (configuration changed) without technical wording', async () => {
    await open('/tax', ALL, {
      ...page(config()),
      'POST /tax/configuration/reviews': () =>
        apiError(409, 'BIZ_0001', [
          { field: 'expectedFingerprint', rule: 'configuration_changed' },
        ]),
    });
    await screen.findByRole('form', { name: 'Confirm tax review' });
    fireEvent.change(field('Your capacity'), { target: { value: 'Owner' } });
    fireEvent.click(screen.getByLabelText('I have read and I confirm the statement above'));
    fireEvent.click(screen.getByRole('button', { name: 'Record my review' }));
    expect(await screen.findByText('Nothing was recorded')).toBeTruthy();
    expect(screen.getByText(/changed after it was shown/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/BIZ_0001|configuration_changed|server wording/);
  });

  it('shows a generic message for an unexpected failure, and retries a failed load', async () => {
    let fail = true;
    await open('/tax', ALL, {
      'GET /tax/configuration': () =>
        fail ? { status: 500, body: undefined } : { status: 200, body: config() },
      'GET /tax/configuration/reviews': () => ({ status: 200, body: noReviews }),
      'POST /tax/configuration/reviews': () => apiError(500, 'SYS_0500'),
    });
    expect(await screen.findByText(/Something went wrong/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('form', { name: 'Confirm tax review' });
    fireEvent.change(field('Your capacity'), { target: { value: 'Owner' } });
    fireEvent.click(screen.getByLabelText('I have read and I confirm the statement above'));
    fireEvent.click(screen.getByRole('button', { name: 'Record my review' }));
    expect(await screen.findByText(/Something went wrong/)).toBeTruthy();
  });

  it('production switch: explains the unmet requirements when refused; shows return-to-demo in production mode', async () => {
    await open('/tax', ALL, {
      ...page(config()),
      'POST /tax/billing-mode': () =>
        apiError(409, 'BIZ_0001', [
          { field: 'SELLER_REGISTERED_VALID', rule: 'requirement_not_met' },
          { field: 'BACKUP_RESTORE_VERIFIED', rule: 'requirement_not_met' },
        ]),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to production billing' }));
    expect(
      await screen.findByText(
        /Production billing is not available:.*regular gst-registered seller.*backup has been restored/,
      ),
    ).toBeTruthy();
    cleanup();
    await open(
      '/tax',
      ALL,
      page(
        config({
          gate: { mode: 'PRODUCTION', eligible: true, requirements: [], sellerProblems: [] },
        }),
      ),
    );
    expect(await screen.findByText('Production billing is on')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Return to demo billing' })).toBeTruthy();
  });

  it('HSN/SAC policy: off needs acknowledgement and reason (server problems shown), and the page reflects an off policy', async () => {
    await open('/tax', ALL, {
      ...page(config()),
      'PUT /tax/hsn-requirement': () =>
        apiError(400, 'VAL_0001', [{ field: 'reason', rule: 'too_short' }]),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Do not require HSN/SAC…' }));
    fireEvent.click(screen.getByLabelText('I understand and accept this'));
    fireEvent.change(field('Reason'), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off the requirement' }));
    expect(await screen.findByText('This is too short.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    cleanup();
    await open(
      '/tax',
      ALL,
      page(
        config({
          hsnPolicy: {
            required: false,
            reason: 'No codes yet',
            changedAt: '2026-10-20T00:00:00.000Z',
          },
        }),
      ),
    );
    expect(await screen.findByText(/not required/)).toBeTruthy();
    expect(screen.getByText(/Reason recorded: No codes yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Require HSN/SAC again' })).toBeTruthy();
  });
});

describe('HSN/SAC page', () => {
  const entry = (over: Partial<HsnSacView> = {}): HsnSacView => ({
    id: `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    code: '8517',
    kind: 'HSN',
    description: 'Telephone sets',
    isActive: true,
    origin: 'USER',
    reviewStatus: 'UNREVIEWED',
    reviewedAt: null,
    reviewedByName: null,
    version: 1,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...over,
  });
  const list =
    (entries: HsnSacView[], total = entries.length): FakeHandler =>
    () => ({ status: 200, body: { entries, total, limit: 25, offset: 0 } });

  it('read-only users see the list without any action; an empty list is explained', async () => {
    await open('/tax/hsn-sac', READ, {
      'GET /tax/hsn-sac': list([
        entry({
          reviewStatus: 'REVIEWED',
          reviewedByName: 'Asha Rao',
          reviewedAt: '2026-10-20T09:30:00.000Z',
        }),
      ]),
    });
    const table = await screen.findByRole('table', { name: 'HSN/SAC codes' });
    expect(table.textContent).toContain('Confirmed');
    expect(table.textContent).toContain('Asha Rao');
    expect(screen.queryByRole('button', { name: 'Add a code' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Edit|Deactivate|Confirm) / })).toBeNull();
    cleanup();
    await open('/tax/hsn-sac', READ, { 'GET /tax/hsn-sac': list([]) });
    expect(await screen.findByText('No HSN/SAC codes yet')).toBeTruthy();
    expect(screen.getByText('Codes will appear here once they are added.')).toBeTruthy();
  });

  it('sends search and filters to the server and clears them', async () => {
    const calls = await open('/tax/hsn-sac', ALL, {
      'GET /tax/hsn-sac': (req) =>
        req.query.includes('search=zzz') ? list([])(req) : list([entry()])(req),
    });
    await screen.findByRole('table', { name: 'HSN/SAC codes' });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'SAC' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No codes match')).toBeTruthy();
    const last = calls.filter((c) => c.path === '/tax/hsn-sac').at(-1)!;
    expect(last.query).toContain('search=zzz');
    expect(last.query).toContain('kind=SAC');
    expect(last.query).not.toContain('isActive');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    await screen.findByRole('table', { name: 'HSN/SAC codes' });
  });

  it('creates an entry with the typed code and kind only, and shows server problems', async () => {
    let body: Record<string, unknown> = {};
    let fail = true;
    await open('/tax/hsn-sac', ALL, {
      'GET /tax/hsn-sac': list([entry()]),
      'POST /tax/hsn-sac': (req) => {
        body = req.body as Record<string, unknown>;
        return fail
          ? apiError(409, 'BIZ_0001', [{ field: 'code', rule: 'duplicate_code' }])
          : { status: 201, body: { entry: entry() } };
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a code' }));
    fireEvent.click(screen.getByRole('radio', { name: /^SAC/ }));
    fireEvent.change(field('Code'), { target: { value: '998314' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }));
    expect(await screen.findByText('The server could not accept some details')).toBeTruthy();
    expect(body).toEqual({ code: '998314', kind: 'SAC', description: null });
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }));
    expect(await screen.findByText('Code 998314 was added.')).toBeTruthy();
  });

  it('edit sends the version and only the description; a stale version asks to reload; toggle and confirm send the version', async () => {
    const e = entry({ version: 4 });
    const sent: { path: string; body: unknown }[] = [];
    let stale = true;
    await open('/tax/hsn-sac', ALL, {
      'GET /tax/hsn-sac': list([e]),
      [`PATCH /tax/hsn-sac/${e.id}`]: (req) => {
        sent.push({ path: req.path, body: req.body });
        return stale ? apiError(409, 'DB_0002') : { status: 200, body: { entry: e } };
      },
      [`POST /tax/hsn-sac/${e.id}/review`]: (req) => {
        sent.push({ path: req.path, body: req.body });
        return { status: 200, body: { entry: e } };
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit 8517' }));
    fireEvent.change(field('Description'), { target: { value: 'Phones' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This entry was changed by someone else')).toBeTruthy();
    stale = false;
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Code 8517 was saved.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate 8517' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm 8517' }));
    await screen.findByRole('table', { name: 'HSN/SAC codes' });
    expect(sent.map((s) => s.body)).toEqual([
      { expectedVersion: 4, description: 'Phones' },
      { expectedVersion: 4, description: 'Phones' },
      { expectedVersion: 4, isActive: false },
      { expectedVersion: 4 },
    ]);
  });
});
