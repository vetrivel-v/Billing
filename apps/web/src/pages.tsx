import { Button, Card, EmptyState, LoadingState, PageHeader } from '@commercebill/ui';
import { useAuth } from './auth.js';
import { MODULES, visibleModules } from './nav.js';
import { StatusPanel } from './StatusPanel.js';

export function BootingPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100">
      <LoadingState label="Starting CommerceBill" />
    </div>
  );
}

function CenteredPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-lg space-y-4 rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold text-brand-700">CommerceBill</p>
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function UnreachablePage() {
  const { retryBoot } = useAuth();
  return (
    <CenteredPanel title="CommerceBill is not ready">
      <p className="text-sm text-slate-600">
        The local service did not answer. It may still be starting. Wait a moment and try again. If
        this keeps happening, close and reopen CommerceBill.
      </p>
      <Button onClick={() => void retryBoot()}>Try again</Button>
    </CenteredPanel>
  );
}

/** The setup wizard screens arrive in the next task; until then this is an honest placeholder, not a fake form. */
export function SetupRequiredPage() {
  const { retryBoot } = useAuth();
  return (
    <CenteredPanel title="Setup required">
      <p className="text-sm text-slate-600">
        This installation has not been set up yet. The setup wizard is not available in this version
        of the application.
      </p>
      <Button variant="secondary" onClick={() => void retryBoot()}>
        Check again
      </Button>
    </CenteredPanel>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-900">{children}</dd>
    </>
  );
}

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Only real information: the signed-in user, their organization, roles and session, and live service status. */
export function DashboardPage() {
  const { state, can } = useAuth();
  if (state.phase !== 'signed-in') return null;
  const { me } = state;
  const modules = visibleModules(can).filter((m) => m.key !== 'dashboard');
  return (
    <>
      <PageHeader title="Dashboard" description={`Welcome, ${me.user.displayName}.`} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Your account">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <Fact label="Name">{me.user.displayName}</Fact>
            <Fact label="Username">{me.user.username}</Fact>
            <Fact label="Organization">{me.organizationName || '-'}</Fact>
            <Fact label="Roles">{me.roles.length > 0 ? me.roles.join(', ') : 'None assigned'}</Fact>
          </dl>
        </Card>
        <Card title="Session">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <Fact label="Ends at the latest">{TIME.format(new Date(me.sessionExpiresAt))}</Fact>
            <Fact label="Idle sign-out">{Math.round(me.idleTimeoutSeconds / 60)} minutes</Fact>
          </dl>
        </Card>
        <StatusPanel />
        <Card title="Modules">
          {modules.length === 0 ? (
            <p className="text-sm text-slate-600">Your account has no module access yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {modules.map((m) => (
                <li key={m.key} className="flex justify-between">
                  <span>{m.label}</span>
                  <span className="text-slate-500">
                    {m.available ? 'Available' : 'Coming soon'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="mt-4">
        <EmptyState title="Business figures are not available yet">
          Sales, stock and receivable figures will appear here when those modules are added. Nothing
          on this page is sample data.
        </EmptyState>
      </div>
    </>
  );
}

/** Direct visits to a module path: no access, or not built yet. */
export function ModulePage({ moduleKey }: { moduleKey: string }) {
  const { can } = useAuth();
  const module = MODULES.find((m) => m.key === moduleKey);
  if (!module) return <NotFoundPage />;
  if (module.permission && !can(module.permission)) {
    return (
      <>
        <PageHeader title={module.label} />
        <EmptyState title="You do not have access to this area">
          Ask your administrator if you need it.
        </EmptyState>
      </>
    );
  }
  return (
    <>
      <PageHeader title={module.label} />
      <EmptyState title="Coming soon">This part of CommerceBill is not available yet.</EmptyState>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState title="There is nothing here">Use the menu to go to a section.</EmptyState>
    </>
  );
}
