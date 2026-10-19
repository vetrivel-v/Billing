import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from './classes.js';
import { Requirement } from './Field.js';

interface SelectProps extends Omit<ComponentPropsWithRef<'select'>, 'id'> {
  label: string;
  requirement?: 'required' | 'optional';
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}

/** Native select with a visible label, hint and error linked for assistive technology. */
export function SelectField({
  label,
  requirement,
  hint,
  error,
  className,
  children,
  ...rest
}: SelectProps) {
  const id = useId();
  const describedBy =
    [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
        <Requirement value={requirement} />
      </label>
      <select
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          'h-9 w-full rounded-md border bg-white px-2 text-sm text-slate-900',
          'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-600',
          error ? 'border-red-500' : 'border-slate-300',
          className,
        )}
      >
        {children}
      </select>
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
}

/** A group of native radio buttons inside a fieldset/legend (arrow keys move the choice, as users expect). */
export function RadioGroup({
  legend,
  name,
  options,
  value,
  onChange,
  error,
}: {
  legend: string;
  name: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  const id = useId();
  return (
    <fieldset aria-describedby={error ? `${id}-error` : undefined} className="space-y-2">
      <legend className="text-sm font-medium text-slate-700">{legend}</legend>
      {options.map((o) => (
        <label
          key={o.value}
          className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 p-3 hover:bg-slate-50 has-checked:border-brand-600 has-checked:bg-brand-50"
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="mt-0.5 accent-brand-600"
          />
          <span>
            <span className="block text-sm font-medium text-slate-900">{o.label}</span>
            {o.description && <span className="block text-xs text-slate-500">{o.description}</span>}
          </span>
        </label>
      ))}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </fieldset>
  );
}
