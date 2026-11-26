import { Badge, Button, Card, EmptyState, Skeleton } from '@mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, BarChart3, Download, Globe, MailCheck, Plus, Timer } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';

const RANGES = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7d' },
  { id: '30d', label: 'Last 30d' },
] as const;

export function OverviewView() {
  const [range, setRange] = useState<'today' | 'yesterday' | '7d' | '30d'>('7d');
  const queryClient = useQueryClient();

  const overviewQuery = useQuery({
    queryKey: ['analytics-overview', range],
    queryFn: () => api.getAnalyticsOverview(range),
  });

  const domainsQuery = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.listDomains(),
  });

  const recordDemoEvent = useMutation({
    mutationFn: () =>
      api.recordAnalyticsEvent({
        messageId: `msg_${Math.random().toString(36).slice(2, 10)}`,
        recipientEmail: 'subscriber@example.com',
        eventType: 'delivered',
        domain: 'example.com',
        latencyMs: 92,
        detail: '250 2.0.0 OK',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['analytics-overview'] });
      await queryClient.invalidateQueries({ queryKey: ['analytics-events'] });
      await queryClient.invalidateQueries({ queryKey: ['billing-subscription'] });
      toast.success('Recorded delivery event in store');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to record event'),
  });

  const handleExportCsv = async () => {
    try {
      const csv = await api.downloadAnalyticsCsv(range);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `email-events-${range}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Downloaded analytics CSV');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    }
  };

  const overview = overviewQuery.data?.overview;
  const domains = domainsQuery.data?.domains ?? [];
  const maxSeriesValue = Math.max(
    1,
    ...(overview?.series.map((s) => Math.max(s.delivered + s.bounced, s.accepted)) ?? [1])
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text)]">Deliverability Overview</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Real-time event telemetry stored in your workspace event pipeline
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 text-xs">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRange(r.id)}
                className={`rounded px-2.5 py-1 font-medium transition-colors cursor-pointer ${
                  range === r.id
                    ? 'bg-[var(--color-accent)] text-[var(--color-accent-fg)]'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          <Button variant="secondary" size="sm" onClick={() => void handleExportCsv()}>
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={recordDemoEvent.isPending}
            onClick={() => recordDemoEvent.mutate()}
          >
            <Plus className="h-3.5 w-3.5" />
            Record Test Delivery
          </Button>
        </div>
      </div>

      {overviewQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="p-4">
            <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
              <span>Delivered</span>
              <MailCheck className="h-4 w-4 text-emerald-500" />
            </div>
            <div className="mt-2 text-2xl font-semibold text-[var(--color-text)]">
              {overview?.counts.delivered ?? 0}
            </div>
            <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              {overview?.counts.accepted ?? 0} accepted total
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
              <span>Delivery Rate</span>
              <Activity className="h-4 w-4 text-blue-500" />
            </div>
            <div className="mt-2 text-2xl font-semibold text-[var(--color-text)]">
              {overview?.rates.deliveryRate ?? 0}%
            </div>
            <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              Open {overview?.rates.openRate ?? 0}% • Click {overview?.rates.clickRate ?? 0}%
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
              <span>Bounce &amp; Complaint</span>
              <BarChart3 className="h-4 w-4 text-amber-500" />
            </div>
            <div className="mt-2 text-2xl font-semibold text-[var(--color-text)]">
              {overview?.rates.bounceRate ?? 0}%
            </div>
            <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              {overview?.counts.bounced ?? 0} bounced • {overview?.counts.complained ?? 0} complaints
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
              <span>Avg MTA Latency</span>
              <Timer className="h-4 w-4 text-violet-500" />
            </div>
            <div className="mt-2 text-2xl font-semibold text-[var(--color-text)]">
              {overview?.avgLatencyMs ?? 0} ms
            </div>
            <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              {domains.filter((d) => d.ownershipVerifiedAt).length} / {domains.length} verified domains
            </div>
          </Card>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium text-[var(--color-text)]">Delivery Volume Trend</h3>
            <span className="text-xs text-[var(--color-text-muted)]">
              {overview?.series.length ?? 0} day buckets
            </span>
          </div>

          {!overview || overview.series.length === 0 ? (
            <EmptyState
              icon={<BarChart3 className="h-5 w-5" />}
              title="No email events recorded yet"
              description="Send through POST /v1/emails or click Record Test Delivery to see real-time telemetry buckets."
            />
          ) : (
            <div className="space-y-2">
              <svg viewBox="0 0 560 180" className="h-44 w-full overflow-visible">
                {overview.series.map((point, index) => {
                  const slotW = 560 / Math.max(1, overview.series.length);
                  const barW = Math.min(36, slotW * 0.55);
                  const x = index * slotW + (slotW - barW) / 2;
                  const deliveredH = Math.max(4, (point.delivered / maxSeriesValue) * 140);
                  const bouncedH = (point.bounced / maxSeriesValue) * 140;
                  return (
                    <g key={point.date}>
                      <rect
                        x={x}
                        y={150 - deliveredH}
                        width={barW}
                        height={deliveredH}
                        rx={4}
                        className="fill-emerald-500/80"
                      />
                      {bouncedH > 0 && (
                        <rect
                          x={x}
                          y={150 - deliveredH - bouncedH}
                          width={barW}
                          height={bouncedH}
                          rx={3}
                          className="fill-red-500/80"
                        />
                      )}
                      <text
                        x={x + barW / 2}
                        y={170}
                        textAnchor="middle"
                        className="fill-[var(--color-text-muted)] text-[10px]"
                      >
                        {point.date.slice(5)}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <div className="flex items-center gap-4 text-[11px] text-[var(--color-text-muted)]">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-xs bg-emerald-500/80" /> Delivered
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-xs bg-red-500/80" /> Bounced
                </span>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium text-[var(--color-text)]">Sending Domains</h3>
            <Globe className="h-4 w-4 text-[var(--color-text-muted)]" />
          </div>
          {domains.length === 0 ? (
            <EmptyState
              icon={<Globe className="h-5 w-5" />}
              title="No domains configured"
              description="Add a custom domain in the Domains tab to configure SPF, DKIM, and DMARC."
            />
          ) : (
            <ul className="space-y-2.5">
              {domains.map((dom) => (
                <li
                  key={dom.id}
                  className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
                >
                  <div>
                    <div className="font-medium text-[var(--color-text)]">{dom.domainName}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      DMARC: {dom.dmarcPolicy} • Selector: {dom.activeDkimSelector ?? 'mp1'}
                    </div>
                  </div>
                  <Badge tone={dom.ownershipVerifiedAt ? 'success' : 'warning'}>
                    {dom.ownershipVerifiedAt ? 'Verified' : 'Pending DNS'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
