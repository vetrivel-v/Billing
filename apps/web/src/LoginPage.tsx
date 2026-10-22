import { Alert, Button, PasswordInput, TextInput } from '@commercebill/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from './api.js';
import { useAuth, type SignedOutNotice } from './auth.js';
import { describeFailure, LOGIN_FAILED, LOGIN_LOCKOUT_NOTICE } from './messages.js';

/** Matches the server lockout threshold. The client cannot see lockout (the server answer is generic by design). */
const LOCKOUT_AFTER_FAILURES = 5;

const NOTICES: Record<SignedOutNotice, { tone: 'info' | 'warning'; text: string }> = {
  'signed-out': { tone: 'info', text: 'You have been signed out.' },
  expired: { tone: 'warning', text: 'Your session expired. Sign in again to continue.' },
  'setup-complete': {
    tone: 'info',
    text: 'Setup is complete. Sign in with the administrator account you just created.',
  },
  restored: {
    tone: 'info',
    text: 'The backup was restored. Everyone is signed out after a restore: sign in again. Real billing stays off until a new backup is verified.',
  },
  ended: {
    tone: 'warning',
    text: 'Your session has ended. It may have been signed out elsewhere or revoked by an administrator. Sign in again to continue.',
  },
};

export function LoginPage({
  notice,
  initialUsername = '',
}: {
  notice?: SignedOutNotice | undefined;
  initialUsername?: string | undefined;
}) {
  const { signIn } = useAuth();
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockoutHint, setLockoutHint] = useState(false);
  // Consecutive failures per typed username, in memory only. The same counting applies to every name, so a name that
  // does not exist behaves exactly like one that does: nothing here reveals which usernames are real.
  const failures = useRef(new Map<string, number>());
  const passwordRef = useRef<HTMLInputElement>(null);
  // Keyboard-friendly: after a failed attempt the cursor goes straight back to the (cleared) password field.
  useEffect(() => {
    if (!busy && error) passwordRef.current?.focus();
  }, [busy, error]);
  // Right after setup the username is already filled in: start in the password field.
  useEffect(() => {
    if (initialUsername) passwordRef.current?.focus();
  }, [initialUsername]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || !username.trim() || !password) return;
    const key = username.trim().toLowerCase();
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
      failures.current.delete(key);
    } catch (err) {
      setPassword('');
      if (err instanceof ApiError && err.status === 401) {
        const count = (failures.current.get(key) ?? 0) + 1;
        failures.current.set(key, count);
        setLockoutHint(count >= LOCKOUT_AFTER_FAILURES);
        setError(LOGIN_FAILED);
      } else {
        setLockoutHint(false);
        setError(describeFailure(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-sm space-y-5 rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div>
          <p className="text-sm font-semibold text-brand-700">CommerceBill</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">Sign in</h1>
          <p className="mt-1 text-sm text-slate-600">
            Use your CommerceBill username and password.
          </p>
        </div>
        {notice && !error && <Alert tone={NOTICES[notice].tone}>{NOTICES[notice].text}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}
        {lockoutHint && <Alert tone="warning">{LOGIN_LOCKOUT_NOTICE}</Alert>}
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <TextInput
            label="Username"
            name="username"
            autoComplete="username"
            autoFocus={!initialUsername}
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
          <PasswordInput
            ref={passwordRef}
            label="Password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <Button
            type="submit"
            className="w-full"
            loading={busy}
            disabled={!username.trim() || !password}
          >
            {busy ? 'Signing in' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
