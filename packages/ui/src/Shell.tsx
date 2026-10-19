import type { ReactNode } from 'react';
import { cx } from './classes.js';

export interface SidebarItemModel {
  key: string;
  label: string;
  /** False = the module is not built yet: shown disabled with a "Coming soon" badge, never as a link. */
  available: boolean;
}

/** Top bar: product name on the left, caller-supplied account area on the right. */
export function AppHeader({
  organization,
  children,
}: {
  organization?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4">
      <div className="flex items-baseline gap-3">
        <span className="text-base font-semibold text-brand-700">CommerceBill</span>
        {organization && <span className="text-sm text-slate-500">{organization}</span>}
      </div>
      <div className="flex items-center gap-3">{children}</div>
    </header>
  );
}

/**
 * Navigation list. Links are rendered by the caller (`renderLink`) so this package stays router-agnostic.
 * Unavailable items are plain disabled text - they cannot be focused or followed.
 */
export function Sidebar({
  items,
  renderLink,
}: {
  items: SidebarItemModel[];
  renderLink: (item: SidebarItemModel, className: (active: boolean) => string) => ReactNode;
}) {
  const base = 'flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium';
  return (
    <nav aria-label="Main" className="w-56 shrink-0 border-r border-slate-200 bg-slate-50 p-3">
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.key}>
            {item.available ? (
              renderLink(item, (active) =>
                cx(
                  base,
                  'focus-visible:outline-2 focus-visible:outline-brand-600',
                  active ? 'bg-brand-100 text-brand-900' : 'text-slate-700 hover:bg-slate-200/70',
                ),
              )
            ) : (
              <span aria-disabled="true" className={cx(base, 'cursor-not-allowed text-slate-400')}>
                {item.label}
                <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Coming soon
                </span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Header + sidebar + scrollable main area. */
export function AppShell({
  header,
  sidebar,
  children,
}: {
  header: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-screen flex-col bg-slate-100 text-slate-900">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-white focus:px-3 focus:py-2"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to main content
      </a>
      {header}
      <div className="flex min-h-0 flex-1">
        {sidebar}
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-auto p-6 outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
