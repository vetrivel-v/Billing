import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  LoadingState,
  PageHeader,
  RadioGroup,
  SelectField,
  TextArea,
  TextInput,
} from '@commercebill/ui';
import type { ProductView } from '@commercebill/shared-types';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  ApiError,
  createProduct,
  getProduct,
  getProductReferences,
  setProductActive,
  updateProduct,
} from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import { HsnSacPicker } from './HsnSacPicker.js';
import { formatInr } from './money.js';
import {
  describeErrors,
  emptyProductForm,
  errorsFromProblems,
  formFromProduct,
  toApiBody,
  validateForm,
  type FieldErrors,
  type ProductForm,
} from './model.js';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card title={title}>
      <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">{children}</div>
    </Card>
  );
}
const wide = 'md:col-span-2';

/** The typed price as a plain decimal, or null: used ONLY to echo it back with a rupee sign (no arithmetic). */
const echo = (typed: string) =>
  /^\d{1,16}(\.\d{1,2})?$/.test(typed.trim()) ? formatInr(typed.trim()) : null;

/** One screen for creating, editing and (without product.write) read-only viewing a product. */
export function ProductFormPage() {
  const { id } = useParams();
  const creating = id === undefined;
  const { authed, can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = can('product.write');
  const readOnly = !canWrite;

  const [form, setForm] = useState<ProductForm>(() => emptyProductForm());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [summary, setSummary] = useState<{ title: string; items: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmToggle, setConfirmToggle] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const version = useRef(0);
  const focusProblem = useRef(false);
  const saveLock = useRef(false);

  const refs = useQuery({
    queryKey: ['product-references'],
    queryFn: () => authed((token) => getProductReferences(token)),
    retry: false,
  });
  const loaded = useQuery({
    queryKey: ['product', id],
    queryFn: () => authed((token) => getProduct(token, id!)),
    enabled: !creating,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    // Never swap the record under someone who is typing: conflicts are reported on save instead.
    refetchOnWindowFocus: false,
  });
  const product: ProductView | undefined = loaded.data?.product;

  useEffect(() => {
    if (product) {
      setForm(formFromProduct(product));
      version.current = product.version;
    }
  }, [product]);

  // A new product starts with the organization's only tax category when there is just one (still the user's to confirm).
  useEffect(() => {
    if (creating && refs.data && refs.data.taxCategories.length === 1) {
      setForm((f) =>
        f.taxCategoryId ? f : { ...f, taxCategoryId: refs.data!.taxCategories[0]!.id },
      );
    }
  }, [creating, refs.data]);

  useEffect(() => {
    if (!focusProblem.current) return;
    focusProblem.current = false;
    document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [summary]);

  const set = (patch: Partial<ProductForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors({});
    setSaved(false);
  };
  const text = (key: keyof ProductForm) => ({
    value: form[key] as string,
    onChange: (e: { target: { value: string } }) =>
      set({ [key]: e.target.value } as Partial<ProductForm>),
    disabled: readOnly || saving,
    error: errors[key],
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (readOnly || saveLock.current) return;
    setSaved(false);
    setConflict(false);
    const local = validateForm(form, creating);
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
      const body = toApiBody(form, creating);
      if (creating) {
        const { product: made } = await authed((t) => createProduct(t, body));
        await queryClient.invalidateQueries({ queryKey: ['products'] });
        const stock = made.trackInventory
          ? ' Stock can be added from Inventory once that module is available.'
          : '';
        navigate('/products', {
          state: { notice: `Product ${made.sku} (${made.name}) was created.${stock}` },
        });
        left = true; // the page is going away: keep the form locked so no second submit can slip in
        return;
      }
      const { product: next } = await authed((t) =>
        updateProduct(t, id!, { ...body, expectedVersion: version.current }),
      );
      version.current = next.version;
      setForm(formFromProduct(next));
      queryClient.setQueryData(['product', id], { product: next });
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.problems.length > 0) {
        const fe = errorsFromProblems(err.problems);
        setErrors(fe);
        setSummary({
          title: 'The server could not accept some details',
          items: describeErrors(fe),
        });
        focusProblem.current = true;
      } else if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.code === 'BIZ_0001' &&
        err.problems.length > 0
      ) {
        const fe = errorsFromProblems(err.problems);
        setErrors(fe);
        setSummary({
          title: 'This product clashes with an existing one',
          items: describeErrors(fe),
        });
        focusProblem.current = true;
      } else if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
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

  async function toggleActive() {
    if (!product) return;
    setToggling(true);
    setToggleError(null);
    try {
      const { product: next } = await authed((t) =>
        setProductActive(t, product.id, !product.isActive, version.current),
      );
      queryClient.setQueryData(['product', id], { product: next });
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      setConfirmToggle(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      else if (!(err instanceof ApiError && err.status === 401))
        setToggleError(describeFailure(err));
      setConfirmToggle(false);
    } finally {
      setToggling(false);
    }
  }

  async function reload() {
    setConflict(false);
    setErrors({});
    setSummary(null);
    setSaved(false);
    await loaded.refetch();
  }

  const back = () => navigate('/products');
  if (creating && !canWrite) {
    return (
      <>
        <PageHeader title="New product" />
        <EmptyState
          title="You do not have access to add products"
          action={
            <Button variant="secondary" onClick={back}>
              Back to products
            </Button>
          }
        >
          Ask your administrator if you need it.
        </EmptyState>
      </>
    );
  }
  if (!creating && loaded.isPending) return <LoadingState label="Loading product" />;
  if (!creating && loaded.isError) {
    const missing = loaded.error instanceof ApiError && loaded.error.status === 404;
    return (
      <>
        <PageHeader title="Product" />
        <EmptyState
          title={missing ? 'Product not found' : 'The product could not be loaded'}
          action={
            <Button variant="secondary" onClick={back}>
              Back to products
            </Button>
          }
        >
          {missing
            ? 'It may have been removed from your view, or the link is wrong.'
            : describeFailure(loaded.error)}
        </EmptyState>
      </>
    );
  }
  if (refs.isPending) return <LoadingState label="Loading reference lists" />;
  if (refs.isError) {
    return (
      <>
        <PageHeader title={creating ? 'New product' : 'Product'} />
        <div className="space-y-3">
          <Alert tone="error">
            The units and tax categories could not be loaded. {describeFailure(refs.error)}
          </Alert>
          <Button variant="secondary" onClick={() => void refs.refetch()}>
            Try again
          </Button>
        </div>
      </>
    );
  }

  const goods = form.kind === 'GOODS';
  const { units, taxCategories, hsnSacTotal } = refs.data;
  const unitMissing =
    product?.unit && product.unitId && !units.some((u) => u.id === product.unitId);
  const taxMissing = product && !taxCategories.some((t) => t.id === product.taxCategoryId);
  const price = echo(form.sellingPrice);
  const inactive = product ? !product.isActive : false;

  return (
    <>
      <PageHeader
        title={creating ? 'New product' : (product?.name ?? 'Product')}
        description={
          creating ? 'Fields marked (required) must be filled in.' : `SKU ${product?.sku}`
        }
        actions={
          <>
            {readOnly && (
              <Button variant="secondary" onClick={back}>
                Back
              </Button>
            )}
            {!creating && canWrite && product && (
              <Button
                variant="secondary"
                onClick={() => setConfirmToggle(true)}
                disabled={toggling}
              >
                {product.isActive ? 'Deactivate' : 'Reactivate'}
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 space-y-3">
        {inactive && (
          <Alert tone="warning">
            <span className="flex items-center gap-2">
              <Badge tone="warning">Inactive</Badge> This product is inactive. It stays on existing
              records but is hidden from the default product list.
            </span>
          </Alert>
        )}
        {readOnly && <Alert tone="info">You have read-only access to products.</Alert>}
        {confirmToggle && product && (
          <Alert
            tone="warning"
            title={product.isActive ? 'Deactivate this product?' : 'Reactivate this product?'}
          >
            <p>
              {product.isActive
                ? 'Nothing is deleted. The product stays on existing records and can be reactivated at any time.'
                : 'The product will appear in the default product list again.'}
            </p>
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" loading={toggling} onClick={() => void toggleActive()}>
                {product.isActive ? 'Yes, deactivate' : 'Yes, reactivate'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmToggle(false)}>
                Cancel
              </Button>
            </div>
          </Alert>
        )}
        {toggleError && <Alert tone="error">{toggleError}</Alert>}
        {conflict && (
          <Alert tone="warning" title="This product was changed by someone else">
            <p>
              Your changes were not saved, so nothing was overwritten. Reload to see the latest
              details; your edits on screen will be replaced.
            </p>
            <div className="mt-2">
              <Button variant="secondary" onClick={() => void reload()}>
                Reload latest
              </Button>
            </div>
          </Alert>
        )}
        {saved && <Alert tone="success">Product saved.</Alert>}
        {summary && (
          <Alert tone="error" title={summary.title}>
            {summary.items.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {summary.items.map((m, i) => (
                  <li key={`${i}-${m}`}>{m}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
      </div>

      <form
        onSubmit={onSubmit}
        noValidate
        className="space-y-4"
        aria-label={creating ? 'New product' : 'Product details'}
      >
        <Section title="Basic details">
          <div className={wide}>
            {creating ? (
              <RadioGroup
                legend="Product type"
                name="kind"
                layout="row"
                value={form.kind}
                onChange={(v) =>
                  set({
                    kind: v as ProductForm['kind'],
                    // an HSN code does not fit a service (and vice versa), and a service never tracks inventory
                    hsnSacCodeId: '',
                    hsnSacLabel: '',
                    trackInventory: false,
                  })
                }
                options={[
                  {
                    value: 'GOODS',
                    label: 'Goods',
                    description:
                      'Physical items counted in a unit; may track inventory; use an HSN code.',
                  },
                  {
                    value: 'SERVICE',
                    label: 'Service',
                    description: 'Work or fees; never tracks inventory; use a SAC code.',
                  },
                ]}
              />
            ) : (
              <p className="text-sm text-slate-600">
                Product type:{' '}
                <span className="font-medium text-slate-900">{goods ? 'Goods' : 'Service'}</span>{' '}
                <span className="text-xs text-slate-500">(cannot be changed)</span>
              </p>
            )}
          </div>
          <div className={wide}>
            <TextInput
              label="Product name"
              requirement="required"
              name="name"
              autoFocus={creating}
              maxLength={200}
              autoComplete="off"
              {...text('name')}
            />
          </div>
          {creating ? (
            <TextInput
              label="SKU"
              requirement="optional"
              name="sku"
              hint="Leave blank to generate the next SKU. It cannot be changed later."
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              {...text('sku')}
              onChange={(e) => set({ sku: e.target.value.toUpperCase() })}
            />
          ) : (
            <TextInput
              label="SKU"
              name="sku"
              hint="The SKU cannot be changed."
              value={form.sku}
              readOnly
              disabled
            />
          )}
          <TextInput
            label="Barcode"
            requirement="optional"
            name="barcode"
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            {...text('barcode')}
          />
          <div className={wide}>
            <TextArea
              label="Description"
              requirement="optional"
              name="description"
              maxLength={2000}
              {...text('description')}
            />
          </div>
        </Section>

        <Section title="Classification">
          <HsnSacPicker
            key={form.kind}
            kind={goods ? 'HSN' : 'SAC'}
            valueId={form.hsnSacCodeId}
            valueLabel={form.hsnSacLabel}
            total={hsnSacTotal}
            disabled={readOnly || saving}
            error={errors.hsnSacCodeId}
            onChange={(codeId, label) => set({ hsnSacCodeId: codeId, hsnSacLabel: label })}
          />
          <SelectField
            label="Unit of measure"
            requirement={goods ? 'required' : 'optional'}
            name="unitId"
            value={form.unitId}
            disabled={readOnly || saving}
            error={errors.unitId}
            onChange={(e) => set({ unitId: e.target.value })}
          >
            <option value="">{goods ? 'Choose a unit…' : 'No unit'}</option>
            {unitMissing && product?.unit && (
              <option value={product.unitId!}>
                {product.unit.code} - {product.unit.name} (inactive)
              </option>
            )}
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.code} - {u.name}
              </option>
            ))}
          </SelectField>
        </Section>

        <Section title="Tax">
          <SelectField
            label="Tax category"
            requirement="required"
            name="taxCategoryId"
            value={form.taxCategoryId}
            disabled={readOnly || saving}
            error={errors.taxCategoryId}
            onChange={(e) => set({ taxCategoryId: e.target.value })}
          >
            <option value="">Choose a tax category…</option>
            {taxMissing && product && (
              <option value={product.taxCategoryId}>{product.taxCategory.name} (inactive)</option>
            )}
            {taxCategories.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </SelectField>
          <p className="text-xs text-slate-500">
            The tax category is only a reference. Tax is calculated when a document is created,
            using the rates in force that day. The rates installed with CommerceBill are
            placeholders and have not been verified by the government or a tax professional.
          </p>
        </Section>

        <Section title="Pricing">
          <div>
            <TextInput
              label="Selling price (INR)"
              requirement="required"
              name="sellingPrice"
              inputMode="decimal"
              hint="For example 1180 or 1180.50."
              autoComplete="off"
              {...text('sellingPrice')}
              className="text-right tabular-nums"
            />
          </div>
          <TextInput
            label="MRP (INR)"
            requirement="optional"
            name="mrp"
            inputMode="decimal"
            hint="Maximum retail price, if printed on the item."
            autoComplete="off"
            {...text('mrp')}
            className="text-right tabular-nums"
          />
          <div className={wide}>
            <RadioGroup
              legend="The selling price"
              name="priceIncludesTax"
              layout="row"
              value={form.priceIncludesTax ? 'incl' : 'excl'}
              onChange={(v) => set({ priceIncludesTax: v === 'incl' })}
              options={[
                {
                  value: 'excl',
                  label: 'Does not include GST',
                  description: 'GST is added on top of this price.',
                },
                {
                  value: 'incl',
                  label: 'Includes GST',
                  description: 'This price is the amount the customer pays, GST included.',
                },
              ]}
            />
          </div>
          <p className="text-sm text-slate-700 md:col-span-2" aria-live="polite">
            {price ? (
              <>
                <span className="font-medium tabular-nums text-slate-900">{price}</span>{' '}
                {form.priceIncludesTax ? 'inclusive of GST' : '+ applicable GST'}
                <span className="block text-xs text-slate-500">
                  The GST amount is worked out when a document is created.
                </span>
              </>
            ) : (
              <span className="text-slate-500">
                Enter a selling price to see how it will be described.
              </span>
            )}
          </p>
        </Section>

        <Section title="Inventory settings">
          {goods ? (
            <div className={wide}>
              <Checkbox
                label="Track inventory"
                description="Stock quantities are not entered here: they will be managed from Inventory once that module is available."
                checked={form.trackInventory}
                disabled={readOnly || saving}
                onChange={(e) => set({ trackInventory: e.target.checked })}
              />
            </div>
          ) : (
            <p className="text-sm text-slate-600 md:col-span-2">
              Services do not track inventory and never create stock movements.
            </p>
          )}
        </Section>

        {canWrite && (
          <div className="flex items-center gap-3 border-t border-slate-200 pt-3">
            <Button type="submit" loading={saving}>
              {saving ? 'Saving' : creating ? 'Create product' : 'Save changes'}
            </Button>
            <Button variant="secondary" onClick={back} disabled={saving}>
              Cancel
            </Button>
          </div>
        )}
      </form>
    </>
  );
}
