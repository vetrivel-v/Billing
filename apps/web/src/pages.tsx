import { Button, EmptyState, LoadingState, PageHeader } from '@commercebill/ui';
import { useAuth } from './auth.js';
import { MODULES } from './nav.js';

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
