export type PlatformRole = 'none' | 'platform_operator' | 'super_admin';

export type OrganizationRole = 'owner' | 'admin' | 'developer' | 'read_only_analyst';

export type AppSurface = 'web' | 'mail' | 'admin';

export type MessageSourceType = 'api' | 'smtp' | 'campaign' | 'webmail' | 'inbound';

export type MessageDirection = 'outbound' | 'inbound';

export type DeliveryState =
  | 'created'
  | 'queued'
  | 'processing'
  | 'accepted_remote'
  | 'deferred'
  | 'bounced'
  | 'rejected'
  | 'cancelled';

export type EmailEventType =
  | 'accepted'
  | 'delivered'
  | 'deferred'
  | 'bounced'
  | 'rejected'
  | 'complained'
  | 'unsubscribed'
  | 'opened'
  | 'clicked';

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual';

export interface OutboundDispatchJob {
  messageId: string;
  recipientId: string;
  organizationId: string;
  domainId: string | null;
  sourceType: MessageSourceType;
  envelopeFrom: string;
  recipientEmail: string;
  bodyStorageKey: string;
  ipPoolId: string | null;
  attemptNo: number;
  traceparent?: string;
}

export interface InboundDispatchJob {
  messageId: string;
  bodyStorageKey: string;
  envelopeFrom: string;
  recipients: string[];
  remoteIp: string;
  heloHost: string;
  tlsUsed: boolean;
}

export type DomainHealthStatus =
  | 'verified'
  | 'pending_verification'
  | 'dns_misconfigured'
  | 'auth_incomplete'
  | 'suspended'
  | 'disabled';

export type DnsCheckState = 'pass' | 'warn' | 'fail' | 'unchecked';

export interface DnsRecordEvaluation {
  id: string;
  category:
    | 'ownership'
    | 'spf'
    | 'dkim'
    | 'dmarc'
    | 'mx'
    | 'a'
    | 'aaaa'
    | 'ptr'
    | 'cname'
    | 'return_path'
    | 'mta_sts'
    | 'tls_rpt'
    | 'bimi';
  type: 'TXT' | 'MX' | 'A' | 'AAAA' | 'PTR' | 'CNAME' | 'HTTPS';
  host: string;
  expected: string;
  detected: string[];
  status: DnsCheckState;
  required: boolean;
  propagationStatus: 'propagated' | 'partial' | 'not_found' | 'error' | 'unchecked';
  resolver: string;
  error: string | null;
  remediation: string;
  checkedAt: string | null;
}

export interface DkimKeySummary {
  id: string;
  domainId: string;
  selector: string;
  algorithm: 'rsa2048' | 'ed25519';
  dnsRecordName: string;
  publicKeyDnsTxt: string;
  status: 'active' | 'retiring' | 'revoked';
  dnsVerified: boolean;
  mtaLoaded: boolean;
  rotatedAt: string | null;
  createdAt: string;
}

export interface DomainNotification {
  id: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  title: string;
  message: string;
  recommendedAction: string;
  targetTab: 'overview' | 'dns' | 'diagnostics' | 'deliverability' | 'sending' | 'hosting' | 'security';
}

export interface DomainDnsCheckHistoryItem {
  id: string;
  domainId: string;
  spfStatus: DnsCheckState;
  dkimStatus: DnsCheckState;
  dmarcStatus: DnsCheckState;
  mxStatus: DnsCheckState;
  ptrStatus: DnsCheckState;
  checkedAt: string;
  changes: string[];
  records: DnsRecordEvaluation[];
}

export interface DomainDeliverabilityMetrics {
  sent30d: number;
  delivered30d: number;
  deferred30d: number;
  bounced30d: number;
  complained30d: number;
  bounceRatePct: number;
  complaintRatePct: number | null;
  lastEmailActivityAt: string | null;
  lastAuthPassedAt: string | null;
  recentFailures: Array<{
    recipientEmail: string;
    smtpCode: number | null;
    enhancedCode: string | null;
    smtpResponse: string | null;
    attemptedAt: string;
  }>;
  reputationStatus: 'not_integrated';
  reputationNote: string;
}

export interface DomainHostingSummary {
  mailboxCount: number;
  activeMailboxCount: number;
  catchAllCount: number;
  totalUsedBytes: number;
  totalQuotaBytes: number;
  mailboxes: Array<{
    id: string;
    emailAddress: string;
    displayName: string;
    status: 'active' | 'suspended';
    usedBytes: number;
    quotaBytes: number;
    isCatchAll: boolean;
  }>;
  lastInboundAt: string | null;
  inboundErrors30d: number;
}
