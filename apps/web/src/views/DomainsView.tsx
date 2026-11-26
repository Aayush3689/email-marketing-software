import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppDialog, AppSwitch, AppTabs, Badge, Button, Card, EmptyState, Input, Skeleton } from '@mail/ui';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Globe,
  Info,
  Mail,
  Plus,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DomainActionsMenu } from '../components/domains/DomainActionsMenu.js';
import {
  DomainDeliverabilityTab,
  DomainSendingConfigTab,
} from '../components/domains/DomainDeliverabilitySendingTab.js';
import { DomainDiagnosticsTab } from '../components/domains/DomainDiagnosticsTab.js';
import { DomainDnsRecordsTab } from '../components/domains/DomainDnsRecordsTab.js';
import {
  DomainHistoryTab,
  DomainHostingTab,
  DomainSecurityTab,
} from '../components/domains/DomainHostingSecurityHistoryTabs.js';
import { DnsStateBadge, DomainHealthBadge, formatShortTimestamp } from '../components/domains/DomainStatusBadge.js';
import { ApiError, type DomainItem, type DomainUpdatePatch, api } from '../lib/api.js';

export function DomainsView() {
  const qc = useQueryClient();

  // Filter & search state
  const [search, setSearch] = useState('');
  const [verifiedFilter, setVerifiedFilter] = useState<'all' | 'verified' | 'pending'>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | 'sending' | 'hosting'>('all');
  const [healthFilter, setHealthFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'recent' | 'name' | 'health'>('recent');

  // Selection & tabs
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('overview');

  // Create domain dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [newSendingEnabled, setNewSendingEnabled] = useState(true);
  const [newHostingEnabled, setNewHostingEnabled] = useState(false);

  // Async diagnostic polling & safe delete state
  const [activeJob, setActiveJob] = useState<{ domainId: string; jobId: string; status: string } | null>(null);
  const [deleteDeps, setDeleteDeps] = useState<{
    mailboxes?: number;
    campaigns?: number;
    smtpCredentials?: number;
    messages?: number;
  } | null>(null);

  const listQuery = useQuery({
    queryKey: ['domains', { search, verifiedFilter, roleFilter, healthFilter, sortBy }],
    queryFn: () =>
      api.listDomains({
        search: search.trim() || undefined,
        verified: verifiedFilter === 'all' ? undefined : verifiedFilter,
        role: roleFilter === 'all' ? undefined : roleFilter,
        health: healthFilter === 'all' ? undefined : healthFilter,
        sort: sortBy,
      }),
  });

  const domains = listQuery.data?.domains ?? [];
  const summary = listQuery.data?.summary ?? {
    total: domains.length,
    verified: domains.filter((d) => Boolean(d.ownershipVerifiedAt)).length,
    dnsIssues: domains.filter((d) => d.healthStatus === 'dns_misconfigured' || d.healthStatus === 'auth_incomplete').length,
    sendingEnabled: domains.filter((d) => d.sendingEnabled).length,
    hostingEnabled: domains.filter((d) => d.hostingEnabled).length,
  };

  useEffect(() => {
    if (domains.length === 0) {
      if (selectedId) setSelectedId(null);
      return;
    }
    if (!selectedId || !domains.some((d) => d.id === selectedId)) {
      setSelectedId(domains[0]!.id);
    }
  }, [domains, selectedId]);

  const detailQuery = useQuery({
    queryKey: ['domain', selectedId],
    queryFn: () => api.getDomain(selectedId!),
    enabled: Boolean(selectedId),
  });

  // Poll async diagnostic jobs when queued/running
  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === 'completed' || activeJob.status === 'failed') return;

    const timer = setInterval(async () => {
      try {
        const res = await api.getDomainDiagnosticJob(activeJob.domainId, activeJob.jobId);
        const nextStatus = res.job.status;
        if (nextStatus === 'completed') {
          setActiveJob(null);
          toast.success('Background DNS diagnostic completed');
          await qc.invalidateQueries({ queryKey: ['domains'] });
          await qc.invalidateQueries({ queryKey: ['domain', activeJob.domainId] });
        } else if (nextStatus === 'failed') {
          setActiveJob(null);
          toast.error(res.job.errorMessage ?? 'Background DNS check failed');
        } else {
          setActiveJob((prev) => (prev ? { ...prev, status: nextStatus } : null));
        }
      } catch {
        setActiveJob(null);
      }
    }, 1500);

    return () => clearInterval(timer);
  }, [activeJob, qc]);

  const createMutation = useMutation({
    mutationFn: () =>
      api.createDomain({
        domainName: newDomain.trim().toLowerCase(),
        sendingEnabled: newSendingEnabled,
        hostingEnabled: newHostingEnabled,
      }),
    onSuccess: async (data) => {
      toast.success(`Domain ${data.domain.domainName} added with DKIM 2048-bit keypair`);
      setNewDomain('');
      setCreateOpen(false);
      await qc.invalidateQueries({ queryKey: ['domains'] });
      setSelectedId(data.domain.id);
      setActiveTab('dns');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create domain'),
  });

  const verifyMutation = useMutation({
    mutationFn: (id: string) => api.verifyDomain(id),
    onSuccess: async (data, id) => {
      if (data.verified) {
        toast.success(data.message ?? 'Domain ownership verified via live DNS');
      } else {
        toast.warning(data.message ?? 'Verification TXT record did not match live DNS yet');
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['domains'] }),
        qc.invalidateQueries({ queryKey: ['domain', id] }),
      ]);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Verification check failed'),
  });

  const diagSyncMutation = useMutation({
    mutationFn: (id: string) => api.runDomainDiagnostics(id, false),
    onSuccess: async (_data, id) => {
      toast.success('Full DNS diagnostics updated');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['domains'] }),
        qc.invalidateQueries({ queryKey: ['domain', id] }),
      ]);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'DNS diagnostics failed'),
  });

  const diagAsyncMutation = useMutation({
    mutationFn: (id: string) => api.runDomainDiagnostics(id, true),
    onSuccess: (data, id) => {
      if (data.job) {
        setActiveJob({ domainId: id, jobId: data.job.id, status: data.job.status });
        toast.info('Queued background DNS check');
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to enqueue background check'),
  });

  const regenTokenMutation = useMutation({
    mutationFn: (id: string) => api.regenerateDomainToken(id),
    onSuccess: async (_data, id) => {
      toast.success('Generated new ownership verification token');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['domains'] }),
        qc.invalidateQueries({ queryKey: ['domain', id] }),
      ]);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to regenerate token'),
  });

  const rotateDkimMutation = useMutation({
    mutationFn: ({
      id,
      selector,
      algorithm,
    }: {
      id: string;
      selector?: string | undefined;
      algorithm?: 'rsa2048' | 'ed25519' | undefined;
    }) => api.rotateDomainDkim(id, { selector, algorithm }),
    onSuccess: async (data, vars) => {
      toast.success(
        `DKIM key rotated to selector "${data.key.selector}"${data.mtaSynced ? ' and synced to Rust MTA' : ''}`
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['domains'] }),
        qc.invalidateQueries({ queryKey: ['domain', vars.id] }),
      ]);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'DKIM rotation failed'),
  });

  const revokeDkimMutation = useMutation({
    mutationFn: ({ id, keyId }: { id: string; keyId: string }) => api.revokeDomainDkim(id, keyId),
    onSuccess: async (_data, vars) => {
      toast.success('DKIM selector revoked');
      await qc.invalidateQueries({ queryKey: ['domain', vars.id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to revoke DKIM key'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: DomainUpdatePatch }) => api.updateDomain(id, patch),
    onSuccess: async (_data, vars) => {
      toast.success('Domain configuration saved');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['domains'] }),
        qc.invalidateQueries({ queryKey: ['domain', vars.id] }),
      ]);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update settings'),
  });

  const deleteMutation = useMutation({
    mutationFn: ({
      id,
      confirmDomainName,
      confirmCleanup,
    }: {
      id: string;
      confirmDomainName: string;
      confirmCleanup: boolean;
    }) => api.deleteDomain(id, { confirmDomainName, confirmCleanup }),
  });

  const handleDeleteDomain = async (
    id: string,
    confirmDomainName: string,
    confirmCleanup: boolean
  ): Promise<boolean> => {
    try {
      await deleteMutation.mutateAsync({ id, confirmDomainName, confirmCleanup });
      setDeleteDeps(null);
      setSelectedId(null);
      toast.success(`Domain ${confirmDomainName} deleted`);
      await qc.invalidateQueries({ queryKey: ['domains'] });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DOMAIN_HAS_DEPENDENCIES') {
        const deps = (err.extra?.dependencies as typeof deleteDeps) ?? null;
        setDeleteDeps(deps);
        toast.warning('Domain has dependent resources. Review cleanup warning to proceed.');
        return false;
      }
      toast.error(err instanceof Error ? err.message : 'Failed to delete domain');
      return false;
    }
  };

  const detail = detailQuery.data;
  const activeJobForSelected = activeJob && activeJob.domainId === selectedId ? activeJob.status : null;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text)]">Domains &amp; DNS Authentication</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Enterprise domain ownership verification, SPF/DKIM/DMARC authentication, inbound MX hosting, MTA-STS, and live DNS diagnostics.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Add Domain
        </Button>
      </div>

      {/* Summary metrics strip (only real backend aggregates) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Card className="p-3">
          <div className="text-[11px] text-[var(--color-text-muted)]">Total Domains</div>
          <div className="mt-1 text-xl font-semibold text-[var(--color-text)]">{summary.total}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] text-[var(--color-text-muted)]">Verified</div>
          <div className="mt-1 flex items-center gap-1.5 text-xl font-semibold text-emerald-600 dark:text-emerald-400">
            <span>{summary.verified}</span>
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] text-[var(--color-text-muted)]">DNS / Auth Issues</div>
          <div
            className={`mt-1 text-xl font-semibold ${
              summary.dnsIssues > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-[var(--color-text)]'
            }`}
          >
            {summary.dnsIssues}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] text-[var(--color-text-muted)]">Sending Enabled</div>
          <div className="mt-1 text-xl font-semibold text-[var(--color-text)]">{summary.sendingEnabled}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] text-[var(--color-text-muted)]">Inbound Hosting</div>
          <div className="mt-1 text-xl font-semibold text-[var(--color-text)]">{summary.hostingEnabled}</div>
        </Card>
      </div>

      {/* Filter & search bar */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-[var(--color-text-muted)]" />
            <Input
              className="pl-8"
              placeholder="Search domains..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <select
            aria-label="Filter by verification status"
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs"
            value={verifiedFilter}
            onChange={(e) => setVerifiedFilter(e.target.value as 'all' | 'verified' | 'pending')}
          >
            <option value="all">All Verification</option>
            <option value="verified">Verified</option>
            <option value="pending">Pending Verification</option>
          </select>

          <select
            aria-label="Filter by domain role"
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as 'all' | 'sending' | 'hosting')}
          >
            <option value="all">Sending &amp; Hosting</option>
            <option value="sending">Sending Enabled</option>
            <option value="hosting">Inbound Hosting Enabled</option>
          </select>

          <select
            aria-label="Filter by health status"
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs"
            value={healthFilter}
            onChange={(e) => setHealthFilter(e.target.value)}
          >
            <option value="all">All Health States</option>
            <option value="verified">Verified</option>
            <option value="pending_verification">Pending verification</option>
            <option value="dns_misconfigured">DNS misconfigured</option>
            <option value="auth_incomplete">Auth incomplete</option>
            <option value="suspended">Suspended</option>
            <option value="disabled">Disabled</option>
          </select>

          <select
            aria-label="Sort domains"
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'recent' | 'name' | 'health')}
          >
            <option value="recent">Sort: Recently added</option>
            <option value="name">Sort: Domain name</option>
            <option value="health">Sort: Health priority</option>
          </select>
        </div>
      </Card>

      {/* Main two-column domain management workspace */}
      {listQuery.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-2">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
          <Skeleton className="h-96 lg:col-span-2" />
        </div>
      ) : listQuery.isError ? (
        <Card className="p-6">
          <div className="flex items-center justify-between gap-3 text-xs text-red-600 dark:text-red-400">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>Failed to load domains: {listQuery.error instanceof Error ? listQuery.error.message : 'Unknown error'}</span>
            </div>
            <Button size="sm" variant="secondary" onClick={() => listQuery.refetch()}>
              Retry
            </Button>
          </div>
        </Card>
      ) : domains.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Globe className="h-5 w-5" />}
            title={search || verifiedFilter !== 'all' || roleFilter !== 'all' || healthFilter !== 'all' ? 'No matching domains' : 'No domains yet'}
            description={
              search || verifiedFilter !== 'all' || roleFilter !== 'all' || healthFilter !== 'all'
                ? 'Try clearing your search query or filters.'
                : 'Add your domain to verify ownership via live DNS, sign outbound messages with 2048-bit DKIM, and configure inbound hosting.'
            }
            action={
              !(search || verifiedFilter !== 'all' || roleFilter !== 'all' || healthFilter !== 'all') ? (
                <Button onClick={() => setCreateOpen(true)}>Add Domain</Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setVerifiedFilter('all');
                    setRoleFilter('all');
                    setHealthFilter('all');
                  }}
                >
                  Reset Filters
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-12 items-start">
          {/* Left column: domain list */}
          <div className="space-y-2 lg:col-span-4">
            {domains.map((dom: DomainItem) => {
              const selected = dom.id === selectedId;
              return (
                <button
                  key={dom.id}
                  type="button"
                  onClick={() => setSelectedId(dom.id)}
                  className={`w-full rounded-lg border p-3.5 text-left transition-colors cursor-pointer ${
                    selected
                      ? 'border-[var(--color-brand)] bg-[var(--color-surface)] shadow-sm'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-muted)]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate font-mono text-sm font-semibold text-[var(--color-text)]">
                      {dom.domainName}
                    </span>
                    <DomainHealthBadge status={dom.healthStatus} />
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <DnsStateBadge state={dom.spfStatus} prefix="SPF" />
                    <DnsStateBadge state={dom.dkimStatus} prefix="DKIM" />
                    <DnsStateBadge state={dom.dmarcStatus} prefix="DMARC" />
                    {dom.hostingEnabled && <DnsStateBadge state={dom.mxStatus} prefix="MX" />}
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--color-text-muted)]">
                    <div className="flex items-center gap-2">
                      <span>{dom.sendingEnabled ? 'Sending On' : 'Sending Off'}</span>
                      <span>•</span>
                      <span>{dom.hostingEnabled ? 'Hosting On' : 'Hosting Off'}</span>
                      {typeof dom.mailboxCount === 'number' && dom.mailboxCount > 0 && (
                        <>
                          <span>•</span>
                          <span>{dom.mailboxCount} mailbox(es)</span>
                        </>
                      )}
                    </div>
                    {(dom.warningsCount ?? 0) > 0 && (
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="h-3 w-3" />
                        {dom.warningsCount}
                      </span>
                    )}
                  </div>

                  <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                    Checked: {formatShortTimestamp(dom.lastDnsCheckedAt)}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right column: tabbed domain details */}
          <Card className="p-5 lg:col-span-8">
            {detailQuery.isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-10 w-2/3" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            ) : detailQuery.isError ? (
              <div className="flex items-center justify-between gap-3 py-8 text-xs text-red-600 dark:text-red-400">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>
                    Failed to load domain details:{' '}
                    {detailQuery.error instanceof Error ? detailQuery.error.message : 'Unknown error'}
                  </span>
                </div>
                <Button size="sm" variant="secondary" onClick={() => detailQuery.refetch()}>
                  Retry
                </Button>
              </div>
            ) : detail ? (
              <div className="space-y-4">
                {/* Domain Details Header */}
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] pb-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-mono text-base font-semibold text-[var(--color-text)]">
                        {detail.domain.domainName}
                      </h3>
                      <DomainHealthBadge status={detail.domain.healthStatus} />
                      {detail.domain.activeDkimSelector && (
                        <Badge tone="brand">DKIM: {detail.domain.activeDkimSelector}</Badge>
                      )}
                      <Badge tone="neutral">DMARC: p={detail.domain.dmarcPolicy}</Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--color-text-muted)]">
                      <span>Verified: {formatShortTimestamp(detail.domain.ownershipVerifiedAt)}</span>
                      <span>•</span>
                      <span>Last DNS check: {formatShortTimestamp(detail.domain.lastDnsCheckedAt)}</span>
                      <span>•</span>
                      <span>Last auth check passed: {formatShortTimestamp(detail.domain.lastAuthPassedAt)}</span>
                    </div>
                  </div>

                  <DomainActionsMenu
                    domain={detail.domain}
                    verifying={verifyMutation.isPending}
                    runningDiagnostics={diagSyncMutation.isPending}
                    regeneratingToken={regenTokenMutation.isPending}
                    rotatingDkim={rotateDkimMutation.isPending}
                    deleting={deleteMutation.isPending}
                    deleteDependencies={deleteDeps}
                    onVerify={() => verifyMutation.mutate(detail.domain.id)}
                    onRunDiagnostics={() => diagSyncMutation.mutate(detail.domain.id)}
                    onRegenerateToken={() => regenTokenMutation.mutate(detail.domain.id)}
                    onRotateDkim={(selector, algorithm) =>
                      rotateDkimMutation.mutate({ id: detail.domain.id, selector, algorithm })
                    }
                    onUpdateSettings={(patch) => updateMutation.mutate({ id: detail.domain.id, patch })}
                    onDeleteDomain={(confirmDomainName, confirmCleanup) =>
                      handleDeleteDomain(detail.domain.id, confirmDomainName, confirmCleanup)
                    }
                    onClearDeleteDependencies={() => setDeleteDeps(null)}
                  />
                </div>

                {/* Suspended alert */}
                {detail.domain.isSuspended && (
                  <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
                    <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-semibold">Domain Suspended:</span>{' '}
                      {detail.domain.suspensionReason ?? 'Outbound sending and relay are suspended by compliance policy.'}
                    </div>
                  </div>
                )}

                {/* Actionable Notifications Banner */}
                {detail.notifications.length > 0 && (
                  <div className="space-y-1.5">
                    {detail.notifications.slice(0, 3).map((note) => (
                      <div
                        key={note.id}
                        className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                          note.severity === 'error'
                            ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                            : note.severity === 'warning'
                              ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300'
                              : 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                        }`}
                      >
                        {note.severity === 'error' ? (
                          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        ) : note.severity === 'warning' ? (
                          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                        ) : (
                          <Info className="h-4 w-4 shrink-0 mt-0.5" />
                        )}
                        <div className="min-w-0 flex-1">
                          <span className="font-semibold">{note.title}: </span>
                          <span>{note.message}</span>
                          {note.recommendedAction && (
                            <span className="block text-[11px] opacity-90 mt-0.5">
                              Recommended: {note.recommendedAction}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Structured Tabs */}
                <AppTabs.Root value={activeTab} onValueChange={setActiveTab} className="space-y-4">
                  <AppTabs.List className="flex flex-wrap gap-1 border-b border-[var(--color-border)] pb-2">
                    {[
                      { id: 'overview', label: 'Overview' },
                      { id: 'dns', label: 'DNS & Auth' },
                      { id: 'diagnostics', label: 'Diagnostics' },
                      { id: 'deliverability', label: 'Deliverability' },
                      { id: 'sending', label: 'Sending' },
                      { id: 'hosting', label: 'Inbound Hosting' },
                      { id: 'security', label: 'Security' },
                      { id: 'history', label: 'History & Audit' },
                    ].map((tab) => (
                      <AppTabs.Tab
                        key={tab.id}
                        value={tab.id}
                        className="rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)] data-[selected]:bg-[var(--color-accent)] data-[selected]:text-[var(--color-accent-fg)] cursor-pointer"
                      >
                        {tab.label}
                      </AppTabs.Tab>
                    ))}
                  </AppTabs.List>

                  {/* Tab 1: Overview */}
                  <AppTabs.Panel value="overview" className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                      <div className="rounded-md border border-[var(--color-border)] p-3 space-y-1">
                        <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                          <ShieldCheck className="h-3.5 w-3.5" /> Ownership Verification
                        </div>
                        <div className="font-semibold text-[var(--color-text)]">
                          {detail.domain.ownershipVerifiedAt
                            ? `Verified (${formatShortTimestamp(detail.domain.ownershipVerifiedAt)})`
                            : 'Pending DNS TXT verification'}
                        </div>
                      </div>

                      <div className="rounded-md border border-[var(--color-border)] p-3 space-y-1">
                        <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                          <Mail className="h-3.5 w-3.5" /> Outbound Sending
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-[var(--color-text)]">
                            {detail.domain.sendingEnabled ? 'Enabled' : 'Disabled'}
                          </span>
                          <AppSwitch
                            checked={detail.domain.sendingEnabled}
                            onCheckedChange={(checked) =>
                              updateMutation.mutate({ id: detail.domain.id, patch: { sendingEnabled: checked } })
                            }
                          />
                        </div>
                      </div>

                      <div className="rounded-md border border-[var(--color-border)] p-3 space-y-1">
                        <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                          <Server className="h-3.5 w-3.5" /> Inbound Hosting
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-[var(--color-text)]">
                            {detail.domain.hostingEnabled ? 'Enabled' : 'Disabled'}
                          </span>
                          <AppSwitch
                            checked={detail.domain.hostingEnabled}
                            onCheckedChange={(checked) =>
                              updateMutation.mutate({ id: detail.domain.id, patch: { hostingEnabled: checked } })
                            }
                          />
                        </div>
                      </div>
                    </div>

                    {/* Consolidated Health Report */}
                    <div className="rounded-md border border-[var(--color-border)] p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h4 className="text-xs font-semibold text-[var(--color-text)]">
                            Consolidated Domain Health Report
                          </h4>
                          <p className="text-[11px] text-[var(--color-text-muted)]">
                            Authentication coverage, MTA signing readiness, and policy posture as of{' '}
                            {formatShortTimestamp(detail.diagnostics.checkedAt ?? detail.domain.lastDnsCheckedAt)}.
                          </p>
                        </div>
                        <DomainHealthBadge status={detail.domain.healthStatus} />
                      </div>

                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                        {[
                          { label: 'Ownership TXT', state: detail.domain.ownershipVerifiedAt ? 'pass' : 'fail' },
                          { label: 'SPF Authorization', state: detail.domain.spfStatus },
                          { label: 'DKIM Signing Key', state: detail.domain.dkimStatus },
                          { label: 'DMARC Policy', state: detail.domain.dmarcStatus },
                          { label: 'Inbound MX', state: detail.domain.mxStatus },
                          { label: 'Sending IP rDNS / PTR', state: detail.domain.ptrStatus },
                        ].map((row) => (
                          <div
                            key={row.label}
                            className="flex items-center justify-between rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-2.5 py-2"
                          >
                            <span className="text-[var(--color-text)]">{row.label}</span>
                            <DnsStateBadge state={row.state as DomainItem['spfStatus']} />
                          </div>
                        ))}
                      </div>

                      <div className="grid gap-3 pt-1 sm:grid-cols-3 text-xs text-[var(--color-text-muted)]">
                        <div>
                          Active DKIM Selector:{' '}
                          <span className="font-mono text-[var(--color-text)]">
                            {detail.domain.activeDkimSelector ?? 'mp1'}
                          </span>
                        </div>
                        <div>
                          Current DMARC Policy:{' '}
                          <span className="font-mono text-[var(--color-text)]">
                            p={detail.domain.dmarcPolicy} ({detail.domain.dmarcPct ?? 100}%)
                          </span>
                        </div>
                        <div>
                          Rust MTA Node:{' '}
                          <span className="font-mono text-[var(--color-text)]">
                            {detail.infra.mtaNodeId ?? detail.infra.heloDomain}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Recommended Actions */}
                    <div className="rounded-md border border-[var(--color-border)] p-4 space-y-2">
                      <h4 className="text-xs font-semibold text-[var(--color-text)]">Recommended Actions</h4>
                      {detail.notifications.length === 0 ? (
                        <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-4 w-4 shrink-0" />
                          All verified DNS and authentication checks are healthy. No immediate action required.
                        </div>
                      ) : (
                        <ul className="space-y-1.5 text-xs text-[var(--color-text-muted)]">
                          {detail.notifications.map((n) => (
                            <li key={n.id} className="flex items-start gap-2">
                              <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[var(--color-brand)] shrink-0" />
                              <div>
                                <span className="font-medium text-[var(--color-text)]">{n.title}:</span>{' '}
                                {n.recommendedAction ?? n.message}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </AppTabs.Panel>

                  {/* Tab 2: DNS Records & Authentication */}
                  <AppTabs.Panel value="dns">
                    <DomainDnsRecordsTab
                      detail={detail}
                      onVerify={() => verifyMutation.mutate(detail.domain.id)}
                      verifying={verifyMutation.isPending}
                      onRotateDkim={(selector, algorithm) =>
                        rotateDkimMutation.mutate({ id: detail.domain.id, selector, algorithm })
                      }
                      rotatingDkim={rotateDkimMutation.isPending}
                      onRevokeDkim={(keyId) => revokeDkimMutation.mutate({ id: detail.domain.id, keyId })}
                      onUpdateSettings={(patch) => updateMutation.mutate({ id: detail.domain.id, patch })}
                      updatingSettings={updateMutation.isPending}
                    />
                  </AppTabs.Panel>

                  {/* Tab 3: Live DNS Diagnostics */}
                  <AppTabs.Panel value="diagnostics">
                    <DomainDiagnosticsTab
                      detail={detail}
                      onRunDiagnostics={(asyncMode) =>
                        asyncMode
                          ? diagAsyncMutation.mutate(detail.domain.id)
                          : diagSyncMutation.mutate(detail.domain.id)
                      }
                      runningSync={diagSyncMutation.isPending}
                      runningAsync={diagAsyncMutation.isPending}
                      activeJobStatus={activeJobForSelected}
                    />
                  </AppTabs.Panel>

                  {/* Tab 4: Email Deliverability & Reputation */}
                  <AppTabs.Panel value="deliverability">
                    <DomainDeliverabilityTab detail={detail} />
                  </AppTabs.Panel>

                  {/* Tab 5: Sending Configuration */}
                  <AppTabs.Panel value="sending">
                    <DomainSendingConfigTab
                      detail={detail}
                      onUpdateSettings={(patch) => updateMutation.mutate({ id: detail.domain.id, patch })}
                      updating={updateMutation.isPending}
                    />
                  </AppTabs.Panel>

                  {/* Tab 6: Inbound Mail Hosting */}
                  <AppTabs.Panel value="hosting">
                    <DomainHostingTab
                      detail={detail}
                      onUpdateSettings={(patch) => updateMutation.mutate({ id: detail.domain.id, patch })}
                    />
                  </AppTabs.Panel>

                  {/* Tab 7: Advanced Security */}
                  <AppTabs.Panel value="security">
                    <DomainSecurityTab
                      detail={detail}
                      onUpdateSettings={(patch) => updateMutation.mutate({ id: detail.domain.id, patch })}
                      updating={updateMutation.isPending}
                    />
                  </AppTabs.Panel>

                  {/* Tab 8: History & Audit Logs */}
                  <AppTabs.Panel value="history">
                    <DomainHistoryTab detail={detail} />
                  </AppTabs.Panel>
                </AppTabs.Root>
              </div>
            ) : null}
          </Card>
        </div>
      )}

      {/* Add Domain Modal */}
      <AppDialog open={createOpen} onOpenChange={setCreateOpen} title="Add Domain">
        <form
          className="space-y-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newDomain.trim()) return;
            createMutation.mutate();
          }}
        >
          <div className="space-y-1">
            <label className="font-medium text-[var(--color-text)]">Domain Name</label>
            <Input
              placeholder="mail.example.com or example.com"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              required
            />
            <p className="text-[11px] text-[var(--color-text-muted)]">
              FastConnect will generate an ownership TXT token and a 2048-bit RSA DKIM signing keypair for your domain.
            </p>
          </div>

          <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
            <AppSwitch
              checked={newSendingEnabled}
              label="Enable Outbound Sending (API, SMTP relay, campaigns)"
              onCheckedChange={setNewSendingEnabled}
            />
            <AppSwitch
              checked={newHostingEnabled}
              label="Enable Inbound Mail Hosting (MX / LMTP / IMAP)"
              onCheckedChange={setNewHostingEnabled}
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating...' : 'Create Domain'}
            </Button>
          </div>
        </form>
      </AppDialog>
    </div>
  );
}
