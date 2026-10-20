import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { formatQuantity } from '@commercebill/inventory-engine/browser';
import { Alert, Button, Card, EmptyState, LoadingState, PageHeader } from '@commercebill/ui';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { ApiError, listStock, listStockMovements } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import { MOVEMENT_LABEL, REASON_LABEL } from './model.js';

const PAGE_SIZE = 25;

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
};

/** One product's stock: what is on hand now, the actions, and its immutable movement history (server-side paged). */
export function InventoryProductPage() {
  const { productId } = useParams();
  const { authed, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const canWrite = can('inventory.adjustment.create');
  const [page, setPage] = useState(0);

  const stock = useQuery({
    queryKey: ['stock-product', productId],
    queryFn: () => authed((t) => listStock(t, { productId: productId!, limit: 1, offset: 0 })),
    retry: false,
    staleTime: 0,
  });
  const movements = useQuery({
    queryKey: ['stock-movements', productId, page],
    queryFn: () =>
      authed((t) =>
        listStockMovements(t, {
          productId: productId!,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
      ),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
  });

  const back = () => navigate('/inventory');
  if (stock.isPending) return <LoadingState label="Loading stock" />;
  const row = stock.data?.stock[0];
  if (stock.isError || !row) {
    const missing =
      !stock.isError || (stock.error instanceof ApiError && stock.error.status === 404);
    return (
      <>
        <PageHeader title="Stock" />
        <EmptyState
          title={missing ? 'This product has no stock record' : 'The stock could not be loaded'}
          action={
            <Button variant="secondary" onClick={back}>
              Back to inventory
            </Button>
          }
        >
          {missing
            ? 'Only goods that track inventory have stock. Check the product in Products.'
            : describeFailure(stock.error)}
        </EmptyState>
      </>
    );
  }

  const m = movements.data;
  return (
    <>
      <PageHeader
        title={row.name}
        description={`SKU ${row.sku}`}
        actions={
          <>
            <Button variant="secondary" onClick={back}>
              Back
            </Button>
            {canWrite && (
              <>
                {!row.hasMovements && (
                  <Button
                    variant="secondary"
                    onClick={() => navigate(`/inventory/${row.productId}/opening`)}
                  >
                    Add opening stock
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={() => navigate(`/inventory/${row.productId}/receive`)}
                >
                  Receive stock
                </Button>
                <Button onClick={() => navigate(`/inventory/${row.productId}/adjust`)}>
                  Adjust stock
                </Button>
              </>
            )}
          </>
        }
      />
      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      {!row.isActive && (
        <div className="mb-4">
          <Alert tone="warning">
            This product is inactive. Its stock is kept and can still be adjusted.
          </Alert>
        </div>
      )}
      <div className="mb-4">
        <Card title="Stock on hand">
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
            <p>
              <span className="text-3xl font-semibold text-slate-900 tabular-nums">
                {formatQuantity(row.onHand)}
              </span>{' '}
              <span className="text-sm text-slate-600">
                {row.unit.code}
                {row.unit.name ? ` (${row.unit.name})` : ''}
              </span>
            </p>
            <p className="text-sm text-slate-600">
              Warehouse:{' '}
              <span className="font-medium text-slate-900">{stock.data?.warehouse?.name}</span>
            </p>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Stock only changes by recording a movement below. Recorded movements cannot be edited or
            deleted; a mistake is corrected with another movement.
          </p>
        </Card>
      </div>

      <h2 className="mb-2 text-base font-semibold text-slate-900">Movements</h2>
      {movements.isPending ? (
        <LoadingState label="Loading movements" />
      ) : movements.isError ? (
        <div className="space-y-3">
          <Alert tone="error">{describeFailure(movements.error)}</Alert>
          <Button variant="secondary" onClick={() => void movements.refetch()}>
            Try again
          </Button>
        </div>
      ) : m!.total === 0 ? (
        <EmptyState title="No movements yet">
          {canWrite
            ? 'Record opening stock or receive stock to start this product’s history.'
            : 'Movements will appear here once stock is recorded.'}
        </EmptyState>
      ) : (
        <>
          <div
            className="overflow-x-auto rounded-lg border border-slate-200 bg-white"
            aria-busy={movements.isFetching}
          >
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Stock movements, newest first</caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                <tr>
                  <th scope="col" className="px-2.5 py-2">
                    Date
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Movement
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Reference / reason
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    Increase
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    Decrease
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Recorded by
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {m!.movements.map((mv) => {
                  const decrease = mv.quantityDelta.startsWith('-');
                  return (
                    <tr key={mv.id} className="align-top hover:bg-slate-50">
                      <td className="px-2.5 py-2 whitespace-nowrap tabular-nums">
                        {fmtDate(mv.businessDate)}
                      </td>
                      <td className="px-2.5 py-2 whitespace-nowrap">
                        {MOVEMENT_LABEL[mv.movementType]}
                      </td>
                      <td className="px-2.5 py-2">
                        {mv.reasonCode && (
                          <div className="font-medium text-slate-900">
                            {REASON_LABEL[mv.reasonCode]}
                          </div>
                        )}
                        {mv.reference && <div className="break-words">{mv.reference}</div>}
                        {mv.note && (
                          <div className="max-w-xs text-xs break-words text-slate-500">
                            {mv.note}
                          </div>
                        )}
                        {!mv.reasonCode && !mv.reference && !mv.note && (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="px-2.5 py-2 text-right font-medium whitespace-nowrap tabular-nums">
                        {decrease ? '' : formatQuantity(mv.quantityDelta)}
                      </td>
                      <td className="px-2.5 py-2 text-right font-medium whitespace-nowrap text-red-700 tabular-nums">
                        {decrease ? formatQuantity(mv.quantityDelta.slice(1)) : ''}
                      </td>
                      <td className="px-2.5 py-2 whitespace-nowrap text-slate-600">
                        {mv.createdByName}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
            <span aria-live="polite">
              Showing {m!.offset + 1}-{m!.offset + m!.movements.length} of {m!.total}
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
                disabled={m!.offset + m!.movements.length >= m!.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Dates are the day the stock event happened. The balance after each movement is not
            shown; stock on hand is the total above.
          </p>
        </>
      )}
      <p className="mt-4 text-sm">
        <Link
          to="/inventory"
          className="font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          All stock
        </Link>
      </p>
    </>
  );
}
