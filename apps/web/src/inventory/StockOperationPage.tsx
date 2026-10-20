import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addQuantities,
  compareQuantities,
  formatQuantity,
  parseQuantity,
} from '@commercebill/inventory-engine/browser';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  LoadingState,
  PageHeader,
  RadioGroup,
  SelectField,
  TextArea,
  TextInput,
} from '@commercebill/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError, listStock, postStockOperation, type StockOperation } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import {
  OPERATION_TITLE,
  REASON_LABEL,
  describeErrors,
  emptyStockForm,
  errorsFromProblems,
  localToday,
  newOperationId,
  ruleText,
  toApiBody,
  validateForm,
  type FieldErrors,
  type StockForm,
} from './model.js';

const OPERATIONS: readonly StockOperation[] = ['opening', 'receive', 'adjust'];
const DESCRIPTION: Record<StockOperation, string> = {
  opening:
    'The quantity you already hold when you start using CommerceBill. It can be recorded once; after that use a stock adjustment.',
  receive:
    'Records stock that physically arrived. This is not a purchase: no supplier, bill or payment is created.',
  adjust:
    'Corrects the quantity on hand, for example after a stock count. A reason is required, and the change cannot be edited later.',
};
const SUCCESS: Record<StockOperation, string> = {
  opening: 'Opening stock was recorded',
  receive: 'Stock receipt was recorded',
  adjust: 'Stock adjustment was recorded',
};

