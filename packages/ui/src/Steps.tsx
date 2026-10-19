import { cx } from './classes.js';

export interface StepModel {
  key: string;
  label: string;
}

/** Visible progress through a multi-step flow. The current step carries aria-current="step". */
export function Steps({
  steps,
  current,
  label = 'Progress',
}: {
  steps: StepModel[];
  current: number;
  label?: string;
}) {
  return (
    <nav aria-label={label}>
      <ol className="space-y-1">
        {steps.map((s, i) => {
          const state = i < current ? 'done' : i === current ? 'current' : 'todo';
          return (
            <li
              key={s.key}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cx(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm',
                state === 'current' && 'bg-brand-100 font-medium text-brand-900',
                state === 'done' && 'text-slate-700',
                state === 'todo' && 'text-slate-400',
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                  state === 'current' && 'border-brand-600 bg-brand-600 text-white',
                  state === 'done' && 'border-brand-600 bg-white text-brand-700',
                  state === 'todo' && 'border-slate-300 bg-white',
                )}
              >
                {state === 'done' ? '✓' : i + 1}
              </span>
              <span>
                {s.label}
                <span className="sr-only">
                  {state === 'done' ? ' (completed)' : state === 'current' ? ' (current step)' : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
