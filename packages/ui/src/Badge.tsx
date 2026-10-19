import type { ReactNode } from 'react';
import { cx } from './classes.js';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'brand';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  success: 'bg-emerald-100 text-emerald-800',
  warning: 'bg-amber-100 text-amber-800',
  brand: 'bg-brand-100 text-brand-800',
};

/** A small status/type label. The text carries the meaning; colour is only reinforcement. */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
