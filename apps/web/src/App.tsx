import { AppHeader, AppShell, Button, Sidebar } from '@commercebill/ui';
import { useEffect, useRef } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router';
import { useAuth } from './auth.js';
import { ChangePasswordPage, ForcedChangePasswordPage } from './ChangePasswordPage.js';
import { LoginPage } from './LoginPage.js';
import { MODULES, visibleModules } from './nav.js';
import {
  BootingPage,
  DashboardPage,
  ModulePage,
  NotFoundPage,
  SetupRequiredPage,
  UnreachablePage,
} from './pages.js';

function Shell() {
  const { state, can, signOut } = useAuth();
  const navigate = useNavigate();
  if (state.phase !== 'signed-in') return null;
  const { me } = state;
  const items = visibleModules(can);
  return (
    <AppShell
      header={
        <AppHeader organization={me.organizationName}>
          <span className="text-sm text-slate-700">{me.user.displayName}</span>
          <Button variant="ghost" onClick={() => navigate('/account/password')}>
            Change password
          </Button>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </AppHeader>
      }
      sidebar={
        <Sidebar
          items={items}
          renderLink={(item, className) => (
            <NavLink
              to={MODULES.find((m) => m.key === item.key)?.path ?? '/'}
              end
              className={({ isActive }) => className(isActive)}
            >
              {item.label}
            </NavLink>
          )}
        />
      }
    >
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/account/password" element={<ChangePasswordPage />} />
        {MODULES.filter((m) => m.key !== 'dashboard').map((m) => (
          <Route key={m.key} path={m.path} element={<ModulePage moduleKey={m.key} />} />
        ))}
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}

/** Chooses what the user can see from the launch check and the session state. Nothing else is reachable. */
export function App() {
  const { state } = useAuth();
  const navigate = useNavigate();
  const wasSignedIn = useRef(false);
  useEffect(() => {
    // After SIGN-OUT, do not leave the previous location in the address. (A deep link followed before signing in is kept.)
    if (state.phase === 'signed-in') wasSignedIn.current = true;
    else if (wasSignedIn.current) {
      wasSignedIn.current = false;
      navigate('/', { replace: true });
    }
  }, [state.phase, navigate]);

  switch (state.phase) {
    case 'booting':
      return <BootingPage />;
    case 'unreachable':
      return <UnreachablePage />;
    case 'setup-required':
      return <SetupRequiredPage />;
    case 'signed-out':
      return <LoginPage notice={state.notice} />;
    case 'signed-in':
      return state.me.mustChangePassword ? <ForcedChangePasswordPage /> : <Shell />;
  }
}
