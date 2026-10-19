import { Alert, PasswordInput, RadioGroup, SelectField, TextInput } from '@commercebill/ui';
import { INDIA_STATE_CODES } from '@commercebill/setup/browser';
import {
  DEFAULT_INVOICE_PREFIX,
  MIN_PASSWORD_LENGTH,
  STATE_OPTIONS,
  UNSUPPORTED_AT_SETUP,
  financialYearSummary,
  invoicePreview,
  type FieldErrors,
  type StepKey,
  type WizardForm,
} from './model.js';

export type Patch = <K extends keyof WizardForm>(
  section: K,
  values: Partial<WizardForm[K]>,
) => void;

interface StepProps {
  form: WizardForm;
  patch: Patch;
  errors: FieldErrors;
}

const BUSINESS_TYPES = [
  'Sole proprietorship',
  'Partnership',
  'Limited liability partnership',
  'Private limited company',
  'Public limited company',
  'Other',
];

export function WelcomeStep({ children }: { children?: React.ReactNode }) {
  return (
    <div className="space-y-4 text-sm text-slate-700">
      <p>
        This short wizard sets up your business, tax registration, financial year, invoice numbering
        and the first administrator account. It takes a few minutes and you can stop and resume
        later.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>Your business name and address</li>
        <li>GST registration details, if you are registered</li>
        <li>The start of your financial year</li>
        <li>A name and password for the administrator</li>
      </ul>
      <p className="text-slate-600">
        The administrator password is never saved by the wizard. If you close CommerceBill part-way,
        you will enter it again.
      </p>
      <Alert tone="info" title="Not part of setup yet">
        {UNSUPPORTED_AT_SETUP.join('; ')}.
      </Alert>
      {children}
    </div>
  );
}

export function BusinessStep({ form, patch, errors }: StepProps) {
  const b = form.business;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <TextInput
          label="Legal business name"
          requirement="required"
          name="legalName"
          autoComplete="organization"
          value={b.legalName}
          onChange={(e) => patch('business', { legalName: e.target.value })}
          error={errors['business.legalName']}
          maxLength={200}
        />
      </div>
      <TextInput
        label="Trade / display name"
        requirement="optional"
        name="tradeName"
        hint="Shown to your team instead of the legal name."
        value={b.tradeName}
        onChange={(e) => patch('business', { tradeName: e.target.value })}
        maxLength={200}
      />
      <div>
        <TextInput
          label="Business type"
          requirement="optional"
          name="businessType"
          list="business-types"
          value={b.businessType}
          onChange={(e) => patch('business', { businessType: e.target.value })}
          maxLength={100}
        />
        <datalist id="business-types">
          {BUSINESS_TYPES.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>
      <TextInput
        label="PAN"
        requirement="optional"
        name="pan"
        hint="10 characters, for example ABCDE1234F."
        value={b.pan}
        onChange={(e) => patch('business', { pan: e.target.value.toUpperCase() })}
        error={errors['business.pan']}
        maxLength={10}
        autoCapitalize="characters"
        spellCheck={false}
      />
    </div>
  );
}

