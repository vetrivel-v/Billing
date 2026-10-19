import { AppHeader, AppShell, Button, Sidebar } from '@commercebill/ui';
import { useEffect, useRef } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router';
import { useAuth } from './auth.js';
import { ChangePasswordPage, ForcedChangePasswordPage } from './ChangePasswordPage.js';
import { CustomerFormPage } from './customers/CustomerFormPage.js';
import { CustomersPage } from './customers/CustomersPage.js';
import { LoginPage } from './LoginPage.js';
import { ProductFormPage } from './products/ProductFormPage.js';
import { ProductsPage } from './products/ProductsPage.js';
import { MODULES, visibleModules } from './nav.js';
import { SetupWizard } from './setup/SetupWizard.js';
import { BootingPage, DashboardPage, ModulePage, NotFoundPage, UnreachablePage } from './pages.js';

/** A built module's screens, shown only to users holding the module's permission (the server still enforces it). */
function Guarded({ module, children }: { module: string; children: React.ReactNode }) {
  const { can } = useAuth();
  const entry = MODULES.find((m) => m.key === module);
  if (entry?.permission && !can(entry.permission)) return <ModulePage moduleKey={module} />;
  return <>{children}</>;
}

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
        <Route
          path="/customers"
          element={
            <Guarded module="customers">
              <CustomersPage />
            </Guarded>
          }
        />
        <Route
          path="/customers/new"
          element={
            <Guarded module="customers">
              <CustomerFormPage />
            </Guarded>
          }
        />
        <Route
          path="/customers/:id"
          element={
            <Guarded module="customers">
              <CustomerFormPage />
            </Guarded>
          }
        />
        <Route
          path="/products"
          element={
            <Guarded module="products">
              <ProductsPage />
            </Guarded>
          }
        />
        <Route
          path="/products/new"
          element={
            <Guarded module="products">
              <ProductFormPage />
            </Guarded>
          }
        />
        <Route
          path="/products/:id"
          element={
            <Guarded module="products">
              <ProductFormPage />
            </Guarded>
          }
        />
        {MODULES.filter(
          (m) => m.key !== 'dashboard' && m.key !== 'customers' && m.key !== 'products',
        ).map((m) => (
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
  const { state, retryBoot, setupCompleted } = useAuth();
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
      return (
        <SetupWizard onCompleted={setupCompleted} onAlreadyCompleted={() => void retryBoot()} />
      );
    case 'signed-out':
      return <LoginPage notice={state.notice} initialUsername={state.username} />;
    case 'signed-in':
      return state.me.mustChangePassword ? <ForcedChangePasswordPage /> : <Shell />;
  }
}
