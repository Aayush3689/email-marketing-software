import type { DnsRecordEvaluation, DkimKeySummary } from '@mail/shared-types';
import { Badge, Button, Input } from '@mail/ui';
import { AlertTriangle, ChevronDown, ChevronRight, Copy, KeyRound, RefreshCw, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DomainDetailResponse, DomainUpdatePatch } from '../../lib/api.js';
import { DnsStateBadge, copyToClipboard, formatShortTimestamp } from './DomainStatusBadge.js';

export function DomainDnsRecordsTab({
  detail,
  onVerify,
  verifying,
  onRotateDkim,
  rotatingDkim,
  onRevokeDkim,
  onUpdateSettings,
  updatingSettings,
}: {
  detail: DomainDetailResponse;
  onVerify: () => void;
  verifying: boolean;
  onRotateDkim: (selector?: string, algorithm?: 'rsa2048' | 'ed25519') => void;
  rotatingDkim: boolean;
  onRevokeDkim: (keyId: string) => void;
  onUpdateSettings: (patch: DomainUpdatePatch) => void;
  updatingSettings: boolean;
}) {
  const { domain, diagnostics, dkimKeys, infra } = detail;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [customSelector, setCustomSelector] = useState('');
  const [dmarcPolicy, setDmarcPolicy] = useState<'none' | 'quarantine' | 'reject'>(domain.dmarcPolicy);
  const [dmarcRua, setDmarcRua] = useState(domain.dmarcRua ?? `mailto:dmarc@${domain.domainName}`);
  const [dmarcRuf, setDmarcRuf] = useState(domain.dmarcRuf ?? '');
  const [dmarcPct, setDmarcPct] = useState(String(domain.dmarcPct ?? 100));
  const [dmarcAspf, setDmarcAspf] = useState<'r' | 's'>(domain.dmarcAspf ?? 'r');
  const [dmarcAdkim, setDmarcAdkim] = useState<'r' | 's'>(domain.dmarcAdkim ?? 'r');

  useEffect(() => {
    setDmarcPolicy(domain.dmarcPolicy);
    setDmarcRua(domain.dmarcRua ?? `mailto:dmarc@${domain.domainName}`);
    setDmarcRuf(domain.dmarcRuf ?? '');
    setDmarcPct(String(domain.dmarcPct ?? 100));
    setDmarcAspf(domain.dmarcAspf ?? 'r');
    setDmarcAdkim(domain.dmarcAdkim ?? 'r');
  }, [domain]);

  const authReadyForStrictDmarc =
    domain.spfStatus === 'pass' && domain.dkimStatus === 'pass';

  const spfRecord = diagnostics.records.find((r) => r.id === 'spf');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-[var(--color-text)]">DNS Records &amp; Authentication</h4>
          <p className="text-xs text-[var(--color-text-muted)]">
            Last live verification: {formatShortTimestamp(diagnostics.checkedAt)} • Sending MTA:{' '}
            <span className="font-mono">{infra.heloDomain}</span>
          </p>
        </div>
        <Button size="sm" variant="secondary" disabled={verifying} onClick={onVerify}>
          <RefreshCw className={`h-3.5 w-3.5 ${verifying ? 'animate-spin' : ''}`} />
          Re-check DNS
        </Button>
      </div>

      {spfRecord && spfRecord.detected.length > 1 && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
          <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">Duplicate SPF TXT records detected on {spfRecord.host}</div>
            <p className="mt-0.5 opacity-90">{spfRecord.remediation}</p>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {diagnostics.records.map((rec: DnsRecordEvaluation) => {
          const isOpen = expandedId === rec.id;
          return (
            <div
              key={rec.id}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setExpandedId(isOpen ? null : rec.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
                >
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                  )}
                  <Badge>{rec.type}</Badge>
                  <span className="font-mono text-[11px] font-medium text-[var(--color-text)] truncate">
                    {rec.host}
                  </span>
                  {!rec.required && <Badge tone="neutral">Optional</Badge>}
                </button>
                <div className="flex items-center gap-1.5">
                  <DnsStateBadge state={rec.status} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyToClipboard('host', rec.host)}
                    title="Copy host/name"
                  >
                    <Copy className="h-3 w-3" /> Host
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyToClipboard('record value', rec.expected)}
                    title="Copy expected value"
                  >
                    <Copy className="h-3 w-3" /> Value
                  </Button>
                </div>
              </div>

              <div className="border-t border-[var(--color-border)] px-3 py-2 space-y-1.5">
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Expected: </span>
                  <span className="font-mono text-[11px] text-[var(--color-text)] break-all">{rec.expected}</span>
                </div>
                {isOpen && (
                  <div className="space-y-1.5 pt-1 text-[11px]">
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                        Detected in DNS:{' '}
                      </span>
                      {rec.detected.length === 0 ? (
                        <span className="italic text-[var(--color-text-muted)]">No record found</span>
                      ) : (
                        <ul className="mt-0.5 space-y-0.5">
                          {rec.detected.map((d, idx) => (
                            <li key={idx} className="font-mono text-[var(--color-text)] break-all">
                              {d}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-4 text-[var(--color-text-muted)]">
                      <span>Propagation: {rec.propagationStatus}</span>
                      <span>Resolver: {rec.resolver}</span>
                      <span>Checked: {formatShortTimestamp(rec.checkedAt)}</span>
                      {rec.error && <span className="text-red-500">Error: {rec.error}</span>}
                    </div>
                    {rec.remediation && (
                      <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-amber-800 dark:text-amber-300">
                        {rec.remediation}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* DKIM Selector Management & Rotation */}
      <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h5 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text)]">
              <KeyRound className="h-3.5 w-3.5" /> DKIM Signing Keys &amp; Selector Rotation
            </h5>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Active selector in Rust MTA: <span className="font-mono">{domain.activeDkimSelector ?? 'mp1'}</span>. Old selectors remain in retiring status during rotation.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Optional selector (e.g. mp2)"
              value={customSelector}
              onChange={(e) => setCustomSelector(e.target.value)}
              className="h-8 w-44 text-xs"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={rotatingDkim}
              onClick={() => {
                onRotateDkim(customSelector.trim() || undefined, 'rsa2048');
                setCustomSelector('');
              }}
            >
              Rotate DKIM Key
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          {dkimKeys.map((k: DkimKeySummary) => (
            <div
              key={k.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono font-semibold text-[var(--color-text)]">{k.selector}</span>
                  <Badge tone={k.status === 'active' ? 'success' : k.status === 'retiring' ? 'warning' : 'neutral'}>
                    {k.status}
                  </Badge>
                  <Badge>{k.algorithm.toUpperCase()}</Badge>
                  <Badge tone={k.dnsVerified ? 'success' : 'warning'}>
                    {k.dnsVerified ? 'DNS Matched' : 'DNS Pending'}
                  </Badge>
                  {k.status === 'active' && (
                    <Badge tone={k.mtaLoaded ? 'brand' : 'warning'}>
                      {k.mtaLoaded ? 'MTA Loaded' : 'MTA Sync Needed'}
                    </Badge>
                  )}
                </div>
                <div className="font-mono text-[11px] text-[var(--color-text-muted)] truncate">
                  {k.dnsRecordName} → {k.publicKeyDnsTxt}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void copyToClipboard('DKIM TXT value', k.publicKeyDnsTxt)}
                >
                  <Copy className="h-3 w-3" /> Copy Key
                </Button>
                {k.status === 'retiring' && (
                  <Button variant="ghost" size="sm" onClick={() => onRevokeDkim(k.id)}>
                    Revoke
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* DMARC Policy Builder */}
      <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
        <h5 className="text-xs font-semibold text-[var(--color-text)]">DMARC Policy &amp; Alignment</h5>
        {(dmarcPolicy === 'quarantine' || dmarcPolicy === 'reject') && !authReadyForStrictDmarc && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              SPF or DKIM is not verified yet. Enforcing <span className="font-mono">p={dmarcPolicy}</span> before SPF and DKIM pass can cause legitimate messages to be blocked or quarantined.
            </span>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3 text-xs">
          <label className="space-y-1">
            <span className="text-[var(--color-text-muted)]">Policy (p=)</span>
            <select
              value={dmarcPolicy}
              onChange={(e) => setDmarcPolicy(e.target.value as 'none' | 'quarantine' | 'reject')}
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs"
            >
              <option value="none">p=none (Monitor)</option>
              <option value="quarantine">p=quarantine</option>
              <option value="reject">p=reject (Strict)</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[var(--color-text-muted)]">Percentage (pct=)</span>
            <Input type="number" min={0} max={100} value={dmarcPct} onChange={(e) => setDmarcPct(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[var(--color-text-muted)]">SPF Align (aspf)</span>
              <select
                value={dmarcAspf}
                onChange={(e) => setDmarcAspf(e.target.value as 'r' | 's')}
                className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs"
              >
                <option value="r">Relaxed (r)</option>
                <option value="s">Strict (s)</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[var(--color-text-muted)]">DKIM Align (adkim)</span>
              <select
                value={dmarcAdkim}
                onChange={(e) => setDmarcAdkim(e.target.value as 'r' | 's')}
                className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs"
              >
                <option value="r">Relaxed (r)</option>
                <option value="s">Strict (s)</option>
              </select>
            </label>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 text-xs">
          <label className="space-y-1">
            <span className="text-[var(--color-text-muted)]">Aggregate Reports (rua=)</span>
            <Input value={dmarcRua} onChange={(e) => setDmarcRua(e.target.value)} placeholder={`mailto:dmarc@${domain.domainName}`} />
          </label>
          <label className="space-y-1">
            <span className="text-[var(--color-text-muted)]">Forensic Reports (ruf=, optional)</span>
            <Input value={dmarcRuf} onChange={(e) => setDmarcRuf(e.target.value)} placeholder={`mailto:forensic@${domain.domainName}`} />
          </label>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={updatingSettings}
            onClick={() =>
              onUpdateSettings({
                dmarcPolicy,
                dmarcPct: Math.min(100, Math.max(0, Number(dmarcPct) || 100)),
                dmarcAspf,
                dmarcAdkim,
                dmarcRua: dmarcRua.trim() || null,
                dmarcRuf: dmarcRuf.trim() || null,
              })
            }
          >
            Save DMARC Settings
          </Button>
        </div>
      </div>

      {/* External DNS Provider Guide */}
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 p-3 text-[11px] text-[var(--color-text-muted)] space-y-1">
        <div className="font-medium text-[var(--color-text)]">External DNS Provider Notes</div>
        <p>
          • <strong>Cloudflare / Route53 / GoDaddy / Namecheap:</strong> Some DNS dashboards auto-append <span className="font-mono">.{domain.domainName}</span> to Host names — enter relative labels like <span className="font-mono">_mailplat-verify</span>, <span className="font-mono">{domain.activeDkimSelector ?? 'mp1'}._domainkey</span>, and <span className="font-mono">_dmarc</span> if your panel appends the root domain automatically.
        </p>
        <p>
          • Ensure DNS proxy (orange cloud) is set to <strong>DNS Only</strong> for MX, A (<span className="font-mono">{infra.heloDomain}</span>), and CNAME records used for mail routing.
        </p>
      </div>
    </div>
  );
}
