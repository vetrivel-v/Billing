import type { MeResponse } from '@commercebill/shared-types';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as api from './api.js';
import { ApiError } from './api.js';

/** Why the user is looking at the sign-in page without having just opened the app. */
export type SignedOutNotice = 'signed-out' | 'expired' | 'ended';

export type AuthState =
  | { phase: 'booting' }
  | { phase: 'unreachable' }
  | { phase: 'setup-required' }
  | { phase: 'signed-out'; notice?: SignedOutNotice }
  | { phase: 'signed-in'; me: MeResponse };

export interface AuthApi {
  state: AuthState;
  /** Re-run the launch check (used by the "Try again" button). */
  retryBoot(): Promise<void>;
  /** Throws ApiError / ApiUnreachableError on failure; the caller decides the wording. */
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /** UI convenience only: the server enforces permissions on every request. */
  can(permission: string): boolean;
}

const AuthContext = createContext<AuthApi | undefined>(undefined);

/** A signed-in user who has not touched the app for the idle timeout is signed out locally (the server agrees). */
const WATCH_INTERVAL_MS = 15_000;
/** At most one keep-alive per this fraction of the idle timeout, and only while the user is active. */
const KEEPALIVE_FRACTION = 3;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ phase: 'booting' });
  // The session token lives only here (memory). It is never put in storage, the URL, the DOM or a log.
  const tokenRef = useRef<string | null>(null);
  const meta = useRef({ expiresAt: 0, idleMs: 0, lastActivity: 0, lastTouch: 0 });

  const endSession = useCallback((notice: SignedOutNotice) => {
    tokenRef.current = null;
    setState({ phase: 'signed-out', notice });
  }, []);

  /** `fresh` = a new sign-in: the user is active now. A refresh must not count as user activity. */
  const adopt = useCallback((me: MeResponse, fresh = false) => {
    const now = Date.now();
    meta.current = {
      expiresAt: Date.parse(me.sessionExpiresAt),
      idleMs: me.idleTimeoutSeconds * 1000,
      lastActivity: fresh ? now : meta.current.lastActivity,
      lastTouch: now,
    };
    setState({ phase: 'signed-in', me });
  }, []);

  const boot = useCallback(async () => {
    setState({ phase: 'booting' });
    try {
      const status = await api.getSetupStatus();
      setState(status.setupRequired ? { phase: 'setup-required' } : { phase: 'signed-out' });
    } catch {
      setState({ phase: 'unreachable' });
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  /** Runs an authenticated call; a 401 means the session is gone (expired, signed out elsewhere or revoked). */
  const run = useCallback(
    async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
      const token = tokenRef.current;
      if (!token) throw new ApiError(401, 'AUTH_0001');
      try {
        const result = await fn(token);
        // The session may have ended (sign-out, expiry) while this call was in flight: never resurrect it.
        if (tokenRef.current !== token) throw new ApiError(401, 'AUTH_0001');
        meta.current.lastTouch = Date.now();
        return result;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && tokenRef.current === token) {
          endSession(Date.now() >= meta.current.expiresAt ? 'expired' : 'ended');
        }
        throw err;
      }
    },
    [endSession],
  );

  const refreshMe = useCallback(async () => {
    adopt(await run(api.getMe));
  }, [adopt, run]);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const session = await api.login(username, password);
      tokenRef.current = session.token;
      try {
        adopt(await api.getMe(session.token), true);
      } catch (err) {
        tokenRef.current = null;
        throw err;
      }
    },
    [adopt],
  );

  const signOut = useCallback(async () => {
    const token = tokenRef.current;
    tokenRef.current = null;
    setState({ phase: 'signed-out', notice: 'signed-out' });
    if (token) await api.logout(token).catch(() => undefined); // best effort: the local session is already gone
  }, []);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await run((token) => api.changePassword(token, currentPassword, newPassword));
      await refreshMe();
    },
    [run, refreshMe],
  );

  const signedIn = state.phase === 'signed-in';
  useEffect(() => {
    if (!signedIn) return;
    const markActive = () => {
      meta.current.lastActivity = Date.now();
    };
    const events = ['pointerdown', 'keydown'] as const;
    for (const e of events) window.addEventListener(e, markActive, { passive: true });
    const timer = setInterval(() => {
      const m = meta.current;
      const now = Date.now();
      if (now >= m.expiresAt) return endSession('expired');
      if (now - m.lastActivity >= m.idleMs) {
        const token = tokenRef.current;
        endSession('expired');
        if (token) void api.logout(token).catch(() => undefined);
        return;
      }
      // Recent activity keeps the server-side idle clock moving; the call itself handles a 401.
      if (now - m.lastTouch >= m.idleMs / KEEPALIVE_FRACTION)
        void refreshMe().catch(() => undefined);
    }, WATCH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      for (const e of events) window.removeEventListener(e, markActive);
    };
  }, [signedIn, endSession, refreshMe]);

  const permissions = state.phase === 'signed-in' ? state.me.permissions : undefined;
  const value = useMemo<AuthApi>(
    () => ({
      state,
      retryBoot: boot,
      signIn,
      signOut,
      changePassword,
      can: (permission) => permissions?.includes(permission) ?? false,
    }),
    [state, boot, signIn, signOut, changePassword, permissions],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
