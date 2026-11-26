import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppDialog, Badge, Button, Card, EmptyState, Input, Skeleton } from '@mail/ui';
import type { BroadcastAnalyticsSummary } from '@mail/shared-types';
import {
  BarChart3,
  Calendar,
  Copy,
  Info,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Send,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, type CampaignItem } from '../../lib/api.js';
import { BroadcastComposerWorkspace } from './BroadcastComposerWorkspace.js';
import { clearLocalDraftRecovery } from './useBroadcastDraftAutosave.js';

const STATUS_BADGE: Record<CampaignItem['status'], 'neutral' | 'brand' | 'warning' | 'success' | 'danger'> = {
  draft: 'neutral',
  scheduled: 'brand',
  sending: 'warning',
  running: 'warning',
  paused: 'warning',
  completed: 'success',
  cancelled: 'neutral',
  failed: 'danger',
};

export function BroadcastAnalyticsPanel({
  campaign,
  onClose,
}: {
  campaign: CampaignItem;
  onClose?: (() => void) | undefined;
}) {
  const analyticsQuery = useQuery({
    queryKey: ['campaign-analytics', campaign.id],
    queryFn: () => api.getBroadcastAnalytics(campaign.id),
    refetchInterval: campaign.status === 'sending' || campaign.status === 'running' ? 5000 : false,
  });

  const a: BroadcastAnalyticsSummary | undefined = analyticsQuery.data?.analytics;

  return (
    <Card className="p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-[var(--color-text)]">{campaign.name}</h3>
            <Badge tone={STATUS_BADGE[campaign.status]}>{campaign.status}</Badge>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            Subject: {campaign.subject ?? '(none)'} • From: {campaign.fromName ? `${campaign.fromName} ` : ''}
            {campaign.fromEmail ?? '(default domain sender)'}
          </p>
        </div>
        {onClose && (
          <Button size="sm" variant="secondary" onClick={onClose}>
            Close Analytics
          </Button>
        )}
      </div>

      {analyticsQuery.isLoading || !a ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
              <div className="text-[11px] uppercase text-[var(--color-text-muted)]">Eligible / Target</div>
              <div className="mt-1 text-xl font-semibold text-[var(--color-text)]">{a.eligibleRecipients}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">Targeted: {a.totalTargeted}</div>
            </div>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
              <div className="text-[11px] uppercase text-[var(--color-text-muted)]">Queued / Handed Off</div>
              <div className="mt-1 text-xl font-semibold text-[var(--color-text)]">{a.sent}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">Pending: {a.queued} • Failed: {a.failed}</div>
            </div>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
              <div className="text-[11px] uppercase text-[var(--color-text-muted)]">Accepted Remote SMTP</div>
              <div className="mt-1 text-xl font-semibold text-emerald-600 dark:text-emerald-400">{a.acceptedRemote}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">Delivered: {a.delivered}</div>
            </div>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
              <div className="text-[11px] uppercase text-[var(--color-text-muted)]">Unique Opens</div>
              <div className="mt-1 text-xl font-semibold text-[var(--color-brand)]">{a.uniqueOpens}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">Total opens: {a.opens}</div>
            </div>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
              <div className="text-[11px] uppercase text-[var(--color-text-muted)]">Unique Clicks</div>
              <div className="mt-1 text-xl font-semibold text-indigo-600 dark:text-indigo-400">{a.uniqueClicks}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">Total clicks: {a.clicks}</div>
            </div>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
              <div className="text-[11px] uppercase text-[var(--color-text-muted)]">Bounces / Unsub</div>
              <div className="mt-1 text-xl font-semibold text-amber-600 dark:text-amber-400">
                {a.bounces} / {a.unsubscribes}
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                Complaints: {a.complaints} • Cancelled: {a.cancelled}
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
            <Info className="h-4 w-4 shrink-0 mt-0.5 text-[var(--color-brand)]" />
            <span>
              <strong>Measurement note:</strong> &ldquo;Accepted Remote SMTP&rdquo; reflects remote 250 OK handoff, not inbox
              vs promotions placement. Open rates depend on pixel loading and client proxy caching.
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Top Clicked Links</h4>
              {a.topLinks.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)]">No link clicks recorded yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {a.topLinks.map((lnk) => (
                    <div
                      key={lnk.url}
                      className="flex items-center justify-between gap-2 rounded bg-[var(--color-surface-muted)] px-2.5 py-1.5 text-xs"
                    >
                      <span className="truncate font-mono text-[var(--color-text)]">{lnk.url}</span>
                      <span className="shrink-0 text-[var(--color-text-muted)]">
                        {lnk.uniqueClicks} unique ({lnk.clicks} total)
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Recent Activity Log</h4>
              {a.recentActivity.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)]">No subscriber activity events recorded yet.</p>
              ) : (
                <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
                  {a.recentActivity.map((ev) => (
                    <div
                      key={ev.id}
                      className="flex items-center justify-between gap-2 rounded bg-[var(--color-surface-muted)] px-2.5 py-1.5 text-xs"
                    >
                      <div className="min-w-0">
                        <span className="font-medium text-[var(--color-text)]">{ev.recipientEmail}</span>
                        <span className="ml-2 text-[var(--color-text-muted)]">{ev.eventType}</span>
                        {ev.detail && <span className="ml-2 text-[11px] text-[var(--color-text-muted)]">({ev.detail})</span>}
                      </div>
                      <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
                        {new Date(ev.occurredAt).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

export function BroadcastsSection({ initialMode = 'broadcasts' }: { initialMode?: 'broadcasts' | 'analytics' }) {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<'all' | CampaignItem['status']>('all');
  const [search, setSearch] = useState('');
  const [analyticsCampaignId, setAnalyticsCampaignId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CampaignItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CampaignItem | null>(null);

  // Full-width composer workspace state (persisted across accidental refresh via sessionStorage)
  const [composerMode, setComposerMode] = useState<'closed' | 'new' | 'edit'>(() => {
    try {
      const savedMode = sessionStorage.getItem('fastconnect_broadcast_composer_mode');
      return savedMode === 'new' || savedMode === 'edit' ? savedMode : 'closed';
    } catch {
      return 'closed';
    }
  });
  const [composerCampaign, setComposerCampaign] = useState<CampaignItem | null>(null);

  const domainsQuery = useQuery({ queryKey: ['domains'], queryFn: () => api.listDomains() });
  const campaignsQuery = useQuery({ queryKey: ['campaigns'], queryFn: () => api.listCampaigns() });

  const allDomains = domainsQuery.data?.domains ?? [];
  const campaigns = campaignsQuery.data?.campaigns ?? [];
  const domainById = new Map(allDomains.map((d) => [d.id, d]));

  // Restore exact server draft on browser refresh if user was actively editing a broadcast
  useEffect(() => {
    if (composerMode === 'edit' && !composerCampaign && campaigns.length > 0) {
      try {
        const activeId = sessionStorage.getItem('fastconnect_active_broadcast_id');
        if (activeId) {
          const found = campaigns.find((c) => c.id === activeId);
          if (found) setComposerCampaign(found);
          else setComposerMode('closed');
        }
      } catch {
        setComposerMode('closed');
      }
    }
  }, [campaigns, composerCampaign, composerMode]);

  const openNewComposer = () => {
    setComposerCampaign(null);
    setComposerMode('new');
    try {
      sessionStorage.setItem('fastconnect_broadcast_composer_mode', 'new');
      sessionStorage.removeItem('fastconnect_active_broadcast_id');
    } catch {
      // ignore
    }
  };

  const openEditComposer = (campaign: CampaignItem) => {
    setComposerCampaign(campaign);
    setComposerMode('edit');
    try {
      sessionStorage.setItem('fastconnect_broadcast_composer_mode', 'edit');
      sessionStorage.setItem('fastconnect_active_broadcast_id', campaign.id);
    } catch {
      // ignore
    }
  };

  const closeComposer = () => {
    setComposerMode('closed');
    setComposerCampaign(null);
    try {
      sessionStorage.removeItem('fastconnect_broadcast_composer_mode');
      sessionStorage.removeItem('fastconnect_active_broadcast_id');
    } catch {
      // ignore
    }
  };

  const duplicateMutation = useMutation({
    mutationFn: (id: string) => api.duplicateCampaign(id),
    onSuccess: (res) => {
      toast.success(`Duplicated "${res.campaign.name}" as draft`);
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Duplicate failed'),
  });

  const transitionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' | 'start' | 'cancel' }) =>
      api.transitionCampaign(id, action),
    onSuccess: (res, vars) => {
      if (vars.action === 'cancel' && res.cancelReport) {
        toast.success(
          `Cancelled: ${res.cancelReport.cancelledCount} queued halted (${res.cancelReport.handedOffCount} already handed to SMTP).`
        );
        setCancelTarget(null);
      } else if (vars.action === 'start') {
        toast.success(`Broadcast started (${res.dispatchedCount ?? 0} recipients queued)`);
      } else {
        toast.success(`Campaign ${vars.action}d`);
      }
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Action failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteCampaign(id),
    onSuccess: (_res, id) => {
      toast.success('Broadcast deleted');
      clearLocalDraftRecovery(id);
      if (analyticsCampaignId === id) setAnalyticsCampaignId(null);
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Delete failed'),
  });

  if (composerMode !== 'closed') {
    return (
      <BroadcastComposerWorkspace
        initialCampaign={composerCampaign}
        onBack={closeComposer}
        onCampaignSaved={(saved) => setComposerCampaign(saved)}
      />
    );
  }

  const activeAnalyticsCampaign =
    campaigns.find((c) => c.id === analyticsCampaignId) ??
    (initialMode === 'analytics' ? campaigns[0] : undefined);

  if (initialMode === 'analytics') {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text)]">Broadcast Delivery &amp; Engagement Funnel</h3>
            <p className="text-xs text-[var(--color-text-muted)]">
              Inspect queued, SMTP-accepted, opened, clicked, bounced, and unsubscribed recipients per broadcast.
            </p>
          </div>
          {campaigns.length > 0 && (
            <select
              value={activeAnalyticsCampaign?.id ?? ''}
              onChange={(e) => setAnalyticsCampaignId(e.target.value)}
              className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)]"
            >
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.status})
                </option>
              ))}
            </select>
          )}
        </div>

        {activeAnalyticsCampaign ? (
          <BroadcastAnalyticsPanel campaign={activeAnalyticsCampaign} />
        ) : (
          <Card>
            <EmptyState
              icon={<BarChart3 className="h-5 w-5" />}
              title="No broadcasts sent yet"
              description="Send or schedule your first broadcast to view delivery funnel and link click telemetry."
            />
          </Card>
        )}
      </div>
    );
  }

  const filteredCampaigns = campaigns.filter((c) => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        (c.subject ?? '').toLowerCase().includes(q) ||
        (domainById.get(c.domainId)?.domainName ?? '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-[var(--color-text-muted)]" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search broadcasts..."
              className="pl-8"
            />
          </div>
          <div className="flex flex-wrap gap-1 border border-[var(--color-border)] rounded-lg bg-[var(--color-surface-muted)] p-0.5">
            {(['all', 'draft', 'scheduled', 'sending', 'completed', 'paused', 'cancelled', 'failed'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors cursor-pointer ${
                  statusFilter === st
                    ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                }`}
              >
                {st === 'all' ? `All (${campaigns.length})` : st}
              </button>
            ))}
          </div>
        </div>

        <Button onClick={openNewComposer}>
          <Plus className="h-4 w-4" /> Create Broadcast
        </Button>
      </div>

      {activeAnalyticsCampaign && (
        <BroadcastAnalyticsPanel campaign={activeAnalyticsCampaign} onClose={() => setAnalyticsCampaignId(null)} />
      )}

      {campaignsQuery.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : filteredCampaigns.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Send className="h-5 w-5" />}
            title={campaigns.length === 0 ? 'No broadcasts yet' : 'No matching broadcasts'}
            description="Create a broadcast to compose an email in the full-width editor, target central tags or segments, and send safely."
            action={
              <Button onClick={openNewComposer}>
                <Plus className="h-4 w-4" /> Create Broadcast
              </Button>
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">
                <tr>
                  <th className="px-4 py-3">Broadcast &amp; Subject</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Sending Domain</th>
                  <th className="px-4 py-3">Audience / Sent</th>
                  <th className="px-4 py-3">Schedule / Updated</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {filteredCampaigns.map((c) => {
                  const domain = domainById.get(c.domainId);
                  const isEditable = c.status === 'draft' || c.status === 'scheduled' || c.status === 'paused';
                  return (
                    <tr key={c.id} className="hover:bg-[var(--color-surface-muted)]/35">
                      <td className="px-4 py-3 max-w-xs">
                        <div className="font-semibold text-[var(--color-text)] truncate">{c.name}</div>
                        <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                          {c.subject || '(no subject yet)'}
                        </div>
                        {c.failureReason && (
                          <div className="text-[11px] text-[var(--color-danger)] mt-0.5">{c.failureReason}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={STATUS_BADGE[c.status]}>{c.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-[var(--color-text-muted)]">
                        <div>{domain?.domainName ?? c.fromEmail ?? '—'}</div>
                        {c.fromEmail && <div className="text-[10px] font-mono">{c.fromEmail}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-[var(--color-text)]">
                          {c.sentCount} / {c.targetCount}
                        </div>
                        <div className="text-[10px] text-[var(--color-text-muted)]">dispatched / targeted</div>
                      </td>
                      <td className="px-4 py-3 text-[var(--color-text-muted)]">
                        {c.scheduledAt ? (
                          <div className="inline-flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {new Date(c.scheduledAt).toLocaleString()}
                          </div>
                        ) : (
                          <div>Updated {new Date(c.updatedAt ?? c.createdAt).toLocaleString()}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {isEditable && (
                            <Button size="sm" variant="primary" onClick={() => openEditComposer(c)}>
                              <Pencil className="h-3.5 w-3.5" /> Edit
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setAnalyticsCampaignId(analyticsCampaignId === c.id ? null : c.id)}
                          >
                            <BarChart3 className="h-3.5 w-3.5" /> Analytics
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Duplicate broadcast"
                            aria-label={`Duplicate ${c.name}`}
                            onClick={() => duplicateMutation.mutate(c.id)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          {c.status === 'sending' && (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Pause broadcast"
                              aria-label={`Pause ${c.name}`}
                              onClick={() => transitionMutation.mutate({ id: c.id, action: 'pause' })}
                            >
                              <Pause className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {c.status === 'paused' && (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Resume broadcast"
                              aria-label={`Resume ${c.name}`}
                              onClick={() => transitionMutation.mutate({ id: c.id, action: 'resume' })}
                            >
                              <Play className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {(c.status === 'scheduled' || c.status === 'sending' || c.status === 'paused') && (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Cancel remaining deliveries"
                              aria-label={`Cancel ${c.name}`}
                              className="text-amber-600 dark:text-amber-400"
                              onClick={() => setCancelTarget(c)}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {c.status !== 'sending' && (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Delete broadcast"
                              aria-label={`Delete ${c.name}`}
                              className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
                              onClick={() => setDeleteTarget(c)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Safe Cancel Dialog */}
      <AppDialog
        open={Boolean(cancelTarget)}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
        title={`Cancel "${cancelTarget?.name ?? ''}"?`}
      >
        <div className="space-y-3 text-xs text-[var(--color-text-muted)]">
          <p>
            Pending recipient deliveries not yet handed off to SMTP will be marked <code>cancelled</code>. Messages already
            accepted into SMTP queues cannot be recalled, and exact counts will be reported.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelTarget(null)}>
              Keep Active
            </Button>
            <Button
              variant="danger"
              disabled={transitionMutation.isPending}
              onClick={() => cancelTarget && transitionMutation.mutate({ id: cancelTarget.id, action: 'cancel' })}
            >
              {transitionMutation.isPending ? 'Cancelling...' : 'Confirm Cancellation'}
            </Button>
          </div>
        </div>
      </AppDialog>

      {/* Delete Confirmation */}
      <AppDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete Broadcast"
      >
        <div className="space-y-3">
          <p className="text-xs text-[var(--color-text-muted)]">
            Permanently delete &ldquo;{deleteTarget?.name ?? ''}&rdquo;?
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Keep
            </Button>
            <Button
              variant="danger"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Permanently'}
            </Button>
          </div>
        </div>
      </AppDialog>
    </div>
  );
}
