import { Alert, Button, Card, LoadingState, Steps } from '@commercebill/ui';
import { INDIA_STATE_CODES } from '@commercebill/setup/browser';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  ApiUnreachableError,
  completeSetup,
  getSetupDraft,
  saveSetupDraft,
} from '../api.js';
import { RATE_LIMITED, SERVICE_UNREACHABLE, UNEXPECTED } from '../messages.js';
import {
  STEPS,
  UNSUPPORTED_AT_SETUP,
  buildDraftData,
  buildSubmitBody,
  describeErrors,
  emptyForm,
  errorsForStep,
  financialYearSummary,
  firstStepWithProblems,
  formFromDraft,
  invoicePreview,
  ruleText,
  stepForField,
  validateForm,
  type FieldErrors,
  type StepKey,
  type WizardForm,
} from './model.js';
import { STEP_COMPONENTS, WelcomeStep, type Patch } from './steps.js';

type DraftState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; data: Record<string, Record<string, unknown>> | null; discarded: boolean };

type SaveState = 'idle' | 'saved' | 'failed';

const stepIndex = (key: StepKey) => STEPS.findIndex((s) => s.key === key);

export interface SetupWizardProps {
  /** Called with the new administrator's username after the atomic completion. NO session exists yet. */
  onCompleted: (username: string) => void;
  /** Called when the server says setup was already completed elsewhere: go back to the launch check. */
  onAlreadyCompleted: () => void;
}

/**
 * First-run setup wizard over the Task 1.4 API: resumable non-secret draft (GET/PUT /setup/draft) and one atomic
 * POST /setup/complete. The administrator password lives only in this component's memory and is never saved in the
 * draft, browser storage, the URL or the review page.
 */
