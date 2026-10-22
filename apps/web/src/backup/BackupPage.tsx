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
  PasswordInput,
  TextInput,
} from '@commercebill/ui';
import { useState, type FormEvent } from 'react';
import type {
  BackupVerificationView,
  BackupView,
  RestoreInspectResponse,
} from '@commercebill/shared-types';
import {
  createBackup,
  getBackupReadiness,
  getBackupStatus,
  inspectRestore,
  listBackups,
  putBackupRetention,
  restoreBackup,
  verifyBackup,
} from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';
import {
  GATE_TEXT,
  PASSPHRASE_TEXT,
  READINESS_LABEL,
  checkLabel,
  describeBackupFailure,
  formatBytes,
  formatWhen,
  passphraseProblem,
} from './model.js';

const PAGE = 10;

function bridge() {
  return typeof window === 'undefined' ? undefined : window.commercebill;
}

function VerificationBadge({ v }: { v: BackupVerificationView | null }) {
  if (!v) return <Badge>Not verified</Badge>;
  return v.result === 'PASS' ? (
    <Badge tone="success">Verified {formatWhen(v.verifiedAt)}</Badge>
  ) : (
    <Badge tone="warning">Verification failed {formatWhen(v.verifiedAt)}</Badge>
  );
}

function CheckList({ v }: { v: BackupVerificationView }) {
  return (
    <ul
      className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2"
      aria-label="Verification checks"
    >
      {v.checks.map((c) => (
        <li key={c.name} className={c.ok ? 'text-slate-700' : 'font-medium text-red-700'}>
          <span aria-hidden="true">{c.ok ? '✓' : '✗'} </span>
          <span className="sr-only">{c.ok ? 'Passed: ' : 'Failed: '}</span>
          {checkLabel(c.name)}
        </li>
      ))}
    </ul>
  );
}

function Readiness() {
  const { authed } = useAuth();
  const q = useQuery({
    queryKey: ['backup-readiness'],
    queryFn: () => authed((t) => getBackupReadiness(t)),
    retry: false,
    staleTime: 0,
  });
  const status = useQuery({
    queryKey: ['backup-status'],
    queryFn: () => authed((t) => getBackupStatus(t)),
    retry: false,
    staleTime: 0,
  });
  return (
    <Card title="Production readiness">
      {q.isPending && <LoadingState label="Checking readiness" />}
      {q.isError && <Alert tone="error">{describeFailure(q.error)}</Alert>}
      {q.data && (
        <div className="space-y-3">
          <ul className="space-y-1 text-sm">
            {q.data.items.map((i) => (
              <li key={i.code} className={i.met ? 'text-slate-700' : 'font-medium text-amber-800'}>
                <span aria-hidden="true">{i.met ? '✓' : '✗'} </span>
                <span className="sr-only">{i.met ? 'Ready: ' : 'Not ready: '}</span>
                {READINESS_LABEL[i.code] ?? i.code}
              </li>
            ))}
          </ul>
          {status.data && (
            <p className="text-sm text-slate-600">{GATE_TEXT[status.data.gate.reason]}</p>
          )}
          <p className="text-sm text-slate-600">
            {q.data.eligible
              ? 'All requirements are met. Switching to real billing is still a separate, deliberate step on the Tax page.'
              : 'Real billing stays off until every requirement is met.'}{' '}
            Mode now: <strong>{q.data.mode === 'PRODUCTION' ? 'Real billing' : 'Demo only'}</strong>
            .
          </p>
        </div>
      )}
    </Card>
  );
}

