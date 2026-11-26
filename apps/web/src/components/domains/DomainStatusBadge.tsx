import type { DnsCheckState, DomainHealthStatus } from '@mail/shared-types';
import { Badge } from '@mail/ui';
import { toast } from 'sonner';

const HEALTH_META: Record<DomainHealthStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  verified: { label: 'Verified', tone: 'success' },
  pending_verification: { label: 'Pending verification', tone: 'warning' },
  dns_misconfigured: { label: 'DNS misconfigured', tone: 'danger' },
  auth_incomplete: { label: 'Auth incomplete', tone: 'warning' },
  suspended: { label: 'Suspended', tone: 'danger' },
  disabled: { label: 'Disabled', tone: 'neutral' },
};

const CHECK_META: Record<DnsCheckState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  pass: { label: 'Pass', tone: 'success' },
  warn: { label: 'Warning', tone: 'warning' },
  fail: { label: 'Failed', tone: 'danger' },
  unchecked: { label: 'Unchecked', tone: 'neutral' },
};

export function DomainHealthBadge({ status }: { status?: DomainHealthStatus | undefined }) {
  const meta = HEALTH_META[status ?? 'pending_verification'];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function DnsStateBadge({
  state,
  prefix,
}: {
  state?: DnsCheckState | undefined;
  prefix?: string | undefined;
}) {
  const meta = CHECK_META[state ?? 'unchecked'];
  return <Badge tone={meta.tone}>{prefix ? `${prefix}: ${meta.label}` : meta.label}</Badge>;
}

export function formatShortTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return 'Never';
  return dt.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export async function copyToClipboard(label: string, value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`Copied ${label}`);
  } catch {
    toast.error('Clipboard permission denied');
  }
}
