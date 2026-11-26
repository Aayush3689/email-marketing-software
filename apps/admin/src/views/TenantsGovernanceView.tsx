import { AppTabs, Badge, Button, Card, EmptyState, Input } from '@mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Globe, ShieldOff, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { adminApi } from '../lib/api.js';

export function TenantsGovernanceView() {
  const [filter, setFilter] = useState('');
  const [suspendReason, setSuspendReason] = useState('Abuse complaint threshold exceeded');
  const queryClient = useQueryClient();

  const orgsQuery = useQuery({ queryKey: ['admin-orgs'], queryFn: () => adminApi.listOrganizations() });
  const usersQuery = useQuery({ queryKey: ['admin-users'], queryFn: () => adminApi.listUsers() });
  const domainsQuery = useQuery({ queryKey: ['admin-domains'], queryFn: () => adminApi.listDomains() });

  const updateOrg = useMutation({
    mutationFn: (args: {
      id: string;
      patch: { status?: 'active' | 'suspended'; sendingMode?: 'sandbox' | 'live' };
    }) => adminApi.updateOrganization(args.id, args.patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-orgs'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
      toast.success('Updated organization & logged audit diff');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update organization'),
  });

  const suspendDomain = useMutation({
    mutationFn: (args: { id: string; isSuspended: boolean }) =>
      adminApi.setDomainSuspended(args.id, args.isSuspended, args.isSuspended ? suspendReason : null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-domains'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
      toast.success('Updated domain suspension state');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed updating domain'),
  });

  const updateUser = useMutation({
    mutationFn: (args: { id: string; status: 'active' | 'suspended' }) =>
      adminApi.updateUser(args.id, { status: args.status }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success('Updated user status');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Super Admin required'),
  });

  const revokeSessions = useMutation({
    mutationFn: (id: string) => adminApi.revokeUserSessions(id),
    onSuccess: async (res) => {
      toast.success(`Revoked ${res.revokedCount} active session(s)`);
      await queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed revoking sessions'),
  });

  const q = filter.trim().toLowerCase();
  const orgs = (orgsQuery.data?.organizations ?? []).filter((o) =>
    !q ? true : o.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)
  );
  const domains = (domainsQuery.data?.domains ?? []).filter((d) =>
    !q ? true : d.domainName.toLowerCase().includes(q)
  );
  const users = (usersQuery.data?.users ?? []).filter((u) =>
    !q ? true : u.email.toLowerCase().includes(q) || u.fullName.toLowerCase().includes(q)
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text)]">
            Tenants, Domains &amp; Access Governance
          </h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Sandbox graduation, domain anti-abuse suspension, and immediate session revocation
          </p>
        </div>
        <Input
          placeholder="Filter by name, domain, email..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-64"
        />
      </div>

      <AppTabs.Root defaultValue="orgs">
        <AppTabs.List className="mb-4 inline-flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-xs">
          {[
            { value: 'orgs', label: `Organizations (${orgs.length})` },
            { value: 'domains', label: `Domains (${domains.length})` },
            { value: 'users', label: `Users & Sessions (${users.length})` },
          ].map((t) => (
            <AppTabs.Tab
              key={t.value}
              value={t.value}
              className="rounded px-3 py-1.5 font-medium text-[var(--color-text-muted)] data-[selected]:bg-[var(--color-accent)] data-[selected]:text-[var(--color-accent-fg)] cursor-pointer"
            >
              {t.label}
            </AppTabs.Tab>
          ))}
        </AppTabs.List>

        <AppTabs.Panel value="orgs">
          <Card className="p-4">
            {orgs.length === 0 ? (
              <EmptyState
                icon={<Building2 className="h-5 w-5" />}
                title="No matching organizations"
                description="Registered customer organizations appear here automatically."
              />
            ) : (
              <div className="space-y-2">
                {orgs.map((org) => (
                  <div
                    key={org.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] p-3 text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-2 font-medium text-sm text-[var(--color-text)]">
                        <span>{org.name}</span>
                        <Badge tone={org.status === 'active' ? 'success' : 'danger'}>{org.status}</Badge>
                        <Badge tone={org.sendingMode === 'live' ? 'brand' : 'warning'}>
                          {org.sendingMode}
                        </Badge>
                      </div>
                      <div className="text-[var(--color-text-muted)]">
                        ID {org.id} • Daily cap {org.dailySendLimit.toLocaleString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          updateOrg.mutate({
                            id: org.id,
                            patch: { sendingMode: org.sendingMode === 'sandbox' ? 'live' : 'sandbox' },
                          })
                        }
                      >
                        {org.sendingMode === 'sandbox' ? 'Graduate to Live' : 'Demote to Sandbox'}
                      </Button>
                      <Button
                        size="sm"
                        variant={org.status === 'active' ? 'danger' : 'secondary'}
                        onClick={() =>
                          updateOrg.mutate({
                            id: org.id,
                            patch: { status: org.status === 'active' ? 'suspended' : 'active' },
                          })
                        }
                      >
                        {org.status === 'active' ? 'Suspend Org' : 'Reactivate'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </AppTabs.Panel>

        <AppTabs.Panel value="domains" className="space-y-3">
          <Card className="p-3 flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Suspension reason:</span>
            <Input
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              className="max-w-md"
            />
          </Card>
          <Card className="p-4">
            {domains.length === 0 ? (
              <EmptyState
                icon={<Globe className="h-5 w-5" />}
                title="No domains found"
                description="Domains registered across all customer organizations appear here."
              />
            ) : (
              <div className="space-y-2">
                {domains.map((dom) => (
                  <div
                    key={dom.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] p-3 text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-2 font-medium text-sm text-[var(--color-text)]">
                        <span>{dom.domainName}</span>
                        <Badge tone={dom.isSuspended ? 'danger' : 'success'}>
                          {dom.isSuspended ? 'Suspended' : 'Active'}
                        </Badge>
                      </div>
                      <div className="text-[var(--color-text-muted)]">
                        Org {dom.organizationId.slice(0, 8)} • DMARC {dom.dmarcPolicy}
                        {dom.suspensionReason ? ` • Reason: ${dom.suspensionReason}` : ''}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={dom.isSuspended ? 'secondary' : 'danger'}
                      onClick={() => suspendDomain.mutate({ id: dom.id, isSuspended: !dom.isSuspended })}
                    >
                      {dom.isSuspended ? 'Unsuspend' : 'Suspend Domain'}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </AppTabs.Panel>

        <AppTabs.Panel value="users">
          <Card className="p-4">
            {users.length === 0 ? (
              <EmptyState
                icon={<Users className="h-5 w-5" />}
                title="No users found"
                description="Platform operators and tenant users appear here."
              />
            ) : (
              <div className="space-y-2">
                {users.map((u) => (
                  <div
                    key={u.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] p-3 text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-2 font-medium text-sm text-[var(--color-text)]">
                        <span>{u.fullName}</span>
                        <Badge tone={u.status === 'active' ? 'success' : 'danger'}>{u.status}</Badge>
                        {u.platformRole !== 'none' && <Badge tone="brand">{u.platformRole}</Badge>}
                      </div>
                      <div className="text-[var(--color-text-muted)]">
                        {u.email} • MFA {u.mfaEnabled ? 'Enrolled' : 'Not enrolled'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => revokeSessions.mutate(u.id)}
                      >
                        <ShieldOff className="h-3.5 w-3.5" /> Revoke Sessions
                      </Button>
                      <Button
                        size="sm"
                        variant={u.status === 'active' ? 'danger' : 'secondary'}
                        onClick={() =>
                          updateUser.mutate({
                            id: u.id,
                            status: u.status === 'active' ? 'suspended' : 'active',
                          })
                        }
                      >
                        {u.status === 'active' ? 'Suspend' : 'Activate'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </AppTabs.Panel>
      </AppTabs.Root>
    </div>
  );
}
