import { type QueryClient, useQuery } from '@tanstack/react-query';
import type { TagItem } from '@mail/shared-types';
import { Check, Tag } from 'lucide-react';
import { api } from '../../lib/api.js';

/**
 * Invalidates all TanStack Query caches that reference tags or tag names/counts
 * so any tag create/rename/delete/assignment reflects immediately across all views.
 */
export async function invalidateAllTagDependents(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['tags'] }),
    qc.invalidateQueries({ queryKey: ['subscribers'] }),
    qc.invalidateQueries({ queryKey: ['segments'] }),
    qc.invalidateQueries({ queryKey: ['campaigns'] }),
    qc.invalidateQueries({ queryKey: ['automations'] }),
    qc.invalidateQueries({ queryKey: ['forms'] }),
    qc.invalidateQueries({ queryKey: ['landing-pages'] }),
  ]);
}

export function useCentralTags(): { tags: TagItem[]; isLoading: boolean; byId: Map<string, TagItem> } {
  const query = useQuery({
    queryKey: ['tags'],
    queryFn: () => api.listTags(),
  });
  const tags = query.data?.tags ?? [];
  const byId = new Map(tags.map((t) => [t.id, t]));
  return { tags, isLoading: query.isLoading, byId };
}

export function TagMultiSelect({
  selectedTagIds,
  onChange,
  tone = 'brand',
  emptyText = 'No tags created yet. Create one in Audience → Tags.',
  prefix,
}: {
  selectedTagIds: string[];
  onChange: (nextIds: string[]) => void;
  tone?: 'brand' | 'danger';
  emptyText?: string;
  prefix?: string;
}) {
  const { tags, isLoading } = useCentralTags();

  if (isLoading) {
    return <span className="text-xs text-[var(--color-text-muted)]">Loading tags...</span>;
  }
  if (tags.length === 0) {
    return <span className="text-xs text-[var(--color-text-muted)]">{emptyText}</span>;
  }

  const toggle = (id: string) => {
    onChange(
      selectedTagIds.includes(id)
        ? selectedTagIds.filter((x) => x !== id)
        : [...selectedTagIds, id]
    );
  };

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t) => {
        const active = selectedTagIds.includes(t.id);
        const activeClasses =
          tone === 'danger'
            ? 'border-red-500/50 bg-red-500/15 text-red-600 dark:text-red-300 font-medium'
            : 'border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)] font-medium';
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={active}
            onClick={() => toggle(t.id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors cursor-pointer ${
              active
                ? activeClasses
                : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]'
            }`}
          >
            <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
            <span>
              {prefix ? `${prefix}: ` : ''}
              {t.name}
            </span>
            <span className="text-[10px] opacity-75">({t.subscriberCount})</span>
            {active && <Check className="h-3 w-3 shrink-0" />}
          </button>
        );
      })}
    </div>
  );
}

export function TagSingleSelect({
  valueTagId,
  onChangeTagId,
  placeholder = 'Select a tag...',
  ariaLabel = 'Select tag',
}: {
  valueTagId: string;
  onChangeTagId: (tagId: string, tagName: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const { tags } = useCentralTags();
  return (
    <div className="relative flex items-center">
      <Tag className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[var(--color-text-muted)]" />
      <select
        aria-label={ariaLabel}
        value={valueTagId}
        onChange={(e) => {
          const id = e.target.value;
          const found = tags.find((t) => t.id === id);
          onChangeTagId(id, found?.name ?? '');
        }}
        className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-3 text-sm text-[var(--color-text)] focus:border-[var(--color-brand)] focus:outline-none"
      >
        <option value="">{placeholder}</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.subscriberCount})
          </option>
        ))}
      </select>
    </div>
  );
}
