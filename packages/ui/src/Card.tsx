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

/**
 * A responsive set of cards. The columns follow the width of the AREA the cards are in (the page next to the sidebar), not the width of the
 * window, so a 1000 px window still gets two columns where they fit instead of one long column; and each card keeps its own height instead of
 * stretching to the tallest card in its row (which left large blank areas inside the shorter ones).
 */
export function CardGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'grid items-start gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))]',
        className,
      )}
    >
      {children}
    </div>
  );
}
