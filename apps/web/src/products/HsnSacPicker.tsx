import { useQuery } from '@tanstack/react-query';
import { Button, TextInput } from '@commercebill/ui';
import { useEffect, useState } from 'react';
import { searchHsnSac } from '../api.js';
import { useAuth } from '../auth.js';
import { describeFailure } from '../messages.js';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Chooses an HSN (goods) or SAC (services) code from the organization's OWN HSN/SAC list on the server. The browser can only pick an
 * entry the server returned (its id is sent), never type a code of its own. When that list is empty the picker says so.
 */
export function HsnSacPicker({
  kind,
  valueId,
  valueLabel,
  total,
  disabled,
  error,
  onChange,
}: {
  kind: 'HSN' | 'SAC';
  valueId: string;
  valueLabel: string;
  /** Number of codes in the whole reference list (0 = nothing entered yet). */
  total: number;
  disabled: boolean;
  error: string | undefined;
  onChange: (id: string, label: string) => void;
}) {
  const { authed } = useAuth();
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 250);
  const results = useQuery({
    queryKey: ['hsn-sac', kind, term],
    queryFn: () =>
      authed((token) => searchHsnSac(token, { kind, ...(term ? { search: term } : {}) })),
    enabled: total > 0 && term !== '',
    retry: false,
  });
  const name = kind === 'HSN' ? 'HSN code' : 'SAC code';

  return (
    <div className="space-y-1">
      {valueId ? (
        <div className="space-y-1">
          <span className="block text-sm font-medium text-slate-700">
            {name} <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <div className="flex items-center gap-2">
            <span
              className="rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 font-mono text-sm"
              data-testid="hsn-selected"
            >
              {valueLabel}
            </span>
            {!disabled && (
              <Button variant="ghost" onClick={() => onChange('', '')} aria-label={`Clear ${name}`}>
                Clear
              </Button>
            )}
          </div>
          {error && <p className="text-xs font-medium text-red-700">{error}</p>}
        </div>
      ) : total === 0 ? (
        <div className="space-y-1">
          <span className="block text-sm font-medium text-slate-700">
            {name} <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <p
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            role="status"
          >
            Your HSN/SAC list is empty, so a code cannot be chosen yet. Add the codes you use under
            Tax, HSN/SAC codes. The product can be saved without one and updated later.
          </p>
        </div>
      ) : (
        <>
          <TextInput
            label={name}
            requirement="optional"
            type="search"
            hint={`Type the start of a ${kind} code or a word from its description.`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={disabled}
            error={error}
            autoComplete="off"
          />
          {term !== '' && (
            <div className="rounded-md border border-slate-200 bg-white" aria-live="polite">
              {results.isPending ? (
                <p className="px-3 py-2 text-xs text-slate-500">Searching…</p>
              ) : results.isError ? (
                <p className="px-3 py-2 text-xs text-red-700">{describeFailure(results.error)}</p>
              ) : results.data.codes.length === 0 ? (
                <p className="px-3 py-2 text-xs text-slate-500">No {kind} code matches.</p>
              ) : (
                <ul className="max-h-48 overflow-auto">
                  {results.data.codes.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-brand-600"
                        onClick={() => {
                          onChange(c.id, `${c.code}${c.description ? ` - ${c.description}` : ''}`);
                          setSearch('');
                        }}
                      >
                        <span className="font-mono">{c.code}</span>
                        {c.description && (
                          <span className="text-slate-600"> - {c.description}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
