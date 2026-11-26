import type {
  AudienceEstimate,
  AudienceSelectionSpec,
  AutomationItem,
  AutomationRunItem,
  BroadcastAnalyticsSummary,
  ContactImportJobItem,
  CustomFieldDef,
  DnsCheckState,
  DnsRecordEvaluation,
  DkimKeySummary,
  DomainDeliverabilityMetrics,
  DomainDnsCheckHistoryItem,
  DomainHealthStatus,
  DomainHostingSummary,
  DomainNotification,
  EmailEventType,
  EmailSequenceItem,
  EmailTemplateBlock,
  GrowthFormItem,
  LandingPageItem,
  SegmentConditionGroup,
  SegmentConditionRule,
  SegmentItem,
  SequenceEnrollmentItem,
  SubscriberRecord,
  SubscriberStatus,
  SuppressionReason,
  TagItem,
} from '@mail/shared-types';

const TOKEN_KEY = 'mailforge_access_token';
const REFRESH_KEY = 'mailforge_refresh_token';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setStoredTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearStoredTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>
  ) {
    super(message);
  }
}

let inFlightRefresh: Promise<string | null> | null = null;

async function refreshAccessTokenSingleFlight(): Promise<string | null> {
  if (inFlightRefresh) return inFlightRefresh;
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) return null;

  inFlightRefresh = (async () => {
    try {
      const res = await fetch('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        clearStoredTokens();
        return null;
      }
      const data = (await res.json()) as { accessToken?: string; refreshToken?: string };
      if (!data.accessToken || !data.refreshToken) {
        clearStoredTokens();
        return null;
      }
      setStoredTokens(data.accessToken, data.refreshToken);
      return data.accessToken;
    } catch {
      return null;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

async function apiFetch<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && !retried && !path.startsWith('/v1/auth/')) {
    const newAccessToken = await refreshAccessTokenSingleFlight();
    if (newAccessToken) {
      return apiFetch<T>(path, init, true);
    }
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const payload = (await res.json()) as { error?: { code?: string; message?: string; [k: string]: unknown } };
      throw new ApiError(
        res.status,
        payload.error?.code ?? 'API_ERROR',
        payload.error?.message ?? `Request failed (${res.status})`,
        payload.error
      );
    }
    throw new ApiError(res.status, 'HTTP_ERROR', `Request failed (${res.status})`);
  }

  return (await res.json()) as T;
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  orgId: string | null;
  orgRole: string | null;
}

export interface DomainItem {
  id: string;
  organizationId: string;
  domainName: string;
  verificationToken: string;
  ownershipVerifiedAt: string | null;
  sendingEnabled: boolean;
  hostingEnabled: boolean;
  isSuspended: boolean;
  suspensionReason?: string | null;
  activeDkimSelector: string | null;
  dkimPolicy?: 'required' | 'optional';
  customReturnPathDomain?: string | null;
  customTrackingDomain?: string | null;
  defaultSenderLocalPart?: string | null;
  dmarcPolicy: 'none' | 'quarantine' | 'reject';
  dmarcRua?: string | null;
  dmarcRuf?: string | null;
  dmarcPct?: number;
  dmarcAspf?: 'r' | 's';
  dmarcAdkim?: 'r' | 's';
  dailySendLimit?: number | null;
  mtaStsMode?: 'none' | 'testing' | 'enforce';
  mtaStsMaxAge?: number;
  tlsRptRua?: string | null;
  bimiSelector?: string;
  bimiLogoUrl?: string | null;
  bimiVmcUrl?: string | null;
  lastDnsCheckedAt?: string | null;
  lastAuthPassedAt?: string | null;
  createdAt: string;
  healthStatus?: DomainHealthStatus;
  spfStatus?: DnsCheckState;
  dkimStatus?: DnsCheckState;
  dmarcStatus?: DnsCheckState;
  mxStatus?: DnsCheckState;
  ptrStatus?: DnsCheckState;
  mailboxCount?: number;
  warningsCount?: number;
}

