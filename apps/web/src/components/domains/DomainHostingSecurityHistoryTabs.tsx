import { AppSwitch, Badge, Button, Input } from '@mail/ui';
import { Inbox, Info, Lock, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DomainDetailResponse, DomainUpdatePatch } from '../../lib/api.js';
import { DnsStateBadge, formatShortTimestamp } from './DomainStatusBadge.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DomainHostingTab({
  detail,
  onUpdateSettings,
}: {
  detail: DomainDetailResponse;
  onUpdateSettings: (patch: DomainUpdatePatch) => void;
}) {
  const { domain, hosting, infra } = detail;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-[var(--color-text)]">Inbound Mail Hosting (IMAP / LMTP)</h4>
          <p className="text-xs text-[var(--color-text-muted)]">
            Separate from outbound sending. Enabling inbound hosting allows Dovecot/LMTP to accept mail for mailboxes on {domain.domainName}; it does not auto-create mailboxes.
          </p>
        </div>
        <AppSwitch
          checked={domain.hostingEnabled}
          label={domain.hostingEnabled ? 'Inbound Hosting On' : 'Inbound Hosting Off'}
          onCheckedChange={(checked) => onUpdateSettings({ hostingEnabled: checked })}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-4 text-xs">
        <div className="rounded-md border border-[var(--color-border)] p-3">
          <div className="text-[var(--color-text-muted)]">MX Status</div>
          <div className="mt-1">
            <DnsStateBadge state={domain.mxStatus} />
          </div>
          <div className="mt-1 font-mono text-[11px] text-[var(--color-text-muted)]">10 {infra.heloDomain}</div>
        </div>
        <div className="rounded-md border border-[var(--color-border)] p-3">
          <div className="text-[var(--color-text-muted)]">Hosted Mailboxes</div>
          <div className="mt-1 text-base font-semibold text-[var(--color-text)]">
            {hosting?.activeMailboxCount ?? 0} / {hosting?.mailboxCount ?? 0}
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)]">
            Catch-all rules: {hosting?.catchAllCount ?? 0}
          </div>
        </div>
        <div className="rounded-md border border-[var(--color-border)] p-3">
          <div className="text-[var(--color-text-muted)]">Storage Used</div>
          <div className="mt-1 text-base font-semibold text-[var(--color-text)]">
            {formatBytes(hosting?.totalUsedBytes ?? 0)}
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)]">
            of {formatBytes(hosting?.totalQuotaBytes ?? 0)} allocated
          </div>
        </div>
        <div className="rounded-md border border-[var(--color-border)] p-3">
          <div className="text-[var(--color-text-muted)]">Inbound Activity (30d)</div>
          <div className="mt-1 text-xs font-medium text-[var(--color-text)]">
            Last: {formatShortTimestamp(hosting?.lastInboundAt)}
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)]">
            Inbound errors: {hosting?.inboundErrors30d ?? 0}
          </div>
        </div>
      </div>

      <div className="rounded-md border border-[var(--color-border)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-xs font-medium">
          <span className="flex items-center gap-1.5">
            <Inbox className="h-3.5 w-3.5" /> Mailboxes for {domain.domainName}
          </span>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            Managed via <code className="font-mono">/v1/mailboxes</code> &amp; accessed at Webmail
          </span>
        </div>
        {!hosting || hosting.mailboxes.length === 0 ? (
          <div className="p-4 text-xs text-[var(--color-text-muted)]">
            No mailboxes created on {domain.domainName} yet. Create mailboxes via <code className="font-mono">POST /v1/mailboxes</code> with catch-all or forwarding rules as needed.
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {hosting.mailboxes.map((mb) => (
              <div key={mb.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                <div>
                  <span className="font-mono font-medium text-[var(--color-text)]">{mb.emailAddress}</span>
                  {mb.isCatchAll && (
                    <Badge tone="brand" className="ml-2">
                      Catch-All
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[11px] text-[var(--color-text-muted)]">
                  <span>
                    {formatBytes(mb.usedBytes)} / {formatBytes(mb.quotaBytes)}
                  </span>
                  <Badge tone={mb.status === 'active' ? 'success' : 'danger'}>{mb.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function DomainSecurityTab({
  detail,
  onUpdateSettings,
  updating,
}: {
  detail: DomainDetailResponse;
  onUpdateSettings: (patch: DomainUpdatePatch) => void;
  updating: boolean;
}) {
  const { domain, infra, diagnostics } = detail;
  const [mtaStsMode, setMtaStsMode] = useState<'none' | 'testing' | 'enforce'>(domain.mtaStsMode ?? 'none');
  const [mtaStsMaxAge, setMtaStsMaxAge] = useState(String(domain.mtaStsMaxAge ?? 86400));
  const [tlsRptRua, setTlsRptRua] = useState(domain.tlsRptRua ?? '');
  const [bimiSelector, setBimiSelector] = useState(domain.bimiSelector ?? 'default');
  const [bimiLogoUrl, setBimiLogoUrl] = useState(domain.bimiLogoUrl ?? '');
  const [bimiVmcUrl, setBimiVmcUrl] = useState(domain.bimiVmcUrl ?? '');

  useEffect(() => {
    setMtaStsMode(domain.mtaStsMode ?? 'none');
    setMtaStsMaxAge(String(domain.mtaStsMaxAge ?? 86400));
    setTlsRptRua(domain.tlsRptRua ?? '');
    setBimiSelector(domain.bimiSelector ?? 'default');
    setBimiLogoUrl(domain.bimiLogoUrl ?? '');
    setBimiVmcUrl(domain.bimiVmcUrl ?? '');
  }, [domain]);

  const stsCheck = diagnostics.records.find((r) => r.id === 'mta-sts');
  const tlsRptCheck = diagnostics.records.find((r) => r.id === 'tls-rpt');
  const bimiCheck = diagnostics.records.find((r) => r.id === 'bimi');
  const dmarcReadyForBimi =
    (domain.dmarcPolicy === 'quarantine' || domain.dmarcPolicy === 'reject') && (domain.dmarcPct ?? 100) === 100;

  return (
    <div className="space-y-5 text-xs">
      <div>
        <h4 className="text-sm font-semibold text-[var(--color-text)]">Advanced Email Security (MTA-STS, TLS-RPT, BIMI)</h4>
        <p className="text-xs text-[var(--color-text-muted)]">
          Optional transport encryption enforcement and brand indicator policies verified directly against DNS &amp; HTTPS.
        </p>
      </div>

      {/* MTA-STS */}
      <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold text-[var(--color-text)]">
            <Lock className="h-3.5 w-3.5" /> MTA-STS (Strict Transport Security)
          </div>
          {stsCheck && <DnsStateBadge state={stsCheck.status} />}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[var(--color-text-muted)]">Policy Mode</span>
            <select
              value={mtaStsMode}
              onChange={(e) => setMtaStsMode(e.target.value as 'none' | 'testing' | 'enforce')}
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs"
            >
              <option value="none">Disabled (none)</option>
              <option value="testing">testing (Report TLS issues)</option>
              <option value="enforce">enforce (Require valid TLS)</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[var(--color-text-muted)]">max_age (seconds)</span>
            <Input type="number" min={60} value={mtaStsMaxAge} onChange={(e) => setMtaStsMaxAge(e.target.value)} />
          </label>
        </div>
        {mtaStsMode !== 'none' && (
          <pre className="rounded bg-[var(--color-surface-muted)] p-2.5 font-mono text-[11px] overflow-x-auto">
{`# Host at https://mta-sts.${domain.domainName}/.well-known/mta-sts.txt
version: STSv1
mode: ${mtaStsMode}
mx: ${infra.heloDomain}
max_age: ${Number(mtaStsMaxAge) || 86400}`}
          </pre>
        )}
      </div>

      {/* TLS-RPT */}
      <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-[var(--color-text)]">SMTP TLS Reporting (TLS-RPT)</span>
          {tlsRptCheck && <DnsStateBadge state={tlsRptCheck.status} />}
        </div>
        <label className="block space-y-1">
          <span className="text-[var(--color-text-muted)]">Report Destination (rua=)</span>
          <Input
            value={tlsRptRua}
            onChange={(e) => setTlsRptRua(e.target.value)}
            placeholder={`mailto:tlsrpt@${domain.domainName}`}
          />
        </label>
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Publish TXT at <span className="font-mono">_smtp._tls.{domain.domainName}</span>. Note: FastConnect validates the DNS record; external report aggregation is handled at the destination mailbox/endpoint.
        </p>
      </div>

      {/* BIMI */}
      <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold text-[var(--color-text)]">
            <ShieldCheck className="h-3.5 w-3.5" /> BIMI (Optional — Not Required for Verification)
          </div>
          {bimiCheck && <DnsStateBadge state={bimiCheck.status} />}
        </div>
        {!dmarcReadyForBimi && (
          <div className="flex items-start gap-2 rounded bg-[var(--color-surface-muted)] p-2 text-[11px] text-[var(--color-text-muted)]">
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              BIMI requires DMARC <span className="font-mono">p=quarantine</span> or <span className="font-mono">p=reject</span> at <span className="font-mono">pct=100</span>. Current policy: <span className="font-mono">p={domain.dmarcPolicy}; pct={domain.dmarcPct ?? 100}</span>.
            </span>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1">
            <span className="text-[var(--color-text-muted)]">Selector</span>
            <Input value={bimiSelector} onChange={(e) => setBimiSelector(e.target.value)} placeholder="default" />
          </label>
          <label className="space-y-1">
            <span className="text-[var(--color-text-muted)]">SVG Logo URL (https://)</span>
            <Input value={bimiLogoUrl} onChange={(e) => setBimiLogoUrl(e.target.value)} placeholder={`https://${domain.domainName}/logo.svg`} />
          </label>
          <label className="space-y-1">
            <span className="text-[var(--color-text-muted)]">VMC Certificate URL (optional)</span>
            <Input value={bimiVmcUrl} onChange={(e) => setBimiVmcUrl(e.target.value)} placeholder="https://..." />
          </label>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={updating}
          onClick={() =>
            onUpdateSettings({
              mtaStsMode,
              mtaStsMaxAge: Math.max(60, Number(mtaStsMaxAge) || 86400),
              tlsRptRua: tlsRptRua.trim() || null,
              bimiSelector: bimiSelector.trim() || 'default',
              bimiLogoUrl: bimiLogoUrl.trim() || null,
              bimiVmcUrl: bimiVmcUrl.trim() || null,
            })
          }
        >
          Save Security Policies
        </Button>
      </div>
    </div>
  );
}

export function DomainHistoryTab({ detail }: { detail: DomainDetailResponse }) {
  const { history, auditEvents } = detail;

  return (
    <div className="grid gap-5 lg:grid-cols-2 text-xs">
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-[var(--color-text)]">DNS Verification History</h4>
        {history.length === 0 ? (
          <div className="rounded-md border border-[var(--color-border)] p-4 text-[var(--color-text-muted)]">
            No DNS checks recorded yet. Click Re-check DNS or Run Full DNS Check.
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {history.map((h) => (
              <div key={h.id} className="rounded-md border border-[var(--color-border)] p-3 space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
                  <span>{formatShortTimestamp(h.checkedAt)}</span>
                  <div className="flex flex-wrap gap-1">
                    <DnsStateBadge state={h.spfStatus} prefix="SPF" />
                    <DnsStateBadge state={h.dkimStatus} prefix="DKIM" />
                    <DnsStateBadge state={h.dmarcStatus} prefix="DMARC" />
                    <DnsStateBadge state={h.mxStatus} prefix="MX" />
                  </div>
                </div>
                {h.changes.length > 0 && (
                  <ul className="list-disc pl-4 text-[11px] text-[var(--color-text)] space-y-0.5">
                    {h.changes.map((c, idx) => (
                      <li key={idx}>{c}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-[var(--color-text)]">Configuration Audit Log</h4>
        {auditEvents.length === 0 ? (
          <div className="rounded-md border border-[var(--color-border)] p-4 text-[var(--color-text-muted)]">
            No configuration changes recorded yet.
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {auditEvents.map((ev) => (
              <div key={ev.id} className="rounded-md border border-[var(--color-border)] p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <Badge>{ev.action}</Badge>
                  <span className="text-[11px] text-[var(--color-text-muted)]">
                    {formatShortTimestamp(ev.createdAt)}
                  </span>
                </div>
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  Actor: <span className="font-mono">{ev.actorUserId}</span>
                  {ev.actorIp ? ` • ${ev.actorIp}` : ''}
                </div>
                {Boolean(ev.afterState) && (
                  <pre className="rounded bg-[var(--color-surface-muted)] p-1.5 font-mono text-[10px] overflow-x-auto">
                    {JSON.stringify(ev.afterState)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
