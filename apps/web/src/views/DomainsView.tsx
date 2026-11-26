import { AppSwitch, Badge, Button, Card, EmptyState, Input } from '@mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Globe, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, type DomainItem } from '../lib/api.js';

export function DomainsView() {
  const [domainName, setDomainName] = useState('');
  const [selected, setSelected] = useState<DomainItem | null>(null);
  const queryClient = useQueryClient();

  const domainsQuery = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.listDomains(),
  });

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      api.createDomain({ domainName: name.trim().toLowerCase(), sendingEnabled: true, hostingEnabled: true }),
    onSuccess: async (res) => {
      setDomainName('');
      setSelected(res.domain);
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast.success(`Registered ${res.domain.domainName}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Domain creation failed'),
  });

  const verifyMutation = useMutation({
    mutationFn: (id: string) => api.verifyDomain(id),
    onSuccess: async (res) => {
      setSelected(res.domain);
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast.success(`Verified ${res.domain.domainName}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Verification failed'),
  });

  const updateMutation = useMutation({
    mutationFn: (args: {
      id: string;
      patch: { sendingEnabled?: boolean; hostingEnabled?: boolean; dmarcPolicy?: 'none' | 'quarantine' | 'reject' };
    }) => api.updateDomain(args.id, args.patch),
    onSuccess: async (res) => {
      setSelected(res.domain);
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast.success('Updated domain policy');
    },
  });

  const domains = domainsQuery.data?.domains ?? [];
  const activeDomain = selected ?? domains[0] ?? null;

  const domainDetailQuery = useQuery({
    queryKey: ['domain-detail', activeDomain?.id],
    queryFn: () => api.getDomain(activeDomain!.id),
    enabled: Boolean(activeDomain?.id),
  });

  const apiDnsRecords = domainDetailQuery.data?.dnsRecords ?? [];

  const copyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
    toast.success('Copied DNS record');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text)]">Domains &amp; DNS Authentication</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Manage SPF, 2048-bit DKIM keys, DMARC policies, and inbound MX routing
          </p>
        </div>

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (domainName.trim()) createMutation.mutate(domainName);
          }}
        >
          <Input
            placeholder="mail.acme.com"
            value={domainName}
            onChange={(e) => setDomainName(e.target.value)}
            className="w-56"
          />
          <Button type="submit" disabled={createMutation.isPending}>
            Add Domain
          </Button>
        </form>
      </div>

      {domains.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Globe className="h-5 w-5" />}
            title="No domains added yet"
            description="Register your sending domain above to generate SPF, DKIM, DMARC, and ownership TXT DNS records."
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="p-3 space-y-2">
            {domains.map((dom) => (
              <button
                key={dom.id}
                type="button"
                onClick={() => setSelected(dom)}
                className={`w-full rounded-md border p-3 text-left transition-colors cursor-pointer ${
                  activeDomain?.id === dom.id
                    ? 'border-[var(--color-brand)] bg-[var(--color-surface-muted)]'
                    : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-[var(--color-text)]">{dom.domainName}</span>
                  <Badge tone={dom.ownershipVerifiedAt ? 'success' : 'warning'}>
                    {dom.ownershipVerifiedAt ? 'Verified' : 'Pending'}
                  </Badge>
                </div>
                <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  Sending: {dom.sendingEnabled ? 'On' : 'Off'} • Hosting: {dom.hostingEnabled ? 'On' : 'Off'}
                </div>
              </button>
            ))}
          </Card>

          {activeDomain && (
            <Card className="p-5 space-y-5 lg:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] pb-4">
                <div>
                  <h3 className="text-base font-semibold text-[var(--color-text)]">{activeDomain.domainName}</h3>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Active DKIM selector: <span className="font-mono">{activeDomain.activeDkimSelector ?? 'mp1'}</span>
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={activeDomain.ownershipVerifiedAt ? 'secondary' : 'primary'}
                  disabled={verifyMutation.isPending}
                  onClick={() => verifyMutation.mutate(activeDomain.id)}
                >
                  {activeDomain.ownershipVerifiedAt ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {activeDomain.ownershipVerifiedAt ? 'Re-check DNS' : 'Verify Ownership'}
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-6">
                <AppSwitch
                  checked={activeDomain.sendingEnabled}
                  label="Transactional & Campaign Sending"
                  onCheckedChange={(checked) =>
                    updateMutation.mutate({ id: activeDomain.id, patch: { sendingEnabled: checked } })
                  }
                />
                <AppSwitch
                  checked={activeDomain.hostingEnabled}
                  label="Inbound Mailbox Hosting (IMAP/LMTP)"
                  onCheckedChange={(checked) =>
                    updateMutation.mutate({ id: activeDomain.id, patch: { hostingEnabled: checked } })
                  }
                />
                <label className="flex items-center gap-2 text-xs text-[var(--color-text)]">
                  <span>DMARC Policy</span>
                  <select
                    value={activeDomain.dmarcPolicy}
                    onChange={(e) =>
                      updateMutation.mutate({
                        id: activeDomain.id,
                        patch: { dmarcPolicy: e.target.value as 'none' | 'quarantine' | 'reject' },
                      })
                    }
                    className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs"
                  >
                    <option value="none">p=none (Monitor)</option>
                    <option value="quarantine">p=quarantine</option>
                    <option value="reject">p=reject (Strict)</option>
                  </select>
                </label>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Required DNS Records
                </h4>
                {(apiDnsRecords.length > 0
                  ? apiDnsRecords.map((rec, idx) => ({
                      key: `${rec.type}-${rec.name}-${idx}`,
                      type: rec.type,
                      host: rec.name,
                      value: rec.value,
                    }))
                  : [
                      {
                        key: 'verify-fallback',
                        type: 'TXT',
                        host: `_mailplat-verify.${activeDomain.domainName}`,
                        value: activeDomain.verificationToken,
                      },
                    ]
                ).map((rec) => (
                  <div
                    key={rec.key}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <Badge>{rec.type}</Badge>
                        <span className="font-mono text-[11px] text-[var(--color-text)] truncate">{rec.host}</span>
                      </div>
                      <div className="font-mono text-[11px] text-[var(--color-text-muted)] truncate">
                        {rec.value}
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => void copyText(rec.value)}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
