import { randomUUID } from 'node:crypto';
import type { PlatformRole } from '@mail/shared-types';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireAuth, requireSuperAdmin } from '../auth/security.js';
import {
  probeMtaControlStatus,
  probeRedisTcp,
  type QueueStatusItem,
  type RabbitMqManagementClient,
  type ServiceProbeResult,
  setMtaDrainMode,
} from '../infra/connectors.js';
import { AppError } from '../middleware/error-handler.js';
import type { AnalyticsStore } from './analytics.js';
import type { AuthStore } from './auth.js';
import type { DomainStore } from './domains.js';
import type { ReadinessDeps } from './health.js';

export interface AdminOrganizationRecord {
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

export interface MtaNodeRecord {
  id: string;
  hostname: string;
  roles: string[];
  status: 'healthy' | 'draining' | 'maintenance' | 'offline';
  controlUrl: string | null;
  activeConnections: number;
  queueLagMs: number;
  lastHeartbeatAt: string;
}

export interface IpPoolRecord {
  id: string;
  name: string;
  poolType: 'shared_transactional' | 'shared_bulk' | 'dedicated' | 'warmup';
  isSuspended: boolean;
  createdAt: string;
}

export interface SendingIpRecord {
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

export interface ProviderRateLimitRecord {
  id: string;
  ipPoolId: string | null;
  remoteDomainPattern: string;
  maxConnections: number;
  maxMsgsPerMinute: number;
  backoffMultiplier: number;
  updatedAt: string;
}

export interface SystemSettingsVersion {
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

export interface AuditLogRecord {
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

export interface AdminInfraConfig {
  readiness: ReadinessDeps;
  pgPool?: Pool;
  redisUrl?: string;
  mtaControlToken?: string;
  rabbitMqManagement?: RabbitMqManagementClient;
}

function requireStrictSuperAdmin() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.auth?.platformRole !== 'super_admin') {
      next(new AppError(403, 'SUPER_ADMIN_ONLY', 'This privileged operation requires super_admin role'));
      return;
    }
    next();
  };
}

export class AdminControlStore {
  private readonly organizations = new Map<string, AdminOrganizationRecord>();
  private readonly nodes = new Map<string, MtaNodeRecord>();
  private readonly ipPools = new Map<string, IpPoolRecord>();
  private readonly sendingIps = new Map<string, SendingIpRecord>();
  private readonly providerLimits = new Map<string, ProviderRateLimitRecord>();
  private readonly internalQueues = new Map<string, QueueStatusItem>();
  private readonly settingsHistory: SystemSettingsVersion[] = [];
  private readonly auditLogs: AuditLogRecord[] = [];

  constructor(
    private readonly deps: {
      authStore: AuthStore;
      domainStore: DomainStore;
      analyticsStore: AnalyticsStore;
      infra: AdminInfraConfig;
    }
  ) {
    const txPoolId = randomUUID();
    const bulkPoolId = randomUUID();
    this.ipPools.set(txPoolId, {
      id: txPoolId,
      name: 'shared-transactional-primary',
      poolType: 'shared_transactional',
      isSuspended: false,
      createdAt: new Date().toISOString(),
    });
    this.ipPools.set(bulkPoolId, {
      id: bulkPoolId,
      name: 'shared-bulk-primary',
      poolType: 'shared_bulk',
      isSuspended: false,
      createdAt: new Date().toISOString(),
    });

    this.settingsHistory.push({
      id: randomUUID(),
      version: 1,
      config: {
        sandboxDailyCap: 500,
        maxAttachmentSizeMb: 25,
        autoSuspendBounceRatePct: 5,
        autoSuspendComplaintRatePct: 0.2,
        maintenanceBanner: '',
        requireTlsForInboundRelay: true,
      },
      updatedBy: 'system',
      createdAt: new Date().toISOString(),
    });

    for (const qName of [
      'mail.outbound.transactional',
      'mail.outbound.bulk',
      'mail.outbound.retry',
      'mail.outbound.transactional.dlq',
      'mail.outbound.bulk.dlq',
      'mail.inbound.delivery',
    ]) {
      this.internalQueues.set(qName, {
        name: qName,
        messagesReady: 0,
        messagesUnacknowledged: 0,
        consumers: 0,
        isDlq: qName.endsWith('.dlq'),
        source: 'internal_outbox',
      });
    }
  }

  recordAudit(entry: Omit<AuditLogRecord, 'id' | 'createdAt'>): AuditLogRecord {
    const rec: AuditLogRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...entry,
    };
    this.auditLogs.unshift(rec);
    if (this.auditLogs.length > 2000) this.auditLogs.length = 2000;

