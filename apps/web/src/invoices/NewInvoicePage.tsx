import { useQueryClient } from '@tanstack/react-query';
import { formatQuantity } from '@commercebill/inventory-engine/browser';
import type { CustomerView, InvoicePreviewResponse, ProductView } from '@commercebill/shared-types';
import { Alert, Badge, Button, Card, PageHeader, SelectField } from '@commercebill/ui';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, listCustomers, listProducts, postInvoice, previewInvoice } from '../api.js';
import { useAuth } from '../auth.js';
import { STATE_OPTIONS, stateName } from '../customers/model.js';
import { describeFailure } from '../messages.js';
import {
  asCalc,
  classifyPostFailure,
  customerContextState,
  describeProblems,
  formatRate,
  formatRupees,
  operationIdFor,
  problemText,
  toRequest,
  unsupportedReason,
  validateLine,
  type DiscountKind,
  type LineDraft,
  type LineErrors,
  type PlaceOfSupplyChoice,
  type PostFailure,
} from './model.js';
import { SearchPicker } from './SearchPicker.js';

const cell = 'px-2 py-1.5 align-top';
const smallInput =
  'h-9 rounded-md border bg-white px-2 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-600';
const stateLabel = (code: string) => `${stateName(code) ?? code} (${code})`;
let lineSeq = 0;

/**
 * Composes a demo invoice. The browser keeps only CHOICES (customer, products, quantities, discounts, place of supply). Prices,
 * rates, tax and totals are always the server's preview; any edit makes the preview stale and disables posting until the
 * invoice is previewed again.
 */
