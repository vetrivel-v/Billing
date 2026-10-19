import { Alert, Button, Card, PageHeader, PasswordInput } from '@commercebill/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from './api.js';
import { useAuth } from './auth.js';
import { describeFailure, passwordRuleText } from './messages.js';

type FieldErrors = Partial<Record<'currentPassword' | 'newPassword' | 'confirm', string>>;

/**
 * Change-own-password form. `forced` = the account is on an administrator-supplied temporary password: this page is
 * then the only screen available until the change succeeds (the server enforces the same rule with AUTH_0004).
 */
export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setDone(false);
    setFormError(null);
    const local: FieldErrors = {};
    if (!current) local.currentPassword = 'Enter your current password.';
    if (!next) local.newPassword = 'Enter a new password.';
    else if (next === current) local.newPassword = passwordRuleText('same_as_current');
    if (next && confirm !== next) local.confirm = 'The two new passwords do not match.';
    setErrors(local);
    if (Object.keys(local).length > 0) return;

    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setCurrent('');
      if (err instanceof ApiError && err.status === 400 && err.problems.length > 0) {
        const fe: FieldErrors = {};
        for (const p of err.problems) {
          if (p.field === 'currentPassword')
            fe.currentPassword = 'The current password is not correct.';
          else if (p.field === 'newPassword')
            fe.newPassword = [fe.newPassword, passwordRuleText(p.rule)].filter(Boolean).join(' ');
        }
        setErrors(fe);
      } else if (!(err instanceof ApiError && err.status === 401)) {
        // A 401 means the session ended; the provider is already showing the sign-in page.
        setFormError(describeFailure(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-md space-y-4" noValidate>
      {formError && <Alert tone="error">{formError}</Alert>}
      {done && (
        <Alert tone="success">Your password was changed. Other sessions were signed out.</Alert>
      )}
      <PasswordInput
        label="Current password"
        name="current-password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        error={errors.currentPassword}
        disabled={busy}
        autoFocus
      />
      <PasswordInput
        label="New password"
        name="new-password"
        autoComplete="new-password"
        hint="Use a long, unique passphrase (12 or more characters)."
        value={next}
        onChange={(e) => setNext(e.target.value)}
        error={errors.newPassword}
        disabled={busy}
      />
      <PasswordInput
        label="Confirm new password"
        name="confirm-password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={errors.confirm}
        disabled={busy}
      />
      <Button type="submit" loading={busy}>
        {forced ? 'Change password and continue' : 'Change password'}
      </Button>
    </form>
  );
}

/** Full-screen variant shown when a password change is required before anything else. */
export function ForcedChangePasswordPage() {
  const { signOut, state } = useAuth();
  const name = state.phase === 'signed-in' ? state.me.user.displayName : '';
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-lg space-y-5 rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div>
          <p className="text-sm font-semibold text-brand-700">CommerceBill</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">Choose a new password</h1>
          <p className="mt-1 text-sm text-slate-600">
            {name ? `${name}, y` : 'Y'}our account is using a temporary password. Set your own
            password to continue.
          </p>
        </div>
        <ChangePasswordForm forced />
        <Button variant="ghost" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

/** In-shell page for a voluntary change. */
export function ChangePasswordPage() {
  return (
    <>
      <PageHeader
        title="Change password"
        description="Changing your password signs out your other sessions."
      />
      <Card>
        <ChangePasswordForm forced={false} />
      </Card>
    </>
  );
}
