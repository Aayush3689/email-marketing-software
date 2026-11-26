import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppDialog, Badge, Button, Card, Input } from '@mail/ui';
import type { AudienceEstimate, AudienceSelectionSpec, SubscriberRecord } from '@mail/shared-types';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Calendar,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  CloudOff,
  Eye,
  Loader2,
  RefreshCw,
  Send,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, type CampaignItem } from '../../lib/api.js';
import { TagMultiSelect, useCentralTags } from './TagSelector.js';
import {
  compileClientBlocks,
  DEFAULT_TEMPLATE_BLOCKS,
  sanitizePreviewHtml,
  VisualEmailEditor,
} from './VisualEmailEditor.js';
import {
  type BroadcastDraftPayload,
  clearLocalDraftRecovery,
  readLocalDraftRecovery,
  useBroadcastDraftAutosave,
} from './useBroadcastDraftAutosave.js';

const COMMON_TIMEZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Asia/Singapore'];

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

function buildInitialDraft(
  campaign: CampaignItem | null,
  defaultVerifiedDomain?: { id: string; domainName: string; defaultSenderLocalPart?: string | null }
): BroadcastDraftPayload {
  if (campaign) {
    const spec: AudienceSelectionSpec = campaign.audienceSpec
      ? campaign.audienceSpec
      : campaign.tagFilter
        ? { mode: 'filtered', includeTags: [campaign.tagFilter] }
        : { mode: 'all' };

    return {
      domainId: campaign.domainId,
      templateId: campaign.templateId ?? '',
      name: campaign.name,
      fromName: campaign.fromName ?? '',
      fromEmail: campaign.fromEmail ?? '',
      replyTo: campaign.replyTo ?? '',
      subject: campaign.subject ?? '',
      previewText: campaign.previewText ?? '',
      blocks: campaign.blocksJson ?? [],
      htmlBody: campaign.htmlBody ?? '',
      textBody: campaign.textBody ?? '',
      audienceSpec: spec,
      deliveryChoice: campaign.scheduledAt ? 'schedule' : 'now',
      scheduledLocal: campaign.scheduledAt ? campaign.scheduledAt.slice(0, 16) : '',
      timezone: campaign.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      wizardStep: 1,
    };
  }

  const compiled = compileClientBlocks(DEFAULT_TEMPLATE_BLOCKS);
  return {
    domainId: defaultVerifiedDomain?.id ?? '',
    templateId: '',
    name: '',
    fromName: '',
    fromEmail: defaultVerifiedDomain
      ? `${defaultVerifiedDomain.defaultSenderLocalPart ?? 'newsletter'}@${defaultVerifiedDomain.domainName}`
      : '',
    replyTo: '',
    subject: 'Newsletter update for {{firstName | fallback: "you"}}',
    previewText: '',
    blocks: DEFAULT_TEMPLATE_BLOCKS,
    htmlBody: compiled.htmlBody,
    textBody: compiled.textBody,
    audienceSpec: { mode: 'all' },
    deliveryChoice: 'now',
    scheduledLocal: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    wizardStep: 1,
  };
}

