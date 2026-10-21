import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  LoadingState,
  PageHeader,
  SelectField,
  TextArea,
  TextInput,
} from '@commercebill/ui';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, getInvoice, recordPayment } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import { formatRupees, operationIdFor } from '../invoices/model.js';
import {
  METHOD_OPTIONS,
  STATUS_LABEL,
  STATUS_TONE,
  classifyPaymentFailure,
  emptyPaymentForm,
  toPaymentRequest,
  validateForm,
  type FieldErrors,
  type PaymentFailure,
  type PaymentForm,
} from './model.js';

/**
 * Records a payment against ONE posted invoice. The balance shown is the server's (grand total minus the persisted allocations);
 * the server re-checks it under a lock when the payment is recorded. One operation id belongs to one candidate payment, so a
 * double click or a retry after a lost answer cannot record it twice.
 */
export function RecordPaymentPage() {
  const { id } = useParams();
  const { authed, can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => authed((token) => getInvoice(token, id!)),
    retry: false,
    staleTime: 0,
  });
  const [form, setForm] = useState<PaymentForm>(emptyPaymentForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<PaymentFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const op = useRef({ key: '', id: '' });
  const amountRef = useRef<HTMLInputElement | null>(null);

  if (!can('sales.payment.record'))
    return (
      <>
        <PageHeader title="Record payment" />
        <Alert tone="warning">You do not have permission to record payments.</Alert>
      </>
    );
  if (q.isPending) return <LoadingState label="Loading invoice" />;
  if (q.isError)
    return (
      <div className="space-y-3">
        <Alert tone="error">
          {q.error instanceof ApiError && q.error.status === 404
            ? 'This invoice could not be found.'
            : describeFailure(q.error)}
        </Alert>
        <Button variant="secondary" onClick={() => navigate('/billing')}>
          Back to invoices
        </Button>
      </div>
    );
  const inv = q.data.invoice;
  const pay = inv.payment;
  const demo = inv.isDemo;
  const settled = pay.status === 'PAID';
  const set = (patch: Partial<PaymentForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors({});
    setFailure((f) => (f?.kind === 'uncertain' ? f : null));
  };
  const hint = METHOD_OPTIONS.find((o) => o.value === form.method)?.hint;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy.current || settled) return;
    const found = validateForm(inv.id, demo, form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      (document.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus();
      return;
    }
    busy.current = true; // a second click while the first is in flight does nothing
    setSaving(true);
    setFailure(null);
    const request = toPaymentRequest(inv.id, demo, form);
    op.current = operationIdFor(op.current, JSON.stringify(request));
    try {
      const res = await authed((token) =>
        recordPayment(token, { ...request, operationId: op.current.id }),
      );
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['invoice', id] });
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
      void queryClient.invalidateQueries({ queryKey: ['receivables'] });
      navigate(`/billing/${inv.id}`, {
        state: {
          notice: res.replayed
            ? `This payment had already been recorded as ${res.payment.paymentNumber}. No second payment was created.`
            : demo
              ? `Demo payment ${res.payment.paymentNumber} was recorded. It is not real money.`
              : `Payment ${res.payment.paymentNumber} of ${formatRupees(res.payment.amount)} was recorded.`,
        },
      });
    } catch (err) {
      const f = classifyPaymentFailure(err);
      setFailure(f);
      if (f.kind === 'rejected') void queryClient.invalidateQueries({ queryKey: ['invoice', id] }); // show the server's current balance
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Record payment"
        description={`Invoice ${inv.documentNumber} for ${inv.customer.name}`}
        actions={
          <Link
            to={`/billing/${inv.id}`}
            className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            Cancel
          </Link>
        }
      />
      {demo && (
        <div className="mb-4">
          <Alert tone="warning" title="DEMO PAYMENT">
            This invoice is a demo invoice, so this is a demo payment for testing. It is not a real
            receipt and does not represent any money received.
          </Alert>
        </div>
      )}
      <div className="grid max-w-3xl grid-cols-[1fr_16rem] items-start gap-4">
        <Card>
          <form onSubmit={(e) => void submit(e)} noValidate className="space-y-3">
            <TextInput
              ref={amountRef}
              label="Amount received (INR)"
              requirement="required"
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => set({ amount: e.target.value })}
              error={errors.amount}
              disabled={settled}
              autoFocus
            />
            <SelectField
              label="Payment method"
              requirement="required"
              value={form.method}
              onChange={(e) => set({ method: e.target.value as PaymentForm['method'] })}
              error={errors.method}
              hint={hint}
              disabled={settled}
            >
              {METHOD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </SelectField>
            <TextInput
              label="Reference"
              {...(['UPI', 'BANK_TRANSFER', 'CHEQUE'].includes(form.method)
                ? { requirement: 'required' as const }
                : { requirement: 'optional' as const })}
              value={form.reference}
              onChange={(e) => set({ reference: e.target.value })}
              error={errors.reference}
              maxLength={60}
              disabled={settled}
            />
            <TextArea
              label="Notes"
              requirement="optional"
              value={form.notes}
              onChange={(e) => set({ notes: e.target.value })}
              error={errors.notes}
              maxLength={500}
              rows={2}
              disabled={settled}
            />
            <p className="text-xs text-slate-500">
              The payment is dated today. Recorded payments cannot be edited or deleted.
            </p>
            {failure?.kind === 'rejected' && <Alert tone="error">{failure.message}</Alert>}
            {failure?.kind === 'uncertain' && (
              <Alert tone="warning" title="We could not confirm whether the payment was recorded">
                Do not enter it again as a new payment. Choose Retry: it safely reuses the same
                entry, so the payment is recorded once.
              </Alert>
            )}
            {settled && <Alert tone="info">This invoice is fully paid.</Alert>}
            <Button type="submit" loading={saving} disabled={settled}>
              {failure?.kind === 'uncertain'
                ? 'Retry'
                : demo
                  ? 'Record demo payment'
                  : 'Record payment'}
            </Button>
          </form>
        </Card>
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-slate-800">Invoice balance</h2>
          <dl className="space-y-1 text-sm" aria-label="Invoice balance">
            <div className="flex justify-between">
              <dt>Invoice total</dt>
              <dd className="tabular-nums">{formatRupees(pay.grandTotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>{demo ? 'Demo paid' : 'Already paid'}</dt>
              <dd className="tabular-nums">{formatRupees(pay.allocated)}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-300 pt-1 font-semibold">
              <dt>{demo ? 'Demo balance' : 'Balance due'}</dt>
              <dd className="tabular-nums">{formatRupees(pay.balanceDue)}</dd>
            </div>
          </dl>
          <div className="mt-2 flex gap-2">
            {demo && <Badge tone="warning">DEMO</Badge>}
            <Badge tone={STATUS_TONE[pay.status]}>{STATUS_LABEL[pay.status]}</Badge>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            The balance is worked out by the server and checked again when you record.
          </p>
        </Card>
      </div>
    </>
  );
}
