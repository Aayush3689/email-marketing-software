import { Badge, Card, EmptyState, Skeleton } from '@mail/ui';
import { useQuery } from '@tanstack/react-query';
import { Activity, Building2, Database, FileClock, Layers, Server } from 'lucide-react';
import { adminApi } from '../lib/api.js';

export function ClusterOverviewView() {
  const overviewQuery = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => adminApi.getOverview(),
    refetchInterval: 10_000,
  });

  if (overviewQuery.isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const ov = overviewQuery.data?.overview;
  if (!ov) return null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text)]">Cluster Health &amp; Telemetry</h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          Live infrastructure probes across PostgreSQL, Redis, RabbitMQ, and registered Rust MTA nodes
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {ov.services.map((svc) => (
          <Card key={svc.name} className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                {svc.name.replace('_', ' ')}
              </span>
              <Badge
                tone={
                  svc.status === 'healthy'
                    ? 'success'
                    : svc.status === 'degraded'
                      ? 'danger'
                      : 'neutral'
                }
              >
                {svc.status}
              </Badge>
            </div>
            <div className="mt-2 text-xs text-[var(--color-text)] truncate" title={svc.detail}>
              {svc.detail}
            </div>
            <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              {svc.latencyMs !== null ? `Probe latency: ${svc.latencyMs} ms` : 'Status probe'}
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <span>Organizations &amp; Domains</span>
            <Building2 className="h-4 w-4 text-blue-500" />
          </div>
          <div className="mt-2 text-2xl font-semibold text-[var(--color-text)]">
            {ov.totals.organizations} / {ov.totals.domains}
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            {ov.totals.suspendedOrganizations} orgs suspended • {ov.totals.suspendedDomains} domains suspended
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <span>MTA Nodes</span>
            <Server className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="mt-2 text-2xl font-semibold text-[var(--color-text)]">
            {ov.totals.mtaNodes}
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            {ov.totals.drainingNodes} currently draining
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <span>Queue &amp; DLQ Depth</span>
            <Layers className="h-4 w-4 text-amber-500" />
          </div>
          <div className="mt-2 text-2xl font-semibold text-[var(--color-text)]">
            {ov.totals.queuedMessages}
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            {ov.totals.dlqMessages} dead-letter messages awaiting triage
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <span>Cluster Events</span>
            <Activity className="h-4 w-4 text-violet-500" />
          </div>
          <div className="mt-2 text-2xl font-semibold text-[var(--color-text)]">
            {ov.emailTelemetry.totalEvents}
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            Avg MTA latency: {ov.emailTelemetry.avgLatencyMs} ms
          </div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileClock className="h-4 w-4 text-[var(--color-brand)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text)]">
              Recent Immutable Admin Actions ({ov.totals.auditLogsCount})
            </h3>
          </div>
          <Database className="h-4 w-4 text-[var(--color-text-muted)]" />
        </div>

        {ov.recentAudits.length === 0 ? (
          <EmptyState
            icon={<FileClock className="h-5 w-5" />}
            title="No audit events yet"
            description="Every Super Admin mutation records an immutable before/after audit log entry."
          />
        ) : (
          <div className="space-y-2">
            {ov.recentAudits.map((log) => (
              <div
                key={log.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
              >
                <div>
                  <span className="font-mono font-medium text-[var(--color-text)]">{log.action}</span>
                  <span className="ml-2 text-[var(--color-text-muted)]">
                    {log.resourceType}:{log.resourceId ?? '-'}
                  </span>
                </div>
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  Actor {log.actorUserId.slice(0, 8)} • {new Date(log.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