export function AddressStep({ form, patch, errors }: StepProps) {
  const a = form.address;
  return (
    <div className="space-y-6">
      <section aria-label="Primary business location" className="grid gap-4 sm:grid-cols-2">
        <h3 className="text-sm font-semibold text-slate-800 sm:col-span-2">
          Primary business location
        </h3>
        <div className="sm:col-span-2">
          <TextInput
            label="Location name"
            requirement="optional"
            name="locationName"
            hint="Defaults to “Head Office”."
            value={a.locationName}
            onChange={(e) => patch('address', { locationName: e.target.value })}
            maxLength={100}
          />
        </div>
        <div className="sm:col-span-2">
          <TextInput
            label="Address line 1"
            requirement="required"
            name="addressLine1"
            autoComplete="address-line1"
            value={a.addressLine1}
            onChange={(e) => patch('address', { addressLine1: e.target.value })}
            error={errors['location.addressLine1']}
            maxLength={200}
          />
        </div>
        <div className="sm:col-span-2">
          <TextInput
            label="Address line 2"
            requirement="optional"
            name="addressLine2"
            autoComplete="address-line2"
            value={a.addressLine2}
            onChange={(e) => patch('address', { addressLine2: e.target.value })}
            maxLength={200}
          />
        </div>
        <TextInput
          label="City"
          requirement="optional"
          name="city"
          autoComplete="address-level2"
          value={a.city}
          onChange={(e) => patch('address', { city: e.target.value })}
          maxLength={100}
        />
        <TextInput
          label="PIN code"
          requirement="optional"
          name="pinCode"
          inputMode="numeric"
          autoComplete="postal-code"
          value={a.pinCode}
          onChange={(e) => patch('address', { pinCode: e.target.value })}
          error={errors['location.pinCode']}
          maxLength={6}
        />
        <div className="sm:col-span-2">
          <SelectField
            label="State / union territory"
            requirement="required"
            name="stateCode"
            value={a.stateCode}
            onChange={(e) => patch('address', { stateCode: e.target.value })}
            error={errors['business.stateCode']}
            hint="Your business state. It is also your default place of supply."
          >
            <option value="">Choose a state…</option>
            {STATE_OPTIONS.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name} ({s.code})
              </option>
            ))}
          </SelectField>
        </div>
        <p className="text-sm text-slate-600 sm:col-span-2">
          Country: <span className="font-medium text-slate-900">India</span>. CommerceBill currently
          supports Indian businesses only.
        </p>
      </section>
      <section aria-label="Primary warehouse" className="grid gap-4 sm:grid-cols-2">
        <h3 className="text-sm font-semibold text-slate-800 sm:col-span-2">Primary warehouse</h3>
        <TextInput
          label="Warehouse name"
          requirement="optional"
          name="warehouseName"
          hint="Defaults to “Main Warehouse”."
          value={form.warehouse.name}
          onChange={(e) => patch('warehouse', { name: e.target.value })}
          maxLength={100}
        />
        <TextInput
          label="Warehouse code"
          requirement="optional"
          name="warehouseCode"
          hint="Defaults to MAIN. Capital letters, digits, - and _."
          value={form.warehouse.code}
          onChange={(e) => patch('warehouse', { code: e.target.value.toUpperCase() })}
          error={errors['warehouse.code']}
          maxLength={30}
        />
      </section>
    </div>
  );
}

export function GstStep({ form, patch, errors }: StepProps) {
  const status = form.gst.status;
  const stateName = INDIA_STATE_CODES[form.address.stateCode];
  return (
    <div className="space-y-4">
      <Alert tone="warning" title="Review your tax configuration">
        Tax configuration should be reviewed before using CommerceBill for real transactions. The
        GST rates installed with CommerceBill are placeholders and have not been verified by the
        government or a tax professional.
      </Alert>
      <RadioGroup
        legend="GST registration status (required)"
        name="gstStatus"
        value={status}
        onChange={(value) => {
          const next = value as WizardForm['gst']['status'];
          // An unregistered business has no GSTIN: the server rejects one, so do not keep it.
          patch('gst', next === 'UNREGISTERED' ? { status: next, gstin: '' } : { status: next });
        }}
        error={errors['business.gstStatus']}
        options={[
          {
            value: 'REGISTERED',
            label: 'Registered',
            description: 'I have a GSTIN and charge GST on sales.',
          },
          {
            value: 'COMPOSITION',
            label: 'Composition scheme',
            description: 'Registered under the composition scheme.',
          },
          { value: 'UNREGISTERED', label: 'Not registered', description: 'I do not have a GSTIN.' },
        ]}
      />
      {(status === 'REGISTERED' || status === 'COMPOSITION') && (
        <TextInput
          label="GSTIN"
          requirement={status === 'REGISTERED' ? 'required' : 'optional'}
          name="gstin"
          hint="15 characters. It must start with your state code and contain your PAN."
          value={form.gst.gstin}
          onChange={(e) => patch('gst', { gstin: e.target.value.toUpperCase() })}
          error={errors['business.gstin']}
          maxLength={15}
          spellCheck={false}
          autoCapitalize="characters"
        />
      )}
      {status === 'UNREGISTERED' && (
        <p className="text-sm text-slate-600">No GSTIN is needed for an unregistered business.</p>
      )}
      <p className="text-sm text-slate-600">
        Default place of supply:{' '}
        <span className="font-medium text-slate-900">
          {stateName
            ? `${stateName} (${form.address.stateCode})`
            : 'choose your state on the Address step'}
        </span>
        . Checking the GSTIN here only tests its format and check character; it does not confirm the
        registration exists.
      </p>
    </div>
  );
}

export function FinancialYearStep({ form, patch, errors }: StepProps) {
  const summary = financialYearSummary(form.fy.startDate);
  return (
    <div className="max-w-md space-y-4">
      <TextInput
        label="First day of the financial year"
        requirement="required"
        name="fyStart"
        type="date"
        hint="In India the financial year normally starts on 1 April."
        value={form.fy.startDate}
        onChange={(e) => patch('fy', { startDate: e.target.value })}
        error={errors['financialYear.startDate']}
      />
      <div
        aria-live="polite"
        className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
      >
        {summary ? (
          <>
            <p className="font-medium text-slate-900">Financial year {summary.label}</p>
            <p className="text-slate-600">
              {summary.start} to {summary.end}
            </p>
          </>
        ) : (
          <p className="text-slate-600">Enter a valid date to see the financial year.</p>
        )}
      </div>
      <p className="text-sm text-slate-600">
        Setup creates this first financial year; each year runs for exactly twelve months.
      </p>
    </div>
  );
}

