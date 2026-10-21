import { useQuery } from '@tanstack/react-query';
import type { InvoiceView } from '@commercebill/shared-types';
import { Alert, Badge, Button, Card } from '@commercebill/ui';
import { useNavigate } from 'react-router';
import { listPayments } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import { formatRupees } from '../invoices/model.js';
import { STATUS_LABEL, STATUS_TONE, methodLabel } from './model.js';

/**
 * Paid and balance of a posted invoice (derived by the server from the persisted allocations), its payment history and the
 * Record payment action. For a DEMO invoice every figure is a demo figure: it is not money received.
 */
export function PaymentSection({ invoice }: { invoice: InvoiceView }) {
  const { authed, can } = useAuth();
  const navigate = useNavigate();
  const canRead = can('sales.payment.read');
  const canRecord = can('sales.payment.record');
  const p = invoice.payment;
  const demo = invoice.isDemo;
  const history = useQuery({
    queryKey: ['payments', 'invoice', invoice.id],
    queryFn: () =>
      authed((token) => listPayments(token, { invoiceId: invoice.id, limit: 100, offset: 0 })),
    enabled: canRead,
    retry: false,
  });
  return (
    <div className="mt-6" data-testid="payment-section">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">
              {demo ? 'Demo payments (not real money)' : 'Payments'}
            </h2>
            <dl
              className="mt-2 grid grid-cols-[auto_auto] gap-x-8 gap-y-1 text-sm"
              aria-label="Payment summary"
            >
              <dt>Grand total</dt>
              <dd className="text-right tabular-nums">{formatRupees(p.grandTotal)}</dd>
              <dt>{demo ? 'Demo paid' : 'Paid'}</dt>
              <dd className="text-right tabular-nums">{formatRupees(p.allocated)}</dd>
              <dt className="font-semibold">{demo ? 'Demo balance' : 'Balance due'}</dt>
              <dd className="text-right font-semibold tabular-nums">
                {formatRupees(p.balanceDue)}
              </dd>
            </dl>
            <div className="mt-2 flex gap-2">
              {demo && <Badge tone="warning">DEMO</Badge>}
              <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
            </div>
          </div>
          {canRecord && p.status !== 'PAID' && (
            <Button onClick={() => navigate(`/billing/${invoice.id}/payment`)}>
              {demo ? 'Record demo payment' : 'Record payment'}
            </Button>
          )}
        </div>
        {demo && (
          <p className="mt-3 text-xs text-amber-800">
            These are demo figures for testing. A demo payment is not a real receipt and does not
            represent money received.
          </p>
        )}
        {canRead && (
          <div className="mt-4">
            {history.isError ? (
              <Alert tone="error">{describeFailure(history.error)}</Alert>
            ) : history.data && history.data.payments.length > 0 ? (
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Payments for this invoice</caption>
                <thead className="border-b border-slate-200 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                  <tr>
                    <th scope="col" className="px-2 py-1.5">
                      Date
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      Payment
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      Method
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      Reference
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {history.data.payments.map((x) => (
                    <tr key={x.id}>
                      <td className="px-2 py-1.5 whitespace-nowrap">{x.paymentDate}</td>
                      <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">
                        {x.paymentNumber} {x.isDemo && <Badge tone="warning">DEMO</Badge>}
                      </td>
                      <td className="px-2 py-1.5">{methodLabel(x.method)}</td>
                      <td className="px-2 py-1.5">{x.reference ?? '-'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {formatRupees(x.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : history.data ? (
              <p className="text-sm text-slate-500">No payments recorded yet.</p>
            ) : null}
            <p className="mt-2 text-xs text-slate-500">
              Recorded payments cannot be edited or deleted. Correcting a payment is not supported
              yet.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
