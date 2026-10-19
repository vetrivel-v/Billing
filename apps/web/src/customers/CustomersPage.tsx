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
import type { CustomerView } from '@commercebill/shared-types';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { listCustomers } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';

const PAGE_SIZE = 25;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const GST_LABEL = {
  REGISTERED: 'Registered',
  COMPOSITION: 'Composition',
  UNREGISTERED: 'Unregistered',
} as const;

function GstCell({ c }: { c: CustomerView }) {
  return (
    <div>
      <div>{GST_LABEL[c.gstStatus]}</div>
      {c.gstin && <div className="font-mono text-xs text-slate-500">{c.gstin}</div>}
    </div>
  );
}

/** Customer list: server-side search, filters and paging (the renderer never holds the whole customer set). */
export function CustomersPage() {
  const { authed, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const canWrite = can('customer.write');

  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 300);
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [type, setType] = useState<'' | 'B2C' | 'B2B'>('');
  // The page belongs to the search term it was chosen for. A changed term resets the page DURING RENDER (React's
  // supported "adjust state on prop change" pattern) rather than in an effect, which could run after a click on Next and
  // silently undo it - and which would leave a remembered page behind for a term the user returns to.
  const [paging, setPaging] = useState({ term, page: 0 });
  if (paging.term !== term) setPaging({ term, page: 0 });
  const page = paging.term === term ? paging.page : 0;
  const setPage = (next: number | ((p: number) => number)) =>
    setPaging({ term, page: typeof next === 'function' ? next(page) : next });

  // Any change of the search term returns to the first page.

  const query = {
    ...(term ? { search: term } : {}),
    ...(status === 'all' ? {} : { isActive: status === 'active' }),
    ...(type ? { type } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const result = useQuery({
    queryKey: ['customers', query],
    queryFn: () => authed((token) => listCustomers(token, query)),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const data = result.data;
  const filtered = Boolean(term) || status !== 'active' || type !== '';
  const clearFilters = () => {
    setSearch('');
    setStatus('active');
    setType('');
    setPage(0);
  };

  return (
    <>
      <PageHeader
        title="Customers"
        description="People and businesses you sell to."
        actions={
          canWrite ? (
            <Button onClick={() => navigate('/customers/new')}>New customer</Button>
          ) : undefined
        }
      />
      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      <div className="mb-3 grid grid-cols-[1fr_10rem_10rem] items-end gap-3">
        <TextInput
          label="Search"
          type="search"
          placeholder="Code, name, phone, email or GSTIN"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={100}
          autoComplete="off"
        />
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as typeof status);
            setPage(0);
          }}
        >
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </SelectField>
        <SelectField
          label="Type"
          value={type}
          onChange={(e) => {
            setType(e.target.value as typeof type);
            setPage(0);
          }}
        >
          <option value="">All types</option>
          <option value="B2B">B2B</option>
          <option value="B2C">B2C</option>
        </SelectField>
      </div>

      {result.isPending ? (
        <LoadingState label="Loading customers" />
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
            title="No customers match"
            action={
              <Button variant="secondary" onClick={clearFilters}>
                Clear search and filters
              </Button>
            }
          >
            Try a different search, or change the status and type filters.
          </EmptyState>
        ) : (
          <EmptyState
            title="No customers yet"
            action={
              canWrite ? (
                <Button onClick={() => navigate('/customers/new')}>New customer</Button>
              ) : undefined
            }
          >
            {canWrite
              ? 'Add your first customer to start billing.'
              : 'Customers will appear here once they are added.'}
          </EmptyState>
        )
      ) : (
        <>
          <div
            className="overflow-x-auto rounded-lg border border-slate-200 bg-white"
            aria-busy={result.isFetching}
          >
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Customers</caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Code
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Customer
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Type
                  </th>
                  <th scope="col" className="px-3 py-2">
                    GST
                  </th>
                  <th scope="col" className="px-3 py-2">
                    State
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Contact
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data!.customers.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{c.code}</td>
                    <td className="px-3 py-2">
                      <div className="max-w-md font-medium break-words text-slate-900">
                        {c.legalName}
                      </div>
                      {c.displayName && (
                        <div className="text-xs text-slate-500">{c.displayName}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={c.customerType === 'B2B' ? 'brand' : 'neutral'}>
                        {c.customerType}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <GstCell c={c} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {c.billingStateName ?? c.billingStateCode}
                    </td>
                    <td className="px-3 py-2">
                      <div>{c.phone ?? <span className="text-slate-400">-</span>}</div>
                      {c.email && <div className="text-xs text-slate-500">{c.email}</div>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={c.isActive ? 'success' : 'warning'}>
                        {c.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Link
                        to={`/customers/${c.id}`}
                        className="font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
                        aria-label={`${canWrite ? 'Edit' : 'Open'} ${c.legalName}`}
                      >
                        {canWrite ? 'Edit' : 'Open'}
                      </Link>
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
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={data!.offset + data!.customers.length >= data!.total}
                onClick={() => setPage((p) => p + 1)}
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
