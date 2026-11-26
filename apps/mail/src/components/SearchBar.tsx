import { Button, Input } from '@mail/ui';
import { Filter, Search, X } from 'lucide-react';
import { useState } from 'react';

export interface SearchFilterState {
  q: string;
  from: string;
  to: string;
  subject: string;
  dateFrom: string;
  dateTo: string;
  hasAttachment: boolean;
  unreadOnly: boolean;
}

export function SearchBar({
  filters,
  onChange,
  inputRef,
}: {
  filters: SearchFilterState;
  onChange: (next: SearchFilterState) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [open, setOpen] = useState(false);

  const hasAdvanced = Boolean(
    filters.from ||
      filters.to ||
      filters.subject ||
      filters.dateFrom ||
      filters.dateTo ||
      filters.hasAttachment ||
      filters.unreadOnly
  );

  return (
    <div className="relative flex-1 max-w-2xl">
      <div className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 h-9">
        <Search className="h-4 w-4 text-[var(--color-text-muted)] shrink-0" />
        <input
          ref={inputRef}
          value={filters.q}
          onChange={(e) => onChange({ ...filters, q: e.target.value })}
          placeholder="Search mail (press /)"
          className="w-full bg-transparent text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
        />
        {(filters.q || hasAdvanced) && (
          <button
            type="button"
            onClick={() =>
              onChange({
                q: '',
                from: '',
                to: '',
                subject: '',
                dateFrom: '',
                dateTo: '',
                hasAttachment: false,
                unreadOnly: false,
              })
            }
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`rounded p-1 cursor-pointer ${
            hasAdvanced ? 'text-[var(--color-brand)]' : 'text-[var(--color-text-muted)]'
          } hover:bg-[var(--color-surface-muted)]`}
          aria-label="Toggle search filters"
        >
          <Filter className="h-3.5 w-3.5" />
        </button>
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-11 z-30 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-lg">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block mb-1 text-[var(--color-text-muted)]">From</label>
              <Input
                value={filters.from}
                onChange={(e) => onChange({ ...filters, from: e.target.value })}
                placeholder="sender@domain.com"
              />
            </div>
            <div>
              <label className="block mb-1 text-[var(--color-text-muted)]">To</label>
              <Input
                value={filters.to}
                onChange={(e) => onChange({ ...filters, to: e.target.value })}
                placeholder="recipient@domain.com"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block mb-1 text-[var(--color-text-muted)]">Subject contains</label>
              <Input
                value={filters.subject}
                onChange={(e) => onChange({ ...filters, subject: e.target.value })}
                placeholder="Invoice, Security alert..."
              />
            </div>
            <div>
              <label className="block mb-1 text-[var(--color-text-muted)]">After</label>
              <Input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => onChange({ ...filters, dateFrom: e.target.value })}
              />
            </div>
            <div>
              <label className="block mb-1 text-[var(--color-text-muted)]">Before</label>
              <Input
                type="date"
                value={filters.dateTo}
                onChange={(e) => onChange({ ...filters, dateTo: e.target.value })}
              />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[var(--color-border)] text-xs">
            <div className="flex items-center gap-4">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.hasAttachment}
                  onChange={(e) => onChange({ ...filters, hasAttachment: e.target.checked })}
                />
                Has attachment
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.unreadOnly}
                  onChange={(e) => onChange({ ...filters, unreadOnly: e.target.checked })}
                />
                Unread only
              </label>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
