import type { PlatformRole } from '@mail/shared-types';

const ADMIN_TOKEN_KEY = 'mailforge_admin_token';

export function getAdminToken(): string | null {
  return localStorage.getItem(ADMIN_TOKEN_KEY);
}

export function setAdminToken(token: string): void {
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function adminFetch<T>(path: string, init: RequestInit = {}, overrideToken?: string): Promise<T> {
  const token = overrideToken ?? getAdminToken();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, { ...init, headers });
  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const payload = (await res.json()) as { error?: { code?: string; message?: string } };
      throw new AdminApiError(
        res.status,
        payload.error?.code ?? 'API_ERROR',
        payload.error?.message ?? `Request failed (${res.status})`
      );
    }
    throw new AdminApiError(res.status, 'HTTP_ERROR', `Request failed (${res.status})`);
  }

  return (await res.json()) as T;
}

export interface AdminAuthClaims {
  sub: string;
  email: string;
  platformRole: PlatformRole;
  mfaVerified: boolean;
}

export interface ServiceProbe {
  name: 'postgres' | 'redis' | 'rabbitmq' | 'mta_cluster';
  status: 'healthy' | 'degraded' | 'unconfigured';
  latencyMs: number | null;
  detail: string;
}

export interface AuditLogItem {
  id: string;
  actorUserId: string;
  actorIp: string | null;
  organizationId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  beforeState: unknown;
  afterState: unknown;
  createdAt: string;
}

export interface AdminOverview {
  services: ServiceProbe[];
  totals: {
    organizations: number;
    suspendedOrganizations: number;
    users: number;
    domains: number;
    suspendedDomains: number;
    mtaNodes: number;
    drainingNodes: number;
    queuedMessages: number;
    dlqMessages: number;
    auditLogsCount: number;
  };
  emailTelemetry: {
    totalEvents: number;
    avgLatencyMs: number;
    counts: Record<string, number>;
  };
  recentAudits: AuditLogItem[];
}

export interface AdminOrgItem {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'pending_review';
  sendingMode: 'sandbox' | 'live';
  dailySendLimit: number;
  monthlySendLimit: number;
  defaultIpPoolId: string | null;
  createdAt: string;
}

export interface AdminUserItem {
  id: string;
  email: string;
  fullName: string;
  status: 'active' | 'suspended';
  platformRole: PlatformRole;
  orgId: string | null;
  orgRole: string | null;
  mfaEnabled: boolean;
}

export interface AdminDomainItem {
  id: string;
  organizationId: string;
  domainName: string;
  ownershipVerifiedAt: string | null;
  sendingEnabled: boolean;
  hostingEnabled: boolean;
  isSuspended: boolean;
  suspensionReason: string | null;
  dmarcPolicy: 'none' | 'quarantine' | 'reject';
}

export interface MtaNodeItem {
  id: string;
  hostname: string;
  roles: string[];
  status: 'healthy' | 'draining' | 'maintenance' | 'offline';
  controlUrl: string | null;
  activeConnections: number;
  queueLagMs: number;
  lastHeartbeatAt: string;
}

export interface QueueStatusItem {
  name: string;
  messagesReady: number;
  messagesUnacknowledged: number;
  consumers: number;
  isDlq: boolean;
  source: 'rabbitmq_management' | 'internal_outbox';
}

export interface IpPoolItem {
  id: string;
  name: string;
  poolType: 'shared_transactional' | 'shared_bulk' | 'dedicated' | 'warmup';
  isSuspended: boolean;
  createdAt: string;
}

export interface SendingIpItem {
  id: string;
  ipPoolId: string;
  ipv4Address: string;
  ptrHostname: string;
  warmupStage: number;
  dailyQuota: number;
  sentToday: number;
  reputationScore: number;
  status: 'active' | 'warming' | 'paused' | 'retired';
}

export interface ProviderRateLimitItem {
  id: string;
  ipPoolId: string | null;
  remoteDomainPattern: string;
  maxConnections: number;
  maxMsgsPerMinute: number;
  backoffMultiplier: number;
  updatedAt: string;
}

export interface SystemSettingsItem {
  id: string;
  version: number;
  config: {
    sandboxDailyCap: number;
    maxAttachmentSizeMb: number;
    autoSuspendBounceRatePct: number;
    autoSuspendComplaintRatePct: number;
    maintenanceBanner: string;
    requireTlsForInboundRelay: boolean;
  };
  updatedBy: string;
  createdAt: string;
}

