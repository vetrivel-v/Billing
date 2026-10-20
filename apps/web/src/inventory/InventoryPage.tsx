import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { formatQuantity } from '@commercebill/inventory-engine/browser';
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
import { listStock } from '../api.js';
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

const link =
  'font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600';

/** Stock overview: tracked goods with the quantity on hand in the primary warehouse (server-side search and paging). */
export function InventoryPage() {
  const { authed, can } = useAuth();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const canWrite = can('inventory.adjustment.create');

  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 300);
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  // The page belongs to the search term it was chosen for; a changed term resets it during render (see ProductsPage).
  const [paging, setPaging] = useState({ term, page: 0 });
  if (paging.term !== term) setPaging({ term, page: 0 });
  const page = paging.term === term ? paging.page : 0;
  const setPage = (next: number | ((p: number) => number)) =>
    setPaging({ term, page: typeof next === 'function' ? next(page) : next });

  const query = {
    ...(term ? { search: term } : {}),
    ...(status === 'all' ? {} : { isActive: status === 'active' }),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const result = useQuery({
    queryKey: ['stock', query],
    queryFn: () => authed((token) => listStock(token, query)),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = result.data;
  const filtered = Boolean(term) || status !== 'active';
  const clearFilters = () => {
    setSearch('');
    setStatus('active');
    setPage(0);
  };

  return (
    <>
      <PageHeader
        title="Inventory"
        description={
          data?.warehouse
            ? `Stock on hand in ${data.warehouse.name}. Only products that track inventory are listed.`
            : 'Stock on hand. Only products that track inventory are listed.'
        }
      />
      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      <div className="mb-3 grid grid-cols-[1fr_10rem] items-end gap-3">
        <TextInput
          label="Search"
          type="search"
          placeholder="SKU, product name or barcode"
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
      </div>

      {result.isPending ? (
        <LoadingState label="Loading stock" />
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
            title="No stock items match"
            action={
              <Button variant="secondary" onClick={clearFilters}>
                Clear search and filters
              </Button>
            }
          >
            Try a different search, or change the status filter.
          </EmptyState>
        ) : (
          <EmptyState title="No products track inventory yet">
            Open a goods product in Products and turn on &ldquo;Track inventory&rdquo;. It will then
            appear here, and you can record its opening stock.
          </EmptyState>
        )
      ) : (
        <>
          <div
            className="overflow-x-auto rounded-lg border border-slate-200 bg-white"
            aria-busy={result.isFetching}
          >
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Stock on hand</caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                <tr>
                  <th scope="col" className="px-2.5 py-2">
                    SKU
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Product
                  </th>
                  <th scope="col" className="hidden px-2.5 py-2 min-[1100px]:table-cell">
                    Warehouse
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    On hand
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Unit
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Status
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data!.stock.map((s) => (
                  <tr key={s.productId} className="hover:bg-slate-50">
                    <td className="px-2.5 py-2 font-mono text-xs whitespace-nowrap">{s.sku}</td>
                    <td className="px-2.5 py-2">
                      <div className="max-w-md min-w-[11rem] font-medium break-words text-slate-900">
                        {s.name}
                      </div>
                    </td>
                    <td className="hidden px-2.5 py-2 whitespace-nowrap text-slate-600 min-[1100px]:table-cell">
                      {data!.warehouse?.name}
                    </td>
                    <td className="px-2.5 py-2 text-right font-medium whitespace-nowrap text-slate-900 tabular-nums">
                      {formatQuantity(s.onHand)}
                    </td>
                    <td className="px-2.5 py-2 whitespace-nowrap">{s.unit.code}</td>
                    <td className="px-2.5 py-2">
                      <Badge tone={s.isActive ? 'success' : 'warning'}>
                        {s.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-2.5 py-2 text-right whitespace-nowrap">
                      <span className="inline-flex max-w-[15rem] flex-wrap justify-end gap-x-3 gap-y-0.5">
                        {canWrite && !s.hasMovements && (
                          <Link
                            to={`/inventory/${s.productId}/opening`}
                            className={link}
                            aria-label={`Add opening stock for ${s.name}`}
                          >
                            Opening stock
                          </Link>
                        )}
                        {canWrite && (
                          <Link
                            to={`/inventory/${s.productId}/receive`}
                            className={link}
                            aria-label={`Receive stock for ${s.name}`}
                          >
                            Receive
                          </Link>
                        )}
                        {canWrite && (
                          <Link
                            to={`/inventory/${s.productId}/adjust`}
                            className={link}
                            aria-label={`Adjust stock for ${s.name}`}
                          >
                            Adjust
                          </Link>
                        )}
                        <Link
                          to={`/inventory/${s.productId}`}
                          className={link}
                          aria-label={`View movements for ${s.name}`}
                        >
                          Movements
                        </Link>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
            <span aria-live="polite">
              Showing {data!.offset + 1}-{data!.offset + data!.stock.length} of {data!.total}
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
                disabled={data!.offset + data!.stock.length >= data!.total}
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
