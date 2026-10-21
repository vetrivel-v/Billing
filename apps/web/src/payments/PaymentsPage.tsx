import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  LoadingState,
  PageHeader,
  SelectField,
  TextInput,
} from '@commercebill/ui';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listPayments } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import { formatRupees } from '../invoices/model.js';
import { METHOD_OPTIONS, methodLabel } from './model.js';

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

/** The payment list: server-side search, filters and paging over recorded (immutable) payments. Demo payments are not real money. */
export function PaymentsPage() {
  const { authed } = useAuth();
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 300);
  const [method, setMethod] = useState('');
  const [type, setType] = useState<'all' | 'demo' | 'production'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const key = `${term}|${method}|${type}|${from}|${to}`;
  const [paging, setPaging] = useState({ key: '', page: 0 });
  const page = paging.key === key ? paging.page : 0;

  const query = {
    ...(term ? { search: term } : {}),
    ...(method ? { method } : {}),
    ...(type === 'all' ? {} : { isDemo: type === 'demo' }),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const result = useQuery({
    queryKey: ['payments', query],
    queryFn: () => authed((token) => listPayments(token, query)),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = result.data;
  const filtered = Boolean(term || method || from || to) || type !== 'all';
  const clear = () => {
    setSearch('');
    setMethod('');
    setType('all');
    setFrom('');
    setTo('');
  };

  return (
    <>
      <PageHeader
        title="Payments"
        description="Recorded customer payments. A recorded payment is permanent: correcting one is not supported yet. Demo payments are not real money."
      />
      <div className="mb-3 grid grid-cols-[minmax(8rem,1fr)_7rem_7.5rem_9rem_9rem] items-end gap-3">
        <TextInput
          label="Search"
          type="search"
          placeholder="Number, reference or customer"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={100}
          autoComplete="off"
        />
        <SelectField label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">All</option>
          {METHOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
        >
          <option value="all">All</option>
          <option value="demo">Demo</option>
          <option value="production">Production</option>
        </SelectField>
        <TextInput
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextInput label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {result.isPending ? (
        <LoadingState label="Loading payments" />
      ) : result.isError ? (
        <div className="space-y-3">
          <Alert tone="error">{describeFailure(result.error)}</Alert>
          <Button variant="secondary" onClick={() => void result.refetch()}>
            Try again
          </Button>
        </div>
      ) : data!.total === 0 ? (
        filtered ? (
          <EmptyState
            title="No payments match"
            action={
              <Button variant="secondary" onClick={clear}>
                Clear search and filters
              </Button>
            }
          >
            Try a different search, method, type or date range.
          </EmptyState>
        ) : (
          <EmptyState title="No payments yet">
            Open an invoice and choose Record payment.
          </EmptyState>
        )
      ) : (
        <>
          <div
            className="overflow-x-auto rounded-lg border border-slate-200 bg-white"
            aria-busy={result.isFetching}
          >
            <table className="w-full text-left text-[13px]">
              <caption className="sr-only">Payments</caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                <tr>
                  <th scope="col" className="px-2 py-2">
                    Date
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Payment
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Customer
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Invoice
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Method
                  </th>
                  <th scope="col" className="hidden px-2 py-2 min-[1100px]:table-cell">
                    Reference
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    Amount
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Type
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data!.payments.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-2 py-2 whitespace-nowrap">{p.paymentDate}</td>
                    <td className="px-2 py-2 font-mono text-xs whitespace-nowrap">
                      {p.paymentNumber}
                    </td>
                    <td className="px-2 py-2">
                      <div className="max-w-[8rem] min-w-[5rem] break-words">{p.customer.name}</div>
                    </td>
                    <td className="px-2 py-2 font-mono text-xs whitespace-nowrap">
                      {p.allocations.map((a) => (
                        <Link
                          key={a.invoiceId}
                          to={`/billing/${a.invoiceId}`}
                          className={link}
                          aria-label={`Open invoice ${a.invoiceNumber}`}
                        >
                          {a.invoiceNumber}
                        </Link>
                      ))}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">{methodLabel(p.method)}</td>
                    <td className="hidden px-2 py-2 min-[1100px]:table-cell">
                      <div className="max-w-[10rem] break-words">{p.reference ?? '-'}</div>
                    </td>
                    <td className="px-2 py-2 text-right font-medium whitespace-nowrap tabular-nums">
                      {formatRupees(p.amount)}
                    </td>
                    <td className="px-2 py-2">
                      {p.isDemo ? (
                        <Badge tone="warning">DEMO</Badge>
                      ) : (
                        <Badge tone="brand">Production</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
            <span aria-live="polite">
              Showing {data!.offset + 1}-{data!.offset + data!.payments.length} of {data!.total}
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
                disabled={data!.offset + data!.payments.length >= data!.total}
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
