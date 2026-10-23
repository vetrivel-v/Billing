import { useQuery, useQueryClient } from '@tanstack/react-query';
import { INDIA_STATE_CODES, type GstStatus } from '@commercebill/setup/browser';
import {
  Alert,
  Button,
  Card,
  CardGrid,
  LoadingState,
  PageHeader,
  SelectField,
  TextInput,
} from '@commercebill/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError, getBusinessProfile, putBusinessProfile } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import {
  FIELD_LABEL,
  NOT_STORED_YET,
  errorsFromProblems,
  formFromProfile,
  requestFromForm,
  validateForm,
  type ProfileErrors,
  type ProfileForm,
} from './model.js';

/** In code order (the table's own key order puts "10" before "01"). */
const STATES = Object.entries(INDIA_STATE_CODES).sort(([a], [b]) => a.localeCompare(b));

const GST_STATUS_LABEL: Record<GstStatus, string> = {
  REGISTERED: 'Registered (regular)',
  COMPOSITION: 'Registered under the composition scheme',
  UNREGISTERED: 'Not registered for GST',
};

const link =
  'font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600';

/**
 * Settings, Business Profile: the seller's legal identity, GST registration and primary place of business. Format checks only: CommerceBill
 * never contacts the GST portal, so a GSTIN that passes is correctly formed, not proven to exist or to belong to the business.
 * Changes apply to future documents; invoices already posted keep the seller details they were posted with.
 */