    const pool = this.deps.infra?.pgPool;
    if (pool) {
      const uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const actorUuid = entry.actorUserId && uuidRx.test(entry.actorUserId) ? entry.actorUserId : null;
      const resourceUuid = entry.resourceId && uuidRx.test(entry.resourceId) ? entry.resourceId : randomUUID();
      void pool
        .query(
          `INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, metadata, ip_address)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            uuidRx.test(rec.id) ? rec.id : randomUUID(),
            actorUuid,
            entry.action,
            entry.resourceType,
            resourceUuid,
            JSON.stringify({ resourceId: entry.resourceId, before: entry.beforeState, after: entry.afterState }),
            entry.actorIp,
          ]
        )
        .catch(() => undefined);
    }
    return rec;
  }

  async hydrateFromPostgres(): Promise<void> {
    const pool = this.deps.infra?.pgPool;
    if (!pool) return;
    try {
      const orgRes = await pool.query(
        `SELECT id::text, name, slug, status, sending_mode, daily_send_limit, monthly_send_limit, default_ip_pool_id::text, created_at
           FROM organizations WHERE status != 'deleted' ORDER BY created_at DESC`
      );
      for (const r of orgRes.rows) {
        this.organizations.set(r.id, {
          id: r.id,
          name: r.name,
          slug: r.slug,
          status: r.status === 'suspended' ? 'suspended' : 'active',
          sendingMode: r.sending_mode === 'live' ? 'live' : 'sandbox',
          dailySendLimit: Number(r.daily_send_limit),
          monthlySendLimit: Number(r.monthly_send_limit),
          defaultIpPoolId: r.default_ip_pool_id ?? null,
          createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        });
      }

      const logRes = await pool.query(
        `SELECT id::text, actor_user_id::text, organization_id::text, action, resource_type, resource_id::text, metadata, ip_address::text, created_at
           FROM audit_logs ORDER BY created_at DESC LIMIT 200`
      );
      if (logRes.rows.length > 0) {
        this.auditLogs.length = 0;
        for (const r of logRes.rows) {
          const meta = (r.metadata ?? {}) as { resourceId?: string | null; before?: unknown; after?: unknown };
          this.auditLogs.push({
            id: r.id,
            actorUserId: r.actor_user_id ?? 'system',
            actorIp: r.ip_address ?? null,
            organizationId: r.organization_id ?? null,
            action: r.action,
            resourceType: r.resource_type,
            resourceId: meta.resourceId ?? r.resource_id ?? null,
            beforeState: meta.before ?? null,
            afterState: meta.after ?? null,
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          });
        }
      }
    } catch {
      // Allow booting cleanly if tables have not finished initializing yet
    }
  }

  listAuditLogs(filters: { action?: string; resourceType?: string }): AuditLogRecord[] {
    return this.auditLogs.filter((log) => {
      if (filters.action && !log.action.includes(filters.action)) return false;
      if (filters.resourceType && log.resourceType !== filters.resourceType) return false;
      return true;
    });
  }

  upsertOrganization(org: AdminOrganizationRecord): void {
    if (!this.organizations.has(org.id)) {
      this.organizations.set(org.id, org);
    }
  }

  async listOrganizations(): Promise<AdminOrganizationRecord[]> {
    if (this.deps.infra?.pgPool) {
      await this.hydrateFromPostgres();
    }
    // Sync any newly registered users' orgs from AuthStore cleanly
    if (this.deps.authStore.listUsers) {
      const users = await this.deps.authStore.listUsers();
      for (const u of users) {
        if (u.orgId && !this.organizations.has(u.orgId)) {
          this.organizations.set(u.orgId, {
            id: u.orgId,
            name: `${u.fullName} Org`,
            slug: u.orgId.slice(0, 8),
            status: u.status === 'suspended' ? 'suspended' : 'active',
            sendingMode: 'sandbox',
            dailySendLimit: 500,
            monthlySendLimit: 10_000,
            defaultIpPoolId: [...this.ipPools.keys()][0] ?? null,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
    return [...this.organizations.values()];
  }

  async updateOrganization(
    id: string,
    patch: Partial<Pick<AdminOrganizationRecord, 'status' | 'sendingMode' | 'dailySendLimit' | 'monthlySendLimit' | 'defaultIpPoolId'>>,
    actor: { userId: string; ip: string | null }
  ): Promise<AdminOrganizationRecord> {
    await this.listOrganizations();
    const existing = this.organizations.get(id);
    if (!existing) throw new AppError(404, 'ORG_NOT_FOUND', 'Organization not found');
    const before = { ...existing };

    if (patch.status !== undefined) existing.status = patch.status;
    if (patch.sendingMode !== undefined) existing.sendingMode = patch.sendingMode;
    if (patch.dailySendLimit !== undefined) existing.dailySendLimit = patch.dailySendLimit;
    const pool = this.deps.infra?.pgPool;
    if (pool) {
      await pool.query(
        `UPDATE organizations
            SET status = COALESCE($2, status),
                sending_mode = COALESCE($3, sending_mode),
                daily_send_limit = COALESCE($4, daily_send_limit),
                monthly_send_limit = COALESCE($5, monthly_send_limit),
                default_ip_pool_id = COALESCE($6, default_ip_pool_id),
                updated_at = NOW()
          WHERE id = $1`,
        [
          id,
          patch.status ?? null,
          patch.sendingMode ?? null,
          patch.dailySendLimit ?? null,
          patch.monthlySendLimit ?? null,
          patch.defaultIpPoolId ?? null,
        ]
      );
    }
    if (patch.monthlySendLimit !== undefined) existing.monthlySendLimit = patch.monthlySendLimit;
    if (patch.defaultIpPoolId !== undefined) existing.defaultIpPoolId = patch.defaultIpPoolId;

    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: id,
      action: 'admin.organization.updated',
      resourceType: 'organization',
      resourceId: id,
      beforeState: before,
      afterState: { ...existing },
    });
    return existing;
  }

  async listUsers() {
    const users = this.deps.authStore.listUsers ? await this.deps.authStore.listUsers() : [];
    return users.map(({ passwordHash: _p, totpSecret: _t, ...pub }) => pub);
  }

  async updateUser(
    userId: string,
    patch: { status?: 'active' | 'suspended'; platformRole?: PlatformRole },
    actor: { userId: string; ip: string | null }
  ) {
    if (!this.deps.authStore.updateUser) {
      throw new AppError(501, 'NOT_SUPPORTED', 'AuthStore does not support user mutation');
    }
    const existing = await this.deps.authStore.findUserById(userId);
    if (!existing) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    const before = { status: existing.status, platformRole: existing.platformRole };
    const updated = await this.deps.authStore.updateUser(userId, patch);
    if (!updated) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: updated.orgId,
      action: 'admin.user.updated',
      resourceType: 'user',
      resourceId: userId,
      beforeState: before,
      afterState: { status: updated.status, platformRole: updated.platformRole },
    });

    const { passwordHash: _p, totpSecret: _t, ...pub } = updated;
    return pub;
  }

  async revokeUserSessions(userId: string, actor: { userId: string; ip: string | null }): Promise<number> {
    const user = await this.deps.authStore.findUserById(userId);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    const revokedCount = this.deps.authStore.revokeUserSessions
      ? await this.deps.authStore.revokeUserSessions(userId)
      : 0;
    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: user.orgId,
      action: 'admin.user.sessions_revoked',
      resourceType: 'user_sessions',
      resourceId: userId,
      beforeState: { active: true },
      afterState: { revokedCount },
    });
    return revokedCount;
  }

  async listAllDomains() {
    return this.deps.domainStore.listAllDomains ? await this.deps.domainStore.listAllDomains() : [];
  }

  async setDomainSuspended(
    domainId: string,
    isSuspended: boolean,
    reason: string | null,
    actor: { userId: string; ip: string | null }
  ) {
    if (!this.deps.domainStore.adminSetSuspended || !this.deps.domainStore.listAllDomains) {
      throw new AppError(501, 'NOT_SUPPORTED', 'DomainStore does not support admin suspension');
    }
    const all = await this.deps.domainStore.listAllDomains();
    const existing = all.find((d) => d.id === domainId);
    if (!existing) throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found');
    const before = { isSuspended: existing.isSuspended, suspensionReason: existing.suspensionReason };

    const updated = await this.deps.domainStore.adminSetSuspended(domainId, isSuspended, reason);
    if (!updated) throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found');

    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: updated.organizationId,
      action: isSuspended ? 'admin.domain.suspended' : 'admin.domain.unsuspended',
      resourceType: 'domain',
      resourceId: domainId,
      beforeState: before,
      afterState: { isSuspended: updated.isSuspended, suspensionReason: updated.suspensionReason },
    });
    return updated;
  }

  registerNode(
    input: { id: string; hostname: string; roles: string[]; controlUrl: string | null },
    actor: { userId: string; ip: string | null }
  ): MtaNodeRecord {
    const existing = this.nodes.get(input.id);
    const node: MtaNodeRecord = {
      id: input.id,
      hostname: input.hostname,
      roles: input.roles,
      status: existing?.status ?? 'healthy',
      controlUrl: input.controlUrl,
      activeConnections: existing?.activeConnections ?? 0,
      queueLagMs: existing?.queueLagMs ?? 0,
      lastHeartbeatAt: new Date().toISOString(),
    };
    this.nodes.set(node.id, node);
    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: null,
      action: 'admin.node.registered',
      resourceType: 'mta_node',
      resourceId: node.id,
      beforeState: existing ? { ...existing } : null,
      afterState: { ...node },
    });
    return node;
  }

  async listNodes(): Promise<MtaNodeRecord[]> {
    const out: MtaNodeRecord[] = [];
    for (const node of this.nodes.values()) {
      if (node.controlUrl) {
        try {
          const live = await probeMtaControlStatus(node.controlUrl, this.deps.infra.mtaControlToken);
          node.activeConnections = live.activeConnections;
          node.status = live.draining ? 'draining' : 'healthy';
          node.lastHeartbeatAt = new Date().toISOString();
        } catch {
          node.status = 'offline';
        }
      }
      out.push(node);
    }
    return out;
  }

  async setNodeDrain(
    nodeId: string,
    drain: boolean,
    actor: { userId: string; ip: string | null }
  ): Promise<MtaNodeRecord> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'MTA node not found');
    const before = { ...node };

    if (node.controlUrl) {
      const live = await setMtaDrainMode(node.controlUrl, drain, this.deps.infra.mtaControlToken);
      node.status = live.draining ? 'draining' : 'healthy';
    } else {
      node.status = drain ? 'draining' : 'healthy';
    }
    node.lastHeartbeatAt = new Date().toISOString();

    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: null,
      action: drain ? 'admin.node.drained' : 'admin.node.resumed',
      resourceType: 'mta_node',
      resourceId: nodeId,
      beforeState: before,
      afterState: { ...node },
    });
    return node;
  }

  seedInternalQueueDepth(queueName: string, messagesReady: number): void {
    const q = this.internalQueues.get(queueName);
    if (q) {
      q.messagesReady = messagesReady;
    } else {
      this.internalQueues.set(queueName, {
        name: queueName,
        messagesReady,
        messagesUnacknowledged: 0,
        consumers: 0,
        isDlq: queueName.endsWith('.dlq'),
        source: 'internal_outbox',
      });
    }
  }

  async listQueues(): Promise<QueueStatusItem[]> {
    if (this.deps.infra.rabbitMqManagement) {
      try {
        return await this.deps.infra.rabbitMqManagement.listQueues();
      } catch {
        // Fall back to tracked queue store if RabbitMQ Management endpoint is offline
      }
    }
    return [...this.internalQueues.values()];
  }

  async retryDlq(queueName: string, actor: { userId: string; ip: string | null }): Promise<{ requeued: number }> {
    if (!queueName.endsWith('.dlq')) {
      throw new AppError(400, 'NOT_A_DLQ', 'Only dead-letter queues ending in .dlq can be retried');
    }
    if (this.deps.infra.rabbitMqManagement) {
      try {
        const requeued = await this.deps.infra.rabbitMqManagement.requeueDlq(queueName);
        this.recordAudit({
          actorUserId: actor.userId,
          actorIp: actor.ip,
          organizationId: null,
          action: 'admin.queue.dlq_retried',
          resourceType: 'rabbitmq_queue',
          resourceId: queueName,
          beforeState: { queueName },
          afterState: { requeued, source: 'rabbitmq_management' },
        });
        return { requeued };
      } catch (err) {
        if (!this.internalQueues.has(queueName)) {
          throw new AppError(
            502,
            'RABBITMQ_UNREACHABLE',
            err instanceof Error ? err.message : 'Failed communicating with RabbitMQ'
          );
        }
      }
    }

    const dlq = this.internalQueues.get(queueName);
    if (!dlq) throw new AppError(404, 'QUEUE_NOT_FOUND', 'Dead-letter queue not found');
    const targetName = queueName.replace(/\.dlq$/, '');
    const target = this.internalQueues.get(targetName);
    const moved = dlq.messagesReady;
    dlq.messagesReady = 0;
    if (target) {
      target.messagesReady += moved;
    }
    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: null,
      action: 'admin.queue.dlq_retried',
      resourceType: 'rabbitmq_queue',
      resourceId: queueName,
      beforeState: { messagesReady: moved },
      afterState: { messagesReady: 0, targetQueue: targetName, requeued: moved },
    });
    return { requeued: moved };
  }

  async purgeQueue(queueName: string, actor: { userId: string; ip: string | null }): Promise<void> {
    if (this.deps.infra.rabbitMqManagement) {
      try {
        await this.deps.infra.rabbitMqManagement.purgeQueue(queueName);
        this.recordAudit({
          actorUserId: actor.userId,
          actorIp: actor.ip,
          organizationId: null,
          action: 'admin.queue.purged',
          resourceType: 'rabbitmq_queue',
          resourceId: queueName,
          beforeState: { queueName },
          afterState: { purged: true, source: 'rabbitmq_management' },
        });
        return;
      } catch (err) {
        if (!this.internalQueues.has(queueName)) {
          throw new AppError(
            502,
            'RABBITMQ_UNREACHABLE',
            err instanceof Error ? err.message : 'Failed purging RabbitMQ queue'
          );
        }
      }
    }

    const q = this.internalQueues.get(queueName);
    if (!q) throw new AppError(404, 'QUEUE_NOT_FOUND', 'Queue not found');
    const prev = q.messagesReady;
    q.messagesReady = 0;
    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: null,
      action: 'admin.queue.purged',
      resourceType: 'rabbitmq_queue',
      resourceId: queueName,
      beforeState: { messagesReady: prev },
      afterState: { messagesReady: 0 },
    });
  }

  listIpPools() {
    return {
      pools: [...this.ipPools.values()],
      sendingIps: [...this.sendingIps.values()],
      providerRateLimits: [...this.providerLimits.values()],
    };
  }

  createIpPool(
    input: { name: string; poolType: IpPoolRecord['poolType'] },
    actor: { userId: string; ip: string | null }
  ): IpPoolRecord {
    const rec: IpPoolRecord = {
      id: randomUUID(),
      name: input.name,
      poolType: input.poolType,
      isSuspended: false,
      createdAt: new Date().toISOString(),
    };
    this.ipPools.set(rec.id, rec);
    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: null,
      action: 'admin.ip_pool.created',
      resourceType: 'ip_pool',
      resourceId: rec.id,
      beforeState: null,
      afterState: { ...rec },
    });
    return rec;
  }

  updateIpPool(id: string, isSuspended: boolean, actor: { userId: string; ip: string | null }): IpPoolRecord {
    const pool = this.ipPools.get(id);
    if (!pool) throw new AppError(404, 'IP_POOL_NOT_FOUND', 'IP pool not found');
    const before = { ...pool };
    pool.isSuspended = isSuspended;
    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: null,
      action: 'admin.ip_pool.updated',
      resourceType: 'ip_pool',
      resourceId: id,
      beforeState: before,
      afterState: { ...pool },
    });
    return pool;
  }

  addSendingIp(
    input: { ipPoolId: string; ipv4Address: string; ptrHostname: string; warmupStage: number; dailyQuota: number },
    actor: { userId: string; ip: string | null }
  ): SendingIpRecord {
    if (!this.ipPools.has(input.ipPoolId)) {
      throw new AppError(404, 'IP_POOL_NOT_FOUND', 'Target IP pool not found');
    }
    const rec: SendingIpRecord = {
      id: randomUUID(),
      ipPoolId: input.ipPoolId,
      ipv4Address: input.ipv4Address,
      ptrHostname: input.ptrHostname,
      warmupStage: input.warmupStage,
      dailyQuota: input.dailyQuota,
      sentToday: 0,
      reputationScore: 100,
      status: 'warming',
    };
    this.sendingIps.set(rec.id, rec);
    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: null,
      action: 'admin.sending_ip.added',
      resourceType: 'sending_ip',
      resourceId: rec.id,
      beforeState: null,
      afterState: { ...rec },
    });
    return rec;
  }

  updateSendingIp(
    id: string,
    patch: Partial<Pick<SendingIpRecord, 'warmupStage' | 'dailyQuota' | 'status' | 'reputationScore'>>,
    actor: { userId: string; ip: string | null }
  ): SendingIpRecord {
    const ip = this.sendingIps.get(id);
    if (!ip) throw new AppError(404, 'SENDING_IP_NOT_FOUND', 'Sending IP not found');
    const before = { ...ip };
    if (patch.warmupStage !== undefined) ip.warmupStage = patch.warmupStage;
    if (patch.dailyQuota !== undefined) ip.dailyQuota = patch.dailyQuota;
    if (patch.status !== undefined) ip.status = patch.status;
    if (patch.reputationScore !== undefined) ip.reputationScore = patch.reputationScore;

    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: null,
      action: 'admin.sending_ip.updated',
      resourceType: 'sending_ip',
      resourceId: id,
      beforeState: before,
      afterState: { ...ip },
    });
    return ip;
  }

  upsertProviderRateLimit(
    input: {
      ipPoolId: string | null;
      remoteDomainPattern: string;
      maxConnections: number;
      maxMsgsPerMinute: number;
      backoffMultiplier: number;
    },
    actor: { userId: string; ip: string | null }
  ): ProviderRateLimitRecord {
    const existing = [...this.providerLimits.values()].find(
      (r) => r.remoteDomainPattern === input.remoteDomainPattern && r.ipPoolId === input.ipPoolId
    );
    const before = existing ? { ...existing } : null;
    const rec: ProviderRateLimitRecord = {
      id: existing?.id ?? randomUUID(),
      ipPoolId: input.ipPoolId,
      remoteDomainPattern: input.remoteDomainPattern.toLowerCase(),
      maxConnections: input.maxConnections,
      maxMsgsPerMinute: input.maxMsgsPerMinute,
      backoffMultiplier: input.backoffMultiplier,
      updatedAt: new Date().toISOString(),
    };
    this.providerLimits.set(rec.id, rec);
    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: null,
      action: 'admin.provider_limit.upserted',
      resourceType: 'provider_rate_limit',
      resourceId: rec.id,
      beforeState: before,
      afterState: { ...rec },
    });
    return rec;
  }

  getSettingsHistory(): SystemSettingsVersion[] {
    return [...this.settingsHistory].reverse();
  }

  updateSettings(
    config: SystemSettingsVersion['config'],
    actor: { userId: string; ip: string | null }
  ): SystemSettingsVersion {
    const current = this.settingsHistory[this.settingsHistory.length - 1];
    const next: SystemSettingsVersion = {
      id: randomUUID(),
      version: (current?.version ?? 0) + 1,
      config,
      updatedBy: actor.userId,
      createdAt: new Date().toISOString(),
    };
    this.settingsHistory.push(next);
    this.recordAudit({
      actorUserId: actor.userId,
      actorIp: actor.ip,
      organizationId: null,
      action: 'admin.settings.updated',
      resourceType: 'system_settings',
      resourceId: String(next.version),
      beforeState: current?.config ?? null,
      afterState: next.config,
    });
    return next;
  }

  async getOverview() {
    const pgStart = Date.now();
    const pgOk = await this.deps.infra.readiness.checkPostgres().catch(() => false);
    const pgProbe: ServiceProbeResult = {
      name: 'postgres',
      status: pgOk ? 'healthy' : 'degraded',
      latencyMs: Date.now() - pgStart,
      detail: pgOk ? 'Connected (SELECT 1 OK)' : 'PostgreSQL health check failed',
    };

    const redisProbe: ServiceProbeResult = this.deps.infra.redisUrl
      ? await probeRedisTcp(this.deps.infra.redisUrl)
      : { name: 'redis', status: 'unconfigured', latencyMs: null, detail: 'REDIS_URL not set' };

    const rabbitProbe: ServiceProbeResult = this.deps.infra.rabbitMqManagement
      ? await this.deps.infra.rabbitMqManagement.checkHealth()
      : {
          name: 'rabbitmq',
          status: 'unconfigured',
          latencyMs: null,
          detail: 'RABBITMQ_MANAGEMENT_URL not set',
        };

    const nodes = await this.listNodes();
    const onlineNodes = nodes.filter((n) => n.status === 'healthy' || n.status === 'draining');
    const mtaProbe: ServiceProbeResult = {
      name: 'mta_cluster',
      status: nodes.length === 0 ? 'unconfigured' : onlineNodes.length === nodes.length ? 'healthy' : 'degraded',
      latencyMs: null,
      detail: `${onlineNodes.length}/${nodes.length} registered MTA nodes reachable`,
    };

    const orgs = await this.listOrganizations();
    const users = await this.listUsers();
    const domains = await this.listAllDomains();
    const queues = await this.listQueues();
    const globalEvents = await this.deps.analyticsStore.getGlobalStats();

    return {
      services: [pgProbe, redisProbe, rabbitProbe, mtaProbe],
      totals: {
        organizations: orgs.length,
        suspendedOrganizations: orgs.filter((o) => o.status === 'suspended').length,
        users: users.length,
        domains: domains.length,
        suspendedDomains: domains.filter((d) => d.isSuspended).length,
        mtaNodes: nodes.length,
        drainingNodes: nodes.filter((n) => n.status === 'draining').length,
        queuedMessages: queues.reduce((sum, q) => sum + q.messagesReady, 0),
        dlqMessages: queues.filter((q) => q.isDlq).reduce((sum, q) => sum + q.messagesReady, 0),
        auditLogsCount: this.auditLogs.length,
      },
      emailTelemetry: globalEvents,
      recentAudits: this.auditLogs.slice(0, 10),
    };
  }
}

export function createAdminRouter(deps: {
  store: AdminControlStore;
  jwtSecret: string;
}): Router {
  const router = Router();
  router.use(requireAuth(deps.jwtSecret), requireSuperAdmin());

  const actorOf = (req: Request) => ({
    userId: req.auth!.sub,
    ip: req.ip ?? null,
  });

  router.get('/overview', async (_req, res) => {
    const overview = await deps.store.getOverview();
    res.json({ overview });
  });

  router.get('/organizations', async (_req, res) => {
    res.json({ organizations: await deps.store.listOrganizations() });
  });

  router.patch('/organizations/:id', async (req, res) => {
    const patch = z
      .object({
        status: z.enum(['active', 'suspended', 'pending_review']).optional(),
        sendingMode: z.enum(['sandbox', 'live']).optional(),
        dailySendLimit: z.number().int().min(0).max(50_000_000).optional(),
        monthlySendLimit: z.number().int().min(0).max(500_000_000).optional(),
        defaultIpPoolId: z.string().nullable().optional(),
      })
      .parse(req.body);

    const org = await deps.store.updateOrganization(
      String(req.params.id ?? ''),
      {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.sendingMode !== undefined ? { sendingMode: patch.sendingMode } : {}),
        ...(patch.dailySendLimit !== undefined ? { dailySendLimit: patch.dailySendLimit } : {}),
        ...(patch.monthlySendLimit !== undefined ? { monthlySendLimit: patch.monthlySendLimit } : {}),
        ...(patch.defaultIpPoolId !== undefined ? { defaultIpPoolId: patch.defaultIpPoolId } : {}),
      },
      actorOf(req)
    );
    res.json({ organization: org });
  });

  router.get('/users', async (_req, res) => {
    res.json({ users: await deps.store.listUsers() });
  });

  router.patch('/users/:id', requireStrictSuperAdmin(), async (req, res) => {
    const patch = z
      .object({
        status: z.enum(['active', 'suspended']).optional(),
        platformRole: z.enum(['none', 'platform_operator', 'super_admin']).optional(),
      })
      .parse(req.body);

    const user = await deps.store.updateUser(
      String(req.params.id ?? ''),
      {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.platformRole !== undefined ? { platformRole: patch.platformRole } : {}),
      },
      actorOf(req)
    );
    res.json({ user });
  });

  router.post('/users/:id/revoke-sessions', requireStrictSuperAdmin(), async (req, res) => {
    const revokedCount = await deps.store.revokeUserSessions(
      String(req.params.id ?? ''),
      actorOf(req)
    );
    res.json({ revokedCount });
  });

  router.get('/domains', async (_req, res) => {
    res.json({ domains: await deps.store.listAllDomains() });
  });

  router.patch('/domains/:id', async (req, res) => {
    const body = z
      .object({
        isSuspended: z.boolean(),
        suspensionReason: z.string().max(300).nullable().default(null),
      })
      .parse(req.body);

    const domain = await deps.store.setDomainSuspended(
      String(req.params.id ?? ''),
      body.isSuspended,
      body.suspensionReason,
      actorOf(req)
    );
    res.json({ domain });
  });

  router.get('/nodes', async (_req, res) => {
    res.json({ nodes: await deps.store.listNodes() });
  });

  router.post('/nodes', requireStrictSuperAdmin(), (req, res) => {
    const body = z
      .object({
        id: z.string().min(2).max(80),
        hostname: z.string().min(2).max(200),
        roles: z.array(z.enum(['ingress', 'outbound', 'inbound'])).min(1),
      controlUrl: z
        .string()
        .url()
        .refine((u) => {
          try {
            const parsed = new URL(u);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
            // Block cloud metadata IPv4/IPv6 ranges from arbitrary node control URLs
            if (parsed.hostname === '169.254.169.254' || parsed.hostname === 'metadata.google.internal') {
              return false;
            }
            return true;
          } catch {
            return false;
          }
        }, 'Invalid or unsafe node controlUrl')
        .nullable()
        .default(null),
      })
      .parse(req.body);

    const node = deps.store.registerNode(body, actorOf(req));
    res.status(201).json({ node });
  });

  router.post('/nodes/:id/drain', requireStrictSuperAdmin(), async (req, res) => {
    const node = await deps.store.setNodeDrain(String(req.params.id ?? ''), true, actorOf(req));
    res.json({ node });
  });

  router.post('/nodes/:id/resume', requireStrictSuperAdmin(), async (req, res) => {
    const node = await deps.store.setNodeDrain(String(req.params.id ?? ''), false, actorOf(req));
    res.json({ node });
  });

  router.get('/queues', async (_req, res) => {
    res.json({ queues: await deps.store.listQueues() });
  });

  router.post('/queues/:queueName/retry-dlq', async (req, res) => {
    const result = await deps.store.retryDlq(String(req.params.queueName ?? ''), actorOf(req));
    res.json(result);
  });

  router.post('/queues/:queueName/purge', requireStrictSuperAdmin(), async (req, res) => {
    await deps.store.purgeQueue(String(req.params.queueName ?? ''), actorOf(req));
    res.status(204).send();
  });

  router.get('/ip-pools', (_req, res) => {
    res.json(deps.store.listIpPools());
  });

  router.post('/ip-pools', (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).max(100),
        poolType: z.enum(['shared_transactional', 'shared_bulk', 'dedicated', 'warmup']),
      })
      .parse(req.body);
    const pool = deps.store.createIpPool(body, actorOf(req));
    res.status(201).json({ pool });
  });

  router.patch('/ip-pools/:id', (req, res) => {
    const body = z.object({ isSuspended: z.boolean() }).parse(req.body);
    const pool = deps.store.updateIpPool(String(req.params.id ?? ''), body.isSuspended, actorOf(req));
    res.json({ pool });
  });

  router.post('/sending-ips', (req, res) => {
    const body = z
      .object({
        ipPoolId: z.string().min(1),
        ipv4Address: z.string().ip({ version: 'v4' }),
        ptrHostname: z.string().min(3),
        warmupStage: z.number().int().min(1).max(10).default(1),
        dailyQuota: z.number().int().min(100).max(5_000_000).default(1000),
      })
      .parse(req.body);
    const sendingIp = deps.store.addSendingIp(body, actorOf(req));
    res.status(201).json({ sendingIp });
  });

  router.patch('/sending-ips/:id', (req, res) => {
    const patch = z
      .object({
        warmupStage: z.number().int().min(1).max(10).optional(),
        dailyQuota: z.number().int().min(0).max(5_000_000).optional(),
        reputationScore: z.number().min(0).max(100).optional(),
        status: z.enum(['active', 'warming', 'paused', 'retired']).optional(),
      })
      .parse(req.body);
    const sendingIp = deps.store.updateSendingIp(
      String(req.params.id ?? ''),
      {
        ...(patch.warmupStage !== undefined ? { warmupStage: patch.warmupStage } : {}),
        ...(patch.dailyQuota !== undefined ? { dailyQuota: patch.dailyQuota } : {}),
        ...(patch.reputationScore !== undefined ? { reputationScore: patch.reputationScore } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      },
      actorOf(req)
    );
    res.json({ sendingIp });
  });

  router.put('/provider-rate-limits', (req, res) => {
    const body = z
      .object({
        ipPoolId: z.string().nullable().default(null),
        remoteDomainPattern: z.string().min(2).max(120),
        maxConnections: z.number().int().min(1).max(200),
        maxMsgsPerMinute: z.number().int().min(1).max(100_000),
        backoffMultiplier: z.number().min(1.1).max(10).default(2),
      })
      .parse(req.body);
    const limit = deps.store.upsertProviderRateLimit(body, actorOf(req));
    res.json({ limit });
  });

  router.get('/settings', (_req, res) => {
    const history = deps.store.getSettingsHistory();
    res.json({ current: history[0] ?? null, history });
  });

  router.put('/settings', requireStrictSuperAdmin(), (req, res) => {
    const body = z
      .object({
        sandboxDailyCap: z.number().int().min(0).max(1_000_000),
        maxAttachmentSizeMb: z.number().int().min(1).max(100),
        autoSuspendBounceRatePct: z.number().min(0.1).max(50),
        autoSuspendComplaintRatePct: z.number().min(0.01).max(10),
        maintenanceBanner: z.string().max(300),
        requireTlsForInboundRelay: z.boolean(),
      })
      .parse(req.body);
    const version = deps.store.updateSettings(body, actorOf(req));
    res.json({ setting: version });
  });

  router.get('/audit-logs', (req, res) => {
    const action = typeof req.query.action === 'string' ? req.query.action : undefined;
    const resourceType =
      typeof req.query.resourceType === 'string' ? req.query.resourceType : undefined;
    const logs = deps.store.listAuditLogs({
      ...(action ? { action } : {}),
      ...(resourceType ? { resourceType } : {}),
    });
    res.json({ auditLogs: logs });
  });

  router.use('/audit-logs', (_req, res) => {
    res.status(405).json({
      error: {
        code: 'IMMUTABLE_AUDIT_LOG',
        message: 'Audit logs are strictly append-only and cannot be modified or deleted',
      },
    });
  });

  return router;
}
