import type { EmailEventType } from '@mail/shared-types';
import { Badge, Button, Card, EmptyState, Input } from '@mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CreditCard, RotateCw, Webhook } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { RevealSecretDialog } from '../components/RevealSecretDialog.js';
import { api } from '../lib/api.js';

const WEBHOOK_EVENTS: EmailEventType[] = [
  'delivered',
  'deferred',
  'bounced',
  'complained',
  'unsubscribed',
  'opened',
  'clicked',
];

export function WebhooksBillingView({ mode }: { mode: 'webhooks' | 'billing' }) {
  const [url, setUrl] = useState('https://hooks.acme.com/mailforge');
  const [selectedEvents, setSelectedEvents] = useState<EmailEventType[]>(['delivered', 'bounced', 'complained']);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const webhooksQuery = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api.listWebhooks(),
    enabled: mode === 'webhooks',
  });
  const deliveriesQuery = useQuery({
    queryKey: ['webhook-deliveries'],
    queryFn: () => api.listWebhookDeliveries(),
    enabled: mode === 'webhooks',
  });
  const eventsQuery = useQuery({
    queryKey: ['analytics-events'],
    queryFn: () => api.listAnalyticsEvents('7d'),
    enabled: mode === 'webhooks',
  });

  const plansQuery = useQuery({
    queryKey: ['billing-plans'],
    queryFn: () => api.listBillingPlans(),
    enabled: mode === 'billing',
  });
  const subQuery = useQuery({
    queryKey: ['billing-subscription'],
    queryFn: () => api.getSubscription(),
    enabled: mode === 'billing',
  });
  const invoicesQuery = useQuery({
    queryKey: ['billing-invoices'],
    queryFn: () => api.listInvoices(),
    enabled: mode === 'billing',
  });

  const createWebhook = useMutation({
    mutationFn: () => api.createWebhook({ url: url.trim(), eventTypes: selectedEvents }),
    onSuccess: async (res) => {
      setRevealedSecret(res.signingSecret);
      await queryClient.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Webhook creation failed'),
  });

  const rotateWebhook = useMutation({
    mutationFn: (id: string) => api.rotateWebhook(id),
    onSuccess: async (res) => {
      setRevealedSecret(res.signingSecret);
      await queryClient.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });

  const upgradePlan = useMutation({
    mutationFn: (planId: 'starter' | 'growth' | 'scale' | 'enterprise') => api.upgradePlan(planId),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['billing-subscription'] });
      await queryClient.invalidateQueries({ queryKey: ['billing-invoices'] });
      toast.success(`Switched to ${res.plan.name} plan`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Plan update failed'),
  });

  if (mode === 'webhooks') {
    const webhooks = webhooksQuery.data?.webhooks ?? [];
    const deliveries = deliveriesQuery.data?.deliveries ?? [];
    const events = eventsQuery.data?.events ?? [];

    return (
      <div className="space-y-6">
        <RevealSecretDialog
          secret={revealedSecret}
          title="Webhook Signing Secret (Shown Once)"
          description="Verify incoming X-MailForge-Signature headers using HMAC-SHA256 over `${timestamp}.${rawBody}`."
          onClose={() => setRevealedSecret(null)}
        />

        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text)]">Webhooks &amp; Event Stream</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            HMAC-SHA256 signed event delivery with replay protection
          </p>
        </div>

        <Card className="p-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.example.com/webhooks/email"
              className="max-w-md"
            />
            <Button
              size="sm"
              disabled={createWebhook.isPending || selectedEvents.length === 0}
              onClick={() => createWebhook.mutate()}
            >
              Add Webhook Endpoint
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {WEBHOOK_EVENTS.map((ev) => {
              const active = selectedEvents.includes(ev);
              return (
                <button
                  key={ev}
                  type="button"
                  onClick={() =>
                    setSelectedEvents((curr) =>
                      curr.includes(ev) ? curr.filter((x) => x !== ev) : [...curr, ev]
                    )
                  }
                  className={`rounded-md border px-2.5 py-1 text-xs cursor-pointer ${
                    active
                      ? 'border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-[var(--color-text)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
                  }`}
                >
                  {ev}
                </button>
              );
            })}
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Registered Endpoints</h3>
            {webhooks.length === 0 ? (
              <EmptyState
                icon={<Webhook className="h-5 w-5" />}
                title="No webhooks registered"
                description="Add an HTTPS endpoint above to receive real-time bounce, delivery, and complaint events."
              />
            ) : (
              <div className="space-y-2">
                {webhooks.map((wh) => (
                  <div
                    key={wh.id}
                    className="flex items-center justify-between rounded-md border border-[var(--color-border)] p-3 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-mono font-medium text-[var(--color-text)] truncate">{wh.url}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {wh.eventTypes.map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => rotateWebhook.mutate(wh.id)}>
                      <RotateCw className="h-3.5 w-3.5" /> Rotate
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold text-[var(--color-text)]">
              Recent Event Activity ({events.length}) • Deliveries ({deliveries.length})
            </h3>
            {events.length === 0 ? (
              <EmptyState
                icon={<Webhook className="h-5 w-5" />}
                title="No recent events"
                description="Recorded delivery, open, click, bounce, and unsubscribe events appear here."
              />
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {events.slice(0, 20).map((ev) => (
                  <div
                    key={ev.id}
                    className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
                  >
                    <div>
                      <span className="font-medium text-[var(--color-text)]">{ev.recipientEmail}</span>
                      <span className="ml-2 text-[var(--color-text-muted)]">{ev.messageId}</span>
                    </div>
                    <Badge tone={ev.eventType === 'bounced' || ev.eventType === 'complained' ? 'danger' : 'success'}>
                      {ev.eventType}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    );
  }

  const plans = plansQuery.data?.plans ?? [];
  const summary = subQuery.data;
  const invoices = invoicesQuery.data?.invoices ?? [];
  const usedPct = summary
    ? Math.min(100, Math.round((summary.monthlyEmailsSent / summary.plan.includedEmailsPerMonth) * 100))
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text)]">Usage, Plans &amp; Billing</h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          Multi-tier quota tracking derived from live organization event counts
        </p>
      </div>

      {summary && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[var(--color-text)]">
                  Current Plan: {summary.plan.name}
                </span>
                <Badge tone="success">{summary.subscription.status}</Badge>
              </div>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {summary.monthlyEmailsSent.toLocaleString()} /{' '}
                {summary.plan.includedEmailsPerMonth.toLocaleString()} emails sent this cycle
              </p>
            </div>
            <div className="text-right text-sm font-semibold text-[var(--color-text)]">
              ${summary.plan.monthlyPriceUsd}/mo
            </div>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
            <div className="h-full bg-[var(--color-brand)]" style={{ width: `${usedPct}%` }} />
          </div>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((p) => {
          const isCurrent = summary?.plan.id === p.id;
          return (
            <Card key={p.id} className="flex flex-col justify-between p-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-[var(--color-text)]">{p.name}</h3>
                  {isCurrent && <Badge tone="brand">Active</Badge>}
                </div>
                <div className="text-2xl font-semibold text-[var(--color-text)]">
                  ${p.monthlyPriceUsd}
                  <span className="text-xs font-normal text-[var(--color-text-muted)]">/mo</span>
                </div>
                <ul className="space-y-1 text-xs text-[var(--color-text-muted)]">
                  <li className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                    {p.includedEmailsPerMonth.toLocaleString()} emails/mo
                  </li>
                  <li className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                    Up to {p.maxDomains} domains / {p.maxMailboxes} mailboxes
                  </li>
                  <li className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                    {p.supportSla}
                  </li>
                </ul>
              </div>
              <Button
                className="mt-4 w-full"
                size="sm"
                variant={isCurrent ? 'secondary' : 'primary'}
                disabled={isCurrent || upgradePlan.isPending}
                onClick={() => upgradePlan.mutate(p.id)}
              >
                {isCurrent ? 'Current Plan' : `Switch to ${p.name}`}
              </Button>
            </Card>
          );
        })}
      </div>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Invoice History</h3>
        {invoices.length === 0 ? (
          <EmptyState
            icon={<CreditCard className="h-5 w-5" />}
            title="No invoices yet"
            description="Plan upgrades and monthly billing statements appear here."
          />
        ) : (
          <div className="space-y-2">
            {invoices.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
              >
                <div>
                  <span className="font-mono font-medium text-[var(--color-text)]">{inv.id}</span>
                  <span className="ml-2 text-[var(--color-text-muted)]">{inv.periodLabel}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[var(--color-text)]">${inv.amountUsd}</span>
                  <Badge tone="success">{inv.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