export function NewInvoicePage() {
  const { authed, can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canCompose = can('sales.invoice.write');
  const canPost = can('sales.invoice.post');

  const [customer, setCustomer] = useState<CustomerView | null>(null);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [pos, setPos] = useState<PlaceOfSupplyChoice | null>(null);
  const [otherState, setOtherState] = useState('');
  const [explicitPick, setExplicitPick] = useState('');
  const [preview, setPreview] = useState<{ key: string; data: InvoicePreviewResponse } | null>(
    null,
  );
  const [previewing, setPreviewing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [lineErrors, setLineErrors] = useState<Record<string, LineErrors>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [failure, setFailure] = useState<PostFailure | null>(null);
  const [staleReview, setStaleReview] = useState(false);
  const postingRef = useRef(false);
  const opRef = useRef({ key: '', id: '' });
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const productInput = useRef<HTMLInputElement | null>(null);

  const request = customer ? toRequest(customer, lines, pos) : null;
  const requestKey = request ? JSON.stringify(request) : '';
  const fresh = preview !== null && preview.key === requestKey ? preview.data : null;
  const outOfDate = preview !== null && !fresh;
  const calc = asCalc(fresh);
  const ctx = customer ? customerContextState(customer) : null;
  const suggested =
    fresh?.placeOfSupply.suggestedStateCode ??
    preview?.data.placeOfSupply.suggestedStateCode ??
    customer?.placeOfSupplyStateCode ??
    null;
  const mustChoose =
    Boolean(ctx && ctx.billing !== ctx.shipping) ||
    Boolean(fresh?.placeOfSupply.requiresExplicitChoice);

  const clearOutcome = () => {
    setFailure(null);
    setStaleReview(false);
    setFormError(null);
  };

  const chooseCustomer = (c: CustomerView) => {
    setCustomer(c);
    setPos(null);
    setPreview(null);
    setProblems([]);
    setExplicitPick('');
    clearOutcome();
  };

  const addProduct = (p: ProductView) => {
    const existing = lines.find((l) => l.product.id === p.id);
    if (existing) {
      qtyRefs.current[existing.key]?.focus();
      return;
    }
    const key = `l${++lineSeq}`;
    setLines((ls) => [
      ...ls,
      { key, product: p, quantity: '1', discountKind: 'NONE', discountValue: '' },
    ]);
    clearOutcome();
    setTimeout(() => qtyRefs.current[key]?.select(), 0);
  };

  const editLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setLineErrors((e) => ({ ...e, [key]: {} }));
    clearOutcome();
  };
  const removeLine = (key: string) => {
    setLines((ls) => ls.filter((l) => l.key !== key));
    clearOutcome();
    productInput.current?.focus();
  };

  const lineName = (ref: string | undefined) => {
    const n = ref ? Number(ref.replace(/^L/, '')) : NaN;
    const l = Number.isInteger(n) ? lines[n - 1] : undefined;
    return l ? `${l.product.name} (${l.product.sku})` : null;
  };

  async function runPreview() {
    if (!customer || !request) return;
    setFormError(null);
    setProblems([]);
    const errs: Record<string, LineErrors> = {};
    for (const l of lines) {
      const e = validateLine(l);
      if (e.quantity || e.discount) errs[l.key] = e;
    }
    setLineErrors(errs);
    const firstBad = lines.find((l) => errs[l.key]);
    if (lines.length === 0) {
      setFormError('Add at least one item before previewing.');
      productInput.current?.focus();
      return;
    }
    if (firstBad) {
      setFormError('Fix the highlighted items, then preview again.');
      qtyRefs.current[firstBad.key]?.focus();
      return;
    }
    setPreviewing(true);
    clearOutcome();
    const key = requestKey;
    try {
      const data = await authed((token) => previewInvoice(token, request));
      setPreview({ key, data });
      const msgs = data.errors.map((e) => {
        const who = lineName(e.lineRef);
        return who ? `${who}: ${problemText(e.code)}` : problemText(e.code);
      });
      setProblems([...new Set(msgs)]);
    } catch (err) {
      setPreview(null);
      if (err instanceof ApiError && err.status === 400)
        setFormError('Some details are not valid. Check the customer, items and place of supply.');
      else setFormError(describeFailure(err));
    } finally {
      setPreviewing(false);
    }
  }

  async function post() {
    if (!fresh || !pos || !request || postingRef.current) return;
    postingRef.current = true; // a second click while the first is in flight does nothing
    setPosting(true);
    setFailure(null);
    opRef.current = operationIdFor(opRef.current, requestKey);
    try {
      const res = await authed((token) =>
        postInvoice(token, {
          ...request,
          placeOfSupply: pos,
          operationId: opRef.current.id,
          calculation: fresh.identity,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      navigate(`/billing/${res.invoice.id}`, {
        state: {
          notice: res.replayed
            ? `This demo invoice had already been posted as ${res.invoice.documentNumber}. No second invoice was created.`
            : `Demo invoice ${res.invoice.documentNumber} was posted. Your stock was not changed.`,
        },
      });
    } catch (err) {
      const f = classifyPostFailure(err);
      setFailure(f);
      if (f.kind === 'stale') {
        setStaleReview(true);
        if (f.recalculation) setPreview({ key: requestKey, data: f.recalculation });
        else setPreview(null);
      }
    } finally {
      postingRef.current = false;
      setPosting(false);
    }
  }

  if (!canCompose)
    return (
      <>
        <PageHeader title="New invoice" />
        <Alert tone="warning">You do not have permission to create invoices.</Alert>
        <p className="mt-3">
          <Link to="/billing" className="text-sm font-medium text-brand-700 hover:underline">
            Back to invoices
          </Link>
        </p>
      </>
    );

  const postable = Boolean(fresh && fresh.ok && fresh.postable && pos);
  const uncertain = failure?.kind === 'uncertain';
  const totals = calc?.totals;
  const dim = outOfDate ? 'opacity-50' : '';

  return (
    <>
      <PageHeader
        title="New invoice"
        description="Choose a customer, add items, confirm the place of supply, preview the GST, then post."
        actions={
          <Link
            to="/billing"
            className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            Cancel
          </Link>
        }
      />
      <div className="mb-4">
        <Alert tone="warning" title="DEMO MODE">
          Invoices created here are for testing and are not production invoices. They do not change
          your stock. Real billing is switched on separately, from the Tax page, once its checklist
          is met.
        </Alert>
      </div>

      <div className="mb-4 grid grid-cols-[1fr_16rem] items-start gap-4">
        <Card>
          <SearchPicker<CustomerView>
            label="Customer"
            placeholder="Search by name, code, phone or GSTIN"
            queryKey="bill-customers"
            load={async (term) =>
              (
                await authed((t) =>
                  listCustomers(t, { search: term, isActive: true, limit: 8, offset: 0 }),
                )
              ).customers
            }
            itemKey={(c) => c.id}
            renderItem={(c) => (
              <span>
                <span className="font-medium">{c.displayName ?? c.legalName}</span>{' '}
                <span className="text-xs text-slate-500">
                  {c.code} &middot; {c.gstin ?? 'No GSTIN'} &middot;{' '}
                  {stateName(c.billingStateCode) ?? c.billingStateCode}
                </span>
              </span>
            )}
            onPick={chooseCustomer}
          />
          {customer && ctx && (
            <div className="mt-3 text-sm text-slate-700" data-testid="customer-context">
              <p>
                <span className="font-medium text-slate-900">
                  {customer.displayName ?? customer.legalName}
                </span>{' '}
                <span className="text-slate-500">({customer.code})</span>
              </p>
              <p className="text-xs text-slate-600">
                {customer.gstStatus === 'UNREGISTERED'
                  ? 'Not GST registered'
                  : `${customer.gstStatus.toLowerCase()} · GSTIN ${customer.gstin ?? ''}`}
              </p>
              <p className="text-xs text-slate-600">
                Billing: {stateLabel(ctx.billing)}
                {ctx.shipping !== ctx.billing && (
                  <> &middot; Shipping: {stateLabel(ctx.shipping)}</>
                )}
              </p>
            </div>
          )}
        </Card>
        <Card>
          <p className="text-sm font-medium text-slate-700">Invoice date</p>
          <p className="text-sm text-slate-900">Today</p>
          <p className="text-xs text-slate-500">Set automatically. Invoices cannot be backdated.</p>
          <div className="mt-2">
            <Badge tone="warning">DEMO</Badge>
          </div>
        </Card>
      </div>

      {customer && (
        <div className="mb-4">
          <Card>
            <h2 className="text-sm font-semibold text-slate-800">Place of supply</h2>
            <p className="mb-2 text-xs text-slate-600">
              Confirm the place of supply for this transaction. CommerceBill only suggests it; you
              decide.
            </p>
            {pos ? (
              <div className="flex items-center gap-3" data-testid="pos-confirmed">
                <Badge tone="success">Confirmed</Badge>
                <span className="text-sm font-medium text-slate-900">
                  {stateLabel(pos.stateCode)}
                </span>
                <Button variant="ghost" onClick={() => setPos(null)}>
                  Change place of supply
                </Button>
              </div>
            ) : mustChoose && ctx ? (
              <fieldset className="space-y-2">
                <legend className="text-sm text-slate-700">
                  Billing: {stateLabel(ctx.billing)}. Shipping: {stateLabel(ctx.shipping)}. Select
                  the place of supply:
                </legend>
                {[ctx.billing, ctx.shipping].map((code, i) => (
                  <label key={`${code}-${i}`} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="pos"
                      checked={explicitPick === code}
                      onChange={() => setExplicitPick(code)}
                    />
                    {i === 0 ? 'Billing state' : 'Shipping state'}: {stateLabel(code)}
                  </label>
                ))}
                <div className="flex items-end gap-2">
                  <SelectField
                    label="Another state"
                    value={otherState}
                    onChange={(e) => {
                      setOtherState(e.target.value);
                      setExplicitPick(e.target.value);
                    }}
                  >
                    <option value="">Other supported state&hellip;</option>
                    {STATE_OPTIONS.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name} ({s.code})
                      </option>
                    ))}
                  </SelectField>
                  <Button
                    disabled={!explicitPick}
                    onClick={() => setPos({ stateCode: explicitPick, choice: 'OVERRIDE' })}
                  >
                    Use selected place of supply
                  </Button>
                </div>
              </fieldset>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <p className="text-sm text-slate-800">
                  Suggested place of supply:{' '}
                  <span className="font-medium">{suggested ? stateLabel(suggested) : '-'}</span>
                </p>
                {suggested && (
                  <Button onClick={() => setPos({ stateCode: suggested, choice: 'CONFIRMED' })}>
                    Confirm {stateName(suggested) ?? suggested}
                  </Button>
                )}
                <SelectField
                  label="Or choose a different state"
                  value={otherState}
                  onChange={(e) => setOtherState(e.target.value)}
                >
                  <option value="">Choose a state&hellip;</option>
                  {STATE_OPTIONS.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </SelectField>
                <Button
                  variant="secondary"
                  disabled={!otherState}
                  onClick={() =>
                    setPos({
                      stateCode: otherState,
                      choice: otherState === suggested ? 'CONFIRMED' : 'OVERRIDE',
                    })
                  }
                >
                  Use this state
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}

      <Card>
        <div className="mb-3 max-w-xl">
          <SearchPicker<ProductView>
            label="Add item"
            placeholder="Search by SKU, name or barcode, then press Enter"
            queryKey="bill-products"
            load={async (term) =>
              (
                await authed((t) =>
                  listProducts(t, { search: term, isActive: true, limit: 8, offset: 0 }),
                )
              ).products
            }
            itemKey={(p) => p.id}
            renderItem={(p) => (
              <span>
                <span className="font-mono text-xs">{p.sku}</span>{' '}
                <span className="font-medium">{p.name}</span>{' '}
                <span className="text-xs text-slate-500">{formatRupees(p.sellingPrice)}</span>
              </span>
            )}
            blockedReason={unsupportedReason}
            onPick={addProduct}
            inputRef={(el) => (productInput.current = el)}
            clearOnPick
            disabled={!customer}
          />
          {!customer && <p className="mt-1 text-xs text-slate-500">Choose a customer first.</p>}
        </div>

        {lines.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            No items yet. Search above and press Enter to add one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Invoice items</caption>
              <thead className="border-b border-slate-200 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                <tr>
                  <th className={cell}>Item</th>
                  <th className={`${cell} w-24`}>Qty</th>
                  <th className={`${cell} text-right`}>Rate</th>
                  <th className={`${cell} w-48`}>Discount</th>
                  <th className={`${cell} text-right`}>Tax</th>
                  <th className={`${cell} text-right`}>Amount</th>
                  <th className={cell}>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((l, i) => {
                  const cl = calc?.lines[i];
                  const e = lineErrors[l.key] ?? {};
                  return (
                    <tr key={l.key}>
                      <td className={cell}>
                        <div className="max-w-[16rem] font-medium break-words text-slate-900">
                          {l.product.name}
                        </div>
                        <div className="font-mono text-xs text-slate-500">{l.product.sku}</div>
                      </td>
                      <td className={cell}>
                        <div className="flex items-center gap-1">
                          <input
                            ref={(el) => {
                              qtyRefs.current[l.key] = el;
                            }}
                            aria-label={`Quantity for ${l.product.name}`}
                            aria-invalid={e.quantity ? true : undefined}
                            inputMode="decimal"
                            value={l.quantity}
                            onChange={(ev) => editLine(l.key, { quantity: ev.target.value })}
                            className={`${smallInput} w-20 text-right ${e.quantity ? 'border-red-500' : 'border-slate-300'}`}
                          />
                          <span className="text-xs text-slate-500">{l.product.unit?.code}</span>
                        </div>
                        {e.quantity && (
                          <p className="text-xs font-medium text-red-700">{e.quantity}</p>
                        )}
                      </td>
                      <td className={`${cell} text-right whitespace-nowrap tabular-nums`}>
                        {formatRupees(l.product.sellingPrice)}
                        <div className="text-xs text-slate-500">
                          {l.product.priceIncludesTax ? 'incl. GST' : 'excl. GST'}
                        </div>
                      </td>
                      <td className={cell}>
                        <div className="flex gap-1">
                          <select
                            aria-label={`Discount type for ${l.product.name}`}
                            value={l.discountKind}
                            onChange={(ev) =>
                              editLine(l.key, {
                                discountKind: ev.target.value as DiscountKind,
                                discountValue: '',
                              })
                            }
                            className={`${smallInput} border-slate-300`}
                          >
                            <option value="NONE">None</option>
                            <option value="PERCENT">% off</option>
                            <option value="AMOUNT">{'₹'} off</option>
                          </select>
                          {l.discountKind !== 'NONE' && (
                            <input
                              aria-label={`Discount ${l.discountKind === 'PERCENT' ? 'percentage' : 'amount in rupees'} for ${l.product.name}`}
                              aria-invalid={e.discount ? true : undefined}
                              inputMode="decimal"
                              value={l.discountValue}
                              onChange={(ev) => editLine(l.key, { discountValue: ev.target.value })}
                              className={`${smallInput} w-20 text-right ${e.discount ? 'border-red-500' : 'border-slate-300'}`}
                            />
                          )}
                        </div>
                        {e.discount && (
                          <p className="text-xs font-medium text-red-700">{e.discount}</p>
                        )}
                      </td>
                      <td className={`${cell} text-right whitespace-nowrap tabular-nums ${dim}`}>
                        {cl
                          ? cl.components.length > 0
                            ? formatRate(cl.rate.ratePercent)
                            : cl.classification.replace('_', ' ').toLowerCase()
                          : '-'}
                      </td>
                      <td
                        className={`${cell} text-right font-medium whitespace-nowrap tabular-nums ${dim}`}
                      >
                        {cl ? formatRupees(cl.lineTotal) : '-'}
                      </td>
                      <td className={cell}>
                        <Button
                          variant="ghost"
                          className="px-2.5"
                          aria-label={`Remove ${l.product.name}`}
                          title="Remove this item"
                          onClick={() => removeLine(l.key)}
                        >
                          {'✕'}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-4 space-y-3">
        {formError && <Alert tone="error">{formError}</Alert>}
        {problems.length > 0 && (
          <Alert tone="error" title="This invoice cannot be posted yet">
            <ul className="list-disc pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        )}
        {fresh && fresh.ok && !fresh.postable && !pos && (
          <Alert tone="info">
            Confirm the place of supply for this transaction, then preview again.
          </Alert>
        )}
        {fresh && fresh.warnings.length > 0 && (
          <Alert tone="info">{describeProblems(fresh.warnings).join(' ')}</Alert>
        )}
        {fresh && fresh.stockWarnings.length > 0 && (
          <Alert tone="info" title="Stock check (advisory)">
            <ul className="list-disc pl-5">
              {fresh.stockWarnings.map((s) => (
                <li key={s.productId}>
                  {s.sku}: {formatQuantity(s.onHand)} available, {formatQuantity(s.required)} needed
                  in production
                  {s.sufficient ? '' : ' (not enough)'}. Demo invoices do not change stock.
                </li>
              ))}
            </ul>
          </Alert>
        )}
        {outOfDate && !staleReview && (
          <Alert tone="warning">
            You changed the invoice after the last preview. Totals are out of date. Preview again
            before posting.
          </Alert>
        )}
        {staleReview && (
          <Alert tone="warning" title="Invoice details changed">
            Invoice details changed since the last preview. Review the updated totals before
            posting.
            {failure?.kind === 'stale' && !failure.recalculation && ' Preview again to see them.'}
          </Alert>
        )}
        {failure?.kind === 'uncertain' && (
          <Alert tone="warning" title="We could not confirm whether the invoice was posted">
            Do not create a new invoice. Choose Retry posting: it safely reuses the same entry, so
            the invoice is posted once.
          </Alert>
        )}
        {failure?.kind === 'rejected' && (
          <Alert tone="error" title="The invoice was not posted">
            <ul className="list-disc pl-5">
              {failure.messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </Alert>
        )}
      </div>

      <div className="mt-4 flex items-start justify-between gap-6">
        <div className="flex gap-2">
          <Button
            variant="secondary"
            loading={previewing}
            disabled={!customer || posting}
            onClick={() => void runPreview()}
          >
            Preview
          </Button>
          <Button
            loading={posting}
            disabled={!postable || !canPost || previewing}
            onClick={() => void post()}
            title={!canPost ? 'You do not have permission to post invoices.' : undefined}
          >
            {uncertain
              ? 'Retry posting'
              : staleReview
                ? 'Post with updated totals'
                : 'Post demo invoice'}
          </Button>
          {!canPost && (
            <span className="self-center text-xs text-slate-500">
              You can preview, but not post.
            </span>
          )}
        </div>
        <dl className={`w-80 space-y-1 text-sm ${dim}`} aria-label="Invoice totals">
          {totals ? (
            <>
              {(
                [
                  ['Gross amount', totals.grossSubtotal],
                  ['Line discounts', totals.lineDiscountTotal],
                  ['Taxable subtotal', totals.taxableSubtotal],
                  ['CGST', totals.componentTotals.CGST],
                  ['SGST', totals.componentTotals.SGST],
                  ['UTGST', totals.componentTotals.UTGST],
                  ['IGST', totals.componentTotals.IGST],
                  ['Rounding adjustment', totals.roundingAdjustmentTotal],
                  ['Round off', totals.roundOff],
                ] as const
              ).map(([label, v]) => (
                <div key={label} className="flex justify-between text-slate-700">
                  <dt>{label}</dt>
                  <dd className="tabular-nums">{formatRupees(v ?? '0.00')}</dd>
                </div>
              ))}
              <div className="flex justify-between border-t border-slate-300 pt-1 text-base font-semibold text-slate-900">
                <dt>Total</dt>
                <dd className="tabular-nums">{formatRupees(totals.grandTotal)}</dd>
              </div>
            </>
          ) : (
            <p className="text-slate-500">
              {outOfDate
                ? 'Totals are out of date. Preview again.'
                : 'Preview to see the GST and total, calculated by the server.'}
            </p>
          )}
        </dl>
      </div>
    </>
  );
}
