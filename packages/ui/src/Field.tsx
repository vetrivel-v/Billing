import { useId, useState, type ComponentPropsWithRef } from 'react';
import { cx } from './classes.js';

interface FieldProps extends Omit<ComponentPropsWithRef<'input'>, 'id'> {
  label: string;
  /** Shows "(required)" or "(optional)" after the label, inside it, so it is also in the accessible name. */
  requirement?: 'required' | 'optional';
  hint?: string;
  /** Shown under the input and linked with aria-describedby / aria-invalid. */
  error?: string | undefined;
}

const INPUT =
  'h-9 w-full rounded-md border bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-600 ' +
  'disabled:bg-slate-100 disabled:text-slate-500';

function Messages({ id, hint, error }: { id: string; hint?: string; error?: string | undefined }) {
  return (
    <>
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
    </>
  );
}

export function Requirement({ value }: { value?: 'required' | 'optional' | undefined }) {
  return value ? <span className="font-normal text-slate-500"> ({value})</span> : null;
}

const describe = (id: string, hint?: string, error?: string) =>
  [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;

export function TextInput({ label, requirement, hint, error, className, ...rest }: FieldProps) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
        <Requirement value={requirement} />
      </label>
      <input
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describe(id, hint, error)}
        className={cx(INPUT, error ? 'border-red-500' : 'border-slate-300', className)}
      />
      <Messages id={id} {...(hint ? { hint } : {})} error={error} />
    </div>
  );
}

/** Password field with a show/hide toggle. The value is never stored or logged by this component. */
export function PasswordInput({ label, requirement, hint, error, className, ...rest }: FieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
        <Requirement value={requirement} />
      </label>
      <div className="relative">
        <input
          {...rest}
          id={id}
          type={visible ? 'text' : 'password'}
          aria-invalid={error ? true : undefined}
          aria-describedby={describe(id, hint, error)}
          className={cx(INPUT, 'pr-16', error ? 'border-red-500' : 'border-slate-300', className)}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-brand-700 hover:text-brand-900"
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      <Messages id={id} {...(hint ? { hint } : {})} error={error} />
    </div>
  );
}
