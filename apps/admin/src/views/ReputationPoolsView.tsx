import { Badge, Button, Card, EmptyState, Input } from '@mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge, Network, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { adminApi, type IpPoolItem } from '../lib/api.js';

export function ReputationPoolsView() {
  const [poolName, setPoolName] = useState('');
  const [poolType, setPoolType] = useState<IpPoolItem['poolType']>('dedicated');
  const [ipv4, setIpv4] = useState('');
  const [ptrHost, setPtrHost] = useState('mta1.mailforge.internal');
  const [domainPattern, setDomainPattern] = useState('gmail.com');
  const [maxConns, setMaxConns] = useState(4);
  const [maxPerMin, setMaxPerMin] = useState(120);

  const queryClient = useQueryClient();
  const poolsQuery = useQuery({ queryKey: ['admin-ip-pools'], queryFn: () => adminApi.listIpPools() });

  const createPool = useMutation({
    mutationFn: () => adminApi.createIpPool({ name: poolName.trim(), poolType }),
    onSuccess: async () => {
      setPoolName('');
      await queryClient.invalidateQueries({ queryKey: ['admin-ip-pools'] });
      toast.success('Created IP pool');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed creating IP pool'),
  });

  const addIp = useMutation({
    mutationFn: () => {
      const targetPool = poolsQuery.data?.pools[0]?.id;
      if (!targetPool) throw new Error('Create or select an IP pool first');
      return adminApi.addSendingIp({
        ipPoolId: targetPool,
        ipv4Address: ipv4.trim(),
        ptrHostname: ptrHost.trim(),
        warmupStage: 1,
        dailyQuota: 1000,
      });
    },
    onSuccess: async () => {
      setIpv4('');
      await queryClient.invalidateQueries({ queryKey: ['admin-ip-pools'] });
      toast.success('Added sending IP to warmup');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed adding sending IP'),
  });

  const advanceWarmup = useMutation({
    mutationFn: (args: { id: string; stage: number; quota: number }) =>
      adminApi.updateSendingIp(args.id, {
        warmupStage: Math.min(10, args.stage + 1),
        dailyQuota: args.quota * 2,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-ip-pools'] });
      toast.success('Advanced warmup stage & doubled daily quota');
    },
  });

  const saveProviderLimit = useMutation({
    mutationFn: () =>
      adminApi.upsertProviderLimit({
        ipPoolId: null,
        remoteDomainPattern: domainPattern.trim(),
        maxConnections: Number(maxConns),
        maxMsgsPerMinute: Number(maxPerMin),
        backoffMultiplier: 2,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-ip-pools'] });
      toast.success('Saved provider rate limit policy');
    },
  });

  const pools = poolsQuery.data?.pools ?? [];
  const ips = poolsQuery.data?.sendingIps ?? [];
  const limits = poolsQuery.data?.providerRateLimits ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text)]">
          IP Pools, Warmup &amp; Provider Throttles
        </h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          Manage egress IP reputation, daily warmup quotas, and per-mailbox-provider concurrency caps
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-[var(--color-brand)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text)]">Egress IP Pools</h3>
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Pool name (e.g. acme-dedicated)"
              value={poolName}
              onChange={(e) => setPoolName(e.target.value)}
            />
            <select
              value={poolType}
              onChange={(e) => setPoolType(e.target.value as IpPoolItem['poolType'])}
              className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs"
            >
              <option value="dedicated">dedicated</option>
              <option value="shared_transactional">shared_transactional</option>
              <option value="shared_bulk">shared_bulk</option>
              <option value="warmup">warmup</option>
            </select>
            <Button size="sm" onClick={() => poolName.trim() && createPool.mutate()}>
              Create
            </Button>
          </div>
          <div className="space-y-2">
            {pools.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
              >
                <div>
                  <span className="font-medium text-[var(--color-text)]">{p.name}</span>
                  <Badge className="ml-2">{p.poolType}</Badge>
                </div>
                <Badge tone={p.isSuspended ? 'danger' : 'success'}>
                  {p.isSuspended ? 'Suspended' : 'Active'}
                </Badge>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-[var(--color-brand)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text)]">Provider Rate Limits</h3>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <Input
              value={domainPattern}
              onChange={(e) => setDomainPattern(e.target.value)}
              placeholder="gmail.com"
              className="col-span-2"
            />
            <Input
              type="number"
              value={maxConns}
              onChange={(e) => setMaxConns(Number(e.target.value))}
              title="Max Connections"
            />
            <Input
              type="number"
              value={maxPerMin}
              onChange={(e) => setMaxPerMin(Number(e.target.value))}
              title="Max msgs/min"
            />
          </div>
          <Button size="sm" onClick={() => saveProviderLimit.mutate()}>
            Save Provider Policy
          </Button>
          {limits.length === 0 ? (
            <EmptyState
              icon={<Gauge className="h-5 w-5" />}
              title="No custom provider overrides"
              description="Configure domain-level concurrency and rate ceilings for Gmail, Outlook, or Yahoo."
            />
          ) : (
            <div className="space-y-1.5">
              {limits.map((l) => (
                <div
                  key={l.id}
                  className="flex items-center justify-between rounded border border-[var(--color-border)] px-3 py-2 text-xs"
                >
                  <span className="font-mono font-medium text-[var(--color-text)]">
                    {l.remoteDomainPattern}
                  </span>
                  <span className="text-[var(--color-text-muted)]">
                    {l.maxConnections} conns • {l.maxMsgsPerMinute}/min • {l.backoffMultiplier}x backoff
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-[var(--color-brand)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text)]">Sending IPs &amp; Warmup Stages</h3>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="IPv4 address (e.g. 203.0.113.25)"
            value={ipv4}
            onChange={(e) => setIpv4(e.target.value)}
            className="w-56"
          />
          <Input
            placeholder="PTR hostname"
            value={ptrHost}
            onChange={(e) => setPtrHost(e.target.value)}
            className="w-60"
          />
          <Button size="sm" onClick={() => ipv4.trim() && addIp.mutate()}>
            Provision Warmup IP
          </Button>
        </div>

        {ips.length === 0 ? (
          <EmptyState
            icon={<Network className="h-5 w-5" />}
            title="No sending IPs registered"
            description="Provision a sending IPv4 with PTR rDNS to manage progressive warmup caps."
          />
        ) : (
          <div className="space-y-2">
            {ips.map((ip) => (
              <div
                key={ip.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-border)] p-3 text-xs"
              >
                <div>
                  <div className="flex items-center gap-2 font-mono font-medium text-[var(--color-text)]">
                    <span>{ip.ipv4Address}</span>
                    <Badge tone={ip.status === 'active' ? 'success' : 'warning'}>{ip.status}</Badge>
                  </div>
                  <div className="text-[var(--color-text-muted)]">
                    PTR: {ip.ptrHostname} • Stage {ip.warmupStage}/10 • Quota {ip.dailyQuota.toLocaleString()}/day • Reputation {ip.reputationScore}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    advanceWarmup.mutate({ id: ip.id, stage: ip.warmupStage, quota: ip.dailyQuota })
                  }
                >
                  Advance Stage
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
