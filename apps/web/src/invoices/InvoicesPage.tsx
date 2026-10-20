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
import { Link, useLocation } from 'react-router';
import { listInvoices } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import { formatRupees } from './model.js';

const PAGE_SIZE = 25;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const link =
  'font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600';

/** The invoice list: server-side search, filters and paging over immutable posted invoices. */
export function InvoicesPage() {
  const { authed, can } = useAuth();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const canCompose = can('sales.invoice.write');

  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 300);
  const [type, setType] = useState<'all' | 'demo' | 'production'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [paging, setPaging] = useState({ key: '', page: 0 });
  const key = `${term}|${type}|${from}|${to}`;
  const page = paging.key === key ? paging.page : 0;
  const setPage = (next: number) => setPaging({ key, page: next });

  const query = {
    ...(term ? { search: term } : {}),
    ...(type === 'all' ? {} : { isDemo: type === 'demo' }),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const result = useQuery({
    queryKey: ['invoices', query],
    queryFn: () => authed((token) => listInvoices(token, query)),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = result.data;
  const filtered = Boolean(term) || type !== 'all' || Boolean(from) || Boolean(to);
  const clearFilters = () => {
    setSearch('');
    setType('all');
    setFrom('');
    setTo('');
  };

  return (
    <>
      <PageHeader
        title="Billing"
        description="Posted invoices. A posted invoice is permanent and cannot be edited."
        actions={
          canCompose ? (
            <Link
              to="/billing/new"
              className="inline-flex h-9 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              New invoice
            </Link>
          ) : undefined
        }
      />
      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      <div className="mb-3 grid grid-cols-[1fr_9rem_9.5rem_9.5rem] items-end gap-3">
        <TextInput
          label="Search"
          type="search"
          placeholder="Invoice number or customer"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={100}
          autoComplete="off"
        />
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
        <LoadingState label="Loading invoices" />
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
            title="No invoices match"
            action={
              <Button variant="secondary" onClick={clearFilters}>
                Clear search and filters
              </Button>
            }
          >
            Try a different search, type or date range.
          </EmptyState>
        ) : (
          <EmptyState title="No invoices yet">
            {canCompose
              ? 'Choose New invoice to create the first one. Until backup and restore are verified, invoices are demo invoices.'
              : 'No invoice has been posted yet.'}
          </EmptyState>
        )
      ) : (
        <>
          <div
            className="overflow-x-auto rounded-lg border border-slate-200 bg-white"
            aria-busy={result.isFetching}
          >
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Invoices</caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                <tr>
                  <th scope="col" className="px-2.5 py-2">
                    Invoice
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Date
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Customer
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    Taxable
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    GST
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    Total
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Type
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data!.invoices.map((i) => (
                  <tr key={i.id} className="hover:bg-slate-50">
                    <td className="px-2.5 py-2 font-mono text-xs whitespace-nowrap">
                      <Link
                        to={`/billing/${i.id}`}
                        className={link}
                        aria-label={`Open invoice ${i.documentNumber}`}
                      >
                        {i.documentNumber}
                      </Link>
                    </td>
                    <td className="px-2.5 py-2 whitespace-nowrap">{i.invoiceDate}</td>
                    <td className="px-2.5 py-2">
                      <div className="max-w-xs min-w-[8rem] break-words">{i.customerName}</div>
                    </td>
                    <td className="px-2.5 py-2 text-right whitespace-nowrap tabular-nums">
                      {formatRupees(i.taxableSubtotal)}
                    </td>
                    <td className="px-2.5 py-2 text-right whitespace-nowrap tabular-nums">
                      {formatRupees(i.taxTotal)}
                    </td>
                    <td className="px-2.5 py-2 text-right font-medium whitespace-nowrap tabular-nums">
                      {formatRupees(i.grandTotal)}
                    </td>
                    <td className="px-2.5 py-2">
                      {i.isDemo ? (
                        <Badge tone="warning">DEMO</Badge>
                      ) : (
                        <Badge tone="brand">Production</Badge>
                      )}
                    </td>
                    <td className="px-2.5 py-2">
                      <Badge tone="success">Posted</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
            <span aria-live="polite">
              Showing {data!.offset + 1}-{data!.offset + data!.invoices.length} of {data!.total}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={data!.offset + data!.invoices.length >= data!.total}
                onClick={() => setPage(page + 1)}
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
