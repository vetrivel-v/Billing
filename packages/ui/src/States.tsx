import type { ReactNode } from 'react';
import { cx } from './classes.js';

export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block animate-spin rounded-full border-2 border-current border-t-transparent',
        size === 'sm' ? 'h-4 w-4' : 'h-6 w-6',
      )}
    />
  );
}

/** A centred busy indicator. `label` is announced to assistive technology. */
export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 p-8 text-slate-600">
      <Spinner />
      <span>{label}…</span>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center">
      <h3 className="text-base font-medium text-slate-800">{title}</h3>
      {children && <p className="max-w-md text-sm text-slate-600">{children}</p>}
      {action}
    </div>
  );
}
