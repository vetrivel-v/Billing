import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, LoadingState, PageHeader } from '@commercebill/ui';
import { formatQuantity } from '@commercebill/inventory-engine/browser';
import { useLocation, useNavigate, useParams } from 'react-router';
import { ApiError, getInvoice } from '../api.js';
import { useAuth } from '../auth.js';
import { stateName } from '../customers/model.js';
import { describeFailure } from '../messages.js';
import { formatRate, formatRupees, problemText } from './model.js';
import { useDocumentActions } from './useDocumentActions.js';

const state = (code: string) => `${stateName(code) ?? code} (${code})`;

function Address({
  a,
}: {
  a: {
    addressLine1: string;
    addressLine2: string | null;
    city: string | null;
    stateCode: string;
    pinCode: string | null;
  };
}) {
  return (
    <p className="text-sm text-slate-800">
      {a.addressLine1}
      {a.addressLine2 ? `, ${a.addressLine2}` : ''}
      <br />
      {[a.city, a.pinCode].filter(Boolean).join(' ')} {state(a.stateCode)}
    </p>
  );
}

const th = 'px-2.5 py-2';

/** A posted invoice, exactly as it was posted (an immutable snapshot). There is nothing to edit here, by design. */
export function InvoiceDetailPage() {
  const { id } = useParams();
  const { authed } = useAuth();
  const navigate = useNavigate();
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  const q = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => authed((token) => getInvoice(token, id!)),
    retry: false,
    staleTime: Infinity,
  });
  const docs = useDocumentActions(q.data?.invoice);
  if (q.isPending) return <LoadingState label="Loading invoice" />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-3">
        <Alert tone="error">
          {notFound ? 'This invoice could not be found.' : describeFailure(q.error)}
        </Alert>
        <Button variant="secondary" onClick={() => navigate('/billing')}>
          Back to invoices
        </Button>
      </div>
    );
  }
  const inv = q.data.invoice;
  const t = inv.totals;
  const taxColumns = inv.tax.calculation && (inv.tax.calculation as { supply?: string }).supply;
  return (
    <>
      <PageHeader
        title={`Invoice ${inv.documentNumber}`}
        description={`Posted ${new Date(inv.createdAt).toLocaleString()} by ${inv.createdByName}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate(`/billing/${inv.id}/print`)}>
              Preview / Print
            </Button>
            <Button
              variant="secondary"
              loading={docs.busy === 'save'}
              disabled={!docs.available || docs.busy !== null}
              title={docs.available ? undefined : docs.unavailableReason}
              onClick={() => void docs.save()}
            >
              Save PDF
            </Button>
            <Button variant="secondary" onClick={() => navigate('/billing')}>
              Back to invoices
            </Button>
          </>
        }
      />
      {docs.message && (
        <div className="mb-4">
          <Alert tone={docs.message.tone}>{docs.message.text}</Alert>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      {inv.isDemo && (
        <div className="mb-4">
          <Alert tone="warning" title="DEMO INVOICE">
            This is a demo invoice for testing. It is not a tax invoice, it did not change your
            stock, and it has no amount receivable.
          </Alert>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {inv.isDemo ? <Badge tone="warning">DEMO</Badge> : <Badge tone="brand">Production</Badge>}
        <Badge tone="success">Posted</Badge>
        <span className="text-sm text-slate-600">
          Date {inv.invoiceDate} &middot; Financial year {inv.financialYearLabel}
        </span>
        <span className="text-sm text-slate-500">Posted invoices cannot be edited.</span>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-4">
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-slate-700">Seller</h2>
          <p className="text-sm font-medium text-slate-900">{inv.seller.legalName}</p>
          <p className="text-xs text-slate-600">GSTIN {inv.seller.gstin}</p>
          <Address a={inv.seller} />
        </Card>
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-slate-700">Customer</h2>
          <p className="text-sm font-medium text-slate-900">
            {inv.customer.name}{' '}
            <span className="font-normal text-slate-500">({inv.customer.code})</span>
          </p>
          <p className="text-xs text-slate-600">
            {inv.customer.gstin ? `GSTIN ${inv.customer.gstin}` : 'Not GST registered'} &middot;{' '}
            {inv.customer.recipientClass}
          </p>
          <p className="mt-1 text-xs font-semibold text-slate-600">Billing</p>
          <Address a={inv.customer.billing} />
          <p className="mt-1 text-xs font-semibold text-slate-600">Shipping</p>
          <Address a={inv.customer.shipping} />
        </Card>
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-slate-700">Place of supply</h2>
          <p className="text-sm font-medium text-slate-900">{state(inv.placeOfSupply.stateCode)}</p>
          <p className="text-xs text-slate-600">
            {inv.placeOfSupply.source === 'USER_OVERRIDE' ? 'Chosen by' : 'Confirmed by'}{' '}
            {inv.placeOfSupply.confirmedByName} on{' '}
            {new Date(inv.placeOfSupply.confirmedAt).toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-600">
            {taxColumns === 'INTER'
              ? 'Inter-state supply (IGST)'
              : 'Intra-state supply (CGST + SGST/UTGST)'}
          </p>
        </Card>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Invoice lines</caption>
          <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
            <tr>
              <th className={th}>#</th>
              <th className={th}>Item</th>
              <th className={`${th} text-right`}>Qty</th>
              <th className={`${th} text-right`}>Rate</th>
              <th className={`${th} text-right`}>Discount</th>
              <th className={`${th} text-right`}>Taxable</th>
              <th className={`${th} text-right`}>GST</th>
              <th className={`${th} text-right`}>Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {inv.lines.map((l) => {
              const parts = [
                l.cgstRate ? `CGST ${formatRate(l.cgstRate)} ${formatRupees(l.cgstAmount)}` : null,
                l.sgstRate ? `SGST ${formatRate(l.sgstRate)} ${formatRupees(l.sgstAmount)}` : null,
                l.utgstRate
                  ? `UTGST ${formatRate(l.utgstRate)} ${formatRupees(l.utgstAmount)}`
                  : null,
                l.igstRate ? `IGST ${formatRate(l.igstRate)} ${formatRupees(l.igstAmount)}` : null,
              ].filter(Boolean);
              return (
                <tr key={l.id}>
                  <td className={th}>{l.lineNo}</td>
                  <td className={th}>
                    <div className="font-medium text-slate-900">{l.productName}</div>
                    <div className="text-xs text-slate-500">
                      {l.sku}
                      {l.hsnSacCode ? ` · ${l.hsnSacKind} ${l.hsnSacCode}` : ''} &middot;{' '}
                      {l.taxCategoryName}
                    </div>
                  </td>
                  <td className={`${th} text-right whitespace-nowrap tabular-nums`}>
                    {formatQuantity(l.quantity)} {l.unitCode}
                  </td>
                  <td className={`${th} text-right whitespace-nowrap tabular-nums`}>
                    {formatRupees(l.unitPrice)}
                    {l.priceBasis === 'INCLUSIVE' && (
                      <div className="text-xs text-slate-500">incl. GST</div>
                    )}
                  </td>
                  <td className={`${th} text-right whitespace-nowrap tabular-nums`}>
                    {l.discountType === 'NONE'
                      ? '-'
                      : l.discountType === 'PERCENT'
                        ? `${formatRate(l.discountPercent)} (${formatRupees(l.discountAmount)})`
                        : formatRupees(l.discountAmount)}
                  </td>
                  <td className={`${th} text-right whitespace-nowrap tabular-nums`}>
                    {formatRupees(l.taxableValue)}
                  </td>
                  <td className={`${th} text-right text-xs tabular-nums`}>
                    {parts.length === 0
                      ? l.classification === 'STANDARD'
                        ? '-'
                        : l.classification.replace('_', ' ').toLowerCase()
                      : parts.map((p) => <div key={p as string}>{p}</div>)}
                  </td>
                  <td className={`${th} text-right font-medium whitespace-nowrap tabular-nums`}>
                    {formatRupees(l.lineTotal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex justify-end">
        <dl className="w-80 space-y-1 text-sm">
          {(
            [
              ['Gross amount', t.grossSubtotal],
              ['Line discounts', t.lineDiscountTotal],
              ['Taxable value', t.taxableSubtotal],
              ['CGST', t.cgst],
              ['SGST', t.sgst],
              ['UTGST', t.utgst],
              ['IGST', t.igst],
              ['Rounding adjustment', t.roundingAdjustmentTotal],
              ['Round off', t.roundOff],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="flex justify-between text-slate-700">
              <dt>{label}</dt>
              <dd className="tabular-nums">{formatRupees(v)}</dd>
            </div>
          ))}
          <div className="flex justify-between border-t border-slate-300 pt-1 text-base font-semibold text-slate-900">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatRupees(t.grandTotal)}</dd>
          </div>
        </dl>
      </div>
      {inv.tax.calculation &&
        Array.isArray((inv.tax.calculation as { warnings?: unknown }).warnings) &&
        ((inv.tax.calculation as { warnings: { code: string }[] }).warnings.length > 0 ? (
          <div className="mt-4">
            <Alert tone="info" title="Notes on the tax calculation">
              {(inv.tax.calculation as { warnings: { code: string }[] }).warnings
                .map((w) => problemText(w.code))
                .join(' ')}
            </Alert>
          </div>
        ) : null)}
    </>
  );
}
