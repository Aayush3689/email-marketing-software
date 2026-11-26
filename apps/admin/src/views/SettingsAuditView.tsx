import { AppSwitch, Badge, Button, Card, EmptyState, Input } from '@mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileClock, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { adminApi } from '../lib/api.js';

export function SettingsAuditView() {
  const [actionFilter, setActionFilter] = useState('');
  const [sandboxCap, setSandboxCap] = useState(500);
  const [maxAttachmentMb, setMaxAttachmentMb] = useState(25);
  const [bounceThresh, setBounceThresh] = useState(5);
  const [complaintThresh, setComplaintThresh] = useState(0.2);
  const [banner, setBanner] = useState('');
  const [requireTls, setRequireTls] = useState(true);

  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => adminApi.getSettings(),
  });

  const auditQuery = useQuery({
    queryKey: ['admin-audit-logs', actionFilter],
    queryFn: () => adminApi.listAuditLogs(actionFilter.trim() || undefined),
  });

  useEffect(() => {
    const cfg = settingsQuery.data?.current?.config;
    if (cfg) {
      setSandboxCap(cfg.sandboxDailyCap);
      setMaxAttachmentMb(cfg.maxAttachmentSizeMb);
      setBounceThresh(cfg.autoSuspendBounceRatePct);
      setComplaintThresh(cfg.autoSuspendComplaintRatePct);
      setBanner(cfg.maintenanceBanner);
      setRequireTls(cfg.requireTlsForInboundRelay);
    }
  }, [settingsQuery.data?.current]);

  const saveSettings = useMutation({
    mutationFn: () =>
      adminApi.updateSettings({
        sandboxDailyCap: Number(sandboxCap),
        maxAttachmentSizeMb: Number(maxAttachmentMb),
        autoSuspendBounceRatePct: Number(bounceThresh),
        autoSuspendComplaintRatePct: Number(complaintThresh),
        maintenanceBanner: banner,
        requireTlsForInboundRelay: requireTls,
      }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-audit-logs'] });
      toast.success(`Published system_settings v${res.setting.version}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed saving settings'),
  });

  const history = settingsQuery.data?.history ?? [];
  const logs = auditQuery.data?.auditLogs ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text)]">
          System Configuration &amp; Immutable Audit Log
        </h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          Versioned platform guardrails (super_admin only) and append-only audit diffs
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-[var(--color-brand)]" />
              <h3 className="text-sm font-semibold text-[var(--color-text)]">Global System Guardrails</h3>
            </div>
            {settingsQuery.data?.current && (
              <Badge tone="brand">v{settingsQuery.data.current.version}</Badge>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <label className="space-y-1">
              <span className="text-[var(--color-text-muted)]">Sandbox Daily Cap</span>
              <Input type="number" value={sandboxCap} onChange={(e) => setSandboxCap(Number(e.target.value))} />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--color-text-muted)]">Max Attachment (MB)</span>
              <Input
                type="number"
                value={maxAttachmentMb}
                onChange={(e) => setMaxAttachmentMb(Number(e.target.value))}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--color-text-muted)]">Auto-Suspend Bounce (%)</span>
              <Input
                type="number"
                step="0.1"
                value={bounceThresh}
                onChange={(e) => setBounceThresh(Number(e.target.value))}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--color-text-muted)]">Auto-Suspend Complaint (%)</span>
              <Input
                type="number"
                step="0.01"
                value={complaintThresh}
                onChange={(e) => setComplaintThresh(Number(e.target.value))}
              />
            </label>
          </div>

          <Input
            placeholder="Global maintenance banner (optional)"
            value={banner}
            onChange={(e) => setBanner(e.target.value)}
          />

          <div className="flex items-center justify-between pt-1">
            <AppSwitch
              checked={requireTls}
              onCheckedChange={setRequireTls}
              label="Require TLS for Inbound Relay"
            />
            <Button size="sm" disabled={saveSettings.isPending} onClick={() => saveSettings.mutate()}>
              Publish New Version
            </Button>
          </div>
        </Card>

        <Card className="p-5 space-y-2">
          <h3 className="text-sm font-semibold text-[var(--color-text)]">
            Configuration Version History ({history.length})
          </h3>
          <div className="space-y-2 max-h-64 overflow-y-auto text-xs">
            {history.map((v) => (
              <div
                key={v.id}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-2.5"
              >
                <div className="flex items-center justify-between font-medium text-[var(--color-text)]">
                  <span>Version {v.version}</span>
                  <span className="text-[11px] text-[var(--color-text-muted)]">
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-[var(--color-text-muted)] font-mono">
                  sandboxCap={v.config.sandboxDailyCap}, bouncePct={v.config.autoSuspendBounceRatePct}%, complaintPct={v.config.autoSuspendComplaintRatePct}%
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileClock className="h-4 w-4 text-[var(--color-brand)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text)]">
              Append-Only Audit Trail ({logs.length})
            </h3>
          </div>
          <Input
            placeholder="Filter action (e.g. node.drained)"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="w-64"
          />
        </div>

        {logs.length === 0 ? (
          <EmptyState
            icon={<FileClock className="h-5 w-5" />}
            title="No matching audit records"
            description="All Super Admin mutations append immutable before/after JSON diffs here."
          />
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {logs.map((l) => (
              <div
                key={l.id}
                className="rounded-md border border-[var(--color-border)] p-3 text-xs space-y-1.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <Badge tone="brand">{l.action}</Badge>
                    <span className="ml-2 font-mono text-[var(--color-text)]">
                      {l.resourceType} / {l.resourceId ?? '-'}
                    </span>
                  </div>
                  <span className="text-[11px] text-[var(--color-text-muted)]">
                    Actor {l.actorUserId} • {new Date(l.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="grid gap-2 md:grid-cols-2 font-mono text-[11px]">
                  <pre className="overflow-x-auto rounded bg-[var(--color-surface-muted)] p-2 text-[var(--color-text-muted)]">
                    BEFORE: {JSON.stringify(l.beforeState)}
                  </pre>
                  <pre className="overflow-x-auto rounded bg-[var(--color-surface-muted)] p-2 text-[var(--color-text)]">
                    AFTER: {JSON.stringify(l.afterState)}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
