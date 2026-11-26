import type { EmailEventType, SuppressionReason } from '@mail/shared-types';

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
    message: string
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
      const payload = (await res.json()) as { error?: { code?: string; message?: string } };
      throw new ApiError(
        res.status,
        payload.error?.code ?? 'API_ERROR',
        payload.error?.message ?? `Request failed (${res.status})`
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
  activeDkimSelector: string | null;
  dmarcPolicy: 'none' | 'quarantine' | 'reject';
  createdAt: string;
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
  activeVersion: number;
  versions: Array<{
    versionNumber: number;
    subject: string;
    htmlBody: string;
    textBody: string;
    createdAt: string;
  }>;
  createdAt: string;
}

export interface ContactItem {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  tags: string[];
  consentSource: string;
  consentedAt: string;
  unsubscribedAt: string | null;
}

export interface CampaignItem {
  id: string;
  domainId: string;
  templateId: string;
  name: string;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';
  timezone: string;
  scheduledAt: string | null;
  tagFilter: string | null;
  targetCount: number;
  sentCount: number;
  createdAt: string;
}

export interface SuppressionItem {
  id: string;
  email: string;
  reason: SuppressionReason;
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

  listDomains: () => apiFetch<{ domains: DomainItem[] }>('/v1/domains'),
  getDomain: (id: string) =>
    apiFetch<{ domain: DomainItem; dnsRecords: Array<{ type: string; name: string; value: string; ttl: number }> }>(
      `/v1/domains/${id}`
    ),
  createDomain: (body: { domainName: string; sendingEnabled: boolean; hostingEnabled: boolean }) =>
    apiFetch<{ domain: DomainItem }>('/v1/domains', { method: 'POST', body: JSON.stringify(body) }),
  verifyDomain: (id: string) =>
    apiFetch<{ domain: DomainItem }>(`/v1/domains/${id}/verify`, { method: 'POST' }),
  updateDomain: (
    id: string,
    patch: { sendingEnabled?: boolean; hostingEnabled?: boolean; dmarcPolicy?: 'none' | 'quarantine' | 'reject' }
  ) => apiFetch<{ domain: DomainItem }>(`/v1/domains/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

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

  listTemplates: () => apiFetch<{ templates: TemplateItem[] }>('/v1/templates'),
  createTemplate: (body: { name: string; category: string; subject: string; htmlBody: string; textBody: string }) =>
    apiFetch<{ template: TemplateItem }>('/v1/templates', { method: 'POST', body: JSON.stringify(body) }),
  duplicateTemplate: (id: string) =>
    apiFetch<{ template: TemplateItem }>(`/v1/templates/${id}/duplicate`, { method: 'POST' }),
  previewTemplate: (body: { subject: string; htmlBody: string; variables: Record<string, string> }) =>
    apiFetch<{ subject: string; htmlBody: string }>('/v1/templates/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

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
  createCampaign: (body: {
    domainId: string;
    templateId: string;
    name: string;
    timezone: string;
    scheduledAt: string | null;
    tagFilter: string | null;
  }) => apiFetch<{ campaign: CampaignItem }>('/v1/campaigns', { method: 'POST', body: JSON.stringify(body) }),
  transitionCampaign: (id: string, action: 'pause' | 'resume' | 'cancel') =>
    apiFetch<{ campaign: CampaignItem }>(`/v1/campaigns/${id}/${action}`, { method: 'POST' }),

  listSuppressions: () => apiFetch<{ suppressions: SuppressionItem[] }>('/v1/suppressions'),
  addSuppression: (body: { email: string; reason: SuppressionReason }) =>
    apiFetch<{ suppression: SuppressionItem }>('/v1/suppressions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeSuppression: (id: string) => apiFetch<void>(`/v1/suppressions/${id}`, { method: 'DELETE' }),

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