export function SetupWizard({ onCompleted, onAlreadyCompleted }: SetupWizardProps) {
  const [draft, setDraft] = useState<DraftState>({ kind: 'loading' });
  const [form, setForm] = useState<WizardForm>(() => emptyForm());
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [summary, setSummary] = useState<{ title: string; items: string[] } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [alreadyDone, setAlreadyDone] = useState(false);
  const version = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const submitLock = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusProblem = useRef(false);

  const loadDraft = useCallback(async () => {
    setDraft({ kind: 'loading' });
    try {
      const r = await getSetupDraft();
      version.current = r.draft?.version ?? 0;
      setDraft({ kind: 'ready', data: r.draft?.data ?? null, discarded: r.discarded });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return onAlreadyCompleted();
      setDraft({
        kind: 'failed',
        message: err instanceof ApiUnreachableError ? SERVICE_UNREACHABLE : UNEXPECTED,
      });
    }
  }, [onAlreadyCompleted]);

  useEffect(() => {
    void loadDraft();
  }, [loadDraft]);

  // Focus management: a new step moves focus to its heading; a failed Continue moves it to the first problem.
  useEffect(() => {
    if (focusProblem.current) {
      focusProblem.current = false;
      const bad = document.querySelector<HTMLElement>(
        '[aria-invalid="true"], fieldset[aria-describedby]',
      );
      if (bad) {
        (bad.matches('fieldset') ? bad.querySelector('input') : bad)?.focus();
        return;
      }
    }
    headingRef.current?.focus();
  }, [step, summary]);

  const patch: Patch = (section, values) => {
    setForm((f) => ({ ...f, [section]: { ...f[section], ...values } }));
    // A changed field no longer carries its old error; the server/Continue re-check will find any that remain.
    setErrors({});
  };

  /**
   * Saves are applied one after another, in the order the user made them: two quick clicks must neither collide on the
   * draft version nor let an older save overwrite a newer one. A failed save never blocks the user (the data is
   * still in this window); it resolves to false instead of throwing.
   */
  function enqueueSave(body: unknown): Promise<boolean> {
    const run = saveChain.current.then(() => persistDraft(body));
    saveChain.current = run.then(() => undefined);
    return run;
  }

  async function persistDraft(body: unknown): Promise<boolean> {
    try {
      const r = await saveSetupDraft(body, version.current);
      version.current = r.version;
      setSaveState('saved');
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'DB_0002') {
        try {
          const fresh = await getSetupDraft(); // someone else saved: ours wins, on top of their version
          const r = await saveSetupDraft(body, fresh.draft?.version ?? 0);
          version.current = r.version;
          setSaveState('saved');
          return true;
        } catch {
          /* fall through */
        }
      }
      if (err instanceof ApiError && err.status === 409 && err.code === 'BIZ_0001') {
        setAlreadyDone(true);
        return false;
      }
      setSaveState('failed');
      return false;
    }
  }

  const saveProgress = (current: WizardForm) => enqueueSave(buildDraftData(current));

  function go(to: number) {
    setErrors({});
    setSummary(null);
    setStep(to);
  }

  function next() {
    const key = STEPS[step]!.key;
    const stepErrors = errorsForStep(validateForm(form), key);
    if (Object.keys(stepErrors).length > 0) {
      focusProblem.current = true;
      setErrors(stepErrors);
      setSummary({
        title: 'Please fix the following before continuing',
        items: describeErrors(stepErrors),
      });
      return;
    }
    void saveProgress(form);
    go(step + 1);
  }

  function back() {
    if (step > 0) {
      void saveProgress(form);
      go(step - 1);
    }
  }

  function resume(data: Record<string, Record<string, unknown>>) {
    const restored = formFromDraft(data);
    setForm(restored);
    // Land on the first step that still needs something. A draft never holds the password, so a otherwise
    // complete draft lands on the Administrator step, where the password is entered again.
    const problem = firstStepWithProblems(validateForm(restored));
    go(stepIndex(problem ?? 'review'));
  }

  async function startOver() {
    setConfirmingReset(false);
    const fresh = emptyForm();
    setForm(fresh);
    if (!(await enqueueSave({}))) await loadDraft();
    setDraft((d) => (d.kind === 'ready' ? { kind: 'ready', data: null, discarded: false } : d));
    go(1);
  }

  async function complete() {
    if (submitLock.current) return; // one submission at a time, however fast the clicks
    const all = validateForm(form);
    const firstBad = firstStepWithProblems(all);
    if (firstBad) {
      setErrors(errorsForStep(all, firstBad));
      setSummary({
        title: 'Some details need attention before setup can be completed',
        items: describeErrors(all),
      });
      focusProblem.current = true;
      setStep(stepIndex(firstBad));
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    setSummary(null);
    try {
      const result = await completeSetup(buildSubmitBody(form));
      setForm(emptyForm()); // drop the password and every entered value from memory
      onCompleted(result.administratorUsername);
      return;
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.problems.length > 0) {
        const fe: FieldErrors = {};
        const general: string[] = [];
        for (const p of err.problems) {
          const text = ruleText(p.field, p.rule);
          if (stepForField(p.field)) fe[p.field] = fe[p.field] ? `${fe[p.field]} ${text}` : text;
          else general.push(text);
        }
        const target = firstStepWithProblems(fe);
        if (fe['administrator.password']) {
          setForm((f) => ({ ...f, admin: { ...f.admin, password: '', confirmPassword: '' } }));
        }
        setErrors(target ? errorsForStep(fe, target) : {});
        setSummary({
          title: 'The server could not accept some details',
          items: [...describeErrors(fe), ...general],
        });
        focusProblem.current = true;
        if (target) setStep(stepIndex(target));
      } else if (err instanceof ApiError && err.status === 409) {
        setAlreadyDone(true);
      } else if (err instanceof ApiError && (err.status === 429 || err.code === 'AUTH_0003')) {
        setSummary({ title: RATE_LIMITED, items: [] });
      } else if (err instanceof ApiUnreachableError) {
        setSummary({ title: SERVICE_UNREACHABLE, items: [] });
      } else {
        setSummary({ title: UNEXPECTED, items: [] });
      }
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  if (alreadyDone) {
    return (
      <Frame>
        <Alert tone="info" title="Setup is already complete">
          This installation was set up already, so the wizard is closed.
        </Alert>
        <Button onClick={onAlreadyCompleted}>Go to sign in</Button>
      </Frame>
    );
  }
  if (draft.kind === 'loading') {
    return (
      <Frame>
        <LoadingState label="Loading setup" />
      </Frame>
    );
  }
  if (draft.kind === 'failed') {
    return (
      <Frame>
        <Alert tone="error">{draft.message}</Alert>
        <Button onClick={() => void loadDraft()}>Try again</Button>
      </Frame>
    );
  }

  const current = STEPS[step]!;
  const Body = STEP_COMPONENTS[current.key];
  const hasDraft = draft.data !== null && Object.keys(draft.data).length > 0;

  return (
    <div className="flex min-h-screen items-start justify-center bg-slate-100 p-6">
      <div className="flex w-full max-w-5xl gap-6">
        <aside className="hidden w-60 shrink-0 md:block">
          <p className="mb-4 px-3 text-base font-semibold text-brand-700">CommerceBill setup</p>
          <Steps steps={[...STEPS]} current={step} label="Setup progress" />
        </aside>
        <main className="min-w-0 flex-1">
          <Card className="p-6">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Step {step + 1} of {STEPS.length}
            </p>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="mb-4 text-2xl font-semibold text-slate-900 outline-none"
            >
              {step === 0 ? 'CommerceBill setup' : current.label}
            </h1>
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
            {current.key === 'welcome' && (
              <WelcomeStep>
                {draft.discarded && (
                  <Alert tone="warning">
                    A previously saved draft could not be used and was discarded. Please start
                    again.
                  </Alert>
                )}
                {hasDraft && (
                  <Alert tone="info" title="You have a saved draft">
                    Resume to restore the details you entered. The administrator password is never
                    saved, so you will enter it again.
                  </Alert>
                )}
                {confirmingReset && (
                  <Alert tone="warning" title="Start over?">
                    <p>This permanently discards the saved draft and clears every field.</p>
                    <div className="mt-2 flex gap-2">
                      <Button variant="secondary" onClick={() => void startOver()}>
                        Yes, discard and start over
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmingReset(false)}>
                        Keep my draft
                      </Button>
                    </div>
                  </Alert>
                )}
              </WelcomeStep>
            )}
            {current.key === 'review' ? (
              <ReviewStep form={form} onEdit={(k) => go(stepIndex(k))} />
            ) : (
              Body && Body({ form, patch, errors })
            )}
            <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-4">
              <div className="flex items-center gap-3">
                {step > 0 && (
                  <Button variant="secondary" onClick={back} disabled={submitting}>
                    Back
                  </Button>
                )}
                <span aria-live="polite" className="text-xs text-slate-500">
                  {saveState === 'saved' && 'Progress saved on this computer.'}
                  {saveState === 'failed' &&
                    'Progress could not be saved; your entries are still on screen.'}
                </span>
              </div>
              <div className="flex gap-3">
                {current.key === 'welcome' && hasDraft && draft.data && (
                  <>
                    <Button variant="secondary" onClick={() => setConfirmingReset(true)}>
                      Start Over
                    </Button>
                    <Button onClick={() => resume(draft.data!)}>Resume Setup</Button>
                  </>
                )}
                {current.key === 'welcome' && !hasDraft && (
                  <Button onClick={() => go(1)}>Start Setup</Button>
                )}
                {current.key !== 'welcome' && current.key !== 'review' && (
                  <Button onClick={next}>Continue</Button>
                )}
                {current.key === 'review' && (
                  <Button onClick={() => void complete()} loading={submitting}>
                    {submitting ? 'Completing setup' : 'Complete Setup'}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        </main>
      </div>
    </div>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-lg space-y-4 rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold text-brand-700">CommerceBill setup</p>
        {children}
      </div>
    </div>
  );
}

function Group({
  title,
  step,
  onEdit,
  children,
}: {
  title: string;
  step: StepKey;
  onEdit: (k: StepKey) => void;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-md border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        <Button variant="ghost" onClick={() => onEdit(step)} aria-label={`Edit ${title}`}>
          Edit
        </Button>
      </div>
      <dl className="grid grid-cols-[11rem_1fr] gap-y-1 text-sm">{children}</dl>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-words font-medium text-slate-900">{value || '-'}</dd>
    </>
  );
}

const GST_LABEL = {
  REGISTERED: 'Registered',
  COMPOSITION: 'Composition scheme',
  UNREGISTERED: 'Not registered',
} as const;

/** Read-only summary. It deliberately shows NO password - only whether one has been entered. */
function ReviewStep({ form, onEdit }: { form: WizardForm; onEdit: (k: StepKey) => void }) {
  const fy = financialYearSummary(form.fy.startDate);
  const preview = invoicePreview(form);
  const state = INDIA_STATE_CODES[form.address.stateCode];
  const address = [
    form.address.addressLine1,
    form.address.addressLine2,
    form.address.city,
    form.address.pinCode,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <div className="space-y-3">
      <Alert tone="warning">
        Review these details carefully. Completing setup will create the initial business and
        administrator.
      </Alert>
      <Group title="Business" step="business" onEdit={onEdit}>
        <Row label="Legal name" value={form.business.legalName} />
        <Row label="Trade name" value={form.business.tradeName} />
        <Row label="Business type" value={form.business.businessType} />
        <Row label="PAN" value={form.business.pan} />
      </Group>
      <Group title="Address" step="address" onEdit={onEdit}>
        <Row label="Location" value={form.address.locationName || 'Head Office'} />
        <Row label="Address" value={address} />
        <Row label="State" value={state ? `${state} (${form.address.stateCode})` : ''} />
        <Row label="Country" value="India" />
        <Row
          label="Warehouse"
          value={`${form.warehouse.name || 'Main Warehouse'} (${form.warehouse.code || 'MAIN'})`}
        />
      </Group>
      <Group title="GST" step="gst" onEdit={onEdit}>
        <Row label="Registration" value={form.gst.status ? GST_LABEL[form.gst.status] : ''} />
        <Row label="GSTIN" value={form.gst.gstin} />
        <Row label="Place of supply" value={state ?? ''} />
      </Group>
      <Group title="Financial year" step="fy" onEdit={onEdit}>
        <Row label="Year" value={fy ? fy.label : ''} />
        <Row label="Period" value={fy ? `${fy.start} to ${fy.end}` : ''} />
      </Group>
      <Group title="Invoice numbering" step="numbering" onEdit={onEdit}>
        <Row label="Prefix" value={form.numbering.invoicePrefix} />
        <Row label="First number" value={form.numbering.invoiceStartNumber} />
        <Row label="Width" value={form.numbering.numericWidth} />
        <Row label="Example" value={'text' in preview ? preview.text : ''} />
      </Group>
      <Group title="Administrator" step="admin" onEdit={onEdit}>
        <Row label="Name" value={form.admin.displayName} />
        <Row label="Username" value={form.admin.username} />
        <Row label="Email" value={form.admin.email} />
        <Row
          label="Password"
          value={
            form.admin.password ? 'Entered (hidden)' : 'Not entered - required before completing'
          }
        />
      </Group>
      <Alert tone="info" title="Not part of setup yet">
        {UNSUPPORTED_AT_SETUP.join('; ')}. Nothing is claimed as active for these.
      </Alert>
    </div>
  );
}
