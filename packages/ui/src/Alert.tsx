import type { ReactNode } from 'react';
import { cx } from './classes.js';

export type AlertTone = 'error' | 'warning' | 'info' | 'success';

const TONES: Record<AlertTone, string> = {
  error: 'border-red-300 bg-red-50 text-red-900',
  warning: 'border-amber-300 bg-amber-50 text-amber-900',
  info: 'border-sky-300 bg-sky-50 text-sky-900',
  success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
};

/** Errors and warnings use role="alert" so they are announced immediately; others use role="status". */
export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: AlertTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
      className={cx('rounded-md border px-3 py-2 text-sm', TONES[tone])}
    >
      {title && <p className="font-medium">{title}</p>}
      <div>{children}</div>
    </div>
  );
}
