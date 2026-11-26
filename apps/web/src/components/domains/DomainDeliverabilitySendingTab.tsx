import { AppSwitch, Badge, Button, Input } from '@mail/ui';
import { AlertCircle, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DomainDetailResponse, DomainUpdatePatch } from '../../lib/api.js';
import { DnsStateBadge, formatShortTimestamp } from './DomainStatusBadge.js';

export function DomainDeliverabilityTab({ detail }: { detail: DomainDetailResponse }) {
  const { domain, deliverability, infra, diagnostics } = detail;
  const ptrRec = diagnostics.records.find((r) => r.id === 'ptr');
  const activeKeyInMta = infra.mtaLoadedSelectors.includes(domain.activeDkimSelector ?? 'mp1');

  return (
    <div className="space-y-5">
      <div>
        <h4 className="text-sm font-semibold text-[var(--color-text)]">Email Deliverability &amp; Reputation</h4>
        <p className="text-xs text-[var(--color-text-muted)]">
          Live authentication alignment, SMTP infrastructure signals, and 30-day delivery outcomes.
        </p>
      </div>

      {domain.sendingEnabled && !activeKeyInMta && infra.mtaNodeId && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            DKIM selector <span className="font-mono">{domain.activeDkimSelector ?? 'mp1'}</span> is configured, but Rust MTA node{' '}
            <span className="font-mono">{infra.mtaNodeId}</span> has not confirmed loading it yet (loaded:{' '}
            {infra.mtaLoadedSelectors.join(', ') || 'none'}).
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
        <div className="rounded-md border border-[var(--color-border)] p-3 space-y-1">
          <div className="text-[var(--color-text-muted)]">SPF Authentication</div>
          <DnsStateBadge state={domain.spfStatus} />
        </div>
        <div className="rounded-md border border-[var(--color-border)] p-3 space-y-1">
          <div className="text-[var(--color-text-muted)]">DKIM Signing ({domain.activeDkimSelector ?? 'mp1'})</div>
          <DnsStateBadge state={domain.dkimStatus} />
        </div>
        <div className="rounded-md border border-[var(--color-border)] p-3 space-y-1">
          <div className="text-[var(--color-text-muted)]">DMARC Alignment (p={domain.dmarcPolicy})</div>
          <DnsStateBadge state={domain.dmarcStatus} />
        </div>
        <div className="rounded-md border border-[var(--color-border)] p-3 space-y-1">
          <div className="text-[var(--color-text-muted)]">Reverse DNS (PTR)</div>
          <DnsStateBadge state={domain.ptrStatus} />
          <div className="font-mono text-[11px] text-[var(--color-text-muted)] truncate">
            {ptrRec?.detected[0] ?? 'Not verified'}
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 text-xs">
        <div className="rounded-md border border-[var(--color-border)] p-3 space-y-1.5">
          <div className="font-medium text-[var(--color-text)]">SMTP Infrastructure</div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">HELO / EHLO Hostname</span>
            <span className="font-mono text-[var(--color-text)]">{infra.heloDomain}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">Sending IP</span>
            <span className="font-mono text-[var(--color-text)]">{infra.publicIp ?? 'System default egress'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">Return-Path Domain</span>
            <span className="font-mono text-[var(--color-text)]">{domain.customReturnPathDomain || domain.domainName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">Outbound TLS</span>
            <span className="text-[var(--color-text)]">Opportunistic STARTTLS + Rustls</span>
          </div>
        </div>

        <div className="rounded-md border border-[var(--color-border)] p-3 space-y-1.5">
          <div className="font-medium text-[var(--color-text)]">30-Day Telemetry</div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">Sent / Delivered</span>
            <span className="text-[var(--color-text)]">
              {deliverability?.sent30d ?? 0} / {deliverability?.delivered30d ?? 0}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">Bounce Rate ({deliverability?.bounced30d ?? 0} bounced)</span>
            <span className="text-[var(--color-text)]">{deliverability?.bounceRatePct ?? 0}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">Complaint Rate ({deliverability?.complained30d ?? 0} FBL)</span>
            <span className="text-[var(--color-text)]">
              {deliverability?.complaintRatePct !== null && deliverability?.complaintRatePct !== undefined
                ? `${deliverability.complaintRatePct}%`
                : 'No traffic yet'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">External Reputation Feed</span>
            <Badge tone="neutral">Not integrated</Badge>
          </div>
        </div>
      </div>

      {deliverability && deliverability.recentFailures.length > 0 && (
        <div className="space-y-2">
          <h5 className="text-xs font-semibold text-[var(--color-text)]">Recent Delivery Failures</h5>
          <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[11px] text-[var(--color-text-muted)]">
                <tr>
                  <th className="px-3 py-2">Recipient</th>
                  <th className="px-3 py-2">SMTP Code</th>
                  <th className="px-3 py-2">Response</th>
                  <th className="px-3 py-2">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {deliverability.recentFailures.map((f, idx) => (
                  <tr key={idx}>
                    <td className="px-3 py-2 font-mono text-[11px]">{f.recipientEmail}</td>
                    <td className="px-3 py-2">
                      <Badge tone="danger">{f.smtpCode ?? 'ERR'} {f.enhancedCode ?? ''}</Badge>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--color-text-muted)] max-w-md truncate">
                      {f.smtpResponse ?? 'Unknown error'}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--color-text-muted)] whitespace-nowrap">
                      {formatShortTimestamp(f.attemptedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function DomainSendingConfigTab({
  detail,
  onUpdateSettings,
  updating,
}: {
  detail: DomainDetailResponse;
  onUpdateSettings: (patch: DomainUpdatePatch) => void;
  updating: boolean;
}) {
  const { domain, infra } = detail;
  const [defaultSender, setDefaultSender] = useState(domain.defaultSenderLocalPart ?? 'noreply');
  const [returnPathDomain, setReturnPathDomain] = useState(domain.customReturnPathDomain ?? '');
  const [trackingDomain, setTrackingDomain] = useState(domain.customTrackingDomain ?? '');
  const [dailyLimit, setDailyLimit] = useState(domain.dailySendLimit !== null && domain.dailySendLimit !== undefined ? String(domain.dailySendLimit) : '');

  useEffect(() => {
    setDefaultSender(domain.defaultSenderLocalPart ?? 'noreply');
    setReturnPathDomain(domain.customReturnPathDomain ?? '');
    setTrackingDomain(domain.customTrackingDomain ?? '');
    setDailyLimit(domain.dailySendLimit !== null && domain.dailySendLimit !== undefined ? String(domain.dailySendLimit) : '');
  }, [domain]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-[var(--color-text)]">Outbound Sending Configuration</h4>
          <p className="text-xs text-[var(--color-text-muted)]">
            Controls API, SMTP submission, and campaign dispatch behavior for {domain.domainName}.
          </p>
        </div>
        <AppSwitch
          checked={domain.sendingEnabled}
          label={domain.sendingEnabled ? 'Sending Enabled' : 'Sending Disabled'}
          onCheckedChange={(checked) => onUpdateSettings({ sendingEnabled: checked })}
        />
      </div>

      {!domain.ownershipVerifiedAt && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
          Domain ownership is pending verification. API and campaign sends from @{domain.domainName} are blocked until DNS ownership passes.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 text-xs">
        <label className="space-y-1">
          <span className="font-medium text-[var(--color-text)]">Default Sender Identity</span>
          <div className="flex items-center gap-1">
            <Input value={defaultSender} onChange={(e) => setDefaultSender(e.target.value)} placeholder="noreply" />
            <span className="font-mono text-[var(--color-text-muted)] shrink-0">@{domain.domainName}</span>
          </div>
        </label>

        <label className="space-y-1">
          <span className="font-medium text-[var(--color-text)]">Domain Daily Send Limit (optional)</span>
          <Input
            type="number"
            min={0}
            value={dailyLimit}
            onChange={(e) => setDailyLimit(e.target.value)}
            placeholder="Uses workspace quota if blank"
          />
        </label>

        <label className="space-y-1">
          <span className="font-medium text-[var(--color-text)]">Custom Return-Path / MAIL FROM Domain</span>
          <Input
            value={returnPathDomain}
            onChange={(e) => setReturnPathDomain(e.target.value)}
            placeholder={`bounces.${domain.domainName}`}
          />
          <span className="block text-[11px] text-[var(--color-text-muted)]">
            Requires MX → {infra.heloDomain} and SPF on the custom Return-Path subdomain.
          </span>
        </label>

        <label className="space-y-1">
          <span className="font-medium text-[var(--color-text)]">Custom Tracking Domain (CNAME)</span>
          <Input
            value={trackingDomain}
            onChange={(e) => setTrackingDomain(e.target.value)}
            placeholder={`track.${domain.domainName}`}
          />
          <span className="block text-[11px] text-[var(--color-text-muted)]">
            Target CNAME: {infra.trackingCnameTarget ?? infra.heloDomain}
          </span>
        </label>
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 p-3 text-xs flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-[var(--color-text-muted)]" />
          <span>
            Active DKIM selector: <span className="font-mono font-medium">{domain.activeDkimSelector ?? 'mp1'}</span> • MTA Node:{' '}
            <span className="font-mono">{infra.mtaNodeId ?? infra.heloDomain}</span>
          </span>
        </div>
        <Button
          size="sm"
          disabled={updating}
          onClick={() =>
            onUpdateSettings({
              defaultSenderLocalPart: defaultSender.trim() || null,
              customReturnPathDomain: returnPathDomain.trim().toLowerCase() || null,
              customTrackingDomain: trackingDomain.trim().toLowerCase() || null,
              dailySendLimit: dailyLimit.trim() === '' ? null : Math.max(0, Number(dailyLimit)),
            })
          }
        >
          Save Sending Config
        </Button>
      </div>
    </div>
  );
}