export function BroadcastComposerWorkspace({
  initialCampaign,
  onBack,
  onCampaignSaved,
}: {
  initialCampaign: CampaignItem | null;
  onBack: () => void;
  onCampaignSaved: (campaign: CampaignItem) => void;
}) {
  const qc = useQueryClient();
  const { byId: tagById } = useCentralTags();
  const domainsQuery = useQuery({ queryKey: ['domains'], queryFn: () => api.listDomains() });
  const templatesQuery = useQuery({ queryKey: ['templates', false], queryFn: () => api.listTemplates(false) });
  const segmentsQuery = useQuery({ queryKey: ['segments'], queryFn: () => api.listSegments() });

  const allDomains = domainsQuery.data?.domains ?? [];
  const verifiedSendingDomains = useMemo(
    () => allDomains.filter((d) => Boolean(d.ownershipVerifiedAt) && d.sendingEnabled && !d.isSuspended),
    [allDomains]
  );

  const [draft, setDraft] = useState<BroadcastDraftPayload>(() =>
    buildInitialDraft(initialCampaign, verifiedSendingDomains[0])
  );
  const [recoveryCandidate, setRecoveryCandidate] = useState<BroadcastDraftPayload | null>(() => {
    const rec = readLocalDraftRecovery(initialCampaign?.id ?? null);
    if (!rec || !rec.dirty) return null;
    if (initialCampaign?.updatedAt && rec.serverUpdatedAt && rec.serverUpdatedAt !== initialCampaign.updatedAt) {
      return rec.draft;
    }
    return !initialCampaign ? rec.draft : rec.draft;
  });

  const [activeStatus, setActiveStatus] = useState<CampaignItem['status']>(initialCampaign?.status ?? 'draft');
  const [estimateResult, setEstimateResult] = useState<{ estimate: AudienceEstimate; sample: SubscriberRecord[] } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [sendingTest, setSendingTest] = useState(false);
  const [confirmSendOpen, setConfirmSendOpen] = useState(false);
  const [submittingAction, setSubmittingAction] = useState(false);

  const isLocked =
    activeStatus === 'sending' ||
    activeStatus === 'running' ||
    activeStatus === 'completed' ||
    activeStatus === 'cancelled';

  const {
    campaignId,
    saveState,
    lastSavedAt,
    saveError,
    conflictCampaign,
    scheduleAutosave,
    flushNow,
    acceptServerConflictVersion,
  } = useBroadcastDraftAutosave({
    initialCampaignId: initialCampaign?.id ?? null,
    initialUpdatedAt: initialCampaign?.updatedAt ?? initialCampaign?.createdAt ?? null,
    draft,
    isLocked,
    onCampaignIdAssigned: (newId, saved) => {
      onCampaignSaved(saved);
      setActiveStatus(saved.status);
      try {
        sessionStorage.setItem('fastconnect_active_broadcast_id', newId);
      } catch {
        // Ignore session storage errors
      }
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onServerSaved: (saved) => {
      setActiveStatus(saved.status);
      onCampaignSaved(saved);
      qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });

  // Backfill first verified domain when opening a blank composer after domains query loads
  useEffect(() => {
    if (!initialCampaign && !draft.domainId && verifiedSendingDomains[0]) {
      const dom = verifiedSendingDomains[0];
      setDraft((prev) => ({
        ...prev,
        domainId: dom.id,
        fromEmail: prev.fromEmail || `${dom.defaultSenderLocalPart ?? 'newsletter'}@${dom.domainName}`,
      }));
    }
  }, [draft.domainId, initialCampaign, verifiedSendingDomains]);

  const updateDraft = (updater: Partial<BroadcastDraftPayload> | ((prev: BroadcastDraftPayload) => BroadcastDraftPayload)) => {
    setDraft((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
      scheduleAutosave(next);
      return next;
    });
  };

  // Fetch audience estimate automatically whenever audienceSpec changes or step 2/4/5 opens
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setEstimating(true);
      void api
        .estimateCampaignAudience(draft.audienceSpec)
        .then((res) => {
          if (active) setEstimateResult(res);
        })
        .catch(() => undefined)
        .finally(() => {
          if (active) setEstimating(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [draft.audienceSpec]);

  const selectedDomain = allDomains.find((d) => d.id === draft.domainId);
  const selectedDomainIsVerified = Boolean(
    selectedDomain?.ownershipVerifiedAt && selectedDomain.sendingEnabled && !selectedDomain.isSuspended
  );
  const fromEmailDomain = draft.fromEmail.includes('@') ? draft.fromEmail.split('@')[1]?.trim().toLowerCase() : '';
  const senderDomainMismatch =
    Boolean(selectedDomain && fromEmailDomain && fromEmailDomain !== selectedDomain.domainName.toLowerCase());

  const step1Valid = Boolean(draft.name.trim() && draft.domainId && selectedDomainIsVerified && draft.subject.trim() && !senderDomainMismatch);
  const step2Valid = (estimateResult?.estimate.eligibleCount ?? 1) >= 0;
  const step3Valid = Boolean(draft.subject.trim() && draft.htmlBody.trim());

  const handleBack = async () => {
    if (saveState === 'unsaved' || saveState === 'offline' || saveState === 'saving') {
      await flushNow(false);
    }
    try {
      sessionStorage.removeItem('fastconnect_active_broadcast_id');
    } catch {
      // ignore
    }
    onBack();
  };

  const handleSendTest = async () => {
    if (!testEmail.trim()) {
      toast.error('Enter a test recipient email address');
      return;
    }
    if (!draft.domainId) {
      toast.error('Select a verified sending domain first');
      return;
    }
    setSendingTest(true);
    try {
      const saved = await flushNow(false);
      const idToTest = saved?.id ?? campaignId;
      if (!idToTest) {
        toast.error('Enter a Campaign Name and Domain to save draft before sending a test');
        return;
      }
      await api.sendCampaignTest(idToTest, testEmail.trim());
      toast.success(`Test email queued for ${testEmail.trim()} (isolated from broadcast analytics)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test send failed');
    } finally {
      setSendingTest(false);
    }
  };

  const scheduleOrSendMutation = useMutation({
    mutationFn: async (mode: 'draft' | 'now' | 'schedule') => {
      if (submittingAction) throw new Error('Submission already in progress');
      setSubmittingAction(true);
      try {
        if (mode === 'schedule' && !draft.scheduledLocal) {
          throw new Error('Pick a scheduled date & time before scheduling');
        }
        const saved = await flushNow(false);
        const id = saved?.id ?? campaignId;
        if (!id) throw new Error('Unable to save campaign draft before dispatch');

        if (mode === 'schedule') {
          const scheduledIso = new Date(draft.scheduledLocal).toISOString();
          const res = await api.updateCampaign(id, { scheduledAt: scheduledIso, status: 'scheduled' });
          clearLocalDraftRecovery(id);
          return { mode, campaign: res.campaign };
        }
        if (mode === 'now') {
          const res = await api.transitionCampaign(id, 'start');
          clearLocalDraftRecovery(id);
          return { mode, campaign: res.campaign, dispatchedCount: res.dispatchedCount };
        }
        return { mode, campaign: saved! };
      } finally {
        setSubmittingAction(false);
      }
    },
    onSuccess: (res) => {
      setConfirmSendOpen(false);
      setActiveStatus(res.campaign.status);
      onCampaignSaved(res.campaign);
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      if (res.mode === 'now') {
        toast.success(`Broadcast queued for ${res.dispatchedCount ?? res.campaign.targetCount} subscribers`);
        onBack();
      } else if (res.mode === 'schedule') {
        toast.success(`Broadcast scheduled for ${new Date(res.campaign.scheduledAt!).toLocaleString()}`);
        onBack();
      } else {
        toast.success('Draft saved to server');
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Action failed'),
  });

  const segments = segmentsQuery.data?.segments ?? [];
  const templates = templatesQuery.data?.templates ?? [];

  const toggleIdInSpec = (
    field: 'includeTagIds' | 'excludeTagIds' | 'includeSegmentIds' | 'excludeSegmentIds',
    nextIds: string[]
  ) => {
    updateDraft((prev) => ({
      ...prev,
      audienceSpec: {
        ...prev.audienceSpec,
        [field]: nextIds,
      },
    }));
  };

  return (
    <div className="space-y-5">
      {/* Sticky Workspace Header */}
      <div className="sticky top-0 z-20 -mx-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="sm" onClick={() => void handleBack()}>
              <ArrowLeft className="h-4 w-4" />
              Back to Broadcasts
            </Button>
            <div className="h-4 w-px bg-[var(--color-border)] hidden sm:block" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-semibold text-sm text-[var(--color-text)]">
                  {draft.name.trim() || 'Untitled Broadcast'}
                </span>
                <Badge tone={STATUS_BADGE[activeStatus]}>{activeStatus}</Badge>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                {saveState === 'saving' && (
                  <span className="inline-flex items-center gap-1 text-[var(--color-brand)]">
                    <Loader2 className="h-3 w-3 animate-spin" /> Saving draft...
                  </span>
                )}
                {saveState === 'saved' && (
                  <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    Saved {lastSavedAt ? `at ${new Date(lastSavedAt).toLocaleTimeString()}` : ''}
                  </span>
                )}
                {saveState === 'unsaved' && (
                  <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                    <Clock className="h-3 w-3" /> Unsaved changes
                  </span>
                )}
                {saveState === 'offline' && (
                  <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                    <CloudOff className="h-3 w-3" /> Offline — changes buffered locally
                  </span>
                )}
                {saveState === 'error' && (
                  <span className="inline-flex items-center gap-1 text-[var(--color-danger)]">
                    <AlertCircle className="h-3 w-3" /> {saveError || 'Save failed'}
                    <button type="button" className="underline ml-1 cursor-pointer" onClick={() => void flushNow(false)}>
                      Retry
                    </button>
                  </span>
                )}
                {saveState === 'conflict' && (
                  <span className="inline-flex items-center gap-1 text-[var(--color-danger)] font-medium">
                    <AlertTriangle className="h-3 w-3" /> Concurrent edit conflict
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {draft.wizardStep !== 4 && (
              <Button variant="secondary" size="sm" onClick={() => updateDraft({ wizardStep: 4 })}>
                <Eye className="h-3.5 w-3.5" /> Preview &amp; Test
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={isLocked || saveState === 'saving' || !draft.domainId}
              onClick={() => void flushNow(false)}
            >
              Save Draft
            </Button>
            {draft.wizardStep < 5 ? (
              <Button
                size="sm"
                onClick={() =>
                  updateDraft({ wizardStep: (draft.wizardStep + 1) as 1 | 2 | 3 | 4 | 5 })
                }
                disabled={draft.wizardStep === 1 && !step1Valid}
              >
                Continue <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={isLocked || !step1Valid || !step3Valid || submittingAction}
                onClick={() => {
                  if (draft.deliveryChoice === 'now') setConfirmSendOpen(true);
                  else scheduleOrSendMutation.mutate(draft.deliveryChoice);
                }}
              >
                <Send className="h-3.5 w-3.5" />
                {draft.deliveryChoice === 'now'
                  ? 'Send Broadcast'
                  : draft.deliveryChoice === 'schedule'
                    ? 'Schedule Broadcast'
                    : 'Save Draft'}
              </Button>
            )}
          </div>
        </div>

        {/* Compact Horizontal Stepper */}
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-1.5">
          {[
            { step: 1 as const, label: 'Domain & Sender', valid: step1Valid },
            { step: 2 as const, label: 'Audience', valid: step2Valid },
            { step: 3 as const, label: 'Compose', valid: step3Valid },
            { step: 4 as const, label: 'Preview & Test', valid: step3Valid },
            { step: 5 as const, label: 'Schedule / Send', valid: step1Valid && step3Valid },
          ].map((item) => {
            const isCurrent = draft.wizardStep === item.step;
            const isPast = draft.wizardStep > item.step;
            return (
              <button
                key={item.step}
                type="button"
                onClick={() => updateDraft({ wizardStep: item.step })}
                className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                  isCurrent
                    ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]'
                    : isPast
                      ? 'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-text)]'
                      : 'border-transparent bg-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]/60'
                }`}
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold ${
                    isCurrent
                      ? 'bg-[var(--color-brand)] text-white'
                      : isPast && item.valid
                        ? 'bg-emerald-600 text-white'
                        : 'bg-[var(--color-border)] text-[var(--color-text)]'
                  }`}
                >
                  {isPast && item.valid ? <Check className="h-2.5 w-2.5" /> : item.step}
                </span>
                <span className="truncate">{item.label}</span>
                {!item.valid && isCurrent && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* Recovery Banner */}
      {recoveryCandidate && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Unsaved local edits from a previous session were found for this draft. Restore them?</span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                clearLocalDraftRecovery(initialCampaign?.id ?? null);
                setRecoveryCandidate(null);
              }}
            >
              Discard Local Copy
            </Button>
            <Button
              size="sm"
              onClick={() => {
                updateDraft(recoveryCandidate);
                setRecoveryCandidate(null);
                toast.success('Restored locally recovered draft changes');
              }}
            >
              Restore Unsaved Changes
            </Button>
          </div>
        </Card>
      )}

      {/* Conflict Resolution Banner */}
      {conflictCampaign && saveState === 'conflict' && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-red-500/40 bg-red-500/10 px-4 py-3 text-xs">
          <div className="flex items-center gap-2 text-[var(--color-danger)]">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>
              This campaign was modified in another tab/session at{' '}
              {new Date(conflictCampaign.updatedAt ?? conflictCampaign.createdAt).toLocaleTimeString()}.
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                acceptServerConflictVersion(conflictCampaign);
                setDraft(buildInitialDraft(conflictCampaign, verifiedSendingDomains[0]));
                toast.info('Loaded latest server version');
              }}
            >
              Load Server Version
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => void flushNow(true)}
            >
              Overwrite with My Changes
            </Button>
          </div>
        </Card>
      )}

      {/* STEP 1: DOMAIN & SENDER */}
      {draft.wizardStep === 1 && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-[var(--color-text)]">Campaign Identity</h3>
              <p className="text-xs text-[var(--color-text-muted)]">
                Name this broadcast internally and craft the inbox subject line &amp; preview text.
              </p>
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">
                  Campaign Name <span className="text-[var(--color-danger)]">*</span>
                </label>
                <Input
                  value={draft.name}
                  onChange={(e) => updateDraft({ name: e.target.value })}
                  placeholder="e.g. November Product Digest"
                />
                {!draft.name.trim() && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">Required before sending or scheduling.</p>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">
                  Email Subject Line <span className="text-[var(--color-danger)]">*</span>
                </label>
                <Input
                  value={draft.subject}
                  onChange={(e) => updateDraft({ subject: e.target.value })}
                  placeholder='Newsletter update for {{firstName | fallback: "you"}}'
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">Preview Text (Preheader)</label>
                <Input
                  value={draft.previewText}
                  onChange={(e) => updateDraft({ previewText: e.target.value })}
                  placeholder="Optional snippet shown next to subject in inbox lists"
                />
              </div>
            </div>
          </Card>

          <Card className="p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-[var(--color-text)]">Verified Sending Domain &amp; Sender</h3>
              <p className="text-xs text-[var(--color-text-muted)]">
                Only ownership-verified, non-suspended domains with Sending enabled can dispatch broadcasts.
              </p>
            </div>

            {verifiedSendingDomains.length === 0 ? (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-[var(--color-danger)]">
                <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <strong>No verified sending domain available.</strong> Verify domain ownership and enable sending in{' '}
                  <strong>Domains &amp; DNS</strong> first.
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">Sending Domain *</label>
                  <select
                    value={draft.domainId}
                    onChange={(e) => {
                      const id = e.target.value;
                      const dom = allDomains.find((d) => d.id === id);
                      const local = (draft.fromEmail.split('@')[0] || dom?.defaultSenderLocalPart || 'newsletter').trim();
                      updateDraft({
                        domainId: id,
                        ...(dom ? { fromEmail: `${local}@${dom.domainName}` } : {}),
                      });
                    }}
                    className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)]"
                  >
                    <option value="">Select verified domain...</option>
                    {allDomains.map((d) => {
                      const ready = Boolean(d.ownershipVerifiedAt && d.sendingEnabled && !d.isSuspended);
                      const reason = !d.ownershipVerifiedAt
                        ? 'Unverified ownership'
                        : !d.sendingEnabled
                          ? 'Sending disabled'
                          : d.isSuspended
                            ? 'Suspended'
                            : d.dkimStatus === 'pass'
                              ? 'DKIM Verified'
                              : 'DKIM pending';
                      return (
                        <option key={d.id} value={d.id} disabled={!ready}>
                          {d.domainName} — {reason}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">From Name</label>
                    <Input
                      value={draft.fromName}
                      onChange={(e) => updateDraft({ fromName: e.target.value })}
                      placeholder="FastConnect Team"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">From Email Address</label>
                    <Input
                      value={draft.fromEmail}
                      onChange={(e) => updateDraft({ fromEmail: e.target.value })}
                      placeholder="newsletter@yourdomain.com"
                    />
                  </div>
                </div>
                {senderDomainMismatch && (
                  <p className="text-xs text-[var(--color-danger)]">
                    Sender email domain (`{fromEmailDomain}`) must match selected domain (`{selectedDomain?.domainName}`).
                  </p>
                )}
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">Reply-To Address (Optional)</label>
                  <Input
                    value={draft.replyTo}
                    onChange={(e) => updateDraft({ replyTo: e.target.value })}
                    placeholder="support@yourdomain.com"
                  />
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* STEP 2: AUDIENCE */}
      {draft.wizardStep === 2 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={draft.audienceSpec.mode === 'all' ? 'primary' : 'secondary'}
                onClick={() => updateDraft({ audienceSpec: { ...draft.audienceSpec, mode: 'all' } })}
              >
                All Active Subscribers
              </Button>
              <Button
                size="sm"
                variant={draft.audienceSpec.mode === 'filtered' ? 'primary' : 'secondary'}
                onClick={() => updateDraft({ audienceSpec: { ...draft.audienceSpec, mode: 'filtered' } })}
              >
                Filter by Central Tags / Segments
              </Button>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={estimating}
              onClick={() => {
                setEstimating(true);
                void api
                  .estimateCampaignAudience(draft.audienceSpec)
                  .then((res) => setEstimateResult(res))
                  .finally(() => setEstimating(false));
              }}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${estimating ? 'animate-spin' : ''}`} /> Refresh Estimate
            </Button>
          </div>

          {draft.audienceSpec.mode === 'filtered' && (
            <div className="grid gap-4 md:grid-cols-2">
              <Card className="p-4 space-y-2.5">
                <div className="text-xs font-semibold text-[var(--color-text)]">Include Central Tags (any match)</div>
                <TagMultiSelect
                  selectedTagIds={draft.audienceSpec.includeTagIds ?? []}
                  onChange={(ids) => toggleIdInSpec('includeTagIds', ids)}
                />
              </Card>
              <Card className="p-4 space-y-2.5">
                <div className="text-xs font-semibold text-[var(--color-text)]">Include Dynamic Segments</div>
                <div className="flex flex-wrap gap-1.5">
                  {segments.length === 0 ? (
                    <span className="text-xs text-[var(--color-text-muted)]">No dynamic segments created yet.</span>
                  ) : (
                    segments.map((s) => {
                      const active = (draft.audienceSpec.includeSegmentIds ?? []).includes(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() =>
                            toggleIdInSpec(
                              'includeSegmentIds',
                              active
                                ? (draft.audienceSpec.includeSegmentIds ?? []).filter((x) => x !== s.id)
                                : [...(draft.audienceSpec.includeSegmentIds ?? []), s.id]
                            )
                          }
                          className={`rounded-full border px-2.5 py-1 text-xs cursor-pointer ${
                            active
                              ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)] font-medium'
                              : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
                          }`}
                        >
                          {s.name} ({s.subscriberCount ?? 0})
                        </button>
                      );
                    })
                  )}
                </div>
              </Card>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-4 space-y-2.5">
              <div className="text-xs font-semibold text-[var(--color-text)]">Exclude Central Tags</div>
              <TagMultiSelect
                tone="danger"
                prefix="Exclude"
                selectedTagIds={draft.audienceSpec.excludeTagIds ?? []}
                onChange={(ids) => toggleIdInSpec('excludeTagIds', ids)}
              />
            </Card>
            <Card className="p-4 space-y-2.5">
              <div className="text-xs font-semibold text-[var(--color-text)]">Exclude Dynamic Segments</div>
              <div className="flex flex-wrap gap-1.5">
                {segments.map((s) => {
                  const active = (draft.audienceSpec.excludeSegmentIds ?? []).includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() =>
                        toggleIdInSpec(
                          'excludeSegmentIds',
                          active
                            ? (draft.audienceSpec.excludeSegmentIds ?? []).filter((x) => x !== s.id)
                            : [...(draft.audienceSpec.excludeSegmentIds ?? []), s.id]
                        )
                      }
                      className={`rounded-full border px-2.5 py-1 text-xs cursor-pointer ${
                        active
                          ? 'border-red-500/50 bg-red-500/15 text-red-600 dark:text-red-300 font-medium'
                          : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
                      }`}
                    >
                      Exclude: {s.name}
                    </button>
                  );
                })}
                {segments.length === 0 && (
                  <span className="text-xs text-[var(--color-text-muted)]">No segments available.</span>
                )}
              </div>
            </Card>
          </div>

          {estimateResult && (
            <Card className="p-4 space-y-3 border-[var(--color-brand)]/40">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-emerald-500" />
                  <span className="text-sm font-semibold text-[var(--color-text)]">
                    Estimated Eligible Recipients:{' '}
                    <span className="text-emerald-600 dark:text-emerald-400">{estimateResult.estimate.eligibleCount}</span>
                  </span>
                </div>
                <span className="text-xs text-[var(--color-text-muted)]">
                  Formula: {estimateResult.estimate.matchedBeforeExclusions} matched − (
                  {estimateResult.estimate.excluded.unsubscribed +
                    estimateResult.estimate.excluded.bounced +
                    estimateResult.estimate.excluded.complained +
                    estimateResult.estimate.excluded.suppressed +
                    estimateResult.estimate.excluded.excludedByRule}{' '}
                  excluded)
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-5 text-xs">
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1.5">
                  <span className="text-[var(--color-text-muted)]">Unsubscribed:</span>{' '}
                  <strong>{estimateResult.estimate.excluded.unsubscribed}</strong>
                </div>
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1.5">
                  <span className="text-[var(--color-text-muted)]">Bounced:</span>{' '}
                  <strong>{estimateResult.estimate.excluded.bounced}</strong>
                </div>
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1.5">
                  <span className="text-[var(--color-text-muted)]">Complained:</span>{' '}
                  <strong>{estimateResult.estimate.excluded.complained}</strong>
                </div>
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1.5">
                  <span className="text-[var(--color-text-muted)]">Suppressed:</span>{' '}
                  <strong>{estimateResult.estimate.excluded.suppressed}</strong>
                </div>
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1.5">
                  <span className="text-[var(--color-text-muted)]">Rule Excluded:</span>{' '}
                  <strong>{estimateResult.estimate.excluded.excludedByRule}</strong>
                </div>
              </div>
              {estimateResult.sample.length > 0 && (
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  Sample eligible recipients: {estimateResult.sample.map((s) => s.email).join(', ')}
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      {/* STEP 3: COMPOSE */}
      {draft.wizardStep === 3 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">
              Load starting layout from Saved Templates (optional):
            </span>
            <select
              value={draft.templateId}
              onChange={(e) => {
                const tid = e.target.value;
                const tpl = templates.find((t) => t.id === tid);
                if (!tpl) {
                  updateDraft({ templateId: '' });
                  return;
                }
                const ver =
                  tpl.versions.find((v) => v.versionNumber === tpl.activeVersion) ??
                  tpl.versions[tpl.versions.length - 1];
                if (ver) {
                  updateDraft({
                    templateId: tid,
                    subject: ver.subject,
                    previewText: ver.previewText ?? '',
                    blocks: ver.blocksJson ?? [],
                    htmlBody: ver.htmlBody,
                    textBody: ver.textBody,
                  });
                  toast.success(`Loaded template "${tpl.name}"`);
                }
              }}
              className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs text-[var(--color-text)]"
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
            subject={draft.subject}
            previewText={draft.previewText}
            blocks={draft.blocks}
            htmlBody={draft.htmlBody}
            textBody={draft.textBody}
            onChange={(patch) => {
              updateDraft({
                ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
                ...(patch.previewText !== undefined ? { previewText: patch.previewText } : {}),
                ...(patch.blocks !== undefined ? { blocks: patch.blocks } : {}),
                ...(patch.htmlBody !== undefined ? { htmlBody: patch.htmlBody } : {}),
                ...(patch.textBody !== undefined ? { textBody: patch.textBody } : {}),
              });
            }}
          />
        </div>
      )}

      {/* STEP 4: PREVIEW & TEST */}
      {draft.wizardStep === 4 && (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            <Card className="p-4 space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                Pre-Send Deliverability &amp; Compliance Checks
              </div>
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  {selectedDomainIsVerified ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-[var(--color-danger)]" />
                  )}
                  <span>Verified &amp; active sending domain (`{selectedDomain?.domainName ?? 'not selected'}`)</span>
                </div>
                <div className="flex items-center gap-2">
                  {draft.htmlBody.includes('unsubscribe') || draft.htmlBody.includes('{{unsubscribeUrl}}') ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                  )}
                  <span>Unsubscribe link &amp; RFC 8058 compliance present</span>
                </div>
                <div className="flex items-center gap-2">
                  {draft.textBody.trim().length > 0 ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                  )}
                  <span>Multipart plain-text fallback present</span>
                </div>
                <div className="flex items-center gap-2">
                  {(estimateResult?.estimate.eligibleCount ?? 0) > 0 ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                  )}
                  <span>Eligible audience: {estimateResult?.estimate.eligibleCount ?? 0} subscriber(s)</span>
                </div>
              </div>
            </Card>

            <Card className="p-4 space-y-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  Send Controlled Test Email
                </div>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Dispatches a `[TEST]` copy directly to your inbox using transactional isolation — never creates broadcast
                  recipient records or inflates analytics.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  placeholder="you@yourdomain.com"
                  className="max-w-xs"
                />
                <Button variant="secondary" disabled={sendingTest || !draft.domainId} onClick={() => void handleSendTest()}>
                  <Send className="h-3.5 w-3.5" /> {sendingTest ? 'Sending Test...' : 'Send Test Email'}
                </Button>
              </div>
            </Card>
          </div>

          <Card className="p-4 space-y-2">
            <div className="text-xs font-semibold text-[var(--color-text)]">
              Sender: {draft.fromName ? `${draft.fromName} <${draft.fromEmail}>` : draft.fromEmail || '(domain default)'}
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">Subject: {draft.subject || '(none)'}</div>
            <iframe
              title="Step 4 Read-Only Email Preview"
              sandbox=""
              srcDoc={sanitizePreviewHtml(draft.htmlBody)}
              style={{
                width: '100%',
                height: '420px',
                border: '1px solid #e4e4e7',
                borderRadius: '8px',
                background: '#ffffff',
              }}
            />
          </Card>
        </div>
      )}

      {/* STEP 5: SCHEDULE / SEND */}
      {draft.wizardStep === 5 && (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            {[
              {
                key: 'now' as const,
                title: 'Send Immediately',
                desc: 'Snapshoots eligible subscribers, respects suppressions, and dispatches through Rust MTA.',
              },
              {
                key: 'schedule' as const,
                title: 'Schedule for Later',
                desc: 'Stores scheduled timestamp + timezone for automated background delivery.',
              },
              {
                key: 'draft' as const,
                title: 'Keep as Draft',
                desc: 'Preserves all edits cleanly on the server so you can return anytime.',
              },
            ].map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => updateDraft({ deliveryChoice: opt.key })}
                className={`rounded-xl border p-4 text-left transition-colors cursor-pointer ${
                  draft.deliveryChoice === opt.key
                    ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]/50'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]'
                }`}
              >
                <div className="text-sm font-semibold text-[var(--color-text)]">{opt.title}</div>
                <div className="mt-1 text-xs text-[var(--color-text-muted)]">{opt.desc}</div>
              </button>
            ))}
          </div>

          {draft.deliveryChoice === 'schedule' && (
            <Card className="p-4 grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">
                  <Calendar className="inline h-3.5 w-3.5 mr-1" /> Send Date &amp; Time
                </label>
                <input
                  type="datetime-local"
                  value={draft.scheduledLocal}
                  onChange={(e) => updateDraft({ scheduledLocal: e.target.value })}
                  className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)]"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">Timezone</label>
                <select
                  value={draft.timezone}
                  onChange={(e) => updateDraft({ timezone: e.target.value })}
                  className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)]"
                >
                  {!COMMON_TIMEZONES.includes(draft.timezone) && <option value={draft.timezone}>{draft.timezone}</option>}
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
            </Card>
          )}

          <Card className="p-4 text-xs space-y-1.5">
            <div className="font-semibold text-sm text-[var(--color-text)]">Final Dispatch Summary</div>
            <div>Campaign: {draft.name || '(unnamed)'}</div>
            <div>Domain: {selectedDomain?.domainName ?? '(none)'}</div>
            <div>Sender: {draft.fromName ? `${draft.fromName} <${draft.fromEmail}>` : draft.fromEmail || '(domain default)'}</div>
            <div>Subject: {draft.subject || '(none)'}</div>
            <div>
              Audience Scope:{' '}
              {draft.audienceSpec.mode === 'all'
                ? 'All Active Subscribers'
                : `${(draft.audienceSpec.includeTagIds ?? [])
                    .map((id) => tagById.get(id)?.name ?? id)
                    .join(', ')} (${(draft.audienceSpec.includeSegmentIds ?? []).length} segment filter(s))`}
            </div>
            <div>
              Estimated Eligible Recipients:{' '}
              <strong className="text-emerald-600 dark:text-emerald-400">
                {estimateResult?.estimate.eligibleCount ?? 0}
              </strong>
            </div>
          </Card>

          <div className="flex justify-between pt-1">
            <Button variant="secondary" onClick={() => updateDraft({ wizardStep: 4 })}>
              <ChevronLeft className="h-4 w-4" /> Back to Preview
            </Button>
            <Button
              disabled={isLocked || !step1Valid || !step3Valid || submittingAction || scheduleOrSendMutation.isPending}
              onClick={() => {
                if (draft.deliveryChoice === 'now') setConfirmSendOpen(true);
                else scheduleOrSendMutation.mutate(draft.deliveryChoice);
              }}
            >
              <Send className="h-4 w-4" />
              {draft.deliveryChoice === 'now'
                ? 'Confirm & Send Immediately'
                : draft.deliveryChoice === 'schedule'
                  ? 'Confirm & Schedule Broadcast'
                  : 'Save Draft'}
            </Button>
          </div>
        </div>
      )}

      {/* Confirmation Dialog before Immediate Broadcast Dispatch */}
      <AppDialog
        open={confirmSendOpen}
        onOpenChange={setConfirmSendOpen}
        title="Confirm Immediate Broadcast Send"
      >
        <div className="space-y-3 text-xs text-[var(--color-text-muted)]">
          <p>
            You are about to queue <strong>{draft.name || 'this broadcast'}</strong> (subject:{' '}
            <strong>{draft.subject}</strong>) for{' '}
            <strong className="text-[var(--color-text)]">{estimateResult?.estimate.eligibleCount ?? 0}</strong> eligible
            subscriber(s). Suppressed, unsubscribed, bounced, and complained contacts will remain excluded.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setConfirmSendOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={submittingAction || scheduleOrSendMutation.isPending}
              onClick={() => scheduleOrSendMutation.mutate('now')}
            >
              {submittingAction ? 'Queuing...' : 'Send Now'}
            </Button>
          </div>
        </div>
      </AppDialog>
    </div>
  );
}
