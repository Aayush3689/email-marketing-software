import { Badge, Button, Card, EmptyState, Input } from '@mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, PauseCircle, PlayCircle, RotateCcw, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { adminApi } from '../lib/api.js';

export function NodesQueuesView() {
  const [nodeId, setNodeId] = useState('mta-local-1');
  const [hostname, setHostname] = useState('127.0.0.1');
  const [controlUrl, setControlUrl] = useState('http://127.0.0.1:9100');
  const queryClient = useQueryClient();

  const nodesQuery = useQuery({ queryKey: ['admin-nodes'], queryFn: () => adminApi.listNodes() });
  const queuesQuery = useQuery({ queryKey: ['admin-queues'], queryFn: () => adminApi.listQueues() });

  const registerNode = useMutation({
    mutationFn: () =>
      adminApi.registerNode({
        id: nodeId.trim(),
        hostname: hostname.trim(),
        roles: ['ingress', 'outbound', 'inbound'],
        controlUrl: controlUrl.trim() || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-nodes'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
      toast.success('Registered MTA node');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Node registration failed'),
  });

  const drainMutation = useMutation({
    mutationFn: (args: { id: string; drain: boolean }) =>
      args.drain ? adminApi.drainNode(args.id) : adminApi.resumeNode(args.id),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-nodes'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
      toast.success(`Node ${res.node.id} is now ${res.node.status}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Control call failed'),
  });

  const retryDlq = useMutation({
    mutationFn: (name: string) => adminApi.retryDlq(name),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-queues'] });
      toast.success(`Requeued ${res.requeued} DLQ message(s)`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'DLQ retry failed'),
  });

  const purgeQueue = useMutation({
    mutationFn: (name: string) => adminApi.purgeQueue(name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-queues'] });
      toast.success('Purged queue');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Purge failed'),
  });

  const nodes = nodesQuery.data?.nodes ?? [];
  const queues = queuesQuery.data?.queues ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text)]">
          Rust MTA Nodes &amp; RabbitMQ Queues
        </h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          Graceful connection draining via HTTP control channel and live DLQ replay/purge
        </p>
      </div>

      <Card className="p-4 space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--color-text-muted)]">
              Node ID
            </label>
            <Input value={nodeId} onChange={(e) => setNodeId(e.target.value)} className="w-40" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--color-text-muted)]">
              Hostname
            </label>
            <Input value={hostname} onChange={(e) => setHostname(e.target.value)} className="w-40" />
          </div>
          <div className="flex-1 min-w-52">
            <label className="mb-1 block text-[11px] font-medium text-[var(--color-text-muted)]">
              Rust Control / Metrics URL
            </label>
            <Input value={controlUrl} onChange={(e) => setControlUrl(e.target.value)} />
          </div>
          <Button size="sm" disabled={registerNode.isPending} onClick={() => registerNode.mutate()}>
            Register / Sync Node
          </Button>
        </div>

        {nodes.length === 0 ? (
          <EmptyState
            icon={<Server className="h-5 w-5" />}
            title="No MTA nodes registered"
            description="Register a running Rust mail-engine control URL (port 9100) to inspect connections and trigger drains."
          />
        ) : (
          <div className="space-y-2">
            {nodes.map((node) => (
              <div
                key={node.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] p-3 text-xs"
              >
                <div>
                  <div className="flex items-center gap-2 font-medium text-sm text-[var(--color-text)]">
                    <span className="font-mono">{node.id}</span>
                    <Badge
                      tone={
                        node.status === 'healthy'
                          ? 'success'
                          : node.status === 'draining'
                            ? 'warning'
                            : 'danger'
                      }
                    >
                      {node.status}
                    </Badge>
                  </div>
                  <div className="text-[var(--color-text-muted)]">
                    {node.hostname} • Roles: {node.roles.join(', ')} • Active SMTP connections:{' '}
                    {node.activeConnections}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {node.status !== 'draining' ? (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={drainMutation.isPending}
                      onClick={() => drainMutation.mutate({ id: node.id, drain: true })}
                    >
                      <PauseCircle className="h-3.5 w-3.5" /> Drain Node
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={drainMutation.isPending}
                      onClick={() => drainMutation.mutate({ id: node.id, drain: false })}
                    >
                      <PlayCircle className="h-3.5 w-3.5" /> Resume Node
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Layers className="h-4 w-4 text-[var(--color-brand)]" />
          <h3 className="text-sm font-semibold text-[var(--color-text)]">Message Broker Queues &amp; DLQs</h3>
        </div>
        <div className="space-y-2">
          {queues.map((q) => (
            <div
              key={q.name}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
            >
              <div>
                <div className="flex items-center gap-2 font-mono font-medium text-[var(--color-text)]">
                  <span>{q.name}</span>
                  {q.isDlq && <Badge tone="danger">DLQ</Badge>}
                  <Badge>{q.source}</Badge>
                </div>
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  Ready: {q.messagesReady} • Unacked: {q.messagesUnacknowledged} • Consumers: {q.consumers}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {q.isDlq && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={q.messagesReady === 0 || retryDlq.isPending}
                    onClick={() => retryDlq.mutate(q.name)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Retry DLQ
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={q.messagesReady === 0 || purgeQueue.isPending}
                  onClick={() => purgeQueue.mutate(q.name)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-red-500" /> Purge
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
