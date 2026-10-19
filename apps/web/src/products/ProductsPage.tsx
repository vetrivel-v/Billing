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
import { Link, useLocation, useNavigate } from 'react-router';
import { listProducts } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import { formatInr } from './money.js';

const PAGE_SIZE = 25;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Product list: server-side search, filters and paging (the renderer never holds the whole catalogue). */
export function ProductsPage() {
  const { authed, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const canWrite = can('product.write');

  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 300);
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [kind, setKind] = useState<'' | 'GOODS' | 'SERVICE'>('');
  const [tracked, setTracked] = useState<'' | 'yes' | 'no'>('');
  // The page belongs to the search term it was chosen for. A changed term resets the page DURING RENDER (React's
  // supported "adjust state on prop change" pattern) rather than in an effect, which could run after a click on Next and
  // silently undo it - and which would leave a remembered page behind for a term the user returns to.
  const [paging, setPaging] = useState({ term, page: 0 });
  if (paging.term !== term) setPaging({ term, page: 0 });
  const page = paging.term === term ? paging.page : 0;
  const setPage = (next: number | ((p: number) => number)) =>
    setPaging({ term, page: typeof next === 'function' ? next(page) : next });

  const query = {
    ...(term ? { search: term } : {}),
    ...(status === 'all' ? {} : { isActive: status === 'active' }),
    ...(kind ? { kind } : {}),
    ...(tracked ? { tracked: tracked === 'yes' } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const result = useQuery({
    queryKey: ['products', query],
    queryFn: () => authed((token) => listProducts(token, query)),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = result.data;
  const filtered = Boolean(term) || status !== 'active' || kind !== '' || tracked !== '';
  const clearFilters = () => {
    setSearch('');
    setStatus('active');
    setKind('');
    setTracked('');
    setPage(0);
  };
  const newButton = canWrite ? (
    <Button onClick={() => navigate('/products/new')}>New product</Button>
  ) : undefined;

  return (
    <>
      <PageHeader title="Products" description="Goods and services you sell." actions={newButton} />
      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      <div className="mb-3 grid grid-cols-[1fr_9rem_9rem_10rem] items-end gap-3">
        <TextInput
          label="Search"
          type="search"
          placeholder="SKU, name, barcode or HSN/SAC"
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
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setPage(0);
          }}
        >
          <option value="">All types</option>
          <option value="GOODS">Goods</option>
          <option value="SERVICE">Services</option>
        </SelectField>
        <SelectField
          label="Inventory"
          value={tracked}
          onChange={(e) => {
            setTracked(e.target.value as typeof tracked);
            setPage(0);
          }}
        >
          <option value="">Tracked or not</option>
          <option value="yes">Tracked</option>
          <option value="no">Not tracked</option>
        </SelectField>
      </div>

      {result.isPending ? (
        <LoadingState label="Loading products" />
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
            title="No products match"
            action={
              <Button variant="secondary" onClick={clearFilters}>
                Clear search and filters
              </Button>
            }
          >
            Try a different search, or change the status, type and inventory filters.
          </EmptyState>
        ) : (
          <EmptyState title="No products yet" action={newButton}>
            {canWrite
              ? 'Add your first product or service to start billing.'
              : 'Products will appear here once they are added.'}
          </EmptyState>
        )
      ) : (
        <>
          <div
            className="overflow-x-auto rounded-lg border border-slate-200 bg-white"
            aria-busy={result.isFetching}
          >
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Products</caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                <tr>
                  <th scope="col" className="px-2.5 py-2">
                    SKU
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Product
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Type
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    HSN/SAC
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Unit
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    Selling price
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Inventory
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
                {data!.products.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-2.5 py-2 font-mono text-xs whitespace-nowrap">{p.sku}</td>
                    <td className="px-2.5 py-2">
                      <div className="max-w-md font-medium break-words text-slate-900">
                        {p.name}
                      </div>
                      {p.barcode && (
                        <div className="font-mono text-xs text-slate-500">{p.barcode}</div>
                      )}
                    </td>
                    <td className="px-2.5 py-2">
                      <Badge tone={p.kind === 'GOODS' ? 'brand' : 'neutral'}>
                        {p.kind === 'GOODS' ? 'Goods' : 'Service'}
                      </Badge>
                    </td>
                    <td className="px-2.5 py-2 font-mono text-xs whitespace-nowrap">
                      {p.hsnSacCode ? (
                        p.hsnSacCode.code
                      ) : (
                        <span className="font-sans text-slate-400">-</span>
                      )}
                    </td>
                    <td className="px-2.5 py-2 whitespace-nowrap">
                      {p.unit?.code ?? <span className="text-slate-400">-</span>}
                    </td>
                    <td className="px-2.5 py-2 text-right whitespace-nowrap tabular-nums">
                      <div className="font-medium text-slate-900">{formatInr(p.sellingPrice)}</div>
                      <div className="text-xs text-slate-500">
                        {p.priceIncludesTax ? 'incl. GST' : '+ GST'}
                      </div>
                    </td>
                    <td className="px-2.5 py-2 whitespace-nowrap">
                      {p.trackInventory ? (
                        <Badge tone="success">Tracked</Badge>
                      ) : (
                        <span className="text-slate-400">
                          <span aria-hidden="true">-</span>
                          <span className="sr-only">Not tracked</span>
                        </span>
                      )}
                    </td>
                    <td className="px-2.5 py-2">
                      <Badge tone={p.isActive ? 'success' : 'warning'}>
                        {p.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-2.5 py-2 text-right whitespace-nowrap">
                      <Link
                        to={`/products/${p.id}`}
                        className="font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
                        aria-label={`${canWrite ? 'Edit' : 'Open'} ${p.name}`}
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
              Showing {data!.offset + 1}-{data!.offset + data!.products.length} of {data!.total}
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
                disabled={data!.offset + data!.products.length >= data!.total}
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
