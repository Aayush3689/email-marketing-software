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
