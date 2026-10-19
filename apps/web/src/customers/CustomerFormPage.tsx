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
import type { CustomerView } from '@commercebill/shared-types';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  ApiError,
  createCustomer,
  getCustomer,
  setCustomerActive,
  updateCustomer,
} from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure, UNEXPECTED } from '../messages.js';
import {
  STATE_OPTIONS,
  deliveryStateCode,
  describeErrors,
  emptyCustomerForm,
  errorsFromProblems,
  formFromCustomer,
  stateName,
  toApiBody,
  validateForm,
  type CustomerForm,
  type FieldErrors,
} from './model.js';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card title={title}>
      <div className="grid gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>
    </Card>
  );
}
const wide = 'md:col-span-2 xl:col-span-3';

/** One screen for creating, editing and (without customer.write) read-only viewing a customer. */
export function CustomerFormPage() {
  const { id } = useParams();
  const creating = id === undefined;
  const { authed, can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = can('customer.write');
  const readOnly = !canWrite;

  const [form, setForm] = useState<CustomerForm>(emptyCustomerForm);
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

  const loaded = useQuery({
    queryKey: ['customer', id],
    queryFn: () => authed((token) => getCustomer(token, id!)),
    enabled: !creating,
    retry: false,
    // A stale copy must never be edited as if it were current.
    staleTime: 0,
    gcTime: 0,
    // Never swap the record under someone who is typing: conflicts are reported on save instead.
    refetchOnWindowFocus: false,
  });
  const customer: CustomerView | undefined = loaded.data?.customer;

  useEffect(() => {
    if (customer) {
      setForm(formFromCustomer(customer));
      version.current = customer.version;
    }
  }, [customer]);

  useEffect(() => {
    if (!focusProblem.current) return;
    focusProblem.current = false;
    document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [summary]);

  const set = (patch: Partial<CustomerForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors({});
    setSaved(false);
  };
  const text = (key: keyof CustomerForm) => ({
    value: form[key] as string,
    onChange: (e: { target: { value: string } }) =>
      set({ [key]: e.target.value } as Partial<CustomerForm>),
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
    try {
      const body = toApiBody(form, creating);
      if (creating) {
        const { customer: made } = await authed((t) => createCustomer(t, body));
        await queryClient.invalidateQueries({ queryKey: ['customers'] });
        navigate('/customers', {
          state: { notice: `Customer ${made.code} (${made.legalName}) was created.` },
        });
        return;
      }
      const { customer: next } = await authed((t) =>
        updateCustomer(t, id!, { ...body, expectedVersion: version.current }),
      );
      version.current = next.version;
      setForm(formFromCustomer(next));
      queryClient.setQueryData(['customer', id], { customer: next });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
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
          title: 'This customer clashes with an existing one',
          items: describeErrors(fe),
        });
        focusProblem.current = true;
      } else if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
      } else if (err instanceof ApiError && err.status === 401) {
        // the session ended; the shell is already showing sign-in
      } else {
        setSummary({ title: describeFailure(err) || UNEXPECTED, items: [] });
      }
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }

  async function toggleActive() {
    if (!customer) return;
    setToggling(true);
    setToggleError(null);
    try {
      const { customer: next } = await authed((t) =>
        setCustomerActive(t, customer.id, !customer.isActive, version.current),
      );
      queryClient.setQueryData(['customer', id], { customer: next });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
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

  if (!creating && loaded.isPending) return <LoadingState label="Loading customer" />;
  if (!creating && loaded.isError) {
    const missing = loaded.error instanceof ApiError && loaded.error.status === 404;
    return (
      <>
        <PageHeader title="Customer" />
        <EmptyState
          title={missing ? 'Customer not found' : 'The customer could not be loaded'}
          action={
            <Button variant="secondary" onClick={() => navigate('/customers')}>
              Back to customers
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
  if (creating && !canWrite) {
    return (
      <>
        <PageHeader title="New customer" />
        <EmptyState
          title="You do not have access to add customers"
          action={
            <Button variant="secondary" onClick={() => navigate('/customers')}>
              Back to customers
            </Button>
          }
        >
          Ask your administrator if you need it.
        </EmptyState>
      </>
    );
  }

  const b2c = form.customerType === 'B2C';
  const delivery = deliveryStateCode(form);
  const needsGstin = form.gstStatus === 'REGISTERED' || form.gstStatus === 'COMPOSITION';
  const inactive = customer ? !customer.isActive : false;

  return (
    <>
      <PageHeader
        title={creating ? 'New customer' : (customer?.legalName ?? 'Customer')}
        description={
          creating
            ? 'Fields marked (required) must be filled in.'
            : `Customer code ${customer?.code}`
        }
        actions={
          <>
            {readOnly && (
              <Button variant="secondary" onClick={() => navigate('/customers')}>
                Back
              </Button>
            )}
            {!creating && canWrite && customer && (
              <Button
                variant="secondary"
                onClick={() => setConfirmToggle(true)}
                disabled={toggling}
              >
                {customer.isActive ? 'Deactivate' : 'Reactivate'}
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 space-y-3">
        {inactive && (
          <Alert tone="warning">
            <span className="flex items-center gap-2">
              <Badge tone="warning">Inactive</Badge> This customer is inactive. It stays on existing
              records but is hidden from the default customer list.
            </span>
          </Alert>
        )}
        {readOnly && <Alert tone="info">You have read-only access to customers.</Alert>}
        {confirmToggle && customer && (
          <Alert
            tone="warning"
            title={customer.isActive ? 'Deactivate this customer?' : 'Reactivate this customer?'}
          >
            <p>
              {customer.isActive
                ? 'Nothing is deleted. The customer stays on existing records and can be reactivated at any time.'
                : 'The customer will appear in the default customer list again.'}
            </p>
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" loading={toggling} onClick={() => void toggleActive()}>
                {customer.isActive ? 'Yes, deactivate' : 'Yes, reactivate'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmToggle(false)}>
                Cancel
              </Button>
            </div>
          </Alert>
        )}
        {toggleError && <Alert tone="error">{toggleError}</Alert>}
        {conflict && (
          <Alert tone="warning" title="This customer was changed by someone else">
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
        {saved && <Alert tone="success">Customer saved.</Alert>}
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
        aria-label={creating ? 'New customer' : 'Customer details'}
      >
        <Section title="Basic details">
          <div className={wide}>
            <RadioGroup
              legend="Customer type"
              name="customerType"
              layout="row"
              value={form.customerType}
              onChange={(v) =>
                set(
                  v === 'B2C'
                    ? { customerType: 'B2C', gstStatus: 'UNREGISTERED', gstin: '' }
                    : { customerType: 'B2B' },
                )
              }
              options={[
                {
                  value: 'B2B',
                  label: 'B2B - business',
                  description: 'A business that may have a GST registration.',
                },
                {
                  value: 'B2C',
                  label: 'B2C - consumer',
                  description: 'An individual buying for personal use; never GST registered.',
                },
              ]}
            />
          </div>
          <TextInput
            label="Customer name"
            requirement="required"
            name="legalName"
            autoFocus={creating}
            maxLength={200}
            autoComplete="off"
            {...text('legalName')}
          />
          <TextInput
            label="Display name"
            requirement="optional"
            name="displayName"
            maxLength={200}
            autoComplete="off"
            {...text('displayName')}
          />
          {creating ? (
            <TextInput
              label="Customer code"
              requirement="optional"
              name="code"
              hint="Leave blank to generate the next code."
              maxLength={30}
              autoComplete="off"
              spellCheck={false}
              {...text('code')}
              onChange={(e) => set({ code: e.target.value.toUpperCase() })}
            />
          ) : (
            <TextInput
              label="Customer code"
              name="code"
              hint="The code cannot be changed."
              value={form.code}
              readOnly
              disabled
            />
          )}
        </Section>

        <Section title="Tax details">
          {b2c ? (
            <p className="text-sm text-slate-600 md:col-span-2 xl:col-span-3">
              Consumers (B2C) are not GST registered, so no GSTIN is needed. Choose B2B above for a
              business with a GST registration.
            </p>
          ) : (
            <>
              <SelectField
                label="GST registration"
                requirement="required"
                name="gstStatus"
                value={form.gstStatus}
                disabled={readOnly || saving}
                error={errors.gstStatus}
                onChange={(e) => {
                  const next = e.target.value as CustomerForm['gstStatus'];
                  set(
                    next === 'UNREGISTERED' ? { gstStatus: next, gstin: '' } : { gstStatus: next },
                  );
                }}
              >
                <option value="REGISTERED">Registered</option>
                <option value="COMPOSITION">Composition scheme</option>
                <option value="UNREGISTERED">Not registered</option>
              </SelectField>
              {needsGstin && (
                <TextInput
                  label="GSTIN"
                  requirement={form.gstStatus === 'REGISTERED' ? 'required' : 'optional'}
                  name="gstin"
                  maxLength={15}
                  spellCheck={false}
                  autoCapitalize="characters"
                  autoComplete="off"
                  {...text('gstin')}
                  onChange={(e) => set({ gstin: e.target.value.toUpperCase() })}
                />
              )}
              <TextInput
                label="PAN"
                requirement="optional"
                name="pan"
                maxLength={10}
                spellCheck={false}
                autoComplete="off"
                {...text('pan')}
                onChange={(e) => set({ pan: e.target.value.toUpperCase() })}
              />
              {needsGstin && (
                <p className="text-xs text-slate-500 md:col-span-2 xl:col-span-3">
                  The GSTIN format and check character are verified here. CommerceBill does not
                  check with the GST portal that a GSTIN is registered or belongs to this customer.
                </p>
              )}
            </>
          )}
          <SelectField
            label="Place of supply"
            requirement="optional"
            name="placeOfSupplyStateCode"
            hint="Used later to work out tax. Defaults to the delivery state."
            value={form.placeOfSupplyStateCode}
            disabled={readOnly || saving}
            error={errors.placeOfSupplyStateCode}
            onChange={(e) => set({ placeOfSupplyStateCode: e.target.value })}
          >
            <option value="">
              {delivery && stateName(delivery)
                ? `Delivery state (${stateName(delivery)})`
                : 'Delivery state (default)'}
            </option>
            {STATE_OPTIONS.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name} ({s.code})
              </option>
            ))}
          </SelectField>
        </Section>

        <Section title="Billing address">
          <div className={wide}>
            <TextInput
              label="Address line 1"
              requirement="required"
              name="billingAddressLine1"
              maxLength={200}
              autoComplete="off"
              {...text('billingAddressLine1')}
            />
          </div>
          <div className={wide}>
            <TextInput
              label="Address line 2"
              requirement="optional"
              name="billingAddressLine2"
              maxLength={200}
              autoComplete="off"
              {...text('billingAddressLine2')}
            />
          </div>
          <TextInput
            label="City"
            requirement="optional"
            name="billingCity"
            maxLength={100}
            autoComplete="off"
            {...text('billingCity')}
          />
          <SelectField
            label="State / union territory"
            requirement="required"
            name="billingStateCode"
            value={form.billingStateCode}
            disabled={readOnly || saving}
            error={errors.billingStateCode}
            onChange={(e) => set({ billingStateCode: e.target.value })}
          >
            <option value="">Choose a state…</option>
            {STATE_OPTIONS.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name} ({s.code})
              </option>
            ))}
          </SelectField>
          <TextInput
            label="PIN code"
            requirement="optional"
            name="billingPinCode"
            inputMode="numeric"
            maxLength={6}
            autoComplete="off"
            {...text('billingPinCode')}
          />
          <p className="text-sm text-slate-600 md:col-span-2 xl:col-span-3">
            Country: <span className="font-medium text-slate-900">India</span>
          </p>
        </Section>

        <Section title="Shipping address">
          <div className={wide}>
            <Checkbox
              label="Shipping address same as billing"
              checked={form.shippingSameAsBilling}
              disabled={readOnly || saving}
              onChange={(e) => set({ shippingSameAsBilling: e.target.checked })}
            />
          </div>
          {!form.shippingSameAsBilling && (
            <>
              <div className={wide}>
                <TextInput
                  label="Address line 1"
                  requirement="required"
                  name="shippingAddressLine1"
                  maxLength={200}
                  autoComplete="off"
                  {...text('shippingAddressLine1')}
                />
              </div>
              <div className={wide}>
                <TextInput
                  label="Address line 2"
                  requirement="optional"
                  name="shippingAddressLine2"
                  maxLength={200}
                  autoComplete="off"
                  {...text('shippingAddressLine2')}
                />
              </div>
              <TextInput
                label="City"
                requirement="optional"
                name="shippingCity"
                maxLength={100}
                autoComplete="off"
                {...text('shippingCity')}
              />
              <SelectField
                label="State / union territory"
                requirement="required"
                name="shippingStateCode"
                value={form.shippingStateCode}
                disabled={readOnly || saving}
                error={errors.shippingStateCode}
                onChange={(e) => set({ shippingStateCode: e.target.value })}
              >
                <option value="">Choose a state…</option>
                {STATE_OPTIONS.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </SelectField>
              <TextInput
                label="PIN code"
                requirement="optional"
                name="shippingPinCode"
                inputMode="numeric"
                maxLength={6}
                autoComplete="off"
                {...text('shippingPinCode')}
              />
            </>
          )}
        </Section>

        <Section title="Contact">
          <TextInput
            label="Contact person"
            requirement="optional"
            name="contactPerson"
            maxLength={100}
            autoComplete="off"
            {...text('contactPerson')}
          />
          <TextInput
            label="Phone"
            requirement="optional"
            name="phone"
            type="tel"
            maxLength={20}
            autoComplete="off"
            {...text('phone')}
          />
          <TextInput
            label="Alternate phone"
            requirement="optional"
            name="alternatePhone"
            type="tel"
            maxLength={20}
            autoComplete="off"
            {...text('alternatePhone')}
          />
          <TextInput
            label="Email"
            requirement="optional"
            name="email"
            type="email"
            maxLength={254}
            autoComplete="off"
            {...text('email')}
          />
        </Section>

        <Section title="Other details">
          <TextInput
            label="Credit limit (INR)"
            requirement="optional"
            name="creditLimit"
            inputMode="decimal"
            hint="Recorded for reference; not enforced yet."
            autoComplete="off"
            {...text('creditLimit')}
          />
          <TextInput
            label="Payment terms (days)"
            requirement="optional"
            name="paymentTermsDays"
            inputMode="numeric"
            hint="For example 30 for net 30 days."
            maxLength={3}
            autoComplete="off"
            {...text('paymentTermsDays')}
          />
          <div className={wide}>
            <TextArea
              label="Notes"
              requirement="optional"
              name="notes"
              maxLength={2000}
              {...text('notes')}
            />
          </div>
        </Section>

        {canWrite && (
          <div className="flex items-center gap-3 border-t border-slate-200 pt-3">
            <Button type="submit" loading={saving}>
              {saving ? 'Saving' : creating ? 'Create customer' : 'Save changes'}
            </Button>
            <Button variant="secondary" onClick={() => navigate('/customers')} disabled={saving}>
              Cancel
            </Button>
          </div>
        )}
      </form>
    </>
  );
}
