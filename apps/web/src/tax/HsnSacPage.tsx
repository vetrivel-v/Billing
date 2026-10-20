import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HsnSacView } from '@commercebill/shared-types';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingState,
  PageHeader,
  RadioGroup,
  SelectField,
  TextInput,
} from '@commercebill/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  ApiError,
  createHsnEntry,
  listHsnEntries,
  reviewHsnEntry,
  updateHsnEntry,
} from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import {
  describeErrors,
  errorsFromProblems,
  formatDateTime,
  validateHsnForm,
  type FieldErrors,
} from './model.js';

const PAGE_SIZE = 25;
const link =
  'font-medium whitespace-nowrap text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type Editing = { mode: 'new' } | { mode: 'edit'; entry: HsnSacView } | null;

/**
 * The organization's own HSN/SAC list. Nothing is installed: every code is typed in by a person (no catalogue is bundled and
 * none is invented). Code and type never change after creation; entries are made inactive, never deleted.
 */
export function HsnSacPage() {
  const { authed, can } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = can('tax.config.update');
  const canReview = can('tax.config.review');

  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 300);
  const [kind, setKind] = useState<'' | 'HSN' | 'SAC'>('');
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [paging, setPaging] = useState({ term, page: 0 });
  if (paging.term !== term) setPaging({ term, page: 0 });
  const page = paging.term === term ? paging.page : 0;
  const setPage = (next: number | ((p: number) => number)) =>
    setPaging({ term, page: typeof next === 'function' ? next(page) : next });

  const query = {
    ...(term ? { search: term } : {}),
    ...(kind ? { kind } : {}),
    ...(status === 'all' ? {} : { isActive: status === 'active' }),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const result = useQuery({
    queryKey: ['hsn-sac', query],
    queryFn: () => authed((t) => listHsnEntries(t, query)),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = result.data;
  const filtered = Boolean(term) || kind !== '' || status !== 'active';

  const [editing, setEditing] = useState<Editing>(null);
  const [code, setCode] = useState('');
  const [entryKind, setEntryKind] = useState<'HSN' | 'SAC'>('HSN');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [summary, setSummary] = useState<{ title: string; items: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const lock = useRef(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['hsn-sac'] });

  const open = (e: Editing) => {
    setEditing(e);
    setErrors({});
    setSummary(null);
    setNotice(null);
    setActionError(null);
    if (e?.mode === 'edit') {
      setCode(e.entry.code);
      setEntryKind(e.entry.kind);
      setDescription(e.entry.description ?? '');
    } else {
      setCode('');
      setEntryKind('HSN');
      setDescription('');
    }
  };

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (lock.current || !editing) return;
    const creating = editing.mode === 'new';
    const local = validateHsnForm({ code, kind: entryKind, description }, creating);
    if (Object.keys(local).length > 0) {
      setErrors(local);
      setSummary({ title: 'Please fix the following before saving', items: describeErrors(local) });
      return;
    }
    setErrors({});
    setSummary(null);
    lock.current = true;
    setSaving(true);
    try {
      if (creating) {
        await authed((t) =>
          createHsnEntry(t, {
            code: code.trim(),
            kind: entryKind,
            description: description.trim() === '' ? null : description.trim(),
          }),
        );
        setNotice(`Code ${code.trim()} was added.`);
      } else {
        const entry = (editing as { entry: HsnSacView }).entry;
        await authed((t) =>
          updateHsnEntry(t, entry.id, {
            expectedVersion: entry.version,
            description: description.trim() === '' ? null : description.trim(),
          }),
        );
        setNotice(`Code ${entry.code} was saved.`);
      }
      setEditing(null);
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
          title: 'The server could not accept some details',
          items: describeErrors(fe),
        });
      } else if (err instanceof ApiError && err.status === 409) {
        setSummary({
          title: 'This entry was changed by someone else',
          items: ['Reload the list and try again.'],
        });
        await refresh();
      } else if (!(err instanceof ApiError && err.status === 401)) {
        setSummary({ title: describeFailure(err), items: [] });
      }
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  async function toggleActive(e: HsnSacView) {
    setActionError(null);
    setNotice(null);
    try {
      await authed((t) =>
        updateHsnEntry(t, e.id, { expectedVersion: e.version, isActive: !e.isActive }),
      );
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setActionError('This entry was changed by someone else. The list was reloaded.');
        await refresh();
      } else if (!(err instanceof ApiError && err.status === 401))
        setActionError(describeFailure(err));
    }
  }

  async function markReviewed(e: HsnSacView) {
    setActionError(null);
    setNotice(null);
    try {
      await authed((t) => reviewHsnEntry(t, e.id, e.version));
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setActionError('This entry was changed by someone else. The list was reloaded.');
        await refresh();
      } else if (!(err instanceof ApiError && err.status === 401))
        setActionError(describeFailure(err));
    }
  }

  return (
    <>
      <PageHeader
        title="HSN/SAC codes"
        description="Your own list of HSN (goods) and SAC (services) codes, used on products and invoices."
        actions={
          <>
            <Link to="/tax" className={link}>
              Tax configuration
            </Link>
            {canWrite && <Button onClick={() => open({ mode: 'new' })}>Add a code</Button>}
          </>
        }
      />
      <div className="space-y-4">
        <Alert tone="info">
          CommerceBill does not include an official HSN/SAC list and does not check codes against
          one. You enter the codes you use, and a person should confirm each one. Editing an entry
          removes its confirmation.
        </Alert>
        {notice && <Alert tone="success">{notice}</Alert>}
        {actionError && <Alert tone="error">{actionError}</Alert>}

        {editing && canWrite && (
          <Card title={editing.mode === 'new' ? 'Add a code' : `Edit ${editing.entry.code}`}>
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
              onSubmit={onSubmit}
              noValidate
              className="max-w-xl space-y-3"
              aria-label={editing.mode === 'new' ? 'Add HSN/SAC code' : 'Edit HSN/SAC code'}
            >
              {editing.mode === 'new' ? (
                <>
                  <RadioGroup
                    legend="Type"
                    name="hsnKind"
                    layout="row"
                    value={entryKind}
                    onChange={(v) => setEntryKind(v as 'HSN' | 'SAC')}
                    options={[
                      { value: 'HSN', label: 'HSN', description: 'For goods.' },
                      { value: 'SAC', label: 'SAC', description: 'For services.' },
                    ]}
                  />
                  <TextInput
                    label="Code"
                    requirement="required"
                    hint="2 to 8 digits. It cannot be changed later."
                    value={code}
                    inputMode="numeric"
                    maxLength={8}
                    autoComplete="off"
                    autoFocus
                    onChange={(e) => setCode(e.target.value)}
                    disabled={saving}
                    error={errors.code}
                  />
                </>
              ) : (
                <p className="text-sm text-slate-700">
                  <span className="font-mono">{editing.entry.code}</span> ({editing.entry.kind}) -
                  the code and type cannot be changed.
                </p>
              )}
              <TextInput
                label="Description"
                requirement="optional"
                value={description}
                maxLength={300}
                autoComplete="off"
                onChange={(e) => setDescription(e.target.value)}
                disabled={saving}
                error={errors.description}
              />
              <div className="flex gap-2">
                <Button type="submit" loading={saving}>
                  {saving ? 'Saving' : editing.mode === 'new' ? 'Add code' : 'Save changes'}
                </Button>
                <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving}>
                  Cancel
                </Button>
              </div>
            </form>
          </Card>
        )}

        <div className="grid grid-cols-[1fr_9rem_9rem] items-end gap-3">
          <TextInput
            label="Search"
            type="search"
            placeholder="Code or description"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={100}
            autoComplete="off"
          />
          <SelectField
            label="Type"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as typeof kind);
              setPage(0);
            }}
          >
            <option value="">HSN and SAC</option>
            <option value="HSN">HSN (goods)</option>
            <option value="SAC">SAC (services)</option>
          </SelectField>
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status);
              setPage(0);
            }}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </SelectField>
        </div>

        {result.isPending ? (
          <LoadingState label="Loading HSN/SAC codes" />
        ) : result.isError ? (
          <div className="space-y-3">
            <Alert tone="error">{describeFailure(result.error)}</Alert>
            <Button variant="secondary" onClick={() => void result.refetch()}>
              Try again
            </Button>
          </div>
        ) : data!.total === 0 ? (
          filtered ? (
            <EmptyState
              title="No codes match"
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setKind('');
                    setStatus('active');
                    setPage(0);
                  }}
                >
                  Clear search and filters
                </Button>
              }
            >
              Try a different search, or change the filters.
            </EmptyState>
          ) : (
            <EmptyState title="No HSN/SAC codes yet">
              {canWrite
                ? 'Add the codes you use. Products and invoice lines pick from this list.'
                : 'Codes will appear here once they are added.'}
            </EmptyState>
          )
        ) : (
          <>
            <div
              className="overflow-x-auto rounded-lg border border-slate-200 bg-white"
              aria-busy={result.isFetching}
            >
              <table className="w-full text-left text-sm">
                <caption className="sr-only">HSN/SAC codes</caption>
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                  <tr>
                    <th scope="col" className="px-2.5 py-2">
                      Code
                    </th>
                    <th scope="col" className="px-2.5 py-2">
                      Type
                    </th>
                    <th scope="col" className="px-2.5 py-2">
                      Description
                    </th>
                    <th scope="col" className="px-2.5 py-2">
                      Status
                    </th>
                    <th scope="col" className="px-2.5 py-2">
                      Confirmed
                    </th>
                    <th scope="col" className="px-2.5 py-2 text-right">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data!.entries.map((e) => (
                    <tr key={e.id} className="align-top hover:bg-slate-50">
                      <td className="px-2.5 py-2 font-mono text-xs whitespace-nowrap">{e.code}</td>
                      <td className="px-2.5 py-2">
                        <Badge tone={e.kind === 'HSN' ? 'brand' : 'neutral'}>{e.kind}</Badge>
                      </td>
                      <td className="max-w-md px-2.5 py-2 break-words">
                        {e.description ?? <span className="text-slate-400">-</span>}
                      </td>
                      <td className="px-2.5 py-2">
                        <Badge tone={e.isActive ? 'success' : 'warning'}>
                          {e.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>
                      <td className="px-2.5 py-2 text-xs">
                        {e.reviewStatus === 'REVIEWED' ? (
                          <span>
                            <Badge tone="success">Confirmed</Badge>
                            <span className="block text-slate-500">
                              {e.reviewedByName}
                              {e.reviewedAt ? `, ${formatDateTime(e.reviewedAt)}` : ''}
                            </span>
                          </span>
                        ) : (
                          <Badge tone="warning">Unreviewed</Badge>
                        )}
                      </td>
                      <td className="px-2.5 py-2 text-right whitespace-nowrap">
                        <span className="inline-flex flex-wrap justify-end gap-x-3 gap-y-0.5">
                          {canWrite && (
                            <button
                              type="button"
                              className={link}
                              onClick={() => open({ mode: 'edit', entry: e })}
                              aria-label={`Edit ${e.code}`}
                            >
                              Edit
                            </button>
                          )}
                          {canWrite && (
                            <button
                              type="button"
                              className={link}
                              onClick={() => void toggleActive(e)}
                              aria-label={`${e.isActive ? 'Deactivate' : 'Reactivate'} ${e.code}`}
                            >
                              {e.isActive ? 'Deactivate' : 'Reactivate'}
                            </button>
                          )}
                          {canReview && e.reviewStatus !== 'REVIEWED' && (
                            <button
                              type="button"
                              className={link}
                              onClick={() => void markReviewed(e)}
                              aria-label={`Confirm ${e.code}`}
                            >
                              Confirm
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-sm text-slate-600">
              <span aria-live="polite">
                Showing {data!.offset + 1}-{data!.offset + data!.entries.length} of {data!.total}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={data!.offset + data!.entries.length >= data!.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
