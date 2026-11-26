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

export type SuppressionReason =
  | 'hard_bounce'
  | 'complaint'
  | 'unsubscribe'
  | 'manual'
  | 'invalid_recipient'
  | 'admin';

export type SubscriberStatus =
  | 'subscribed'
  | 'unsubscribed'
  | 'bounced'
  | 'complained'
  | 'pending_confirmation';

export interface SubscriberRecord {
  id: string;
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  status: SubscriberStatus;
  tags: string[];
  tagIds?: string[];
  attributes: Record<string, string | number | boolean | null>;
  consentSource: string;
  consentedAt: string;
  unsubscribedAt: string | null;
  lastActivityAt: string | null;
  engagementScore: number;
  createdAt: string;
  updatedAt?: string;
}

export interface TagItem {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  color: string;
  subscriberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomFieldDef {
  id: string;
  organizationId: string;
  fieldKey: string;
  label: string;
  fieldType: 'text' | 'number' | 'date' | 'boolean';
  description: string;
  createdAt: string;
}

export type SegmentRuleOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'gt'
  | 'lt'
  | 'before'
  | 'after'
  | 'in_last_days'
  | 'is_empty'
  | 'is_not_empty'
  | 'has_tag'
  | 'not_has_tag'
  | 'has_any_tag'
  | 'has_all_tags'
  | 'opened_broadcast'
  | 'not_opened_broadcast'
  | 'clicked_link'
  | 'not_clicked_link';

export interface SegmentConditionRule {
  id: string;
  kind: 'rule';
  field: string;
  operator: SegmentRuleOperator;
  value?: string | string[] | number;
}

export interface SegmentConditionGroup {
  id: string;
  kind: 'group';
  matchType: 'all' | 'any';
  rules: Array<SegmentConditionRule | SegmentConditionGroup>;
}

export interface SegmentItem {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  matchType: 'all' | 'any';
  conditions: Array<SegmentConditionRule | SegmentConditionGroup>;
  subscriberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export type EmailBlockType =
  | 'heading'
  | 'text'
  | 'image'
  | 'button'
  | 'divider'
  | 'social'
  | 'footer'
  | 'columns';

export interface EmailTemplateBlock {
  id: string;
  type: EmailBlockType;
  props: Record<string, string | string[] | boolean | number>;
}

export interface AudienceSelectionSpec {
  mode: 'all' | 'filtered';
  includeTagIds?: string[];
  includeTags?: string[];
  includeSegmentIds?: string[];
  subscriberIds?: string[];
  excludeTagIds?: string[];
  excludeTags?: string[];
  excludeSegmentIds?: string[];
}

export interface AudienceEstimate {
  totalContacts: number;
  matchedBeforeExclusions: number;
  eligibleCount: number;
  excluded: {
    unsubscribed: number;
    bounced: number;
    complained: number;
    suppressed: number;
    invalidEmail: number;
    excludedByRule: number;
  };
}

export interface ContactImportJobItem {
  id: string;
  organizationId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  fileName: string | null;
  consentSource: string;
  totalRows: number;
  importedCount: number;
  updatedCount: number;
  skippedDuplicates: number;
  invalidCount: number;
  suppressedCount: number;
  missingConsentCount: number;
  failedCount: number;
  errorReport: Array<{ row: number; email: string; reason: string }>;
  createdAt: string;
  completedAt: string | null;
}

export interface SequenceStepItem {
  id: string;
  sequenceId: string;
  position: number;
  delayDays: number;
  delayHours: number;
  subject: string;
  previewText: string;
  htmlBody: string;
  textBody: string;
  blocksJson: EmailTemplateBlock[];
  enabled: boolean;
}

export interface EmailSequenceItem {
  id: string;
  organizationId: string;
  domainId: string | null;
  name: string;
  description: string;
  fromName: string;
  fromEmail: string | null;
  replyTo: string | null;
  enabled: boolean;
  allowReentry: boolean;
  exitOnUnsubscribe: boolean;
  steps: SequenceStepItem[];
  enrolledCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SequenceEnrollmentItem {
  id: string;
  sequenceId: string;
  subscriberId: string;
  subscriberEmail: string;
  currentStepIndex: number;
  status: 'active' | 'completed' | 'exited' | 'paused';
  nextSendAt: string | null;
  lastSentAt: string | null;
  exitedReason: string | null;
  enrolledAt: string;
  completedAt: string | null;
}

export type AutomationTriggerType =
  | 'tag_added'
  | 'segment_joined'
  | 'form_submitted'
  | 'landing_page_signup'
  | 'api_event';

export type AutomationNodeType =
  | 'trigger'
  | 'condition'
  | 'action_add_tag'
  | 'action_remove_tag'
  | 'action_send_email'
  | 'action_subscribe_sequence'
  | 'action_unsubscribe_sequence'
  | 'action_update_field'
  | 'delay'
  | 'end';

export interface AutomationNode {
  id: string;
  type: AutomationNodeType;
  label: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
}

export interface AutomationEdge {
  id: string;
  source: string;
  target: string;
  branch?: 'yes' | 'no' | 'next';
}

export interface AutomationItem {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  status: 'draft' | 'published' | 'paused';
  triggerType: AutomationTriggerType;
  triggerConfig: Record<string, unknown>;
  nodes: AutomationNode[];
  edges: AutomationEdge[];
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRunItem {
  id: string;
  automationId: string;
  subscriberId: string;
  subscriberEmail: string;
  currentNodeId: string | null;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  nextRunAt: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface GrowthFormItem {
  id: string;
  organizationId: string;
  name: string;
  formType: 'inline' | 'popup' | 'embedded';
  title: string;
  description: string;
  buttonText: string;
  successMessage: string;
  redirectUrl: string | null;
  consentText: string;
  doubleOptIn: boolean;
  fields: Array<{ key: string; label: string; required: boolean }>;
  tagIds: string[];
  published: boolean;
  submissionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LandingPageItem {
  id: string;
  organizationId: string;
  slug: string;
  title: string;
  headline: string;
  subheadline: string;
  bodyHtml: string;
  heroImageUrl: string | null;
  templateKey: string;
  buttonText: string;
  customDomain: string | null;
  formId: string | null;
  tagIds: string[];
  published: boolean;
  viewsCount: number;
  conversionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BroadcastAnalyticsSummary {
  campaignId: string;
  totalTargeted: number;
  eligibleRecipients: number;
  queued: number;
  sent: number;
  acceptedRemote: number;
  delivered: number;
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  bounces: number;
  complaints: number;
  unsubscribes: number;
  failed: number;
  cancelled: number;
  topLinks: Array<{ url: string; clicks: number; uniqueClicks: number }>;
  recentActivity: Array<{
    id: string;
    recipientEmail: string;
    eventType: EmailEventType;
    detail: string | null;
    occurredAt: string;
  }>;
}

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