export interface DomainListSummary {
  total: number;
  verified: number;
  dnsIssues: number;
  sendingEnabled: number;
  hostingEnabled: number;
}

export interface DomainAuditEventItem {
  id: string;
  actorUserId: string;
  actorIp: string | null;
  action: string;
  beforeState: unknown;
  afterState: unknown;
  createdAt: string;
}

export interface DomainDetailResponse {
  domain: DomainItem;
  dnsRecords: Array<{ type: string; host?: string; name?: string; value: string; purpose?: string; ttl?: number }>;
  diagnostics: {
    checkedAt: string | null;
    records: DnsRecordEvaluation[];
  };
  dkimKeys: DkimKeySummary[];
  deliverability: DomainDeliverabilityMetrics | null;
  hosting: DomainHostingSummary | null;
  history: DomainDnsCheckHistoryItem[];
  auditEvents: DomainAuditEventItem[];
  notifications: DomainNotification[];
  infra: {
    heloDomain: string;
    publicIp: string | null;
    spfIncludeDomain: string | null;
    trackingCnameTarget: string | null;
    mtaNodeId: string | null;
    mtaLoadedSelectors: string[];
  };
}

export interface DomainUpdatePatch {
  sendingEnabled?: boolean;
  hostingEnabled?: boolean;
  dkimPolicy?: 'required' | 'optional';
  defaultSenderLocalPart?: string | null;
  customReturnPathDomain?: string | null;
  customTrackingDomain?: string | null;
  dailySendLimit?: number | null;
  dmarcPolicy?: 'none' | 'quarantine' | 'reject';
  dmarcRua?: string | null;
  dmarcRuf?: string | null;
  dmarcPct?: number;
  dmarcAspf?: 'r' | 's';
  dmarcAdkim?: 'r' | 's';
  mtaStsMode?: 'none' | 'testing' | 'enforce';
  mtaStsMaxAge?: number;
  tlsRptRua?: string | null;
  bimiSelector?: string;
  bimiLogoUrl?: string | null;
  bimiVmcUrl?: string | null;
}