export function BusinessProfilePage() {
  const { authed } = useAuth();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => authed((t) => getBusinessProfile(t)),
    retry: false,
    staleTime: 0,
  });
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const profile = q.data;

  useEffect(() => {
    if (profile) setForm(formFromProfile(profile));
  }, [profile]);

  if (q.isPending) return <LoadingState label="Loading business profile" />;
  if (q.isError || !profile || !form) {
    return (
      <>
        <PageHeader title="Business Profile" />
        <div className="space-y-3">
          <Alert tone="error">{describeFailure(q.error)}</Alert>
          <Button variant="secondary" onClick={() => void q.refetch()}>
            Try again
          </Button>
        </div>
      </>
    );
  }

  const readOnly = !profile.canEdit;
  const set = <K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) => {
    setForm({ ...form, [key]: value });
    if (errors[key]) setErrors({ ...errors, [key]: undefined });
    setMessage(null);
  };
  const registered = form.gstStatus !== 'UNREGISTERED';

  async function save(e: FormEvent) {
    e.preventDefault();
    if (readOnly || busy || !form || !profile) return;
    const early = validateForm(form);
    if (Object.keys(early).length > 0) {
      setErrors(early);
      setMessage({ tone: 'error', text: 'Some details need correcting. Nothing was saved.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const r = await authed((t) => putBusinessProfile(t, requestFromForm(form, profile.version)));
      setErrors({});
      setMessage(
        r.changedFields.length === 0
          ? { tone: 'info', text: 'No changes to save.' }
          : {
              tone: 'success',
              text: `Saved. Changed: ${r.changedFields.map((f) => FIELD_LABEL[f] ?? f).join(', ')}.`,
            },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['business-profile'] }),
        queryClient.invalidateQueries({ queryKey: ['tax-configuration'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] }),
      ]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.problems.length > 0) {
        setErrors(errorsFromProblems(err.problems));
        setMessage({ tone: 'error', text: 'Some details need correcting. Nothing was saved.' });
      } else if (err instanceof ApiError && err.status === 409) {
        if (err.problems.length > 0) setErrors(errorsFromProblems(err.problems));
        setMessage({
          tone: 'error',
          text:
            err.problems.length > 0
              ? 'Some details need correcting. Nothing was saved.'
              : 'The profile was changed elsewhere. Reload it and try again. Nothing was saved.',
        });
      } else {
        setMessage({ tone: 'error', text: `${describeFailure(err)} Nothing was saved.` });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Business Profile"
        description="Who you are as a seller: legal name, GST registration and your place of business."
      />
      {readOnly && <Alert tone="info">You can view the business profile but not change it.</Alert>}
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <form onSubmit={(e) => void save(e)} noValidate className="mt-4 space-y-4">
        <CardGrid>
          <Card title="Business">
            <div className="space-y-3">
              <TextInput
                label="Legal business name"
                requirement="required"
                value={form.legalName}
                error={errors.legalName}
                disabled={readOnly}
                maxLength={200}
                onChange={(e) => set('legalName', e.target.value)}
              />
              <TextInput
                label="Trade / display name"
                requirement="optional"
                value={form.tradeName}
                error={errors.tradeName}
                disabled={readOnly}
                maxLength={200}
                onChange={(e) => set('tradeName', e.target.value)}
              />
              <TextInput
                label="Business type"
                requirement="optional"
                value={form.businessType}
                error={errors.businessType}
                disabled={readOnly}
                maxLength={100}
                onChange={(e) => set('businessType', e.target.value)}
              />
            </div>
          </Card>
          <Card title="GST registration">
            <div className="space-y-3">
              <SelectField
                label="GST registration status"
                requirement="required"
                value={form.gstStatus}
                error={errors.gstStatus}
                disabled={readOnly}
                onChange={(e) => set('gstStatus', e.target.value as GstStatus)}
              >
                {(Object.keys(GST_STATUS_LABEL) as GstStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {GST_STATUS_LABEL[s]}
                  </option>
                ))}
              </SelectField>
              <TextInput
                label="GSTIN"
                {...(registered ? { requirement: 'required' as const } : {})}
                value={registered ? form.gstin : ''}
                error={errors.gstin}
                disabled={readOnly || !registered}
                maxLength={15}
                autoCapitalize="characters"
                spellCheck={false}
                hint="Format check only. CommerceBill does not verify it with the GST portal."
                onChange={(e) => set('gstin', e.target.value.toUpperCase())}
              />
              <TextInput
                label="PAN"
                requirement="optional"
                value={form.pan}
                error={errors.pan}
                disabled={readOnly}
                maxLength={10}
                autoCapitalize="characters"
                spellCheck={false}
                onChange={(e) => set('pan', e.target.value.toUpperCase())}
              />
              <SelectField
                label="State"
                requirement="required"
                value={form.stateCode}
                error={errors.stateCode}
                disabled={readOnly}
                hint="The first two digits of the GSTIN must match this state."
                onChange={(e) => set('stateCode', e.target.value)}
              >
                {STATES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name} ({code})
                  </option>
                ))}
              </SelectField>
            </div>
          </Card>
          <Card title="Place of business">
            <div className="space-y-3">
              <TextInput
                label="Location name"
                requirement="required"
                value={form.locationName}
                error={errors.locationName}
                disabled={readOnly}
                maxLength={100}
                onChange={(e) => set('locationName', e.target.value)}
              />
              <TextInput
                label="Address line 1"
                requirement="required"
                value={form.addressLine1}
                error={errors.addressLine1}
                disabled={readOnly}
                maxLength={200}
                onChange={(e) => set('addressLine1', e.target.value)}
              />
              <TextInput
                label="Address line 2"
                requirement="optional"
                value={form.addressLine2}
                error={errors.addressLine2}
                disabled={readOnly}
                maxLength={200}
                onChange={(e) => set('addressLine2', e.target.value)}
              />
              <div className="grid grid-cols-2 gap-3">
                <TextInput
                  label="City"
                  requirement="optional"
                  value={form.city}
                  error={errors.city}
                  disabled={readOnly}
                  maxLength={100}
                  onChange={(e) => set('city', e.target.value)}
                />
                <TextInput
                  label="PIN code"
                  requirement="optional"
                  value={form.pinCode}
                  error={errors.pinCode}
                  disabled={readOnly}
                  maxLength={6}
                  inputMode="numeric"
                  onChange={(e) => set('pinCode', e.target.value)}
                />
              </div>
              <p className="text-xs text-slate-500">Country: India (fixed).</p>
            </div>
          </Card>
        </CardGrid>
        {!readOnly && (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save business profile'}
            </Button>
            <Link to="/settings" className={link}>
              Back to Settings
            </Link>
          </div>
        )}
        <div className="max-w-3xl space-y-1 text-sm text-slate-600">
          <p>
            Changes apply to <strong>future</strong> invoices and documents. Invoices already posted
            keep the seller details they were posted with.
          </p>
          <p>
            A correctly formatted GSTIN is not proof that it exists or belongs to you. The tax rates
            and categories still need review by a qualified professional.
          </p>
          <p>Not stored yet, so not shown here: {NOT_STORED_YET.join(', ')}.</p>
          <p>
            <Link to="/tax" className={link}>
              Tax configuration and production readiness
            </Link>
          </p>
        </div>
      </form>
    </>
  );
}
