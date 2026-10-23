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
  TextArea,
  TextInput,
} from '@commercebill/ui';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  ApiError,
  getTaxConfiguration,
  listTaxReviews,
  postBillingMode,
  postTaxReview,
  putHsnRequirement,
} from '../api.js';
import { READINESS_FIX } from '../backup/model.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import {
  CLASSIFICATION_LABEL,
  JURISDICTION_KIND_LABEL,
  REQUIREMENT_LABEL,
  SELLER_PROBLEM_LABEL,
  describeErrors,
  errorsFromProblems,
  formatDate,
  formatDateTime,
  shortFingerprint,
  validateReviewForm,
  type FieldErrors,
} from './model.js';

const REVIEW_PAGE = 10;
/** Requirements fixed on another screen (the tax review itself is on this page). */
const FIX_ELSEWHERE = {
  SELLER_REGISTERED_VALID: READINESS_FIX.SELLER_REGISTERED_VALID!,
  BACKUP_RESTORE_VERIFIED: READINESS_FIX.BACKUP_RESTORE_VERIFIED!,
} as Record<string, { to: string; screen: string; permission: string }>;
const link =
  'font-medium whitespace-nowrap text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600';

/**
 * Tax configuration: what is installed, whether a person has reviewed it, and why billing is DEMO-only. Confirming a review is a
 * business confirmation recorded here; it is NOT government verification and NOT a legal or tax certification.
 */
