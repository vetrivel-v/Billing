import type { ReactNode } from 'react';
import { cx } from './classes.js';

export function Card({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cx('rounded-lg border border-slate-200 bg-white p-4 shadow-sm', className)}
    >
      {title && <h2 className="mb-3 text-sm font-semibold text-slate-700">{title}</h2>}
      {children}
    </section>
  );
}
