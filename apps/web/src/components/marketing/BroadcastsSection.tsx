import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppDialog, Badge, Button, Card, EmptyState, Input, Skeleton } from '@mail/ui';
import type {
  AudienceEstimate,
  AudienceSelectionSpec,
  BroadcastAnalyticsSummary,
  EmailTemplateBlock,
  SubscriberRecord,
} from '@mail/shared-types';
import {
  AlertCircle,
  BarChart3,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Info,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
  ShieldAlert,
  Trash2,
  Users,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, type CampaignItem } from '../../lib/api.js';
import {
  compileClientBlocks,
  DEFAULT_TEMPLATE_BLOCKS,
  sanitizePreviewHtml,
  VisualEmailEditor,
} from './VisualEmailEditor.js';

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

const COMMON_TIMEZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Asia/Singapore'];

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
    refetchInterval: campaign.status === 'sending' ? 5000 : false,
  });

  const a: BroadcastAnalyticsSummary | undefined = analyticsQuery.data?.analytics;

  return (
    <Card className="p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-[var(--fg-primary)]">{campaign.name}</h3>
            <Badge tone={STATUS_BADGE[campaign.status]}>{campaign.status}</Badge>
          </div>
          <p className="text-xs text-[var(--fg-muted)] mt-0.5">
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
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3">
              <div className="text-[11px] uppercase text-[var(--fg-muted)]">Eligible / Target</div>
              <div className="mt-1 text-xl font-semibold text-[var(--fg-primary)]">{a.eligibleRecipients}</div>
              <div className="text-[11px] text-[var(--fg-muted)]">Targeted: {a.totalTargeted}</div>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3">
              <div className="text-[11px] uppercase text-[var(--fg-muted)]">Queued / Handed Off</div>
              <div className="mt-1 text-xl font-semibold text-[var(--fg-primary)]">{a.sent}</div>
              <div className="text-[11px] text-[var(--fg-muted)]">Pending queue: {a.queued}</div>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3">
              <div className="text-[11px] uppercase text-[var(--fg-muted)]">Accepted Remote SMTP</div>
              <div className="mt-1 text-xl font-semibold text-emerald-400">{a.acceptedRemote}</div>
              <div className="text-[11px] text-[var(--fg-muted)]">Delivered events: {a.delivered}</div>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3">
              <div className="text-[11px] uppercase text-[var(--fg-muted)]">Unique Opens</div>
              <div className="mt-1 text-xl font-semibold text-sky-400">{a.uniqueOpens}</div>
              <div className="text-[11px] text-[var(--fg-muted)]">Total opens: {a.opens}</div>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3">
              <div className="text-[11px] uppercase text-[var(--fg-muted)]">Unique Clicks</div>
              <div className="mt-1 text-xl font-semibold text-indigo-400">{a.uniqueClicks}</div>
              <div className="text-[11px] text-[var(--fg-muted)]">Total clicks: {a.clicks}</div>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3">
              <div className="text-[11px] uppercase text-[var(--fg-muted)]">Bounces / Unsub</div>
              <div className="mt-1 text-xl font-semibold text-amber-400">
                {a.bounces} / {a.unsubscribes}
              </div>
              <div className="text-[11px] text-[var(--fg-muted)]">
                Complaints: {a.complaints} • Cancelled: {a.cancelled}
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3 py-2 text-xs text-[var(--fg-muted)]">
            <Info className="h-4 w-4 shrink-0 mt-0.5 text-sky-400" />
            <span>
              <strong>Measurement honesty:</strong> &ldquo;Accepted by remote SMTP&rdquo; records remote 250 OK handoff
              (not inbox vs promotions placement). Open tracking relies on tracking pixels and may be undercounted when
              email clients block images or overcounted by Apple Mail Privacy Protection proxies.
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">Top Clicked Links</h4>
              {a.topLinks.length === 0 ? (
                <p className="text-xs text-[var(--fg-muted)]">No link clicks recorded yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {a.topLinks.map((lnk) => (
                    <div
                      key={lnk.url}
                      className="flex items-center justify-between gap-2 rounded bg-[var(--bg-subtle)] px-2.5 py-1.5 text-xs"
                    >
                      <span className="truncate font-mono text-[var(--fg-primary)]">{lnk.url}</span>
                      <span className="shrink-0 text-[var(--fg-muted)]">
                        {lnk.uniqueClicks} unique ({lnk.clicks} total)
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">Recent Activity Log</h4>
              {a.recentActivity.length === 0 ? (
                <p className="text-xs text-[var(--fg-muted)]">No subscriber activity events recorded yet.</p>
              ) : (
                <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
                  {a.recentActivity.map((ev) => (
                    <div
                      key={ev.id}
                      className="flex items-center justify-between gap-2 rounded bg-[var(--bg-subtle)] px-2.5 py-1.5 text-xs"
                    >
                      <div className="min-w-0">
                        <span className="font-medium text-[var(--fg-primary)]">{ev.recipientEmail}</span>
                        <span className="ml-2 text-[var(--fg-muted)]">{ev.eventType}</span>
                        {ev.detail && <span className="ml-2 text-[11px] text-[var(--fg-muted)]">({ev.detail})</span>}
                      </div>
                      <span className="shrink-0 text-[11px] text-[var(--fg-muted)]">
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
  const [analyticsCampaignId, setAnalyticsCampaignId] = useState<string | null>(null);

  // Cancel confirmation dialog
  const [cancelTarget, setCancelTarget] = useState<CampaignItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CampaignItem | null>(null);

  // Guided 5-step Wizard state
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Step 1
  const [domainId, setDomainId] = useState('');
  const [name, setName] = useState('');
  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [subject, setSubject] = useState('Newsletter update for {{firstName | fallback: "you"}}');
  const [previewText, setPreviewText] = useState('');

  // Step 2 Audience
  const [audienceMode, setAudienceMode] = useState<'all' | 'filtered'>('all');
  const [includeTags, setIncludeTags] = useState<string[]>([]);
  const [includeSegmentIds, setIncludeSegmentIds] = useState<string[]>([]);
  const [excludeTags, setExcludeTags] = useState<string[]>([]);
  const [excludeSegmentIds, setExcludeSegmentIds] = useState<string[]>([]);
  const [estimateResult, setEstimateResult] = useState<{ estimate: AudienceEstimate; sample: SubscriberRecord[] } | null>(null);
  const [estimating, setEstimating] = useState(false);

  // Step 3 Content
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [blocks, setBlocks] = useState<EmailTemplateBlock[]>(DEFAULT_TEMPLATE_BLOCKS);
  const [htmlBody, setHtmlBody] = useState(() => compileClientBlocks(DEFAULT_TEMPLATE_BLOCKS).htmlBody);
  const [textBody, setTextBody] = useState(() => compileClientBlocks(DEFAULT_TEMPLATE_BLOCKS).textBody);

  // Step 4 Test Send
  const [testEmail, setTestEmail] = useState('');
  const [sendingTest, setSendingTest] = useState(false);

  // Step 5 Schedule
  const [deliveryChoice, setDeliveryChoice] = useState<'draft' | 'now' | 'schedule'>('now');
  const [scheduledLocal, setScheduledLocal] = useState('');
  const [timezone, setTimezone] = useState('UTC');

  const domainsQuery = useQuery({ queryKey: ['domains'], queryFn: () => api.listDomains() });
  const campaignsQuery = useQuery({ queryKey: ['campaigns'], queryFn: () => api.listCampaigns() });
  const templatesQuery = useQuery({ queryKey: ['templates', false], queryFn: () => api.listTemplates(false) });
  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: () => api.listTags() });
  const segmentsQuery = useQuery({ queryKey: ['segments'], queryFn: () => api.listSegments() });

  const allDomains = domainsQuery.data?.domains ?? [];
  const verifiedSendingDomains = allDomains.filter(
    (d) => Boolean(d.ownershipVerifiedAt) && d.sendingEnabled && !d.isSuspended
  );
  const campaigns = campaignsQuery.data?.campaigns ?? [];
  const templates = templatesQuery.data?.templates ?? [];
  const tags = tagsQuery.data?.tags ?? [];
  const segments = segmentsQuery.data?.segments ?? [];

  const currentAudienceSpec: AudienceSelectionSpec = useMemo(
    () =>
      audienceMode === 'all'
        ? {
            mode: 'all',
            ...(excludeTags.length > 0 ? { excludeTags } : {}),
            ...(excludeSegmentIds.length > 0 ? { excludeSegmentIds } : {}),
          }
        : {
            mode: 'filtered',
            ...(includeTags.length > 0 ? { includeTags } : {}),
            ...(includeSegmentIds.length > 0 ? { includeSegmentIds } : {}),
            ...(excludeTags.length > 0 ? { excludeTags } : {}),
            ...(excludeSegmentIds.length > 0 ? { excludeSegmentIds } : {}),
          },
    [audienceMode, excludeSegmentIds, excludeTags, includeSegmentIds, includeTags]
  );

  const runEstimate = async (spec: AudienceSelectionSpec) => {
    setEstimating(true);
    try {
      const res = await api.estimateCampaignAudience(spec);
      setEstimateResult(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Audience estimation failed');
    } finally {
      setEstimating(false);
    }
  };

  useEffect(() => {
    if (wizardOpen && wizardStep === 2) {
      void runEstimate(currentAudienceSpec);
    }
  }, [wizardOpen, wizardStep, currentAudienceSpec]);

  const openNewWizard = () => {
    const firstVerified = verifiedSendingDomains[0];
    setEditingId(null);
    setWizardStep(1);
    setDomainId(firstVerified?.id ?? '');
    setName('');
    setFromName('');
    setFromEmail(
      firstVerified ? `${firstVerified.defaultSenderLocalPart ?? 'newsletter'}@${firstVerified.domainName}` : ''
    );
    setReplyTo('');
    setSubject('Newsletter update for {{firstName | fallback: "you"}}');
    setPreviewText('');
    setAudienceMode('all');
    setIncludeTags([]);
    setIncludeSegmentIds([]);
    setExcludeTags([]);
    setExcludeSegmentIds([]);
    setEstimateResult(null);
    setSelectedTemplateId('');
    setBlocks(DEFAULT_TEMPLATE_BLOCKS);
    const compiled = compileClientBlocks(DEFAULT_TEMPLATE_BLOCKS);
    setHtmlBody(compiled.htmlBody);
    setTextBody(compiled.textBody);
    setDeliveryChoice('now');
    setScheduledLocal('');
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    setWizardOpen(true);
  };

  const openEditWizard = (c: CampaignItem) => {
    setEditingId(c.id);
    setWizardStep(1);
    setDomainId(c.domainId);
    setName(c.name);
    setFromName(c.fromName ?? '');
    setFromEmail(c.fromEmail ?? '');
    setReplyTo(c.replyTo ?? '');
    setSubject(c.subject ?? '');
    setPreviewText(c.previewText ?? '');
    const spec = c.audienceSpec;
    if (spec) {
      setAudienceMode(spec.mode);
      setIncludeTags(spec.includeTags ?? []);
      setIncludeSegmentIds(spec.includeSegmentIds ?? []);
      setExcludeTags(spec.excludeTags ?? []);
      setExcludeSegmentIds(spec.excludeSegmentIds ?? []);
    } else if (c.tagFilter) {
      setAudienceMode('filtered');
      setIncludeTags([c.tagFilter]);
      setIncludeSegmentIds([]);
      setExcludeTags([]);
      setExcludeSegmentIds([]);
    } else {
      setAudienceMode('all');
      setIncludeTags([]);
      setIncludeSegmentIds([]);
      setExcludeTags([]);
      setExcludeSegmentIds([]);
    }
    setSelectedTemplateId(c.templateId ?? '');
    setBlocks(c.blocksJson ?? []);
    setHtmlBody(c.htmlBody ?? '');
    setTextBody(c.textBody ?? '');
    setDeliveryChoice(c.scheduledAt ? 'schedule' : 'draft');
    setScheduledLocal(c.scheduledAt ? c.scheduledAt.slice(0, 16) : '');
    setTimezone(c.timezone || 'UTC');
    setWizardOpen(true);
  };

  const buildPayload = (scheduledIso: string | null) => ({
    domainId,
    ...(selectedTemplateId ? { templateId: selectedTemplateId } : {}),
    name,
    ...(fromName ? { fromName } : {}),
    fromEmail: fromEmail || null,
    replyTo: replyTo || null,
    subject: subject || null,
    ...(previewText ? { previewText } : {}),
    htmlBody: sanitizePreviewHtml(htmlBody) || null,
    textBody: textBody || null,
    ...(blocks.length > 0 ? { blocksJson: blocks } : {}),
    audienceSpec: currentAudienceSpec,
    timezone,
    scheduledAt: scheduledIso,
    tagFilter: includeTags[0] ?? null,
  });

  const handleSaveOrSend = async (choice: 'draft' | 'now' | 'schedule') => {
    try {
      let scheduledIso: string | null = null;
      if (choice === 'schedule') {
        if (!scheduledLocal) {
          toast.error('Please pick a scheduled date and time');
          return;
        }
        scheduledIso = new Date(scheduledLocal).toISOString();
      }
      const payload = buildPayload(scheduledIso);
      let saved: CampaignItem;
      if (editingId) {
        const res = await api.updateCampaign(editingId, payload);
        saved = res.campaign;
      } else {
        const res = await api.createCampaign(payload);
        saved = res.campaign;
        setEditingId(saved.id);
      }

      if (choice === 'now') {
        const startRes = await api.transitionCampaign(saved.id, 'start');
        toast.success(`Broadcast queued for ${startRes.dispatchedCount ?? saved.targetCount} subscribers`);
      } else if (choice === 'schedule') {
        toast.success(`Broadcast scheduled for ${new Date(scheduledIso!).toLocaleString()}`);
      } else {
        toast.success('Broadcast saved as draft');
      }
      setWizardOpen(false);
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save broadcast');
    }
  };

  const handleSendTest = async () => {
    if (!testEmail.trim()) {
      toast.error('Enter a recipient email for the test send');
      return;
    }
    if (!domainId) {
      toast.error('Select a verified sending domain first');
      return;
    }
    setSendingTest(true);
    try {
      let targetId = editingId;
      if (!targetId) {
        const created = await api.createCampaign(buildPayload(null));
        targetId = created.campaign.id;
        setEditingId(targetId);
        qc.invalidateQueries({ queryKey: ['campaigns'] });
      } else {
        await api.updateCampaign(targetId, buildPayload(null));
      }
      await api.sendCampaignTest(targetId, testEmail.trim());
      toast.success(`Test email queued for ${testEmail.trim()}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test send failed');
    } finally {
      setSendingTest(false);
    }
  };

  const transitionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' | 'start' | 'cancel' }) =>
      api.transitionCampaign(id, action),
    onSuccess: (res, vars) => {
      if (vars.action === 'cancel' && res.cancelReport) {
        toast.success(
          `Cancelled: ${res.cancelReport.cancelledCount} queued deliveries halted (${res.cancelReport.handedOffCount} already handed off to SMTP).`
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
    onSuccess: () => {
      toast.success('Broadcast deleted');
      setDeleteTarget(null);
      if (analyticsCampaignId === deleteTarget?.id) setAnalyticsCampaignId(null);
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Delete failed'),
  });

  const activeAnalyticsCampaign =
    campaigns.find((c) => c.id === analyticsCampaignId) ??
    (initialMode === 'analytics' ? campaigns[0] : undefined);

  if (initialMode === 'analytics') {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--fg-primary)]">Broadcast Delivery & Engagement Funnel</h2>
            <p className="text-xs text-[var(--fg-muted)]">
              Inspect queued, SMTP-accepted, opened, clicked, bounced, and unsubscribed recipients per broadcast.
            </p>
          </div>
          {campaigns.length > 0 && (
            <select
              value={activeAnalyticsCampaign?.id ?? ''}
              onChange={(e) => setAnalyticsCampaignId(e.target.value)}
              className="rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--fg-primary)]"
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
          <EmptyState
            icon={<BarChart3 className="h-5 w-5" />}
            title="No broadcasts sent yet"
            description="Send or schedule your first broadcast to view delivery funnel and link click telemetry."
          />
        )}
      </div>
    );
  }

  const filteredCampaigns = campaigns.filter((c) => (statusFilter === 'all' ? true : c.status === statusFilter));
  const toggleInList = (list: string[], val: string, setter: (next: string[]) => void) => {
    setter(list.includes(val) ? list.filter((x) => x !== val) : [...list, val]);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(['all', 'draft', 'scheduled', 'sending', 'completed', 'paused', 'cancelled', 'failed'] as const).map((st) => (
            <Button
              key={st}
              size="sm"
              variant={statusFilter === st ? 'primary' : 'secondary'}
              onClick={() => setStatusFilter(st)}
            >
              {st === 'all' ? `All (${campaigns.length})` : st}
            </Button>
          ))}
        </div>

        <Button onClick={openNewWizard}>
          <Plus className="mr-1.5 h-4 w-4" /> Create Broadcast
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
        <EmptyState
          icon={<Send className="h-5 w-5" />}
          title="No broadcasts in this view"
          description="Use the guided Broadcast Wizard to pick a verified domain, select tags or segments, compose an email, preview & test, and send."
          action={
            <Button onClick={openNewWizard}>
              <Plus className="mr-1.5 h-4 w-4" /> Create Broadcast
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {filteredCampaigns.map((c) => (
            <Card key={c.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--fg-primary)]">{c.name}</h3>
                    <Badge tone={STATUS_BADGE[c.status]}>{c.status}</Badge>
                    {c.failureReason && <span className="text-xs text-red-400">({c.failureReason})</span>}
                  </div>
                  <p className="text-xs text-[var(--fg-secondary)]">
                    Subject: <span className="font-medium">{c.subject ?? '(untitled)'}</span>
                    {c.fromEmail ? ` • From: ${c.fromEmail}` : ''}
                  </p>
                  <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--fg-muted)]">
                    <span>Targeted: {c.targetCount}</span>
                    <span>Dispatched: {c.sentCount}</span>
                    {c.scheduledAt && (
                      <span className="inline-flex items-center gap-1">
                        <Calendar className="h-3 w-3" /> Scheduled: {new Date(c.scheduledAt).toLocaleString()} ({c.timezone})
                      </span>
                    )}
                    {c.dispatchedAt && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" /> Dispatched: {new Date(c.dispatchedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setAnalyticsCampaignId(analyticsCampaignId === c.id ? null : c.id)}
                  >
                    <BarChart3 className="mr-1 h-3.5 w-3.5" /> Analytics
                  </Button>
                  {(c.status === 'draft' || c.status === 'scheduled' || c.status === 'paused') && (
                    <Button size="sm" variant="secondary" onClick={() => openEditWizard(c)}>
                      <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                    </Button>
                  )}
                  {(c.status === 'draft' || c.status === 'scheduled') && (
                    <Button
                      size="sm"
                      onClick={() => transitionMutation.mutate({ id: c.id, action: 'start' })}
                    >
                      <Play className="mr-1 h-3.5 w-3.5" /> Send Now
                    </Button>
                  )}
                  {c.status === 'sending' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => transitionMutation.mutate({ id: c.id, action: 'pause' })}
                    >
                      <Pause className="mr-1 h-3.5 w-3.5" /> Pause
                    </Button>
                  )}
                  {c.status === 'paused' && (
                    <Button
                      size="sm"
                      onClick={() => transitionMutation.mutate({ id: c.id, action: 'resume' })}
                    >
                      <Play className="mr-1 h-3.5 w-3.5" /> Resume
                    </Button>
                  )}
                  {(c.status === 'scheduled' || c.status === 'sending' || c.status === 'paused') && (
                    <Button size="sm" variant="secondary" onClick={() => setCancelTarget(c)}>
                      <XCircle className="mr-1 h-3.5 w-3.5 text-amber-400" /> Cancel
                    </Button>
                  )}
                  {c.status !== 'sending' && (
                    <Button size="sm" variant="secondary" onClick={() => setDeleteTarget(c)}>
                      <Trash2 className="h-3.5 w-3.5 text-red-400" />
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Guided 5-Step Broadcast Wizard */}
      <AppDialog
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        title={editingId ? 'Edit Broadcast' : 'New Email Broadcast'}
        maxWidthClass="max-w-5xl"
      >
        <div className="max-h-[80vh] overflow-y-auto space-y-4 pr-1">
          <p className="text-xs text-[var(--fg-muted)]">
            Step {wizardStep} of 5 — Guided broadcast setup with verified domain and consent enforcement.
          </p>
          {/* Stepper */}
          <div className="grid grid-cols-5 gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-1.5 text-xs">
            {[
              { step: 1 as const, label: '1. Domain & Sender' },
              { step: 2 as const, label: '2. Audience' },
              { step: 3 as const, label: '3. Compose' },
              { step: 4 as const, label: '4. Preview & Test' },
              { step: 5 as const, label: '5. Schedule / Send' },
            ].map((item) => (
              <button
                key={item.step}
                type="button"
                onClick={() => setWizardStep(item.step)}
                className={`rounded-md px-2 py-1.5 text-center font-medium transition-colors ${
                  wizardStep === item.step
                    ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                    : 'text-[var(--fg-secondary)] hover:bg-[var(--bg-surface)]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* STEP 1 */}
          {wizardStep === 1 && (
            <div className="space-y-4">
              {verifiedSendingDomains.length === 0 ? (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
                  <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <strong>No verified sending domain available.</strong> Verify domain ownership and enable sending in{' '}
                    <strong>Domains &amp; DNS Authentication</strong> before sending a broadcast.
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Campaign Name (Internal)</label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. November Product Update" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Verified Sending Domain</label>
                    <select
                      value={domainId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setDomainId(id);
                        const dom = verifiedSendingDomains.find((d) => d.id === id);
                        if (dom && (!fromEmail || fromEmail.includes('@'))) {
                          const local = (fromEmail.split('@')[0] || dom.defaultSenderLocalPart || 'newsletter').trim();
                          setFromEmail(`${local}@${dom.domainName}`);
                        }
                      }}
                      className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--fg-primary)]"
                    >
                      <option value="">Select verified domain...</option>
                      {verifiedSendingDomains.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.domainName} ({d.dkimStatus === 'pass' ? 'DKIM Pass' : 'DKIM check pending'})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">From Name</label>
                    <Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="e.g. FastConnect Team" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">From Email Address</label>
                    <Input
                      value={fromEmail}
                      onChange={(e) => setFromEmail(e.target.value)}
                      placeholder="newsletter@yourdomain.com"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Reply-To (Optional)</label>
                    <Input
                      value={replyTo}
                      onChange={(e) => setReplyTo(e.target.value)}
                      placeholder="support@yourdomain.com"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Subject Line</label>
                    <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Email subject" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 2 */}
          {wizardStep === 2 && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={audienceMode === 'all' ? 'primary' : 'secondary'}
                  onClick={() => setAudienceMode('all')}
                >
                  All Active Subscribers
                </Button>
                <Button
                  size="sm"
                  variant={audienceMode === 'filtered' ? 'primary' : 'secondary'}
                  onClick={() => setAudienceMode('filtered')}
                >
                  Filter by Tags / Segments
                </Button>
                <Button size="sm" variant="secondary" disabled={estimating} onClick={() => runEstimate(currentAudienceSpec)}>
                  <Users className="mr-1 h-3.5 w-3.5" /> {estimating ? 'Counting...' : 'Refresh Estimate'}
                </Button>
              </div>

              {audienceMode === 'filtered' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <Card className="p-3 space-y-2">
                    <div className="text-xs font-semibold text-[var(--fg-primary)]">Include Tags (any match)</div>
                    <div className="flex flex-wrap gap-1.5">
                      {tags.length === 0 ? (
                        <span className="text-xs text-[var(--fg-muted)]">No tags yet.</span>
                      ) : (
                        tags.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => toggleInList(includeTags, t.name, setIncludeTags)}
                            className={`rounded-full border px-2.5 py-0.5 text-xs ${
                              includeTags.includes(t.name)
                                ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]'
                                : 'border-[var(--border-default)] text-[var(--fg-secondary)]'
                            }`}
                          >
                            {t.name} ({t.subscriberCount})
                          </button>
                        ))
                      )}
                    </div>
                  </Card>
                  <Card className="p-3 space-y-2">
                    <div className="text-xs font-semibold text-[var(--fg-primary)]">Include Dynamic Segments</div>
                    <div className="flex flex-wrap gap-1.5">
                      {segments.length === 0 ? (
                        <span className="text-xs text-[var(--fg-muted)]">No segments created yet.</span>
                      ) : (
                        segments.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => toggleInList(includeSegmentIds, s.id, setIncludeSegmentIds)}
                            className={`rounded-full border px-2.5 py-0.5 text-xs ${
                              includeSegmentIds.includes(s.id)
                                ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]'
                                : 'border-[var(--border-default)] text-[var(--fg-secondary)]'
                            }`}
                          >
                            {s.name}
                          </button>
                        ))
                      )}
                    </div>
                  </Card>
                </div>
              )}

              <div className="grid gap-3 md:grid-cols-2">
                <Card className="p-3 space-y-2">
                  <div className="text-xs font-semibold text-[var(--fg-primary)]">Exclude Tags</div>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => toggleInList(excludeTags, t.name, setExcludeTags)}
                        className={`rounded-full border px-2.5 py-0.5 text-xs ${
                          excludeTags.includes(t.name)
                            ? 'border-red-500 bg-red-500/20 text-red-300'
                            : 'border-[var(--border-default)] text-[var(--fg-secondary)]'
                        }`}
                      >
                        Exclude: {t.name}
                      </button>
                    ))}
                  </div>
                </Card>
                <Card className="p-3 space-y-2">
                  <div className="text-xs font-semibold text-[var(--fg-primary)]">Exclude Segments</div>
                  <div className="flex flex-wrap gap-1.5">
                    {segments.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggleInList(excludeSegmentIds, s.id, setExcludeSegmentIds)}
                        className={`rounded-full border px-2.5 py-0.5 text-xs ${
                          excludeSegmentIds.includes(s.id)
                            ? 'border-red-500 bg-red-500/20 text-red-300'
                            : 'border-[var(--border-default)] text-[var(--fg-secondary)]'
                        }`}
                      >
                        Exclude: {s.name}
                      </button>
                    ))}
                  </div>
                </Card>
              </div>

              {estimateResult && (
                <Card className="p-3 space-y-2 border-[var(--accent)]/40">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-[var(--fg-primary)]">
                      Eligible Recipients: <span className="text-emerald-400">{estimateResult.estimate.eligibleCount}</span>
                    </div>
                    <span className="text-xs text-[var(--fg-muted)]">
                      Matched before exclusions: {estimateResult.estimate.matchedBeforeExclusions} / {estimateResult.estimate.totalContacts} contacts
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-[var(--fg-muted)]">
                    <span>Unsubscribed: {estimateResult.estimate.excluded.unsubscribed}</span>
                    <span>• Bounced: {estimateResult.estimate.excluded.bounced}</span>
                    <span>• Complained: {estimateResult.estimate.excluded.complained}</span>
                    <span>• Suppressed: {estimateResult.estimate.excluded.suppressed}</span>
                    <span>• Rule Exclusions: {estimateResult.estimate.excluded.excludedByRule}</span>
                  </div>
                  {estimateResult.sample.length > 0 && (
                    <div className="text-[11px] text-[var(--fg-secondary)]">
                      Sample: {estimateResult.sample.map((s) => s.email).join(', ')}
                    </div>
                  )}
                </Card>
              )}
            </div>
          )}

          {/* STEP 3 */}
          {wizardStep === 3 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-2.5">
                <span className="text-xs font-medium text-[var(--fg-secondary)]">Start from Saved Template (optional):</span>
                <select
                  value={selectedTemplateId}
                  onChange={(e) => {
                    const tid = e.target.value;
                    setSelectedTemplateId(tid);
                    const tpl = templates.find((t) => t.id === tid);
                    if (tpl) {
                      const activeVer =
                        tpl.versions.find((v) => v.versionNumber === tpl.activeVersion) ??
                        tpl.versions[tpl.versions.length - 1];
                      if (activeVer) {
                        setSubject(activeVer.subject);
                        setPreviewText(activeVer.previewText ?? '');
                        setBlocks(activeVer.blocksJson ?? []);
                        setHtmlBody(activeVer.htmlBody);
                        setTextBody(activeVer.textBody);
                      }
                      toast.success(`Loaded template "${tpl.name}"`);
                    }
                  }}
                  className="rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs text-[var(--fg-primary)]"
                >
                  <option value="">-- Custom content --</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} (v{t.activeVersion})
                    </option>
                  ))}
                </select>
              </div>

              <VisualEmailEditor
                compact
                subject={subject}
                previewText={previewText}
                blocks={blocks}
                htmlBody={htmlBody}
                textBody={textBody}
                onChange={(patch) => {
                  if (patch.subject !== undefined) setSubject(patch.subject);
                  if (patch.previewText !== undefined) setPreviewText(patch.previewText);
                  if (patch.blocks !== undefined) setBlocks(patch.blocks);
                  if (patch.htmlBody !== undefined) setHtmlBody(patch.htmlBody);
                  if (patch.textBody !== undefined) setTextBody(patch.textBody);
                }}
              />
            </div>
          )}

          {/* STEP 4 */}
          {wizardStep === 4 && (
            <div className="space-y-4">
              <Card className="p-3 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">Pre-Send Checklist</div>
                <div className="grid gap-2 sm:grid-cols-2 text-xs">
                  <div className="flex items-center gap-2">
                    {verifiedSendingDomains.some((d) => d.id === domainId) ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-red-400" />
                    )}
                    <span>Verified sending domain selected</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {htmlBody.includes('unsubscribe') || htmlBody.includes('{{unsubscribeUrl}}') ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-amber-400" />
                    )}
                    <span>Unsubscribe link / RFC 8058 compliance</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {textBody.trim().length > 0 ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-amber-400" />
                    )}
                    <span>Plain-text fallback body included</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {(estimateResult?.estimate.eligibleCount ?? 0) > 0 ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-amber-400" />
                    )}
                    <span>
                      Eligible audience: {estimateResult?.estimate.eligibleCount ?? 'check Step 2'}
                    </span>
                  </div>
                </div>
              </Card>

              <Card className="p-3 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">Send Real Test Email</div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                    placeholder="you@yourdomain.com"
                    className="max-w-xs"
                  />
                  <Button variant="secondary" disabled={sendingTest} onClick={handleSendTest}>
                    <Send className="mr-1.5 h-3.5 w-3.5" /> {sendingTest ? 'Sending Test...' : 'Send Test Email'}
                  </Button>
                </div>
                <p className="text-[11px] text-[var(--fg-muted)]">
                  Saves this broadcast as a draft (if unsaved) and dispatches a `[TEST]` email using sample subscriber variables.
                </p>
              </Card>
            </div>
          )}

          {/* STEP 5 */}
          {wizardStep === 5 && (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <button
                  type="button"
                  onClick={() => setDeliveryChoice('now')}
                  className={`rounded-lg border p-3 text-left ${
                    deliveryChoice === 'now'
                      ? 'border-[var(--accent)] bg-[var(--bg-subtle)]'
                      : 'border-[var(--border-default)]'
                  }`}
                >
                  <div className="text-sm font-semibold text-[var(--fg-primary)]">Send Immediately</div>
                  <div className="text-xs text-[var(--fg-muted)] mt-1">
                    Queues messages to eligible subscribers right after confirmation.
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setDeliveryChoice('schedule')}
                  className={`rounded-lg border p-3 text-left ${
                    deliveryChoice === 'schedule'
                      ? 'border-[var(--accent)] bg-[var(--bg-subtle)]'
                      : 'border-[var(--border-default)]'
                  }`}
                >
                  <div className="text-sm font-semibold text-[var(--fg-primary)]">Schedule for Later</div>
                  <div className="text-xs text-[var(--fg-muted)] mt-1">
                    Executed by the background scheduler at the chosen date &amp; time.
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setDeliveryChoice('draft')}
                  className={`rounded-lg border p-3 text-left ${
                    deliveryChoice === 'draft'
                      ? 'border-[var(--accent)] bg-[var(--bg-subtle)]'
                      : 'border-[var(--border-default)]'
                  }`}
                >
                  <div className="text-sm font-semibold text-[var(--fg-primary)]">Save as Draft</div>
                  <div className="text-xs text-[var(--fg-muted)] mt-1">Keep editing before scheduling or sending.</div>
                </button>
              </div>

              {deliveryChoice === 'schedule' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Send Date &amp; Time</label>
                    <input
                      type="datetime-local"
                      value={scheduledLocal}
                      onChange={(e) => setScheduledLocal(e.target.value)}
                      className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--fg-primary)]"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Timezone Label</label>
                    <select
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--fg-primary)]"
                    >
                      {!COMMON_TIMEZONES.includes(timezone) && <option value={timezone}>{timezone}</option>}
                      {COMMON_TIMEZONES.map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <Card className="p-3 text-xs space-y-1">
                <div className="font-semibold text-[var(--fg-primary)]">Broadcast Summary</div>
                <div>Name: {name || '(unnamed)'}</div>
                <div>From: {fromName ? `${fromName} <${fromEmail}>` : fromEmail || '(domain default)'}</div>
                <div>Subject: {subject}</div>
                <div>Eligible Recipients: {estimateResult?.estimate.eligibleCount ?? 'Estimated on launch'}</div>
              </Card>
            </div>
          )}

          {/* Footer Navigation */}
          <div className="flex items-center justify-between border-t border-[var(--border-subtle)] pt-3">
            <div className="flex gap-2">
              {wizardStep > 1 && (
                <Button
                  variant="secondary"
                  onClick={() => setWizardStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3 | 4 | 5) : s))}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" /> Back
                </Button>
              )}
              <Button variant="secondary" onClick={() => handleSaveOrSend('draft')} disabled={!name.trim() || !domainId}>
                Save Draft
              </Button>
            </div>

            <div className="flex gap-2">
              {wizardStep < 5 ? (
                <Button
                  onClick={() => setWizardStep((s) => (s < 5 ? ((s + 1) as 1 | 2 | 3 | 4 | 5) : s))}
                  disabled={wizardStep === 1 && (!name.trim() || !domainId)}
                >
                  Continue <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              ) : (
                <Button
                  disabled={!name.trim() || !domainId || !subject.trim()}
                  onClick={() => handleSaveOrSend(deliveryChoice)}
                >
                  <Send className="mr-1.5 h-4 w-4" />
                  {deliveryChoice === 'now'
                    ? 'Confirm & Send Broadcast'
                    : deliveryChoice === 'schedule'
                      ? 'Confirm & Schedule'
                      : 'Save Draft'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </AppDialog>

      {/* Safe Cancel Dialog */}
      <AppDialog
        open={Boolean(cancelTarget)}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
        title={`Cancel "${cancelTarget?.name ?? ''}"?`}
      >
        <div className="space-y-3 text-xs text-[var(--fg-secondary)]">
          <p>
            All pending recipient deliveries that have not yet been handed off to the SMTP MTA will be marked{' '}
            <code>cancelled</code>. Any messages already accepted or in remote SMTP delivery queues cannot be recalled, and the
            exact counts will be reported immediately.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelTarget(null)}>
              Keep Active
            </Button>
            <Button
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
          <p className="text-xs text-[var(--fg-secondary)]">
            Permanently delete &ldquo;{deleteTarget?.name ?? ''}&rdquo;?
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Keep
            </Button>
            <Button
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