function Destination({ canManage }: { canManage: boolean }) {
  const { authed } = useAuth();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['backup-status'],
    queryFn: () => authed((t) => getBackupStatus(t)),
    retry: false,
    staleTime: 0,
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const desktop = bridge();
  const choose = async () => {
    if (!desktop) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await desktop.chooseBackupDestination();
      if (r.status === 'failed')
        setMsg('That folder could not be used. Choose a different folder.');
      await queryClient.invalidateQueries({ queryKey: ['backup-status'] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Backup folder">
      <div className="space-y-3 text-sm">
        <p>
          Folder:{' '}
          <strong>
            {status.data?.destination ? status.data.destination.label : 'Not chosen yet'}
          </strong>
        </p>
        {canManage && (
          <div>
            {desktop ? (
              <Button variant="secondary" loading={busy} onClick={() => void choose()}>
                {status.data?.destination ? 'Change folder' : 'Choose folder'}
              </Button>
            ) : (
              <p className="text-slate-600">Choosing a folder is available in the desktop app.</p>
            )}
          </div>
        )}
        {msg && <Alert tone="error">{msg}</Alert>}
        <p className="text-slate-600">
          A backup kept only on this computer does not protect you if the computer is lost, stolen
          or damaged. Copy backups to an external drive or another safe place.
        </p>
      </div>
    </Card>
  );
}

function CreateBackup({ canCreate }: { canCreate: boolean }) {
  const { authed } = useAuth();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['backup-status'],
    queryFn: () => authed((t) => getBackupStatus(t)),
    retry: false,
    staleTime: 0,
  });
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [verifyNow, setVerifyNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [done, setDone] = useState<{ backup: BackupView; v: BackupVerificationView | null } | null>(
    null,
  );
  const hasDestination = Boolean(status.data?.destination);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(null);
    const problem = passphraseProblem(pass, confirm);
    if (problem) {
      setFieldError(PASSPHRASE_TEXT[problem] ?? 'Check the passphrase.');
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      const r = await authed((t) =>
        createBackup(t, { passphrase: pass, passphraseConfirm: confirm, verifyNow }),
      );
      setDone({ backup: r.backup, v: r.verification });
      setPass('');
      setConfirm('');
      await queryClient.invalidateQueries({ queryKey: ['backups'] });
      await queryClient.invalidateQueries({ queryKey: ['backup-status'] });
      await queryClient.invalidateQueries({ queryKey: ['backup-readiness'] });
    } catch (err) {
      setError(describeBackupFailure(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Create a backup">
      {!canCreate ? (
        <p className="text-sm text-slate-600">Only an administrator can create backups.</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="max-w-lg space-y-3" noValidate>
          <Alert tone="warning" title="Keep this passphrase safe">
            The passphrase protects the backup. It is not stored anywhere, and nobody, including the
            makers of CommerceBill, can recover it. If you lose it, the backup can never be opened.
          </Alert>
          <PasswordInput
            label="Backup passphrase"
            requirement="required"
            hint="At least 12 characters."
            autoComplete="new-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            error={fieldError && passphraseProblem(pass) ? fieldError : undefined}
          />
          <PasswordInput
            label="Confirm passphrase"
            requirement="required"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={fieldError && !passphraseProblem(pass) ? fieldError : undefined}
          />
          <Checkbox
            label="Verify after creating (restore into a separate test database and check)"
            checked={verifyNow}
            onChange={(e) => setVerifyNow(e.target.checked)}
          />
          {!hasDestination && <Alert tone="info">Choose a backup folder first.</Alert>}
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" loading={busy} disabled={!hasDestination}>
            {busy ? 'Creating backup…' : 'Create backup'}
          </Button>
          {busy && (
            <p role="status" className="text-sm text-slate-600">
              Working. Billing continues to work meanwhile. Do not close CommerceBill.
            </p>
          )}
          {done && (
            <div className="space-y-2">
              <Alert tone="success" title="Backup created">
                {done.backup.fileName} ({formatBytes(done.backup.sizeBytes)}).
              </Alert>
              {done.v &&
                (done.v.result === 'PASS' ? (
                  <Alert tone="success" title="Verified">
                    The backup was restored into a separate test database and every check passed.
                  </Alert>
                ) : (
                  <Alert tone="error" title="Verification failed">
                    The backup was created, but it did not pass verification. Do not rely on it.
                    <CheckList v={done.v} />
                  </Alert>
                ))}
            </div>
          )}
        </form>
      )}
    </Card>
  );
}

function History({ canCreate }: { canCreate: boolean }) {
  const { authed } = useAuth();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: ['backups', page],
    queryFn: () => authed((t) => listBackups(t, { limit: PAGE, offset: page * PAGE })),
    retry: false,
    staleTime: 0,
  });
  const [open, setOpen] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ id: string; v: BackupVerificationView } | null>(null);

  const run = async (id: string) => {
    setError(null);
    const problem = passphraseProblem(pass);
    if (problem) {
      setError(PASSPHRASE_TEXT[problem] ?? 'Check the passphrase.');
      return;
    }
    setBusy(true);
    try {
      const r = await authed((t) => verifyBackup(t, id, { passphrase: pass }));
      setShown({ id, v: r.verification });
      setPass('');
      setOpen(null);
      await queryClient.invalidateQueries({ queryKey: ['backups'] });
      await queryClient.invalidateQueries({ queryKey: ['backup-status'] });
      await queryClient.invalidateQueries({ queryKey: ['backup-readiness'] });
    } catch (err) {
      setError(describeBackupFailure(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Backup history">
      {q.isPending && <LoadingState label="Loading backups" />}
      {q.isError && <Alert tone="error">{describeFailure(q.error)}</Alert>}
      {q.data && q.data.backups.length === 0 && (
        <EmptyState title="No backups yet">Create your first backup above.</EmptyState>
      )}
      {q.data && q.data.backups.length > 0 && (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Backups, newest first</caption>
              <thead className="text-xs text-slate-500">
                <tr>
                  <th scope="col" className="py-1 pr-3">
                    Created
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    File
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    Size
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    Status
                  </th>
                  <th scope="col" className="py-1">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.backups.map((b) => (
                  <tr key={b.id} className="border-t border-slate-100 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{formatWhen(b.createdAt)}</td>
                    <td className="py-2 pr-3 break-all">
                      {b.fileName}{' '}
                      {b.kind === 'PRE_RESTORE' && <Badge tone="brand">Safety backup</Badge>}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{formatBytes(b.sizeBytes)}</td>
                    <td className="py-2 pr-3">
                      {b.fileAvailable ? (
                        <VerificationBadge v={b.verification} />
                      ) : (
                        <Badge>File removed</Badge>
                      )}
                      {shown?.id === b.id && <CheckList v={shown.v} />}
                    </td>
                    <td className="py-2">
                      {canCreate && b.fileAvailable && (
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setOpen(open === b.id ? null : b.id);
                            setError(null);
                            setPass('');
                          }}
                          aria-label={`Verify ${b.fileName}`}
                        >
                          Verify
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open && (
            <form
              className="max-w-lg space-y-2 rounded-md border border-slate-200 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(open);
              }}
            >
              <PasswordInput
                label="Passphrase of this backup"
                requirement="required"
                autoComplete="off"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
              {error && <Alert tone="error">{error}</Alert>}
              <Button type="submit" loading={busy}>
                {busy ? 'Verifying…' : 'Verify now'}
              </Button>
            </form>
          )}
          {!open && error && <Alert tone="error">{error}</Alert>}
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600">{q.data.total} backups</span>
            <span className="flex gap-2">
              <Button variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button
                variant="ghost"
                disabled={(page + 1) * PAGE >= q.data.total}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

function Retention({ canCreate }: { canCreate: boolean }) {
  const { authed } = useAuth();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['backup-status'],
    queryFn: () => authed((t) => getBackupStatus(t)),
    retry: false,
    staleTime: 0,
  });
  const [value, setValue] = useState<string | null>(null);
  const shown = value ?? (status.data?.retentionKeep ? String(status.data.retentionKeep) : '');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const n = shown.trim() === '' ? null : Number(shown);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 365)) {
      setMsg({
        tone: 'error',
        text: 'Enter a number from 1 to 365, or leave it empty to keep every backup.',
      });
      return;
    }
    setBusy(true);
    try {
      await authed((t) => putBackupRetention(t, n));
      setMsg({ tone: 'success', text: 'Saved.' });
      setValue(null);
      await queryClient.invalidateQueries({ queryKey: ['backup-status'] });
    } catch (err) {
      setMsg({ tone: 'error', text: describeBackupFailure(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Keeping backups">
      <form onSubmit={(e) => void save(e)} className="max-w-lg space-y-3" noValidate>
        <TextInput
          label="Number of verified backups to keep"
          requirement="optional"
          hint="Older backup files are removed from the folder only after a newer verified backup exists. The most recent verified backup is never removed. Leave empty to keep everything."
          inputMode="numeric"
          value={shown}
          disabled={!canCreate}
          onChange={(e) => setValue(e.target.value)}
        />
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {canCreate && (
          <Button type="submit" variant="secondary" loading={busy}>
            Save
          </Button>
        )}
      </form>
    </Card>
  );
}

function Restore() {
  const { authed, restoreCompleted } = useAuth();
  const queryClient = useQueryClient();
  const desktop = bridge();
  const [source, setSource] = useState<{ id: string; label: string } | null>(null);
  const [pass, setPass] = useState('');
  const [info, setInfo] = useState<RestoreInspectResponse | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setSource(null);
    setPass('');
    setInfo(null);
    setConfirmText('');
    setError(null);
  };
  const choose = async () => {
    if (!desktop) return;
    setError(null);
    setInfo(null);
    const r = await desktop.chooseRestoreFile();
    if (r.status === 'chosen' && r.sourceId)
      setSource({ id: r.sourceId, label: r.label ?? 'backup' });
    else if (r.status === 'failed')
      setError('That file could not be used. Choose a CommerceBill backup file.');
  };
  const inspect = async (e: FormEvent) => {
    e.preventDefault();
    if (!source) return;
    const problem = passphraseProblem(pass);
    if (problem) {
      setError(PASSPHRASE_TEXT[problem] ?? 'Check the passphrase.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      setInfo(await authed((t) => inspectRestore(t, { sourceId: source.id, passphrase: pass })));
    } catch (err) {
      setError(describeBackupFailure(err));
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    if (!source || !info) return;
    setError(null);
    setBusy(true);
    try {
      await authed((t) =>
        restoreBackup(t, { sourceId: source.id, passphrase: pass, confirmation: confirmText }),
      );
      // Sessions are not restored, so every session is gone: say so on the sign-in page rather than failing the next call.
      queryClient.clear();
      restoreCompleted();
    } catch (err) {
      setError(describeBackupFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const blocked = info && (!info.schemaCompatible || !info.sameOrganization);
  return (
    <Card title="Restore from a backup">
      <div className="max-w-lg space-y-3 text-sm">
        {!desktop ? (
          <p className="text-slate-600">Restoring is available in the desktop app.</p>
        ) : !source ? (
          <>
            <p className="text-slate-600">
              Use this only to recover data, for example after a computer problem. Everything
              entered after the backup was made will be replaced.
            </p>
            <Button variant="secondary" onClick={() => void choose()}>
              Choose backup file
            </Button>
          </>
        ) : !info ? (
          <form onSubmit={(e) => void inspect(e)} className="space-y-3" noValidate>
            <p>
              Backup file: <strong>{source.label}</strong>
            </p>
            <PasswordInput
              label="Passphrase of this backup"
              requirement="required"
              autoComplete="off"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
            />
            <div className="flex gap-2">
              <Button type="submit" loading={busy}>
                Open backup
              </Button>
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-slate-500">Business</dt>
              <dd className="font-medium">{info.organizationName}</dd>
              <dt className="text-slate-500">Made on</dt>
              <dd className="font-medium">{formatWhen(info.createdAt)}</dd>
              <dt className="text-slate-500">Contents</dt>
              <dd className="font-medium">
                {info.rows} records in {info.tables} tables
              </dd>
              <dt className="text-slate-500">Verification</dt>
              <dd className="font-medium">
                {info.verificationStatus === 'PASS'
                  ? 'Verified here'
                  : info.verificationStatus === 'FAIL'
                    ? 'Failed verification'
                    : 'Not verified here'}
              </dd>
            </dl>
            {!info.sameOrganization && (
              <Alert tone="error">This backup belongs to a different business.</Alert>
            )}
            {!info.schemaCompatible && (
              <Alert tone="error">
                This backup was made by a different version of CommerceBill and cannot be restored
                here.
              </Alert>
            )}
            {!blocked && (
              <>
                <Alert tone="warning" title="This replaces your current data">
                  Everything entered after {formatWhen(info.createdAt)} will be replaced. Before
                  anything changes, CommerceBill saves and checks a safety backup of your current
                  data, protected by this same passphrase. Billing is paused while the restore runs.
                </Alert>
                <TextInput
                  label="Type RESTORE to confirm"
                  requirement="required"
                  autoComplete="off"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    loading={busy}
                    disabled={confirmText !== 'RESTORE'}
                    onClick={() => void restore()}
                  >
                    {busy ? 'Restoring…' : 'Restore now'}
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={reset}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
            {blocked && (
              <Button variant="ghost" onClick={reset}>
                Close
              </Button>
            )}
          </div>
        )}
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Card>
  );
}

/** Settings → Backup & Recovery: manual encrypted backups, verified restore tests, history, restore and production readiness. */
export function BackupPage() {
  const { can } = useAuth();
  const canCreate = can('backup.create');
  return (
    <>
      <PageHeader
        title="Backup & Recovery"
        description="Encrypted backups of your business data, checked by restoring them into a separate test database."
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <Readiness />
          <Destination canManage={canCreate} />
          <CreateBackup canCreate={canCreate} />
          <Retention canCreate={canCreate} />
        </div>
        <div className="space-y-4">
          <History canCreate={canCreate} />
          {can('backup.restore') && <Restore />}
        </div>
      </div>
    </>
  );
}
