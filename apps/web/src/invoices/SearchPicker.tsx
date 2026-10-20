import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { describeFailure } from '../messages.js';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface Props<T> {
  label: string;
  placeholder: string;
  queryKey: string;
  /** Loads matches for a (possibly empty) search term from the real API. */
  load: (term: string) => Promise<T[]>;
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** A reason this item cannot be chosen (shown, and the item is not selectable), or null. */
  blockedReason?: (item: T) => string | null;
  onPick: (item: T) => void;
  inputRef?: (el: HTMLInputElement | null) => void;
  disabled?: boolean;
  /** Clears the text after picking (product entry) instead of keeping it. */
  clearOnPick?: boolean;
}

/**
 * A keyboard-first search box: type to search, Arrow keys move, Enter picks the highlighted match (or the only match),
 * Escape closes. Matches come from the server; nothing is cached as business truth.
 */
export function SearchPicker<T>(p: Props<T>) {
  const id = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const term = useDebounced(text.trim(), 250);
  const boxRef = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: [p.queryKey, term],
    queryFn: () => p.load(term),
    enabled: open && term.length > 0,
    retry: false,
  });
  const items = term.length > 0 ? (q.data ?? []) : [];
  const waiting = text.trim() !== term || q.isFetching;

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (item: T) => {
    if (p.blockedReason?.(item)) return;
    p.onPick(item);
    setText(p.clearOnPick ? '' : text);
    setOpen(false);
    setActive(0);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && open && items.length > 0 && !waiting) {
      e.preventDefault();
      const item = items[Math.min(active, items.length - 1)]!;
      pick(item);
    } else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {p.label}
      </label>
      <input
        id={id}
        ref={p.inputRef}
        role="combobox"
        aria-expanded={open && term.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && items.length > 0 ? `${id}-opt-${active}` : undefined}
        autoComplete="off"
        disabled={p.disabled}
        placeholder={p.placeholder}
        value={text}
        maxLength={100}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-600 disabled:bg-slate-100"
      />
      {open && term.length > 0 && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={`${p.label} results`}
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-slate-300 bg-white py-1 text-sm shadow-lg"
        >
          {q.isError ? (
            <li className="px-3 py-2 text-red-700">{describeFailure(q.error)}</li>
          ) : waiting && items.length === 0 ? (
            <li className="px-3 py-2 text-slate-500">Searching&hellip;</li>
          ) : items.length === 0 ? (
            <li className="px-3 py-2 text-slate-500">No matches</li>
          ) : (
            items.map((item, i) => {
              const blocked = p.blockedReason?.(item) ?? null;
              return (
                <li
                  key={p.itemKey(item)}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={blocked ? true : undefined}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(item);
                  }}
                  className={
                    'px-3 py-1.5 ' +
                    (blocked ? 'cursor-not-allowed text-slate-400 ' : 'cursor-pointer ') +
                    (i === active ? 'bg-brand-50' : '')
                  }
                >
                  {p.renderItem(item)}
                  {blocked && <div className="text-xs text-amber-700">{blocked}</div>}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
