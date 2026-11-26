import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppDialog, Badge, Button, Card, EmptyState, Input, Skeleton } from '@mail/ui';
import type { SegmentItem, SubscriberRecord, SubscriberStatus, TagItem } from '@mail/shared-types';
import {
  CheckCircle2,
  Download,
  Mail,
  Plus,
  Search,
  Tag,
  Trash2,
  UserCheck,
  UserMinus,
  Users,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';

const STATUS_TONE: Record<SubscriberStatus, 'success' | 'neutral' | 'danger' | 'warning'> = {
  subscribed: 'success',
  unsubscribed: 'neutral',
  bounced: 'danger',
  complained: 'danger',
  pending_confirmation: 'warning',
};

export function SubscribersSection({
  initialTagFilter,
  onClearInitialTag,
  onOpenImportWizard,
}: {
  initialTagFilter?: string | undefined;
  onClearInitialTag?: () => void;
  onOpenImportWizard: () => void;
}) {
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>(initialTagFilter ?? '');
  const [segmentFilter, setSegmentFilter] = useState<string>('');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [sortBy, setSortBy] = useState<'recent' | 'oldest' | 'engagement' | 'email'>('recent');
  const [page, setPage] = useState(1);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [profileId, setProfileId] = useState<string | null>(null);

  // Add subscriber dialog
  const [addOpen, setAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newFirst, setNewFirst] = useState('');
  const [newLast, setNewLast] = useState('');
  const [newTags, setNewTags] = useState('');
  const [newSource, setNewSource] = useState('manual_console');
  const [newAttrsText, setNewAttrsText] = useState('');

  // Profile drawer edit / resubscribe / delete dialogs
  const [tagToAdd, setTagToAdd] = useState('');
  const [resubOpen, setResubOpen] = useState(false);
  const [resubConsentSource, setResubConsentSource] = useState('written_opt_in_confirmation');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const activeTag = initialTagFilter || tagFilter;

  const subsQuery = useQuery({
    queryKey: ['subscribers', { search, statusFilter, activeTag, segmentFilter, sourceFilter, sortBy, page }],
    queryFn: () =>
      api.listSubscribers({
        search: search.trim() || undefined,
        status: (statusFilter || undefined) as SubscriberStatus | undefined,
        tag: activeTag || undefined,
        segmentId: segmentFilter || undefined,
        source: sourceFilter.trim() || undefined,
        sort: sortBy,
        page,
        pageSize: 25,
      }),
  });

  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: () => api.listTags() });
  const segmentsQuery = useQuery({ queryKey: ['segments'], queryFn: () => api.listSegments() });
  const customFieldsQuery = useQuery({ queryKey: ['custom-fields'], queryFn: () => api.listCustomFields() });

  const profileQuery = useQuery({
    queryKey: ['subscriber-profile', profileId],
    queryFn: () => api.getSubscriberProfile(profileId!),
    enabled: Boolean(profileId),
  });

  const invalidateAudience = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['subscribers'] }),
      qc.invalidateQueries({ queryKey: ['tags'] }),
      qc.invalidateQueries({ queryKey: ['segments'] }),
      qc.invalidateQueries({ queryKey: ['campaigns'] }),
      ...(profileId ? [qc.invalidateQueries({ queryKey: ['subscriber-profile', profileId] })] : []),
    ]);
  };

  const addMutation = useMutation({
    mutationFn: () => {
      const attrs: Record<string, string> = {};
      if (newAttrsText.trim()) {
        for (const line of newAttrsText.split('\n')) {
          const [k, ...rest] = line.split('=');
          if (k?.trim() && rest.length > 0) attrs[k.trim()] = rest.join('=').trim();
        }
      }
      return api.upsertSubscriber({
        email: newEmail.trim(),
        firstName: newFirst.trim(),
        lastName: newLast.trim(),
        tags: newTags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        attributes: attrs,
        consentSource: newSource.trim() || 'manual_console',
      });
    },
    onSuccess: async (res) => {
      toast.success(res.created ? `Added ${res.subscriber.email}` : `Updated ${res.subscriber.email}`);
      setNewEmail('');
      setNewFirst('');
      setNewLast('');
      setNewTags('');
      setNewAttrsText('');
      setAddOpen(false);
      await invalidateAudience();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save subscriber'),
  });

  const bulkMutation = useMutation({
    mutationFn: (vars: { action: 'add_tag' | 'remove_tag' | 'unsubscribe' | 'delete'; tagName?: string | undefined }) =>
      api.bulkSubscribersAction({
        ids: [...selectedIds],
        action: vars.action,
        ...(vars.tagName ? { tagName: vars.tagName } : {}),
      }),
    onSuccess: async (res) => {
      toast.success(`Updated ${res.affected} subscriber(s)`);
      setSelectedIds(new Set());
      setBulkTagInput('');
      await invalidateAudience();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Bulk action failed'),
  });

  const updateSubMutation = useMutation({
    mutationFn: (vars: {
      id: string;
      patch: { addTags?: string[] | undefined; removeTags?: string[] | undefined; firstName?: string | undefined; lastName?: string | undefined };
    }) => api.updateSubscriber(vars.id, vars.patch),
    onSuccess: async () => {
      toast.success('Subscriber updated');
      setTagToAdd('');
      await invalidateAudience();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Update failed'),
  });

  const unsubMutation = useMutation({
    mutationFn: (id: string) => api.unsubscribeSubscriber(id, 'profile_manual'),
    onSuccess: async () => {
      toast.success('Subscriber unsubscribed and suppressed');
      await invalidateAudience();
    },
  });

  const resubMutation = useMutation({
    mutationFn: (id: string) => api.resubscribeSubscriber(id, resubConsentSource.trim()),
    onSuccess: async () => {
      toast.success('Subscriber resubscribed with verified consent');
      setResubOpen(false);
      await invalidateAudience();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Resubscribe failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSubscriber(id),
    onSuccess: async () => {
      toast.success('Subscriber deleted');
      setDeleteConfirmId(null);
      setProfileId(null);
      await invalidateAudience();
    },
  });

  const handleExportCsv = async () => {
    try {
      const csv = await api.downloadSubscribersCsv({
        search: search.trim() || undefined,
        status: statusFilter || undefined,
        tag: activeTag || undefined,
        segmentId: segmentFilter || undefined,
        ids: selectedIds.size > 0 ? [...selectedIds] : undefined,
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'fastconnect-subscribers.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Exported subscriber CSV');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    }
  };

  const subscribers = subsQuery.data?.subscribers ?? [];
  const total = subsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 25));
  const tags: TagItem[] = tagsQuery.data?.tags ?? [];
  const segments: SegmentItem[] = segmentsQuery.data?.segments ?? [];

  const allOnPageSelected = subscribers.length > 0 && subscribers.every((s) => selectedIds.has(s.id));

  return (
    <div className="space-y-4">
      {/* Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-text)]">Subscribers ({total})</h3>
          <p className="text-xs text-[var(--color-text-muted)]">
            Single source of truth for your audience — organized via normalized tags, attributes, and segments without duplicate records.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={handleExportCsv}>
            <Download className="h-3.5 w-3.5" />
            {selectedIds.size > 0 ? `Export Selected (${selectedIds.size})` : 'Export CSV'}
          </Button>
          <Button size="sm" variant="secondary" onClick={onOpenImportWizard}>
            Import CSV Wizard
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add Subscriber
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[var(--color-text-muted)]" />
            <Input
              className="pl-8"
              placeholder="Search email or name..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>

          <select
            aria-label="Filter by status"
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Statuses</option>
            <option value="subscribed">Subscribed</option>
            <option value="unsubscribed">Unsubscribed</option>
            <option value="bounced">Bounced</option>
            <option value="complained">Complained</option>
            <option value="pending_confirmation">Pending Confirmation</option>
          </select>

          <select
            aria-label="Filter by tag"
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5"
            value={activeTag}
            onChange={(e) => {
              onClearInitialTag?.();
              setTagFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Tags</option>
            {tags.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name} ({t.subscriberCount})
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by segment"
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5"
            value={segmentFilter}
            onChange={(e) => {
              setSegmentFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Segments</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                Segment: {s.name} ({s.subscriberCount ?? 0})
              </option>
            ))}
          </select>

          <Input
            className="w-36"
            placeholder="Source filter..."
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value);
              setPage(1);
            }}
          />

          <select
            aria-label="Sort subscribers"
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'recent' | 'oldest' | 'engagement' | 'email')}
          >
            <option value="recent">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="engagement">Highest engagement</option>
            <option value="email">Email A-Z</option>
          </select>
        </div>
      </Card>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <Card className="flex flex-wrap items-center justify-between gap-2 border-[var(--color-brand)]/40 bg-[var(--color-brand-soft)]/40 p-3 text-xs">
          <div className="font-medium text-[var(--color-text)]">{selectedIds.size} subscriber(s) selected</div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-40"
              placeholder="Tag name..."
              value={bulkTagInput}
              onChange={(e) => setBulkTagInput(e.target.value)}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!bulkTagInput.trim() || bulkMutation.isPending}
              onClick={() => bulkMutation.mutate({ action: 'add_tag', tagName: bulkTagInput.trim() })}
            >
              Apply Tag
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!bulkTagInput.trim() || bulkMutation.isPending}
              onClick={() => bulkMutation.mutate({ action: 'remove_tag', tagName: bulkTagInput.trim() })}
            >
              Remove Tag
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={bulkMutation.isPending}
              onClick={() => bulkMutation.mutate({ action: 'unsubscribe' })}
            >
              Unsubscribe
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={bulkMutation.isPending}
              onClick={() => bulkMutation.mutate({ action: 'delete' })}
            >
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
          </div>
        </Card>
      )}

      {/* Main grid: Data table + optional profile drawer */}
      <div className={`grid gap-4 ${profileId ? 'lg:grid-cols-12' : ''}`}>
        <Card className={`overflow-hidden ${profileId ? 'lg:col-span-7' : ''}`}>
          {subsQuery.isLoading ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : subscribers.length === 0 ? (
            <EmptyState
              icon={<Users className="h-5 w-5" />}
              title="No matching subscribers"
              description="Add subscribers manually, import a CSV file, or capture signups via Forms and Landing Pages."
              action={<Button onClick={() => setAddOpen(true)}>Add Subscriber</Button>}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 text-[11px] text-[var(--color-text-muted)]">
                  <tr>
                    <th className="p-3 w-8">
                      <input
                        type="checkbox"
                        checked={allOnPageSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedIds(new Set(subscribers.map((s) => s.id)));
                          } else {
                            setSelectedIds(new Set());
                          }
                        }}
                      />
                    </th>
                    <th className="p-3">Subscriber</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Tags</th>
                    <th className="p-3">Source</th>
                    <th className="p-3">Engagement</th>
                    <th className="p-3">Joined</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {subscribers.map((sub: SubscriberRecord) => (
                    <tr
                      key={sub.id}
                      className={`hover:bg-[var(--color-surface-muted)]/40 cursor-pointer ${
                        profileId === sub.id ? 'bg-[var(--color-surface-muted)]/60' : ''
                      }`}
                      onClick={() => setProfileId(sub.id)}
                    >
                      <td className="p-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(sub.id)}
                          onChange={(e) => {
                            const next = new Set(selectedIds);
                            if (e.target.checked) next.add(sub.id);
                            else next.delete(sub.id);
                            setSelectedIds(next);
                          }}
                        />
                      </td>
                      <td className="p-3">
                        <div className="font-mono font-medium text-[var(--color-text)]">{sub.email}</div>
                        {(sub.firstName || sub.lastName) && (
                          <div className="text-[11px] text-[var(--color-text-muted)]">
                            {sub.firstName} {sub.lastName}
                          </div>
                        )}
                      </td>
                      <td className="p-3">
                        <Badge tone={STATUS_TONE[sub.status] ?? 'neutral'}>{sub.status.replace('_', ' ')}</Badge>
                      </td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1">
                          {sub.tags.length === 0 ? (
                            <span className="text-[var(--color-text-muted)]">—</span>
                          ) : (
                            sub.tags.slice(0, 3).map((t) => (
                              <Badge key={t} tone="brand">
                                {t}
                              </Badge>
                            ))
                          )}
                          {sub.tags.length > 3 && <Badge tone="neutral">+{sub.tags.length - 3}</Badge>}
                        </div>
                      </td>
                      <td className="p-3 text-[var(--color-text-muted)]">{sub.consentSource}</td>
                      <td className="p-3">
                        <div className="text-[var(--color-text)] font-medium">{sub.engagementScore} pts</div>
                        <div className="text-[10px] text-[var(--color-text-muted)]">
                          {sub.lastActivityAt ? new Date(sub.lastActivityAt).toLocaleDateString() : 'No clicks/opens yet'}
                        </div>
                      </td>
                      <td className="p-3 text-[var(--color-text-muted)]">
                        {new Date(sub.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="flex items-center justify-between border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
                <span>
                  Page {page} of {totalPages} ({total} total)
                </span>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Card>

        {/* Subscriber Profile Side Panel */}
        {profileId && (
          <Card className="p-4 lg:col-span-5 space-y-4">
            <div className="flex items-start justify-between gap-2 border-b border-[var(--color-border)] pb-3">
              <div>
                <div className="font-mono text-sm font-semibold text-[var(--color-text)]">
                  {profileQuery.data?.subscriber.email ?? 'Loading profile...'}
                </div>
                {profileQuery.data && (
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                    <Badge tone={STATUS_TONE[profileQuery.data.subscriber.status]}>
                      {profileQuery.data.subscriber.status}
                    </Badge>
                    <span>Source: {profileQuery.data.subscriber.consentSource}</span>
                  </div>
                )}
              </div>
              <Button size="icon" variant="ghost" onClick={() => setProfileId(null)} aria-label="Close profile">
                <X className="h-4 w-4" />
              </Button>
            </div>

            {profileQuery.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : profileQuery.data ? (
              <div className="space-y-4 text-xs">
                {/* Details & Quick Actions */}
                <div className="flex flex-wrap gap-2">
                  {profileQuery.data.subscriber.status !== 'unsubscribed' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => unsubMutation.mutate(profileQuery.data.subscriber.id)}
                    >
                      <UserMinus className="h-3.5 w-3.5" />
                      Unsubscribe
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => setResubOpen(true)}>
                      <UserCheck className="h-3.5 w-3.5" />
                      Resubscribe (Consent)
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-600 dark:text-red-400"
                    onClick={() => setDeleteConfirmId(profileQuery.data.subscriber.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                </div>

                {/* Tags */}
                <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
                  <div className="font-semibold text-[var(--color-text)] flex items-center gap-1.5">
                    <Tag className="h-3.5 w-3.5" /> Assigned Tags
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {profileQuery.data.subscriber.tags.map((t) => (
                      <Badge key={t} tone="brand" className="gap-1">
                        {t}
                        <button
                          type="button"
                          className="ml-1 hover:text-red-500 cursor-pointer"
                          onClick={() =>
                            updateSubMutation.mutate({
                              id: profileQuery.data.subscriber.id,
                              patch: { removeTags: [t] },
                            })
                          }
                        >
                          ×
                        </button>
                      </Badge>
                    ))}
                    {profileQuery.data.subscriber.tags.length === 0 && (
                      <span className="text-[var(--color-text-muted)]">No tags yet</span>
                    )}
                  </div>
                  <form
                    className="flex gap-1.5 pt-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!tagToAdd.trim()) return;
                      updateSubMutation.mutate({
                        id: profileQuery.data.subscriber.id,
                        patch: { addTags: [tagToAdd.trim()] },
                      });
                    }}
                  >
                    <Input
                      className="h-8"
                      placeholder="Add tag..."
                      value={tagToAdd}
                      onChange={(e) => setTagToAdd(e.target.value)}
                    />
                    <Button size="sm" type="submit" disabled={!tagToAdd.trim()}>
                      Add
                    </Button>
                  </form>
                </div>

                {/* Custom Fields & Consent */}
                <div className="space-y-1.5 rounded-md border border-[var(--color-border)] p-3">
                  <div className="font-semibold text-[var(--color-text)]">Attributes &amp; Consent</div>
                  <div className="text-[var(--color-text-muted)]">
                    Name: {profileQuery.data.subscriber.firstName} {profileQuery.data.subscriber.lastName || '—'}
                  </div>
                  <div className="text-[var(--color-text-muted)]">
                    Consented: {new Date(profileQuery.data.subscriber.consentedAt).toLocaleString()}
                  </div>
                  {Object.entries(profileQuery.data.subscriber.attributes ?? {}).map(([k, v]) => (
                    <div key={k} className="flex justify-between font-mono text-[11px]">
                      <span className="text-[var(--color-text-muted)]">{k}</span>
                      <span>{String(v ?? '')}</span>
                    </div>
                  ))}
                  {customFieldsQuery.data?.customFields.length ? (
                    <div className="pt-1 text-[10px] text-[var(--color-text-muted)]">
                      Defined org fields: {customFieldsQuery.data.customFields.map((f) => f.fieldKey).join(', ')}
                    </div>
                  ) : null}
                </div>

                {/* Email Delivery & Engagement History */}
                <div className="space-y-1.5 rounded-md border border-[var(--color-border)] p-3">
                  <div className="font-semibold text-[var(--color-text)] flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5" /> Delivery &amp; Engagement Timeline
                  </div>
                  {profileQuery.data.emailActivity.length === 0 && profileQuery.data.deliveries.length === 0 ? (
                    <p className="text-[var(--color-text-muted)]">No broadcast or sequence activity recorded yet.</p>
                  ) : (
                    <div className="max-h-48 overflow-y-auto space-y-1.5">
                      {profileQuery.data.emailActivity.map((ev) => (
                        <div key={ev.id} className="flex items-center justify-between text-[11px]">
                          <span className="font-medium capitalize">{ev.eventType}</span>
                          <span className="truncate max-w-[160px] text-[var(--color-text-muted)]">{ev.detail ?? ''}</span>
                          <span className="text-[var(--color-text-muted)]">{new Date(ev.createdAt).toLocaleDateString()}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Lifecycle Events */}
                {profileQuery.data.events.length > 0 && (
                  <div className="space-y-1.5 rounded-md border border-[var(--color-border)] p-3">
                    <div className="font-semibold text-[var(--color-text)] flex items-center gap-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Consent &amp; Tag Audit Events
                    </div>
                    <div className="max-h-32 overflow-y-auto space-y-1 text-[11px] text-[var(--color-text-muted)]">
                      {profileQuery.data.events.map((ev) => (
                        <div key={ev.id} className="flex justify-between">
                          <span>
                            {ev.eventType} ({ev.source ?? 'system'})
                          </span>
                          <span>{new Date(ev.createdAt).toLocaleDateString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </Card>
        )}
      </div>

      {/* Add Subscriber Modal */}
      <AppDialog open={addOpen} onOpenChange={setAddOpen} title="Add Subscriber">
        <form
          className="space-y-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            addMutation.mutate();
          }}
        >
          <div className="space-y-1">
            <label className="font-medium">Email Address *</label>
            <Input autoFocus type="email" required value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="subscriber@company.com" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="font-medium">First Name</label>
              <Input value={newFirst} onChange={(e) => setNewFirst(e.target.value)} placeholder="Alice" />
            </div>
            <div className="space-y-1">
              <label className="font-medium">Last Name</label>
              <Input value={newLast} onChange={(e) => setNewLast(e.target.value)} placeholder="Rivera" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="font-medium">Tags (comma-separated)</label>
            <Input value={newTags} onChange={(e) => setNewTags(e.target.value)} placeholder="Newsletter, Customer" />
          </div>
          <div className="space-y-1">
            <label className="font-medium">Consent Source *</label>
            <Input required value={newSource} onChange={(e) => setNewSource(e.target.value)} placeholder="web_signup_form" />
          </div>
          <div className="space-y-1">
            <label className="font-medium">Custom Attributes (key=value per line, optional)</label>
            <textarea
              rows={3}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-xs"
              placeholder={'plan_tier=pro\ncompany=Acme'}
              value={newAttrsText}
              onChange={(e) => setNewAttrsText(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={addMutation.isPending}>
              {addMutation.isPending ? 'Saving...' : 'Save Subscriber'}
            </Button>
          </div>
        </form>
      </AppDialog>

      {/* Consent Resubscribe Dialog */}
      <AppDialog open={resubOpen} onOpenChange={setResubOpen} title="Confirm Explicit Resubscribe Consent">
        <form
          className="space-y-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            if (profileQuery.data) resubMutation.mutate(profileQuery.data.subscriber.id);
          }}
        >
          <p className="text-[var(--color-text-muted)]">
            Resubscribing an unsubscribed contact requires verifiable opt-in consent. Record the proof/source of consent below.
          </p>
          <Input required value={resubConsentSource} onChange={(e) => setResubConsentSource(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setResubOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={resubMutation.isPending}>
              Confirm Resubscribe
            </Button>
          </div>
        </form>
      </AppDialog>

      {/* Safe Subscriber Delete Dialog */}
      <AppDialog open={Boolean(deleteConfirmId)} onOpenChange={(o) => !o && setDeleteConfirmId(null)} title="Delete Subscriber Permanently?">
        <div className="space-y-3 text-xs">
          <p className="text-[var(--color-text-muted)]">
            This permanently deletes this subscriber profile and tag memberships. Suppression entries (if unsubscribed/bounced) should be managed in Suppressions to prevent accidental re-imports.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={deleteMutation.isPending}
              onClick={() => deleteConfirmId && deleteMutation.mutate(deleteConfirmId)}
            >
              Delete Subscriber
            </Button>
          </div>
        </div>
      </AppDialog>
    </div>
  );
}