export function TaxConfigurationPage() {
  const { authed, can } = useAuth();
  const queryClient = useQueryClient();
  const canReview = can('tax.config.review');
  const canUpdate = can('tax.config.update');

  const config = useQuery({
    queryKey: ['tax-configuration'],
    queryFn: () => authed((t) => getTaxConfiguration(t)),
    retry: false,
    staleTime: 0,
  });
  const [reviewPage, setReviewPage] = useState(0);
  const reviews = useQuery({
    queryKey: ['tax-reviews', reviewPage],
    queryFn: () =>
      authed((t) => listTaxReviews(t, { limit: REVIEW_PAGE, offset: reviewPage * REVIEW_PAGE })),
    retry: false,
    staleTime: 0,
  });

  const [capacity, setCapacity] = useState('');
  const [note, setNote] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [summary, setSummary] = useState<{ title: string; items: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [hsnOpen, setHsnOpen] = useState(false);
  const [hsnAck, setHsnAck] = useState(false);
  const [hsnReason, setHsnReason] = useState('');
  const [hsnErrors, setHsnErrors] = useState<FieldErrors>({});
  const [hsnBusy, setHsnBusy] = useState(false);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tax-configuration'] }),
      queryClient.invalidateQueries({ queryKey: ['tax-reviews'] }),
    ]);
  };

  if (config.isPending) return <LoadingState label="Loading tax configuration" />;
  if (config.isError) {
    return (
      <>
        <PageHeader title="Tax configuration" />
        <div className="space-y-3">
          <Alert tone="error">{describeFailure(config.error)}</Alert>
          <Button variant="secondary" onClick={() => void config.refetch()}>
            Try again
          </Button>
        </div>
      </>
    );
  }
  const c = config.data;
  const state = c.review.state;
  const gate = c.gate;

  async function submitReview(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setDone(null);
    const local = validateReviewForm({ capacity, note, acknowledged });
    if (Object.keys(local).length > 0) {
      setErrors(local);
      setSummary({
        title: 'Please fix the following before confirming',
        items: describeErrors(local),
      });
      return;
    }
    setErrors({});
    setSummary(null);
    setSaving(true);
    try {
      await authed((t) =>
        postTaxReview(t, {
          capacity: capacity.trim(),
          note: note.trim() === '' ? null : note.trim(),
          acknowledged: true,
          noticeVersion: c.notice.version,
          expectedFingerprint: c.fingerprint,
        }),
      );
      setCapacity('');
      setNote('');
      setAcknowledged(false);
      setDone('Your review was recorded for the configuration shown on this page.');
      setReviewPage(0);
      await refresh();
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.problems.length > 0 &&
        (err.status === 400 || err.status === 409)
      ) {
        const fe = errorsFromProblems(err.problems);
        setErrors(fe);
        setSummary({
          title:
            err.status === 409
              ? 'Nothing was recorded'
              : 'The server could not accept some details',
          items: describeErrors(fe),
        });
        if (err.status === 409) await refresh(); // show what changed
      } else if (!(err instanceof ApiError && err.status === 401)) {
        setSummary({ title: describeFailure(err), items: [] });
      }
    } finally {
      setSaving(false);
    }
  }

  async function changeMode(mode: 'DEMO' | 'PRODUCTION') {
    setModeBusy(true);
    setModeError(null);
    try {
      await authed((t) => postBillingMode(t, mode));
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setModeError(
          'Production billing is not available: ' +
            err.problems
              .map((p) => REQUIREMENT_LABEL[p.field] ?? p.field)
              .join('; ')
              .toLowerCase() +
            '.',
        );
      } else if (!(err instanceof ApiError && err.status === 401))
        setModeError(describeFailure(err));
    } finally {
      setModeBusy(false);
    }
  }

  async function changeHsnPolicy(required: boolean) {
    setHsnBusy(true);
    setHsnErrors({});
    try {
      await authed((t) =>
        putHsnRequirement(
          t,
          required
            ? { required: true }
            : { required: false, acknowledged: hsnAck, reason: hsnReason.trim() },
        ),
      );
      setHsnOpen(false);
      setHsnAck(false);
      setHsnReason('');
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.problems.length > 0)
        setHsnErrors(errorsFromProblems(err.problems));
      else if (!(err instanceof ApiError && err.status === 401))
        setHsnErrors({ reason: describeFailure(err) });
    } finally {
      setHsnBusy(false);
    }
  }

  const stateBadge =
    state === 'CURRENT' ? (
      <Badge tone="success">Reviewed</Badge>
    ) : state === 'STALE' ? (
      <Badge tone="warning">Review out of date</Badge>
    ) : (
      <Badge tone="warning">Not reviewed</Badge>
    );

  return (
    <>
      <PageHeader
        title="Tax configuration"
        description="The tax categories, rates and rules CommerceBill uses, and whether a person has reviewed them."
        actions={
          <Link to="/tax/hsn-sac" className={link}>
            HSN/SAC codes
          </Link>
        }
      />
      <div className="space-y-4">
        {gate.mode === 'DEMO' ? (
          <Alert tone="warning" title="Demo billing only">
            <p>
              Invoices can be tried out in demo mode, but they are marked DEMO and are not real tax
              invoices. Production billing stays unavailable until every requirement below is met.
            </p>
          </Alert>
        ) : (
          <Alert tone="info" title="Production billing is on">
            <p>
              Billing is in production mode. A change to the tax configuration makes the review out
              of date.
            </p>
          </Alert>
        )}

        <Card title="Production billing requirements">
          <ul className="space-y-1.5 text-sm" aria-label="Production billing requirements">
            {gate.requirements.map((r) => (
              <li key={r.code} className="flex items-start gap-2">
                <span className="mt-0.5">
                  <Badge tone={r.met ? 'success' : 'warning'}>{r.met ? 'Met' : 'Not met'}</Badge>
                </span>
                <span className="text-slate-800">{REQUIREMENT_LABEL[r.code] ?? r.code}</span>
                {!r.met && FIX_ELSEWHERE[r.code] && can(FIX_ELSEWHERE[r.code]!.permission) && (
                  <Link
                    to={FIX_ELSEWHERE[r.code]!.to}
                    className={link}
                    aria-label={`Fix: ${REQUIREMENT_LABEL[r.code] ?? r.code} (opens ${FIX_ELSEWHERE[r.code]!.screen})`}
                  >
                    Fix
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {gate.sellerProblems.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-sm text-amber-900">
              {gate.sellerProblems.map((p) => (
                <li key={p}>{SELLER_PROBLEM_LABEL[p] ?? p}</li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">
            These checks are an internal safety gate. Meeting them is not a statement that your
            invoices are legally correct.
          </p>
          {canReview && (
            <div className="mt-3 flex items-center gap-3">
              {gate.mode === 'DEMO' ? (
                <Button
                  variant="secondary"
                  loading={modeBusy}
                  onClick={() => void changeMode('PRODUCTION')}
                >
                  Switch to production billing
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  loading={modeBusy}
                  onClick={() => void changeMode('DEMO')}
                >
                  Return to demo billing
                </Button>
              )}
              <span className="text-xs text-slate-500">
                Current mode: {gate.mode === 'DEMO' ? 'Demo' : 'Production'}
              </span>
            </div>
          )}
          {modeError && (
            <div className="mt-3">
              <Alert tone="error">{modeError}</Alert>
            </div>
          )}
        </Card>

        <Card title="Review status">
          <div className="flex flex-wrap items-center gap-3">
            {stateBadge}
            <span className="text-sm text-slate-600">
              Configuration fingerprint{' '}
              <code className="font-mono text-xs" title={c.fingerprint}>
                {shortFingerprint(c.fingerprint)}
              </code>
            </span>
          </div>
          {state === 'STALE' && (
            <div className="mt-3">
              <Alert tone="warning">
                The tax configuration has changed since it was last reviewed. It needs to be
                reviewed again before production billing.
              </Alert>
            </div>
          )}
          {c.review.latest ? (
            <dl className="mt-3 grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
              <dt className="text-slate-500">Last reviewed by</dt>
              <dd>
                {c.review.latest.reviewedByName}{' '}
                <span className="text-slate-500">({c.review.latest.reviewerCapacity})</span>
              </dd>
              <dt className="text-slate-500">When</dt>
              <dd>{formatDateTime(c.review.latest.reviewedAt)}</dd>
              <dt className="text-slate-500">Rules reviewed</dt>
              <dd>
                {c.review.latest.rulesetVersion} / engine {c.review.latest.engineVersion}
              </dd>
              {c.review.latest.note && (
                <>
                  <dt className="text-slate-500">Note</dt>
                  <dd className="break-words">{c.review.latest.note}</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="mt-3 text-sm text-slate-600">
              Nobody has reviewed this tax configuration yet.
            </p>
          )}
        </Card>

        <Card title="Tax categories and rates">
          <Alert tone="warning">
            The rates installed with CommerceBill are placeholders. They are not verified against
            any government source by CommerceBill. Have them checked by an accountant or tax
            professional before production use.
          </Alert>
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Tax categories and effective-dated rates</caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                <tr>
                  <th scope="col" className="px-2.5 py-2">
                    Category
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Treatment
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    GST rate
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Effective
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Source
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    Review
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {c.categories.flatMap((cat) =>
                  cat.rates.length === 0
                    ? [
                        <tr key={cat.id}>
                          <td className="px-2.5 py-2">
                            <div className="font-medium text-slate-900">{cat.name}</div>
                            <div className="font-mono text-xs text-slate-500">
                              {cat.code}
                              {!cat.isActive && <span className="ml-2 font-sans">(inactive)</span>}
                            </div>
                          </td>
                          <td className="px-2.5 py-2">
                            {CLASSIFICATION_LABEL[cat.classification] ?? cat.classification}
                          </td>
                          <td className="px-2.5 py-2 text-right text-slate-500">no rate</td>
                          <td colSpan={3} />
                        </tr>,
                      ]
                    : cat.rates.map((r, i) => (
                        <tr key={r.id} className="align-top">
                          <td className="px-2.5 py-2">
                            {i === 0 && (
                              <>
                                <div className="font-medium text-slate-900">{cat.name}</div>
                                <div className="font-mono text-xs text-slate-500">
                                  {cat.code}
                                  {!cat.isActive && (
                                    <span className="ml-2 font-sans">(inactive)</span>
                                  )}
                                </div>
                              </>
                            )}
                          </td>
                          <td className="px-2.5 py-2">
                            {i === 0 &&
                              (CLASSIFICATION_LABEL[cat.classification] ?? cat.classification)}
                          </td>
                          <td className="px-2.5 py-2 text-right tabular-nums">
                            {cat.classification === 'STANDARD'
                              ? `${r.ratePercent.replace(/\.?0+$/, '')}%`
                              : '-'}
                            {r.cessPercent !== '0.0000' && (
                              <div className="text-xs text-amber-800">
                                cess {r.cessPercent} (not supported)
                              </div>
                            )}
                          </td>
                          <td className="px-2.5 py-2 whitespace-nowrap">
                            {formatDate(r.effectiveFrom)} to {formatDate(r.effectiveTo)}
                          </td>
                          <td className="px-2.5 py-2">
                            {r.origin === 'REFERENCE_SEED'
                              ? 'Installed placeholder'
                              : 'Entered by a person'}
                          </td>
                          <td className="px-2.5 py-2">
                            <Badge tone={r.reviewStatus === 'REVIEWED' ? 'success' : 'warning'}>
                              {r.reviewStatus === 'REVIEWED' ? 'Reviewed' : 'Unreviewed'}
                            </Badge>
                          </td>
                        </tr>
                      )),
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Rates cannot be edited. A rate change is a new row with a new start date, and the old
            row keeps its end date, so invoices already issued keep the rate they used.
          </p>
        </Card>

        <Card title="HSN/SAC policy">
          <p className="text-sm text-slate-800">
            {c.hsnPolicy.required ? (
              <>
                Every invoice line must carry an <strong>HSN/SAC code</strong>. This is the default.
              </>
            ) : (
              <>
                HSN/SAC codes are <strong>not required</strong> on invoice lines.
                {c.hsnPolicy.reason && (
                  <span className="block text-slate-600">
                    Reason recorded: {c.hsnPolicy.reason}
                  </span>
                )}
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            CommerceBill checks that a code is present and is the right kind. It does not check how
            many digits your turnover requires. Manage your codes under{' '}
            <Link to="/tax/hsn-sac" className={link}>
              HSN/SAC codes
            </Link>
            .
          </p>
          {canUpdate && (
            <div className="mt-3">
              {c.hsnPolicy.required ? (
                hsnOpen ? (
                  <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3">
                    <p className="text-sm text-amber-900">
                      Turning this off lets invoices be issued without HSN/SAC codes. This is
                      recorded with your reason.
                    </p>
                    <Checkbox
                      label="I understand and accept this"
                      checked={hsnAck}
                      onChange={(e) => setHsnAck(e.target.checked)}
                    />
                    {hsnErrors.acknowledged && (
                      <p className="text-xs font-medium text-red-700">{hsnErrors.acknowledged}</p>
                    )}
                    <TextInput
                      label="Reason"
                      requirement="required"
                      value={hsnReason}
                      maxLength={300}
                      onChange={(e) => setHsnReason(e.target.value)}
                      error={hsnErrors.reason}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        loading={hsnBusy}
                        onClick={() => void changeHsnPolicy(false)}
                      >
                        Turn off the requirement
                      </Button>
                      <Button variant="ghost" onClick={() => setHsnOpen(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="secondary" onClick={() => setHsnOpen(true)}>
                    Do not require HSN/SAC…
                  </Button>
                )
              ) : (
                <Button
                  variant="secondary"
                  loading={hsnBusy}
                  onClick={() => void changeHsnPolicy(true)}
                >
                  Require HSN/SAC again
                </Button>
              )}
            </div>
          )}
        </Card>

        <Card title="Jurisdiction rules">
          <p className="text-sm text-slate-700">
            Rule set <code className="font-mono text-xs">{c.jurisdictions.id}</code> version{' '}
            {c.jurisdictions.version} <Badge tone="warning">Unreviewed</Badge> decides whether a
            sale is CGST + SGST, CGST + UTGST or IGST. It is part of what you review.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Calculation rules {c.engine.rulesetVersion} (engine {c.engine.engineVersion}, rounding{' '}
            {c.engine.roundingPolicyId}) are a provisional CommerceBill rule set, approved for
            implementation only. They are not professional tax advice.
          </p>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-brand-700">
              Show the {c.jurisdictions.entries.length} listed places
            </summary>
            <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Jurisdiction rules</caption>
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                  <tr>
                    <th scope="col" className="px-2.5 py-1.5">
                      Code
                    </th>
                    <th scope="col" className="px-2.5 py-1.5">
                      Place
                    </th>
                    <th scope="col" className="px-2.5 py-1.5">
                      Treatment
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {c.jurisdictions.entries.map((j) => (
                    <tr key={j.code}>
                      <td className="px-2.5 py-1.5 font-mono text-xs">{j.code}</td>
                      <td className="px-2.5 py-1.5">{j.name}</td>
                      <td className="px-2.5 py-1.5 text-slate-600">
                        {JURISDICTION_KIND_LABEL[j.kind] ?? j.kind}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </Card>

        {canReview ? (
          <Card title="Confirm review">
            {done && (
              <div className="mb-3">
                <Alert tone="success">{done}</Alert>
              </div>
            )}
            {summary && (
              <div className="mb-3">
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
              onSubmit={submitReview}
              noValidate
              className="max-w-2xl space-y-3"
              aria-label="Confirm tax review"
            >
              <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
                {c.notice.text}
              </p>
              <TextInput
                label="Your capacity"
                requirement="required"
                hint="For example: owner, accountant, tax consultant."
                value={capacity}
                maxLength={120}
                onChange={(e) => setCapacity(e.target.value)}
                disabled={saving}
                error={errors.capacity}
              />
              <TextArea
                label="Note"
                requirement="optional"
                value={note}
                maxLength={1000}
                onChange={(e) => setNote(e.target.value)}
                disabled={saving}
              />
              <Checkbox
                label="I have read and I confirm the statement above"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                disabled={saving}
              />
              {errors.acknowledged && (
                <p className="text-xs font-medium text-red-700">{errors.acknowledged}</p>
              )}
              <Button type="submit" loading={saving}>
                {saving ? 'Recording' : 'Record my review'}
              </Button>
            </form>
          </Card>
        ) : (
          <Alert tone="info">
            Only people with the tax review permission can confirm the review.
          </Alert>
        )}

        <Card title="Review history">
          {reviews.isPending ? (
            <LoadingState label="Loading review history" />
          ) : reviews.isError ? (
            <Alert tone="error">{describeFailure(reviews.error)}</Alert>
          ) : reviews.data.total === 0 ? (
            <EmptyState title="No reviews yet">
              Reviews are listed here, newest first, and can never be edited or deleted.
            </EmptyState>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Review history</caption>
                  <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                    <tr>
                      <th scope="col" className="px-2.5 py-2">
                        When
                      </th>
                      <th scope="col" className="px-2.5 py-2">
                        Reviewer
                      </th>
                      <th scope="col" className="px-2.5 py-2">
                        Capacity
                      </th>
                      <th scope="col" className="px-2.5 py-2">
                        Rules
                      </th>
                      <th scope="col" className="px-2.5 py-2">
                        Configuration
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {reviews.data.reviews.map((r) => (
                      <tr key={r.id}>
                        <td className="px-2.5 py-2 whitespace-nowrap">
                          {formatDateTime(r.reviewedAt)}
                        </td>
                        <td className="px-2.5 py-2">{r.reviewedByName}</td>
                        <td className="px-2.5 py-2">{r.reviewerCapacity}</td>
                        <td className="px-2.5 py-2 whitespace-nowrap">{r.rulesetVersion}</td>
                        <td className="px-2.5 py-2 font-mono text-xs" title={r.fingerprint}>
                          {shortFingerprint(r.fingerprint)}
                          {r.fingerprint === c.fingerprint && (
                            <span className="ml-2 font-sans text-emerald-700">current</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
                <span aria-live="polite">
                  Showing {reviews.data.offset + 1}-
                  {reviews.data.offset + reviews.data.reviews.length} of {reviews.data.total}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    disabled={reviewPage === 0}
                    onClick={() => setReviewPage((p) => Math.max(0, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={
                      reviews.data.offset + reviews.data.reviews.length >= reviews.data.total
                    }
                    onClick={() => setReviewPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
