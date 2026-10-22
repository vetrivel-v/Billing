import { useQuery } from '@tanstack/react-query';
import type { DashboardSummaryResponse } from '@commercebill/shared-types';
import { Alert, Badge, Card, LoadingState, PageHeader } from '@commercebill/ui';
import { Link } from 'react-router';
import { getDashboardSummary } from '../api.js';
import { useAuth } from '../auth.js';
import { formatRupees } from '../invoices/model.js';
import { visibleModules } from '../nav.js';
import { describeFailure } from '../messages.js';
import { StatusPanel } from '../StatusPanel.js';
import { GATE_TEXT, READINESS_LABEL, formatWhen } from '../backup/model.js';

const link =
  'font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600';
const TIME = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-900">{children}</dd>
    </>
  );
}

function Tile({
  label,
  value,
  note,
  demo,
}: {
  label: string;
  value: string;
  note?: string;
  demo: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 shadow-sm ${demo ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}
    >
      <p className="text-xs font-semibold tracking-wide text-slate-600 uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">{value}</p>
      {note && <p className="mt-1 text-xs text-slate-600">{note}</p>}
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

function Figures({ s, demo }: { s: DashboardSummaryResponse; demo: boolean }) {
  const key = demo ? 'demo' : 'production';
  const prefix = demo ? 'DEMO ' : '';
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {s.sales && (
        <>
          <Tile
            demo={demo}
            label={`${prefix}sales today`}
            value={formatRupees(s.sales[key].today.total)}
            note={plural(s.sales[key].today.count, 'invoice', 'invoices')}
          />
          <Tile
            demo={demo}
            label={`${prefix}sales this month`}
            value={formatRupees(s.sales[key].month.total)}
            note={plural(s.sales[key].month.count, 'invoice', 'invoices')}
          />
        </>
      )}
      {s.receivables && (
        <Tile
          demo={demo}
          label={`${prefix}receivables outstanding`}
          value={formatRupees(s.receivables[key].outstanding)}
          note={plural(s.receivables[key].openInvoices, 'unpaid invoice', 'unpaid invoices')}
        />
      )}
      {s.paymentsToday && (
        <Tile
          demo={demo}
          label={`${prefix}payments received today`}
          value={formatRupees(s.paymentsToday[key].total)}
          note={plural(s.paymentsToday[key].count, 'payment', 'payments')}
        />
      )}
    </div>
  );
}

const hasProduction = (s: DashboardSummaryResponse): boolean =>
  s.mode === 'PRODUCTION' ||
  (s.sales?.production.month.count ?? 0) > 0 ||
  (s.paymentsToday?.production.count ?? 0) > 0 ||
  Number(s.receivables?.production.outstanding ?? 0) > 0 ||
  (s.recentInvoices ?? []).some((i) => !i.isDemo);

function Readiness({ s }: { s: DashboardSummaryResponse }) {
  if (!s.readiness) return null;
  return (
    <Card title="Production readiness">
      <div className="space-y-3 text-sm">
        <p>
          Overall:{' '}
          <strong className={s.readiness.ready ? 'text-emerald-800' : 'text-amber-800'}>
            {s.readiness.ready ? 'READY' : 'NOT READY'}
          </strong>
        </p>
        <ul className="space-y-1">
          {s.readiness.items.map((i) => (
            <li key={i.code} className={i.met ? 'text-slate-700' : 'font-medium text-amber-800'}>
              <span aria-hidden="true">{i.met ? '✓' : '✗'} </span>
              <span className="sr-only">{i.met ? 'Ready: ' : 'Not ready: '}</span>
              {READINESS_LABEL[i.code] ?? i.code}
            </li>
          ))}
        </ul>
        <p className="text-slate-600">
          This is the software&apos;s own checklist, not a GST or legal certification. The tax rates
          and categories are placeholders until a qualified professional has reviewed them.{' '}
          {s.mode === 'PRODUCTION'
            ? 'Real billing is on.'
            : s.readiness.ready
              ? 'The checklist is met, so real billing could be switched on from the Tax page. That is a deliberate step you take yourself; nothing switches on automatically.'
              : 'Real billing stays off until every item is met.'}{' '}
          <Link to="/tax" className={link}>
            Tax configuration
          </Link>
        </p>
      </div>
    </Card>
  );
}

function Recovery({ s }: { s: DashboardSummaryResponse }) {
  if (!s.recovery) return null;
  const r = s.recovery;
  return (
    <Card title="Backup and recovery">
      <div className="space-y-2 text-sm">
        <p>
          Status:{' '}
          <strong className={r.gate.met ? 'text-emerald-800' : 'text-amber-800'}>
            {r.gate.met ? 'Verified' : 'Not verified'}
          </strong>
        </p>
        <p className="text-slate-600">{GATE_TEXT[r.gate.reason]}</p>
        <p className="text-slate-600">
          Last backup: {r.lastBackupAt ? formatWhen(r.lastBackupAt) : 'none yet'}. Last verified
          backup: {r.lastVerifiedAt ? formatWhen(r.lastVerifiedAt) : 'none yet'}.
        </p>
        <Link to="/settings/backup" className={link}>
          Backup &amp; Recovery
        </Link>
      </div>
    </Card>
  );
}

function RecentTables({ s }: { s: DashboardSummaryResponse }) {
  return (
    <>
      {s.recentInvoices && (
        <Card title="Recent invoices">
          {s.recentInvoices.length === 0 ? (
            <p className="text-sm text-slate-600">No invoices yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">The five most recent invoices</caption>
              <thead className="text-xs text-slate-500">
                <tr>
                  <th scope="col" className="py-1 pr-2">
                    Invoice
                  </th>
                  <th scope="col" className="py-1 pr-2">
                    Customer
                  </th>
                  <th scope="col" className="py-1 pr-2 text-right">
                    Total
                  </th>
                  <th scope="col" className="py-1 text-right">
                    Balance
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.recentInvoices.map((i) => (
                  <tr key={i.id} className="border-t border-slate-100">
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      <Link to={`/billing/${i.id}`} className={link}>
                        {i.documentNumber}
                      </Link>{' '}
                      {i.isDemo && <Badge tone="warning">DEMO</Badge>}
                    </td>
                    <td className="py-1.5 pr-2">{i.customerName}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {formatRupees(i.grandTotal)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatRupees(i.balanceDue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {s.recentPayments && (
        <Card title="Recent payments">
          {s.recentPayments.length === 0 ? (
            <p className="text-sm text-slate-600">No payments yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">The five most recent payments</caption>
              <thead className="text-xs text-slate-500">
                <tr>
                  <th scope="col" className="py-1 pr-2">
                    Payment
                  </th>
                  <th scope="col" className="py-1 pr-2">
                    Customer
                  </th>
                  <th scope="col" className="py-1 text-right">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.recentPayments.map((p) => (
                  <tr key={p.id} className="border-t border-slate-100">
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      {p.paymentNumber} {p.isDemo && <Badge tone="warning">DEMO</Badge>}
                    </td>
                    <td className="py-1.5 pr-2">{p.customerName}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatRupees(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}

/**
 * Dashboard: real, server-computed facts only, for the signed-in user's organization and permissions. DEMO figures are labelled DEMO and
 * never added to real (production) figures. Nothing is estimated: there is no profit, cost or accounting figure.
 */
export function DashboardPage() {
  const { state, can, authed } = useAuth();
  const summary = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: () => authed((t) => getDashboardSummary(t)),
    retry: false,
    staleTime: 0,
    enabled: state.phase === 'signed-in',
  });
  if (state.phase !== 'signed-in') return null;
  const { me } = state;
  const modules = visibleModules(can).filter((m) => m.key !== 'dashboard');
  const s = summary.data;
  return (
    <>
      <PageHeader title="Dashboard" description={`Welcome, ${me.user.displayName}.`} />
      <div className="space-y-4">
        {summary.isPending && <LoadingState label="Loading figures" />}
        {summary.isError && (
          <Alert tone="error">
            The business figures could not be loaded. {describeFailure(summary.error)}
          </Alert>
        )}
        {s && (
          <Alert
            tone={s.mode === 'DEMO' ? 'warning' : 'info'}
            title={s.mode === 'DEMO' ? 'DEMO mode' : 'Real billing is on'}
          >
            {s.mode === 'DEMO'
              ? 'CommerceBill is in DEMO mode. Every figure below is demo data: not real sales, not real money, not a tax invoice.'
              : 'Real (production) figures are shown separately from any DEMO figures and are never added together.'}
          </Alert>
        )}
        {s && (s.sales || s.receivables || s.paymentsToday) && (
          <section aria-label="Demo figures" className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700">Demo figures (as of {s.asOf})</h2>
            <Figures s={s} demo />
          </section>
        )}
        {s && (s.sales || s.receivables || s.paymentsToday) && hasProduction(s) && (
          <section aria-label="Real figures" className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700">Real (production) figures</h2>
            <Figures s={s} demo={false} />
          </section>
        )}
        {s && (
          <div className="grid gap-4 xl:grid-cols-2">
            <RecentTables s={s} />
            {s.stock && (
              <Card title="Stock">
                <p className="text-sm text-slate-700">
                  {plural(s.stock.trackedProducts, 'tracked product', 'tracked products')}:{' '}
                  {s.stock.withStock} with stock on hand, {s.stock.outOfStock} with nothing on hand.{' '}
                  <Link to="/inventory" className={link}>
                    Inventory
                  </Link>
                </p>
              </Card>
            )}
            <Recovery s={s} />
            <Readiness s={s} />
          </div>
        )}
        {!summary.isPending && modules.length === 0 && (
          <p className="text-sm text-slate-600">Your account has no module access yet.</p>
        )}
        <div className="grid gap-4 xl:grid-cols-3">
          <Card title="Your account">
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
              <Fact label="Name">{me.user.displayName}</Fact>
              <Fact label="Username">{me.user.username}</Fact>
              <Fact label="Organization">{me.organizationName || '-'}</Fact>
              <Fact label="Roles">
                {me.roles.length > 0 ? me.roles.join(', ') : 'None assigned'}
              </Fact>
            </dl>
          </Card>
          <Card title="Session">
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
              <Fact label="Ends at the latest">{TIME.format(new Date(me.sessionExpiresAt))}</Fact>
              <Fact label="Idle sign-out">{Math.round(me.idleTimeoutSeconds / 60)} minutes</Fact>
            </dl>
          </Card>
          <StatusPanel />
        </div>
      </div>
    </>
  );
}
