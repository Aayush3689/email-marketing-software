import { Badge, Button } from '@mail/ui';
import { RefreshCw, SearchCheck } from 'lucide-react';
import type { DomainDetailResponse } from '../../lib/api.js';
import { DnsStateBadge, formatShortTimestamp } from './DomainStatusBadge.js';

export function DomainDiagnosticsTab({
  detail,
  onRunDiagnostics,
  runningSync,
  runningAsync,
  activeJobStatus,
}: {
  detail: DomainDetailResponse;
  onRunDiagnostics: (asyncMode: boolean) => void;
  runningSync: boolean;
  runningAsync: boolean;
  activeJobStatus: string | null;
}) {
  const { diagnostics } = detail;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-[var(--color-text)]">Live DNS Diagnostics</h4>
          <p className="text-xs text-[var(--color-text-muted)]">
            Checks A, AAAA, MX, TXT, SPF, DKIM, DMARC, PTR, and configured CNAME/policy endpoints using live DNS queries. Last run: {formatShortTimestamp(diagnostics.checkedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={runningAsync || runningSync}
            onClick={() => onRunDiagnostics(true)}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${runningAsync ? 'animate-spin' : ''}`} />
            {activeJobStatus ? `Job: ${activeJobStatus}` : 'Run Background Check'}
          </Button>
          <Button size="sm" disabled={runningSync || runningAsync} onClick={() => onRunDiagnostics(false)}>
            <SearchCheck className="h-3.5 w-3.5" />
            Run Full DNS Check
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
            <tr>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Host</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Propagation</th>
              <th className="px-3 py-2">Expected vs Detected</th>
              <th className="px-3 py-2">Resolver / Checked</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {diagnostics.records.map((rec) => (
              <tr key={rec.id} className="align-top">
                <td className="px-3 py-2.5">
                  <Badge>{rec.type}</Badge>
                </td>
                <td className="px-3 py-2.5 font-mono text-[11px] text-[var(--color-text)]">{rec.host}</td>
                <td className="px-3 py-2.5">
                  <DnsStateBadge state={rec.status} />
                </td>
                <td className="px-3 py-2.5 text-[11px] text-[var(--color-text-muted)]">{rec.propagationStatus}</td>
                <td className="px-3 py-2.5 space-y-1 max-w-md">
                  <div className="font-mono text-[11px] text-[var(--color-text)] break-all">
                    <span className="text-[var(--color-text-muted)]">Exp: </span>
                    {rec.expected}
                  </div>
                  <div className="font-mono text-[11px] text-[var(--color-text-muted)] break-all">
                    <span>Det: </span>
                    {rec.detected.length > 0 ? rec.detected.join(' | ') : 'None'}
                  </div>
                  {rec.error && <div className="text-[11px] text-red-500">Lookup error: {rec.error}</div>}
                  {rec.remediation && (
                    <div className="text-[11px] text-amber-700 dark:text-amber-300">{rec.remediation}</div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-[11px] text-[var(--color-text-muted)] whitespace-nowrap">
                  <div>{rec.resolver}</div>
                  <div>{formatShortTimestamp(rec.checkedAt)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