export const adminApi = {
  login: (body: { email: string; password: string }) =>
    adminFetch<{
      accessToken: string;
      refreshToken: string;
      user: { id: string; email: string; fullName: string; platformRole: PlatformRole };
    }>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ ...body, appSurface: 'admin' }),
    }),

  enrollMfa: (preMfaToken: string) =>
    adminFetch<{ secret: string; otpauthUri: string; mfaEnabled: boolean }>(
      '/v1/auth/mfa/enroll',
      { method: 'POST' },
      preMfaToken
    ),

  verifyMfa: (preMfaToken: string, code: string) =>
    adminFetch<{ accessToken: string; refreshToken: string; mfaVerified: boolean }>(
      '/v1/auth/mfa/verify',
      { method: 'POST', body: JSON.stringify({ code }) },
      preMfaToken
    ),

  me: () => adminFetch<{ auth: AdminAuthClaims }>('/v1/auth/me'),
  logout: () => adminFetch<void>('/v1/auth/logout', { method: 'POST', body: '{}' }),

  getOverview: () => adminFetch<{ overview: AdminOverview }>('/admin/v1/overview'),

  listOrganizations: () => adminFetch<{ organizations: AdminOrgItem[] }>('/admin/v1/organizations'),
  updateOrganization: (
    id: string,
    patch: Partial<Pick<AdminOrgItem, 'status' | 'sendingMode' | 'dailySendLimit' | 'monthlySendLimit'>>
  ) =>
    adminFetch<{ organization: AdminOrgItem }>(`/admin/v1/organizations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  listUsers: () => adminFetch<{ users: AdminUserItem[] }>('/admin/v1/users'),
  updateUser: (id: string, patch: { status?: 'active' | 'suspended'; platformRole?: PlatformRole }) =>
    adminFetch<{ user: AdminUserItem }>(`/admin/v1/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  revokeUserSessions: (id: string) =>
    adminFetch<{ revokedCount: number }>(`/admin/v1/users/${id}/revoke-sessions`, { method: 'POST' }),

  listDomains: () => adminFetch<{ domains: AdminDomainItem[] }>('/admin/v1/domains'),
  setDomainSuspended: (id: string, isSuspended: boolean, suspensionReason: string | null) =>
    adminFetch<{ domain: AdminDomainItem }>(`/admin/v1/domains/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isSuspended, suspensionReason }),
    }),

  listNodes: () => adminFetch<{ nodes: MtaNodeItem[] }>('/admin/v1/nodes'),
  registerNode: (body: {
    id: string;
    hostname: string;
    roles: Array<'ingress' | 'outbound' | 'inbound'>;
    controlUrl: string | null;
  }) => adminFetch<{ node: MtaNodeItem }>('/admin/v1/nodes', { method: 'POST', body: JSON.stringify(body) }),
  drainNode: (id: string) => adminFetch<{ node: MtaNodeItem }>(`/admin/v1/nodes/${id}/drain`, { method: 'POST' }),
  resumeNode: (id: string) => adminFetch<{ node: MtaNodeItem }>(`/admin/v1/nodes/${id}/resume`, { method: 'POST' }),

  listQueues: () => adminFetch<{ queues: QueueStatusItem[] }>('/admin/v1/queues'),
  retryDlq: (queueName: string) =>
    adminFetch<{ requeued: number }>(`/admin/v1/queues/${encodeURIComponent(queueName)}/retry-dlq`, {
      method: 'POST',
    }),
  purgeQueue: (queueName: string) =>
    adminFetch<void>(`/admin/v1/queues/${encodeURIComponent(queueName)}/purge`, { method: 'POST' }),

  listIpPools: () =>
    adminFetch<{
      pools: IpPoolItem[];
      sendingIps: SendingIpItem[];
      providerRateLimits: ProviderRateLimitItem[];
    }>('/admin/v1/ip-pools'),
  createIpPool: (body: { name: string; poolType: IpPoolItem['poolType'] }) =>
    adminFetch<{ pool: IpPoolItem }>('/admin/v1/ip-pools', { method: 'POST', body: JSON.stringify(body) }),
  updateIpPool: (id: string, isSuspended: boolean) =>
    adminFetch<{ pool: IpPoolItem }>(`/admin/v1/ip-pools/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isSuspended }),
    }),
  addSendingIp: (body: {
    ipPoolId: string;
    ipv4Address: string;
    ptrHostname: string;
    warmupStage: number;
    dailyQuota: number;
  }) => adminFetch<{ sendingIp: SendingIpItem }>('/admin/v1/sending-ips', { method: 'POST', body: JSON.stringify(body) }),
  updateSendingIp: (
    id: string,
    patch: Partial<Pick<SendingIpItem, 'warmupStage' | 'dailyQuota' | 'status' | 'reputationScore'>>
  ) =>
    adminFetch<{ sendingIp: SendingIpItem }>(`/admin/v1/sending-ips/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  upsertProviderLimit: (body: {
    ipPoolId: string | null;
    remoteDomainPattern: string;
    maxConnections: number;
    maxMsgsPerMinute: number;
    backoffMultiplier: number;
  }) =>
    adminFetch<{ limit: ProviderRateLimitItem }>('/admin/v1/provider-rate-limits', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  getSettings: () =>
    adminFetch<{ current: SystemSettingsItem | null; history: SystemSettingsItem[] }>('/admin/v1/settings'),
  updateSettings: (config: SystemSettingsItem['config']) =>
    adminFetch<{ setting: SystemSettingsItem }>('/admin/v1/settings', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  listAuditLogs: (action?: string) =>
    adminFetch<{ auditLogs: AuditLogItem[] }>(
      action ? `/admin/v1/audit-logs?action=${encodeURIComponent(action)}` : '/admin/v1/audit-logs'
    ),
};