export interface ApiKeyItem {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  rateLimitRpm: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface SmtpCredentialItem {
  id: string;
  domainId: string | null;
  username: string;
  allowedSenderPatterns: string[];
  maxRatePerMin: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface TemplateItem {
  id: string;
  name: string;
  category: string;
  description?: string | undefined;
  activeVersion: number;
  archivedAt?: string | null | undefined;
  versions: Array<{
    versionNumber: number;
    subject: string;
    previewText?: string | undefined;
    htmlBody: string;
    textBody: string;
    blocksJson?: EmailTemplateBlock[] | undefined;
    createdAt: string;
  }>;
  createdAt: string;
  updatedAt?: string | undefined;
}

export type ContactItem = SubscriberRecord;

export interface SubscriberProfileResponse {
  subscriber: SubscriberRecord;
  events: Array<{ id: string; eventType: string; source: string | null; detail: unknown; createdAt: string }>;
  deliveries: Array<{ messageId: string; subject: string; state: string; createdAt: string }>;
  emailActivity: Array<{ id: string; eventType: EmailEventType; detail: string | null; createdAt: string }>;
  enrollments: SequenceEnrollmentItem[];
  automationRuns: AutomationRunItem[];
  suppression: SuppressionItem | null;
}

export interface CampaignItem {
  id: string;
  domainId: string;
  templateId: string;
  name: string;
  status: 'draft' | 'scheduled' | 'sending' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
  fromName?: string | undefined;
  fromEmail?: string | null | undefined;
  replyTo?: string | null | undefined;
  subject?: string | null | undefined;
  previewText?: string | undefined;
  htmlBody?: string | null | undefined;
  textBody?: string | null | undefined;
  blocksJson?: EmailTemplateBlock[] | undefined;
  audienceSpec?: AudienceSelectionSpec | undefined;
  timezone: string;
  scheduledAt: string | null;
  tagFilter: string | null;
  targetCount: number;
  sentCount: number;
  dispatchedAt?: string | null | undefined;
  completedAt?: string | null | undefined;
  failureReason?: string | null | undefined;
  createdAt: string;
}

export interface SuppressionItem {
  id: string;
  email: string;
  reason: SuppressionReason;
  source?: string | null | undefined;
  relatedCampaignId?: string | null | undefined;
  status?: string | undefined;
  createdAt: string;
}

export interface WebhookEndpointItem {
  id: string;
  url: string;
  secretPrefix: string;
  eventTypes: EmailEventType[];
  isActive: boolean;
  createdAt: string;
}

export interface WebhookDeliveryItem {
  id: string;
  webhookId: string;
  eventType: EmailEventType;
  attemptCount: number;
  httpStatus: number | null;
  status: 'pending' | 'delivered' | 'failed';
  createdAt: string;
}

export interface AnalyticsOverview {
  range: 'today' | 'yesterday' | '7d' | '30d' | 'custom';
  totalEvents: number;
  counts: Record<EmailEventType, number>;
  rates: {
    deliveryRate: number;
    bounceRate: number;
    openRate: number;
    clickRate: number;
  };
  avgLatencyMs: number;
  series: Array<{
    date: string;
    accepted: number;
    delivered: number;
    bounced: number;
    opened: number;
    clicked: number;
  }>;
}

export interface EmailEventItem {
  id: string;
  messageId: string;
  recipientEmail: string;
  eventType: EmailEventType;
  domain: string;
  latencyMs: number;
  detail: string | null;
  createdAt: string;
}

export interface BillingPlanItem {
  id: 'starter' | 'growth' | 'scale' | 'enterprise';
  name: string;
  monthlyPriceUsd: number;
  includedEmailsPerMonth: number;
  maxDomains: number;
  maxMailboxes: number;
  dedicatedIpIncluded: boolean;
  supportSla: string;
}

export interface SubscriptionSummary {
  subscription: {
    organizationId: string;
    planId: BillingPlanItem['id'];
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
  };
  plan: BillingPlanItem;
  monthlyEmailsSent: number;
}

export interface InvoiceItem {
  id: string;
  planId: BillingPlanItem['id'];
  amountUsd: number;
  status: 'paid' | 'open';
  issuedAt: string;
  periodLabel: string;
}

export const api = {
  register: (body: { email: string; password: string; fullName: string; organizationName: string }) =>
    apiFetch<{ accessToken: string; refreshToken: string; user: AuthUser }>('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  login: (body: { email: string; password: string }) =>
    apiFetch<{ accessToken: string; refreshToken: string; user: AuthUser }>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  me: () => apiFetch<{ user: AuthUser }>('/v1/auth/me'),
  logout: () =>
    apiFetch<void>('/v1/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: getStoredRefreshToken() }),
    }),

  listDomains: (params?: {
    search?: string | undefined;
    health?: string | undefined;
    verified?: string | undefined;
    role?: string | undefined;
    sort?: string | undefined;
  }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.health) qs.set('health', params.health);
    if (params?.verified) qs.set('verified', params.verified);
    if (params?.role) qs.set('role', params.role);
    if (params?.sort) qs.set('sort', params.sort);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<{ domains: DomainItem[]; summary?: DomainListSummary }>(`/v1/domains${suffix}`);
  },
  getDomain: (id: string) => apiFetch<DomainDetailResponse>(`/v1/domains/${id}`),
  createDomain: (body: { domainName: string; sendingEnabled: boolean; hostingEnabled: boolean }) =>
    apiFetch<{ domain: DomainItem }>('/v1/domains', { method: 'POST', body: JSON.stringify(body) }),
  verifyDomain: (id: string) =>
    apiFetch<{ domain: DomainItem; verified: boolean; ownershipMatched?: boolean; message?: string }>(
      `/v1/domains/${id}/verify`,
      { method: 'POST' }
    ),
  runDomainDiagnostics: (id: string, asyncMode = false) =>
    apiFetch<{
      domain?: DomainItem;
      check?: DomainDnsCheckHistoryItem;
      job?: { id: string; status: 'queued' | 'running' | 'completed' | 'failed'; resultCheckId: string | null; errorMessage: string | null };
    }>(`/v1/domains/${id}/diagnostics${asyncMode ? '?async=true' : ''}`, { method: 'POST' }),
  getDomainDiagnosticJob: (id: string, jobId: string) =>
    apiFetch<{ job: { id: string; status: 'queued' | 'running' | 'completed' | 'failed'; resultCheckId: string | null; errorMessage: string | null } }>(
      `/v1/domains/${id}/diagnostics/${jobId}`
    ),
  regenerateDomainToken: (id: string) =>
    apiFetch<{ domain: DomainItem }>(`/v1/domains/${id}/regenerate-token`, { method: 'POST' }),
  rotateDomainDkim: (
    id: string,
    body?: { selector?: string | undefined; algorithm?: 'rsa2048' | 'ed25519' | undefined }
  ) =>
    apiFetch<{ key: DkimKeySummary; dkimKeys: DkimKeySummary[]; mtaSynced: boolean }>(
      `/v1/domains/${id}/dkim/rotate`,
      { method: 'POST', body: JSON.stringify(body ?? {}) }
    ),
  revokeDomainDkim: (id: string, keyId: string) =>
    apiFetch<{ revoked: boolean }>(`/v1/domains/${id}/dkim/${keyId}/revoke`, { method: 'POST' }),
  updateDomain: (id: string, patch: DomainUpdatePatch) =>
    apiFetch<{ domain: DomainItem }>(`/v1/domains/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteDomain: (id: string, body: { confirmDomainName: string; confirmCleanup: boolean }) =>
    apiFetch<void>(`/v1/domains/${id}`, { method: 'DELETE', body: JSON.stringify(body) }),

  listApiKeys: () => apiFetch<{ apiKeys: ApiKeyItem[] }>('/v1/api-keys'),
  createApiKey: (body: { name: string; scopes: string[]; rateLimitRpm: number }) =>
    apiFetch<{ apiKey: ApiKeyItem; secret: string }>('/v1/api-keys', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  rotateApiKey: (id: string) =>
    apiFetch<{ apiKey: ApiKeyItem; secret: string }>(`/v1/api-keys/${id}/rotate`, { method: 'POST' }),
  revokeApiKey: (id: string) => apiFetch<void>(`/v1/api-keys/${id}`, { method: 'DELETE' }),

  listSmtpCredentials: () => apiFetch<{ credentials: SmtpCredentialItem[] }>('/v1/smtp-credentials'),
  createSmtpCredential: (body: { domainId: string | null; allowedSenderPatterns: string[]; maxRatePerMin: number }) =>
    apiFetch<{ credential: SmtpCredentialItem; secretPassword: string }>('/v1/smtp-credentials', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  rotateSmtpCredential: (id: string) =>
    apiFetch<{ credential: SmtpCredentialItem; secretPassword: string }>(`/v1/smtp-credentials/${id}/rotate`, {
      method: 'POST',
    }),
  revokeSmtpCredential: (id: string) => apiFetch<void>(`/v1/smtp-credentials/${id}`, { method: 'DELETE' }),

  listTemplates: (includeArchived = false) =>
    apiFetch<{ templates: TemplateItem[] }>(`/v1/templates${includeArchived ? '?includeArchived=true' : ''}`),
  createTemplate: (body: {
    name: string;
    category: string;
    description?: string | undefined;
    subject: string;
    previewText?: string | undefined;
    htmlBody: string;
    textBody: string;
    blocksJson?: EmailTemplateBlock[] | undefined;
  }) => apiFetch<{ template: TemplateItem }>('/v1/templates', { method: 'POST', body: JSON.stringify(body) }),
  updateTemplate: (
    id: string,
    body: {
      name?: string | undefined;
      category?: string | undefined;
      description?: string | undefined;
      archived?: boolean | undefined;
      subject?: string | undefined;
      previewText?: string | undefined;
      htmlBody?: string | undefined;
      textBody?: string | undefined;
      blocksJson?: EmailTemplateBlock[] | undefined;
    }
  ) => apiFetch<{ template: TemplateItem }>(`/v1/templates/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  duplicateTemplate: (id: string) =>
    apiFetch<{ template: TemplateItem }>(`/v1/templates/${id}/duplicate`, { method: 'POST' }),
  deleteTemplate: (id: string) => apiFetch<void>(`/v1/templates/${id}`, { method: 'DELETE' }),
  renderTemplateBlocks: (body: { blocksJson: EmailTemplateBlock[]; subject?: string | undefined; previewText?: string | undefined }) =>
    apiFetch<{ htmlBody: string; textBody: string }>('/v1/templates/render-blocks', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  previewTemplate: (body: { subject: string; htmlBody: string; variables: Record<string, string> }) =>
    apiFetch<{ subject: string; htmlBody: string }>('/v1/templates/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listSubscribers: (params?: {
    search?: string | undefined;
    status?: SubscriberStatus | undefined;
    tag?: string | undefined;
    tagId?: string | undefined;
    segmentId?: string | undefined;
    source?: string | undefined;
    customFieldKey?: string | undefined;
    customFieldValue?: string | undefined;
    sort?: 'recent' | 'oldest' | 'engagement' | 'email' | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
  }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.status) qs.set('status', params.status);
    if (params?.tag) qs.set('tag', params.tag);
    if (params?.tagId) qs.set('tagId', params.tagId);
    if (params?.segmentId) qs.set('segmentId', params.segmentId);
    if (params?.source) qs.set('source', params.source);
    if (params?.customFieldKey) qs.set('customFieldKey', params.customFieldKey);
    if (params?.customFieldValue) qs.set('customFieldValue', params.customFieldValue);
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<{ subscribers: SubscriberRecord[]; total: number; page: number; pageSize: number }>(`/v1/subscribers${suffix}`);
  },
  upsertSubscriber: (body: {
    email: string;
    firstName?: string | undefined;
    lastName?: string | undefined;
    status?: 'subscribed' | 'unsubscribed' | 'pending_confirmation' | undefined;
    tags?: string[] | undefined;
    attributes?: Record<string, string | number | boolean | null> | undefined;
    consentSource: string;
  }) => apiFetch<{ subscriber: SubscriberRecord; created: boolean }>('/v1/subscribers', { method: 'POST', body: JSON.stringify(body) }),
  getSubscriberProfile: (id: string) => apiFetch<SubscriberProfileResponse>(`/v1/subscribers/${id}`),
  updateSubscriber: (
    id: string,
    body: {
      firstName?: string | undefined;
      lastName?: string | undefined;
      attributes?: Record<string, string | number | boolean | null> | undefined;
      addTags?: string[] | undefined;
      removeTags?: string[] | undefined;
    }
  ) => apiFetch<{ subscriber: SubscriberRecord }>(`/v1/subscribers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  unsubscribeSubscriber: (id: string, reason?: string | undefined) =>
    apiFetch<{ subscriber: SubscriberRecord }>(`/v1/subscribers/${id}/unsubscribe`, {
      method: 'POST',
      body: JSON.stringify({ ...(reason ? { reason } : {}) }),
    }),
  resubscribeSubscriber: (id: string, consentSource: string) =>
    apiFetch<{ subscriber: SubscriberRecord }>(`/v1/subscribers/${id}/resubscribe`, {
      method: 'POST',
      body: JSON.stringify({ consentSource, confirmedByConsent: true }),
    }),
  deleteSubscriber: (id: string) => apiFetch<void>(`/v1/subscribers/${id}`, { method: 'DELETE' }),
  bulkSubscribersAction: (body: {
    ids: string[];
    action: 'add_tag' | 'remove_tag' | 'unsubscribe' | 'delete';
    tagName?: string | undefined;
  }) => apiFetch<{ affected: number }>('/v1/subscribers/bulk', { method: 'POST', body: JSON.stringify(body) }),
  importSubscribersCsv: (body: {
    fileName: string | null;
    consentSource: string;
    defaultTags: string[];
    fieldMapping: Record<string, string>;
    csvText: string;
  }) => apiFetch<{ job: ContactImportJobItem }>('/v1/subscribers/import-csv', { method: 'POST', body: JSON.stringify(body) }),
  listImportJobs: () => apiFetch<{ jobs: ContactImportJobItem[] }>('/v1/subscribers/import-jobs'),
  downloadSubscribersCsv: async (params?: { search?: string | undefined; status?: string | undefined; tag?: string | undefined; segmentId?: string | undefined; ids?: string[] | undefined }) => {
    const token = getStoredToken();
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.status) qs.set('status', params.status);
    if (params?.tag) qs.set('tag', params.tag);
    if (params?.segmentId) qs.set('segmentId', params.segmentId);
    if (params?.ids?.length) qs.set('ids', params.ids.join(','));
    const res = await fetch(`/v1/subscribers/export.csv${qs.toString() ? `?${qs.toString()}` : ''}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    return res.text();
  },
  downloadImportErrorsCsv: async (jobId: string) => {
    const token = getStoredToken();
    const res = await fetch(`/v1/subscribers/import-jobs/${jobId}/errors.csv`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Error report download failed (${res.status})`);
    return res.text();
  },

  listTags: () => apiFetch<{ tags: TagItem[] }>('/v1/tags'),
  createTag: (body: { name: string; description?: string | undefined; color?: string | undefined }) =>
    apiFetch<{ tag: TagItem }>('/v1/tags', { method: 'POST', body: JSON.stringify(body) }),
  updateTag: (id: string, body: { name?: string | undefined; description?: string | undefined; color?: string | undefined }) =>
    apiFetch<{ tag: TagItem }>(`/v1/tags/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTag: (id: string) => apiFetch<void>(`/v1/tags/${id}`, { method: 'DELETE' }),

  listCustomFields: () => apiFetch<{ customFields: CustomFieldDef[] }>('/v1/custom-fields'),
  createCustomField: (body: { fieldKey: string; label: string; fieldType: 'text' | 'number' | 'date' | 'boolean'; description?: string | undefined }) =>
    apiFetch<{ customField: CustomFieldDef }>('/v1/custom-fields', { method: 'POST', body: JSON.stringify(body) }),
  deleteCustomField: (id: string) => apiFetch<void>(`/v1/custom-fields/${id}`, { method: 'DELETE' }),

  listSegments: () => apiFetch<{ segments: SegmentItem[] }>('/v1/segments'),
  previewSegment: (body: { matchType: 'all' | 'any'; conditions: Array<SegmentConditionRule | SegmentConditionGroup> }) =>
    apiFetch<{ count: number; sample: SubscriberRecord[] }>('/v1/segments/preview', { method: 'POST', body: JSON.stringify(body) }),
  createSegment: (body: { name: string; description?: string | undefined; matchType: 'all' | 'any'; conditions: Array<SegmentConditionRule | SegmentConditionGroup> }) =>
    apiFetch<{ segment: SegmentItem }>('/v1/segments', { method: 'POST', body: JSON.stringify(body) }),
  updateSegment: (id: string, body: { name?: string | undefined; description?: string | undefined; matchType?: 'all' | 'any' | undefined; conditions?: Array<SegmentConditionRule | SegmentConditionGroup> | undefined }) =>
    apiFetch<{ segment: SegmentItem }>(`/v1/segments/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSegment: (id: string) => apiFetch<void>(`/v1/segments/${id}`, { method: 'DELETE' }),

  listContacts: (tag?: string) =>
    apiFetch<{ contacts: ContactItem[] }>(tag ? `/v1/contacts?tag=${encodeURIComponent(tag)}` : '/v1/contacts'),
  importContacts: (body: {
    consentSource: string;
    contacts: Array<{ email: string; firstName?: string; lastName?: string; tags?: string[] }>;
  }) =>
    apiFetch<{ imported: number; skippedSuppressed: number }>('/v1/contacts/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listCampaigns: () => apiFetch<{ campaigns: CampaignItem[] }>('/v1/campaigns'),
  estimateCampaignAudience: (spec: AudienceSelectionSpec) =>
    apiFetch<{ estimate: AudienceEstimate; sample: SubscriberRecord[] }>('/v1/campaigns/estimate-audience', {
      method: 'POST',
      body: JSON.stringify(spec),
    }),
  createCampaign: (body: {
    domainId: string;
    templateId?: string | undefined;
    name: string;
    fromName?: string | undefined;
    fromEmail?: string | null | undefined;
    replyTo?: string | null | undefined;
    subject?: string | null | undefined;
    previewText?: string | undefined;
    htmlBody?: string | null | undefined;
    textBody?: string | null | undefined;
    blocksJson?: EmailTemplateBlock[] | undefined;
    audienceSpec?: AudienceSelectionSpec | undefined;
    timezone: string;
    scheduledAt: string | null;
    tagFilter: string | null;
  }) => apiFetch<{ campaign: CampaignItem }>('/v1/campaigns', { method: 'POST', body: JSON.stringify(body) }),
  updateCampaign: (id: string, body: Record<string, unknown>) =>
    apiFetch<{ campaign: CampaignItem }>(`/v1/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCampaign: (id: string) => apiFetch<void>(`/v1/campaigns/${id}`, { method: 'DELETE' }),
  sendCampaignTest: (id: string, toEmail: string) =>
    apiFetch<{ sent: boolean; toEmail: string }>(`/v1/campaigns/${id}/send-test`, {
      method: 'POST',
      body: JSON.stringify({ toEmail }),
    }),
  getBroadcastAnalytics: (id: string) =>
    apiFetch<{ analytics: BroadcastAnalyticsSummary }>(`/v1/campaigns/${id}/analytics`),
  transitionCampaign: (id: string, action: 'pause' | 'resume' | 'start' | 'cancel') =>
    apiFetch<{
      campaign: CampaignItem;
      dispatchedCount?: number;
      cancelReport?: { cancelledCount: number; handedOffCount: number };
    }>(`/v1/campaigns/${id}/${action}`, { method: 'POST' }),

  listSuppressions: (params?: { search?: string | undefined; reason?: string | undefined }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.reason) qs.set('reason', params.reason);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<{ suppressions: SuppressionItem[] }>(`/v1/suppressions${suffix}`);
  },
  addSuppression: (body: { email: string; reason: SuppressionReason }) =>
    apiFetch<{ suppression: SuppressionItem }>('/v1/suppressions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeSuppression: (id: string) => apiFetch<void>(`/v1/suppressions/${id}`, { method: 'DELETE' }),

  listSequences: () => apiFetch<{ sequences: EmailSequenceItem[] }>('/v1/sequences'),
  createSequence: (body: Record<string, unknown>) =>
    apiFetch<{ sequence: EmailSequenceItem }>('/v1/sequences', { method: 'POST', body: JSON.stringify(body) }),
  updateSequence: (id: string, body: Record<string, unknown>) =>
    apiFetch<{ sequence: EmailSequenceItem }>(`/v1/sequences/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSequence: (id: string) => apiFetch<void>(`/v1/sequences/${id}`, { method: 'DELETE' }),
  enrollInSequence: (id: string, subscriberId: string) =>
    apiFetch<{ enrollment: SequenceEnrollmentItem }>(`/v1/sequences/${id}/enroll`, {
      method: 'POST',
      body: JSON.stringify({ subscriberId }),
    }),
  listSequenceEnrollments: (id: string) =>
    apiFetch<{ enrollments: SequenceEnrollmentItem[] }>(`/v1/sequences/${id}/enrollments`),

  listAutomations: () => apiFetch<{ automations: AutomationItem[] }>('/v1/automations'),
  createAutomation: (body: Record<string, unknown>) =>
    apiFetch<{ automation: AutomationItem }>('/v1/automations', { method: 'POST', body: JSON.stringify(body) }),
  updateAutomation: (id: string, body: Record<string, unknown>) =>
    apiFetch<{ automation: AutomationItem }>(`/v1/automations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAutomation: (id: string) => apiFetch<void>(`/v1/automations/${id}`, { method: 'DELETE' }),
  listAutomationRuns: (automationId?: string) =>
    apiFetch<{ runs: AutomationRunItem[] }>(`/v1/automations/runs${automationId ? `?automationId=${encodeURIComponent(automationId)}` : ''}`),
  triggerAutomation: (id: string, subscriberId: string) =>
    apiFetch<{ run: AutomationRunItem }>(`/v1/automations/${id}/trigger`, {
      method: 'POST',
      body: JSON.stringify({ subscriberId }),
    }),

  listForms: () => apiFetch<{ forms: GrowthFormItem[] }>('/v1/forms'),
  createForm: (body: Record<string, unknown>) =>
    apiFetch<{ form: GrowthFormItem }>('/v1/forms', { method: 'POST', body: JSON.stringify(body) }),
  updateForm: (id: string, body: Record<string, unknown>) =>
    apiFetch<{ form: GrowthFormItem }>(`/v1/forms/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteForm: (id: string) => apiFetch<void>(`/v1/forms/${id}`, { method: 'DELETE' }),

  listLandingPages: () => apiFetch<{ landingPages: LandingPageItem[] }>('/v1/landing-pages'),
  createLandingPage: (body: Record<string, unknown>) =>
    apiFetch<{ landingPage: LandingPageItem }>('/v1/landing-pages', { method: 'POST', body: JSON.stringify(body) }),
  updateLandingPage: (id: string, body: Record<string, unknown>) =>
    apiFetch<{ landingPage: LandingPageItem }>(`/v1/landing-pages/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteLandingPage: (id: string) => apiFetch<void>(`/v1/landing-pages/${id}`, { method: 'DELETE' }),

  listWebhooks: () => apiFetch<{ webhooks: WebhookEndpointItem[] }>('/v1/webhooks'),
  createWebhook: (body: { url: string; eventTypes: EmailEventType[] }) =>
    apiFetch<{ webhook: WebhookEndpointItem; signingSecret: string }>('/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  rotateWebhook: (id: string) =>
    apiFetch<{ webhook: WebhookEndpointItem; signingSecret: string }>(`/v1/webhooks/${id}/rotate`, {
      method: 'POST',
    }),
  listWebhookDeliveries: () => apiFetch<{ deliveries: WebhookDeliveryItem[] }>('/v1/webhooks/deliveries'),

  getAnalyticsOverview: (range: string) =>
    apiFetch<{ overview: AnalyticsOverview }>(`/v1/analytics/overview?range=${encodeURIComponent(range)}`),
  listAnalyticsEvents: (range: string, eventType?: string) =>
    apiFetch<{ events: EmailEventItem[] }>(
      `/v1/analytics/events?range=${encodeURIComponent(range)}${eventType ? `&eventType=${encodeURIComponent(eventType)}` : ''}`
    ),
  recordAnalyticsEvent: (body: {
    messageId: string;
    recipientEmail: string;
    eventType: EmailEventType;
    domain: string;
    latencyMs?: number;
    detail?: string;
  }) => apiFetch<{ event: EmailEventItem }>('/v1/analytics/events', { method: 'POST', body: JSON.stringify(body) }),
  downloadAnalyticsCsv: async (range: string) => {
    const token = getStoredToken();
    const res = await fetch(`/v1/analytics/export.csv?range=${encodeURIComponent(range)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    return res.text();
  },

  listBillingPlans: () => apiFetch<{ plans: BillingPlanItem[] }>('/v1/billing/plans'),
  getSubscription: () => apiFetch<SubscriptionSummary>('/v1/billing/subscription'),
  upgradePlan: (planId: BillingPlanItem['id']) =>
    apiFetch<{ subscription: SubscriptionSummary['subscription']; plan: BillingPlanItem; invoice: InvoiceItem }>(
      '/v1/billing/upgrade',
      { method: 'POST', body: JSON.stringify({ planId }) }
    ),
  listInvoices: () => apiFetch<{ invoices: InvoiceItem[] }>('/v1/billing/invoices'),
};