/** Opening stock, manual receipt and adjustment: one form, three operations. The server alone decides the resulting stock. */
export function StockOperationPage() {
  const params = useParams();
  const productId = params.productId!;
  const operation = params.action as StockOperation;
  const valid = OPERATIONS.includes(operation);
  const { authed, can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = can('inventory.adjustment.create');

  const [form, setForm] = useState<StockForm>(() => emptyStockForm());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [summary, setSummary] = useState<{ title: string; items: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const focusProblem = useRef(false);
  // One identity per logical entry: pressing Save again with unchanged content (for example after a lost answer)
  // reuses it, so the server records the change once. Any edit starts a new entry.
  const operationId = useRef(newOperationId());

  const stock = useQuery({
    queryKey: ['stock-product', productId],
    queryFn: () => authed((t) => listStock(t, { productId, limit: 1, offset: 0 })),
    enabled: valid && canWrite,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!focusProblem.current) return;
    focusProblem.current = false;
    document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [summary]);

  const set = (patch: Partial<StockForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors({});
    operationId.current = newOperationId();
  };

  const back = () => navigate(`/inventory/${productId}`);
  const list = () => navigate('/inventory');

  if (!valid) {
    return (
      <EmptyState
        title="Page not found"
        action={
          <Button variant="secondary" onClick={list}>
            Back to inventory
          </Button>
        }
      >
        There is no such stock action.
      </EmptyState>
    );
  }
  if (!canWrite) {
    return (
      <>
        <PageHeader title={OPERATION_TITLE[operation]} />
        <EmptyState
          title="You do not have access to change stock"
          action={
            <Button variant="secondary" onClick={list}>
              Back to inventory
            </Button>
          }
        >
          Ask your administrator if you need it.
        </EmptyState>
      </>
    );
  }
  if (stock.isPending) return <LoadingState label="Loading product" />;
  const row = stock.data?.stock[0];
  const warehouse = stock.data?.warehouse;
  if (stock.isError || !row || !warehouse) {
    const missing =
      !stock.isError || (stock.error instanceof ApiError && stock.error.status === 404);
    return (
      <>
        <PageHeader title={OPERATION_TITLE[operation]} />
        <EmptyState
          title={missing ? 'This product cannot hold stock' : 'The product could not be loaded'}
          action={
            <Button variant="secondary" onClick={list}>
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
  if (operation === 'opening' && row.hasMovements) {
    return (
      <>
        <PageHeader title={OPERATION_TITLE[operation]} description={row.name} />
        <Alert tone="info" title="Opening stock has already been recorded">
          <p>
            This product already has stock history. Use a stock adjustment to correct the quantity.
          </p>
          <div className="mt-2 flex gap-2">
            <Button onClick={() => navigate(`/inventory/${productId}/adjust`)}>Adjust stock</Button>
            <Button variant="secondary" onClick={back}>
              Back
            </Button>
          </div>
        </Alert>
      </>
    );
  }

  const places = row.unit.decimalPlaces;
  const qty = parseQuantity(form.quantity.trim(), places);
  const decreasing = operation === 'adjust' && form.direction === 'DECREASE';
  // Preview only. The server recomputes the result and is the only authority on stock.
  const result = qty.ok
    ? addQuantities(row.onHand, decreasing ? `-${qty.value}` : qty.value)
    : null;
  const wouldGoNegative = result !== null && compareQuantities(result, '0') < 0;

  const text = (key: 'quantity' | 'businessDate' | 'reference' | 'note') => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) =>
      set({ [key]: e.target.value } as Partial<StockForm>),
    disabled: saving,
    error: errors[key],
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saveLock.current) return;
    const local = validateForm(operation, form, places);
    if (Object.keys(local).length > 0) {
      setErrors(local);
      setSummary({ title: 'Please fix the following before saving', items: describeErrors(local) });
      focusProblem.current = true;
      return;
    }
    setSummary(null);
    saveLock.current = true;
    setSaving(true);
    let left = false;
    try {
      const body = toApiBody(operation, form, {
        operationId: operationId.current,
        productId,
        warehouseId: warehouse!.id,
      });
      const res = await authed((t) => postStockOperation(t, operation, body));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['stock'] }),
        queryClient.invalidateQueries({ queryKey: ['stock-product'] }),
        queryClient.invalidateQueries({ queryKey: ['stock-movements'] }),
      ]);
      navigate(`/inventory/${productId}`, {
        state: {
          notice: `${SUCCESS[operation]} for ${row!.name}. Stock on hand is now ${formatQuantity(res.onHand)} ${row!.unit.code}.${res.replayed ? ' (This entry had already been saved; nothing was added twice.)' : ''}`,
        },
      });
      left = true; // the page is going away: keep the form locked so no second submit can slip in
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.problems.length > 0 &&
        (err.status === 400 || err.status === 409)
      ) {
        const fe = errorsFromProblems(err.problems);
        // Field-level text where a field exists; the rest goes in the summary.
        const shown: FieldErrors = {};
        for (const [k, v] of Object.entries(fe)) if (k in form) shown[k] = v;
        setErrors(shown);
        if (fe.quantity && err.problems.some((p) => p.rule === 'insufficient_stock')) {
          shown.quantity = `${ruleText('insufficient_stock')} Stock on hand is ${formatQuantity(row!.onHand)} ${row!.unit.code}.`;
          setErrors({ ...shown });
        }
        setSummary({
          title:
            err.status === 409
              ? 'Nothing was recorded'
              : 'The server could not accept some details',
          items: ((rest) =>
            rest.length === 0 && err.status === 409
              ? ['No stock was changed. Check the details and try again.']
              : rest)(describeErrors(fe).filter((m) => !m.startsWith('Quantity:'))),
        });
        focusProblem.current = true;
      } else if (!(err instanceof ApiError && err.status === 401)) {
        setSummary({ title: describeFailure(err), items: [] });
      }
    } finally {
      if (!left) {
        saveLock.current = false;
        setSaving(false);
      }
    }
  }

  return (
    <>
      <PageHeader title={OPERATION_TITLE[operation]} description={DESCRIPTION[operation]} />
      {summary && (
        <div className="mb-4">
          <Alert tone="error" title={summary.title}>
            {summary.items.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {summary.items.map((m, i) => (
                  <li key={`${i}-${m}`}>{m}</li>
                ))}
              </ul>
            )}
          </Alert>
        </div>
      )}
      <form
        onSubmit={onSubmit}
        noValidate
        className="max-w-2xl space-y-4"
        aria-label={OPERATION_TITLE[operation]}
      >
        <Card title="Product">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-slate-500">Product</dt>
            <dd className="font-medium break-words text-slate-900">{row.name}</dd>
            <dt className="text-slate-500">SKU</dt>
            <dd className="font-mono text-xs">{row.sku}</dd>
            <dt className="text-slate-500">Warehouse</dt>
            <dd>{warehouse.name}</dd>
            <dt className="text-slate-500">Stock on hand</dt>
            <dd className="tabular-nums">
              <span className="font-medium text-slate-900">{formatQuantity(row.onHand)}</span>{' '}
              {row.unit.code}
            </dd>
          </dl>
        </Card>

        <Card title="Details">
          <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
            {operation === 'adjust' && (
              <div className="md:col-span-2">
                <RadioGroup
                  legend="Change"
                  name="direction"
                  layout="row"
                  value={form.direction}
                  onChange={(v) => set({ direction: v as StockForm['direction'] })}
                  options={[
                    {
                      value: 'INCREASE',
                      label: 'Increase stock',
                      description: 'Add to the quantity on hand.',
                    },
                    {
                      value: 'DECREASE',
                      label: 'Decrease stock',
                      description: 'Remove from the quantity on hand.',
                    },
                  ]}
                />
              </div>
            )}
            <TextInput
              label={`Quantity (${row.unit.code})`}
              requirement="required"
              name="quantity"
              inputMode="decimal"
              autoFocus
              autoComplete="off"
              hint={
                places === 0
                  ? 'Whole numbers only for this unit.'
                  : `Up to ${places} decimal place${places === 1 ? '' : 's'} for this unit.`
              }
              {...text('quantity')}
              className="text-right tabular-nums"
            />
            <TextInput
              label="Date"
              requirement="required"
              name="businessDate"
              type="date"
              max={localToday()}
              hint="The day the stock event happened."
              {...text('businessDate')}
            />
            {operation === 'adjust' && (
              <div className="md:col-span-2">
                <SelectField
                  label="Reason"
                  requirement="required"
                  name="reasonCode"
                  value={form.reasonCode}
                  disabled={saving}
                  error={errors.reasonCode}
                  onChange={(e) => set({ reasonCode: e.target.value as StockForm['reasonCode'] })}
                >
                  <option value="">Choose a reason…</option>
                  {(Object.keys(REASON_LABEL) as (keyof typeof REASON_LABEL)[]).map((k) => (
                    <option key={k} value={k}>
                      {REASON_LABEL[k]}
                    </option>
                  ))}
                </SelectField>
              </div>
            )}
            {
              <div className="md:col-span-2">
                <TextInput
                  label="Reference"
                  requirement="optional"
                  name="reference"
                  hint={
                    operation === 'receive'
                      ? 'For example a delivery challan or packing slip number.'
                      : 'For example a count sheet number.'
                  }
                  maxLength={60}
                  autoComplete="off"
                  {...text('reference')}
                />
              </div>
            }
            <div className="md:col-span-2">
              <TextArea
                label="Note"
                requirement={
                  operation === 'adjust' && form.reasonCode === 'OTHER' ? 'required' : 'optional'
                }
                name="note"
                maxLength={500}
                {...text('note')}
              />
            </div>
          </div>
        </Card>

        {operation === 'adjust' && (
          <Card title="Result">
            <dl
              className="grid max-w-sm grid-cols-[1fr_auto] gap-y-1 text-sm tabular-nums"
              aria-live="polite"
            >
              <dt className="text-slate-600">Current stock</dt>
              <dd className="text-right">
                {formatQuantity(row.onHand)} {row.unit.code}
              </dd>
              <dt className="text-slate-600">Adjustment</dt>
              <dd className="text-right">
                {qty.ok
                  ? `${decreasing ? '-' : '+'}${formatQuantity(qty.value)} ${row.unit.code}`
                  : '-'}
              </dd>
              <dt className="border-t border-slate-200 pt-1 font-medium text-slate-900">
                Resulting stock
              </dt>
              <dd className="border-t border-slate-200 pt-1 text-right font-medium text-slate-900">
                {result === null ? '-' : `${formatQuantity(result)} ${row.unit.code}`}
              </dd>
            </dl>
            {wouldGoNegative ? (
              <p className="mt-2 text-sm font-medium text-red-700">
                This would take stock below zero, which is not allowed. Saving will be refused.
              </p>
            ) : (
              <p className="mt-2 text-xs text-slate-500">
                This is a preview. The final result is calculated and checked when you save.
              </p>
            )}
          </Card>
        )}

        <div className="flex items-center gap-3 border-t border-slate-200 pt-3">
          <Button type="submit" loading={saving}>
            {saving
              ? 'Saving'
              : operation === 'receive'
                ? 'Record receipt'
                : operation === 'opening'
                  ? 'Record opening stock'
                  : 'Record adjustment'}
          </Button>
          <Button variant="secondary" onClick={back} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    </>
  );
}