export function NumberingStep({ form, patch, errors }: StepProps) {
  const preview = invoicePreview(form);
  return (
    <div className="max-w-xl space-y-4">
      <TextInput
        label="Invoice prefix"
        requirement="optional"
        name="invoicePrefix"
        hint={`Letters, digits, / . _ - and {FY} for the financial year. Default: ${DEFAULT_INVOICE_PREFIX}`}
        value={form.numbering.invoicePrefix}
        onChange={(e) => patch('numbering', { invoicePrefix: e.target.value })}
        error={errors['numbering.invoicePrefix']}
        maxLength={40}
        spellCheck={false}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput
          label="First invoice number"
          requirement="optional"
          name="invoiceStartNumber"
          inputMode="numeric"
          value={form.numbering.invoiceStartNumber}
          onChange={(e) => patch('numbering', { invoiceStartNumber: e.target.value })}
          error={errors['numbering.invoiceStartNumber']}
        />
        <TextInput
          label="Number width (digits)"
          requirement="optional"
          name="numericWidth"
          inputMode="numeric"
          hint="Applies to every document type."
          value={form.numbering.numericWidth}
          onChange={(e) => patch('numbering', { numericWidth: e.target.value })}
          error={errors['numbering.numericWidth']}
        />
      </div>
      <div
        aria-live="polite"
        className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
      >
        <p className="text-slate-600">Example of your first invoice number</p>
        {'text' in preview ? (
          <p
            data-testid="invoice-preview"
            className="font-mono text-base font-semibold text-slate-900"
          >
            {preview.text}
          </p>
        ) : (
          <p className="text-slate-600">{preview.error}</p>
        )}
        <p className="mt-1 text-xs text-slate-500">
          This is only an example. No number is used until an invoice is posted.
        </p>
      </div>
      <p className="text-sm text-slate-600">
        Numbers restart at the first number each financial year; {'{FY}'} is replaced by the year,
        for example 2026-27. Credit notes, debit notes, purchase orders and payment receipts start
        with standard prefixes you can review later.
      </p>
    </div>
  );
}

export function AdministratorStep({ form, patch, errors }: StepProps) {
  const a = form.admin;
  return (
    <div className="max-w-xl space-y-4">
      <TextInput
        label="Administrator name"
        requirement="required"
        name="displayName"
        autoComplete="name"
        value={a.displayName}
        onChange={(e) => patch('admin', { displayName: e.target.value })}
        error={errors['administrator.displayName']}
        maxLength={100}
      />
      <TextInput
        label="Username"
        requirement="required"
        name="username"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        hint="Used to sign in: lower-case letters, digits, . _ - or @ (3-64 characters)."
        value={a.username}
        onChange={(e) => patch('admin', { username: e.target.value })}
        error={errors['administrator.username']}
        maxLength={64}
      />
      <TextInput
        label="Email"
        requirement="optional"
        name="email"
        type="email"
        autoComplete="off"
        value={a.email}
        onChange={(e) => patch('admin', { email: e.target.value })}
        error={errors['administrator.email']}
        maxLength={254}
      />
      <PasswordInput
        label="Password"
        requirement="required"
        name="new-password"
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. Avoid common passwords, your username and the product name; a long passphrase works well.`}
        value={a.password}
        onChange={(e) => patch('admin', { password: e.target.value })}
        error={errors['administrator.password']}
        maxLength={256}
      />
      <PasswordInput
        label="Confirm password"
        requirement="required"
        name="confirm-password"
        autoComplete="new-password"
        value={a.confirmPassword}
        onChange={(e) => patch('admin', { confirmPassword: e.target.value })}
        error={errors.confirmPassword}
        maxLength={256}
      />
      <p className="text-xs text-slate-500">
        The password is kept only in this window until setup completes. It is never saved in the
        setup draft.
      </p>
    </div>
  );
}

export const STEP_COMPONENTS: Partial<Record<StepKey, (p: StepProps) => React.ReactNode>> = {
  business: BusinessStep,
  address: AddressStep,
  gst: GstStep,
  fy: FinancialYearStep,
  numbering: NumberingStep,
  admin: AdministratorStep,
};
