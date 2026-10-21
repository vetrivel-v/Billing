import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingState,
  PageHeader,
  SelectField,
  TextInput,
} from '@commercebill/ui';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, getCustomerReceivable, getReceivables } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import { formatRupees } from '../invoices/model.js';
import { STATUS_LABEL, STATUS_TONE } from './model.js';

const PAGE_SIZE = 25;
const link =
  'font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const DEMO_NOTE =
  'Demo figures are for testing: demo invoices and demo payments are not real sales or real money, and are never part of production receivables.';

/** What each customer owes: invoiced minus paid, derived by the server from invoices and recorded payments. */
export function ReceivablesPage() {
  const { authed } = useAuth();
  const [params, setParams] = useSearchParams();
  const isDemo = params.get('demo') === '1';
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 300);
  const [paging, setPaging] = useState({ key: '', page: 0 });
  const key = `${isDemo}|${term}`;
  const page = paging.key === key ? paging.page : 0;
  const query = {
    isDemo,
    ...(term ? { search: term } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const result = useQuery({
    queryKey: ['receivables', query],
    queryFn: () => authed((token) => getReceivables(token, query)),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = result.data;
  return (
    <>
      <PageHeader
        title="Receivables"
        description="Invoiced, paid and outstanding by customer. Balances are worked out from the invoices and recorded payments."
      />
      <div className="mb-3 grid grid-cols-[1fr_12rem] items-end gap-3">
        <TextInput
          label="Search customer"
          type="search"
          placeholder="Name or code"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={100}
          autoComplete="off"
        />
        <SelectField
          label="Show"
          value={isDemo ? 'demo' : 'production'}
          onChange={(e) => setParams(e.target.value === 'demo' ? { demo: '1' } : {})}
        >
          <option value="production">Production</option>
          <option value="demo">Demo (not real)</option>
        </SelectField>
      </div>
      {isDemo && (
        <div className="mb-3">
          <Alert tone="warning" title="DEMO figures">
            {DEMO_NOTE}
          </Alert>
        </div>
      )}
      {result.isPending ? (
        <LoadingState label="Loading receivables" />
      ) : result.isError ? (
        <div className="space-y-3">
          <Alert tone="error">{describeFailure(result.error)}</Alert>
          <Button variant="secondary" onClick={() => void result.refetch()}>
            Try again
          </Button>
        </div>
      ) : data!.total === 0 ? (
        <EmptyState
          title={
            term
              ? 'No customers match'
              : isDemo
                ? 'No demo invoices yet'
                : 'No production invoices yet'
          }
        >
          {term
            ? 'Try a different search.'
            : isDemo
              ? 'Demo invoices appear here once they are posted.'
              : 'Receivables appear here once production invoices are posted.'}
        </EmptyState>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-3 gap-3 text-sm" aria-label="Totals">
            {(
              [
                ['Invoiced', data!.totals.invoiced],
                [isDemo ? 'Demo paid' : 'Paid', data!.totals.paid],
                [isDemo ? 'Demo outstanding' : 'Outstanding', data!.totals.outstanding],
              ] as const
            ).map(([label, v]) => (
              <Card key={label}>
                <p className="text-xs text-slate-500">{label}</p>
                <p className="text-lg font-semibold tabular-nums">{formatRupees(v)}</p>
              </Card>
            ))}
          </div>
          <div
            className="overflow-x-auto rounded-lg border border-slate-200 bg-white"
            aria-busy={result.isFetching}
          >
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Receivables by customer</caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                <tr>
                  <th scope="col" className="px-2.5 py-2">
                    Customer
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    Invoices
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    Invoiced
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    {isDemo ? 'Demo paid' : 'Paid'}
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    {isDemo ? 'Demo outstanding' : 'Outstanding'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data!.customers.map((c) => (
                  <tr key={c.customerId} className="hover:bg-slate-50">
                    <td className="px-2.5 py-2">
                      <Link
                        to={`/receivables/${c.customerId}${isDemo ? '?demo=1' : ''}`}
                        className={link}
                        aria-label={`Receivables of ${c.customerName}`}
                      >
                        {c.customerName}
                      </Link>{' '}
                      <span className="text-xs text-slate-500">{c.customerCode}</span>
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{c.invoiceCount}</td>
                    <td className="px-2.5 py-2 text-right whitespace-nowrap tabular-nums">
                      {formatRupees(c.totalInvoiced)}
                    </td>
                    <td className="px-2.5 py-2 text-right whitespace-nowrap tabular-nums">
                      {formatRupees(c.totalPaid)}
                    </td>
                    <td className="px-2.5 py-2 text-right font-medium whitespace-nowrap tabular-nums">
                      {formatRupees(c.outstanding)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
            <span aria-live="polite">
              Showing {data!.offset + 1}-{data!.offset + data!.customers.length} of {data!.total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={page === 0}
                onClick={() => setPaging({ key, page: page - 1 })}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={data!.offset + data!.customers.length >= data!.total}
                onClick={() => setPaging({ key, page: page + 1 })}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** One customer: totals, then each invoice with what was paid, what is due and the derived display status. */
export function CustomerReceivablePage() {
  const { customerId } = useParams();
  const { authed } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const isDemo = params.get('demo') === '1';
  const q = useQuery({
    queryKey: ['receivables', 'customer', customerId, isDemo],
    queryFn: () => authed((token) => getCustomerReceivable(token, customerId!, isDemo)),
    retry: false,
  });
  if (q.isPending) return <LoadingState label="Loading customer" />;
  if (q.isError)
    return (
      <div className="space-y-3">
        <Alert tone="error">
          {q.error instanceof ApiError && q.error.status === 404
            ? 'This customer could not be found.'
            : describeFailure(q.error)}
        </Alert>
        <Button variant="secondary" onClick={() => navigate('/receivables')}>
          Back to receivables
        </Button>
      </div>
    );
  const d = q.data;
  return (
    <>
      <PageHeader
        title={d.customer.name}
        description={`Customer ${d.customer.code} - ${isDemo ? 'demo' : 'production'} invoices`}
        actions={
          <Button
            variant="secondary"
            onClick={() => navigate(isDemo ? '/receivables?demo=1' : '/receivables')}
          >
            Back to receivables
          </Button>
        }
      />
      {isDemo && (
        <div className="mb-3">
          <Alert tone="warning" title="DEMO figures">
            {DEMO_NOTE}
          </Alert>
        </div>
      )}
      <div className="mb-3 grid grid-cols-3 gap-3 text-sm" aria-label="Customer totals">
        {(
          [
            ['Total invoiced', d.totals.invoiced],
            [isDemo ? 'Demo paid' : 'Total paid', d.totals.paid],
            [isDemo ? 'Demo outstanding' : 'Outstanding', d.totals.outstanding],
          ] as const
        ).map(([label, v]) => (
          <Card key={label}>
            <p className="text-xs text-slate-500">{label}</p>
            <p className="text-lg font-semibold tabular-nums">{formatRupees(v)}</p>
          </Card>
        ))}
      </div>
      {d.invoices.length === 0 ? (
        <EmptyState title="No invoices">
          This customer has no {isDemo ? 'demo' : 'production'} invoices.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Invoices of this customer</caption>
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
              <tr>
                <th scope="col" className="px-2.5 py-2">
                  Invoice
                </th>
                <th scope="col" className="px-2.5 py-2">
                  Date
                </th>
                <th scope="col" className="px-2.5 py-2 text-right">
                  Invoice total
                </th>
                <th scope="col" className="px-2.5 py-2 text-right">
                  {isDemo ? 'Demo paid' : 'Paid'}
                </th>
                <th scope="col" className="px-2.5 py-2 text-right">
                  {isDemo ? 'Demo balance' : 'Balance'}
                </th>
                <th scope="col" className="px-2.5 py-2">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {d.invoices.map((r) => (
                <tr key={r.invoiceId} className="hover:bg-slate-50">
                  <td className="px-2.5 py-2 font-mono text-xs whitespace-nowrap">
                    <Link
                      to={`/billing/${r.invoiceId}`}
                      className={link}
                      aria-label={`Open invoice ${r.documentNumber}`}
                    >
                      {r.documentNumber}
                    </Link>
                  </td>
                  <td className="px-2.5 py-2 whitespace-nowrap">{r.invoiceDate}</td>
                  <td className="px-2.5 py-2 text-right whitespace-nowrap tabular-nums">
                    {formatRupees(r.grandTotal)}
                  </td>
                  <td className="px-2.5 py-2 text-right whitespace-nowrap tabular-nums">
                    {formatRupees(r.paid)}
                  </td>
                  <td className="px-2.5 py-2 text-right font-medium whitespace-nowrap tabular-nums">
                    {formatRupees(r.balanceDue)}
                  </td>
                  <td className="px-2.5 py-2">
                    <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
