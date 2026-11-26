import { randomBytes, randomUUID } from 'node:crypto';
import type {
  DnsCheckState,
  DnsRecordEvaluation,
  DkimKeySummary,
  DomainDeliverabilityMetrics,
  DomainDnsCheckHistoryItem,
  DomainHealthStatus,
  DomainHostingSummary,
  DomainNotification,
} from '@mail/shared-types';
import {
  createDomainRequestSchema,
  deleteDomainSchema,
  rotateDkimSchema,
  updateDomainSettingsSchema,
} from '@mail/validation';
import { Router } from 'express';
import { requireAuth, requireOrgRole } from '../auth/security.js';
import { AppError } from '../middleware/error-handler.js';
import { generateDomainDkimKeyPair } from '../services/dkim-service.js';
import {
  type DnsLookupAdapter,
  type FullDomainDnsDiagnostics,
  buildExpectedDmarcValue,
  createNodeDnsAdapter,
  diffDnsSnapshots,
  getInfraDnsConfig,
  runFullDomainDiagnostics,
} from '../services/dns-verifier.js';

export interface DomainRecord {
  id: string;
  organizationId: string;
  domainName: string;
  verificationToken: string;
  ownershipVerifiedAt: string | null;
  sendingEnabled: boolean;
  hostingEnabled: boolean;
  isSuspended: boolean;
  suspensionReason: string | null;
  activeDkimSelector: string | null;
  dkimPolicy: 'required' | 'optional';
  customReturnPathDomain: string | null;
  customTrackingDomain: string | null;
  defaultSenderLocalPart: string | null;
  dmarcPolicy: 'none' | 'quarantine' | 'reject';
  dmarcRua: string | null;
  dmarcRuf: string | null;
  dmarcPct: number;
  dmarcAspf: 'r' | 's';
  dmarcAdkim: 'r' | 's';
  dailySendLimit: number | null;
  mtaStsMode: 'none' | 'testing' | 'enforce';
  mtaStsMaxAge: number;
  tlsRptRua: string | null;
  bimiSelector: string;
  bimiLogoUrl: string | null;
  bimiVmcUrl: string | null;
  lastDnsCheckedAt: string | null;
  lastAuthPassedAt: string | null;
  createdAt: string;
}

export interface StoredDkimKeyRecord {
  id: string;
  domainId: string;
  selector: string;
  algorithm: 'rsa2048' | 'ed25519';
  dnsRecordName: string;
  publicKeyDnsTxt: string;
  keyEncryptionVersion?: number;
  status: 'active' | 'retiring' | 'revoked';
  rotatedAt: string | null;
  createdAt: string;
}

export interface DomainDnsJobRecord {
  id: string;
  organizationId: string;
  domainId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  triggerSource: 'manual' | 'scheduled' | 'verify' | 'auto';
  resultCheckId: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DomainAuditEvent {
  id: string;
  actorUserId: string;
  actorIp: string | null;
  action: string;
  beforeState: unknown;
  afterState: unknown;
  createdAt: string;
}

export interface DomainUpdatePatch {
  hostingEnabled?: boolean;
  sendingEnabled?: boolean;
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

export interface DomainListItem extends DomainRecord {
  healthStatus: DomainHealthStatus;
  spfStatus: DnsCheckState;
  dkimStatus: DnsCheckState;
  dmarcStatus: DnsCheckState;
  mxStatus: DnsCheckState;
  ptrStatus: DnsCheckState;
  mailboxCount: number;
  warningsCount: number;
}

export interface DomainStore {
  listDomains(organizationId: string): Promise<DomainRecord[]>;
  listAllDomains?(): Promise<DomainRecord[]>;
  adminSetSuspended?(
    domainId: string,
    isSuspended: boolean,
    suspensionReason: string | null
  ): Promise<DomainRecord | null>;
  createDomain(input: {
    organizationId: string;
    domainName: string;
    sendingEnabled: boolean;
    hostingEnabled: boolean;
  }): Promise<DomainRecord>;
  getDomain(organizationId: string, domainId: string): Promise<DomainRecord | null>;
  markVerified(organizationId: string, domainId: string): Promise<DomainRecord | null>;
  updateSettings(
    organizationId: string,
    domainId: string,
    patch: DomainUpdatePatch
  ): Promise<DomainRecord | null>;
  regenerateVerificationToken?(orgId: string, domainId: string): Promise<DomainRecord | null>;
  listDkimKeys?(domainId: string): Promise<StoredDkimKeyRecord[]>;
  ensureInitialDkimKey?(domainId: string, domainName: string, selector: string): Promise<StoredDkimKeyRecord>;
  rotateDkimKey?(
    orgId: string,
    domainId: string,
    selector: string,
    algorithm: 'rsa2048' | 'ed25519'
  ): Promise<StoredDkimKeyRecord | null>;
  revokeDkimKey?(orgId: string, domainId: string, keyId: string): Promise<boolean>;
  recordDnsCheckResult?(
    domainId: string,
    report: FullDomainDnsDiagnostics
  ): Promise<DomainDnsCheckHistoryItem>;
  listDnsCheckHistory?(domainId: string, limit?: number): Promise<DomainDnsCheckHistoryItem[]>;
  enqueueDnsJob?(
    orgId: string,
    domainId: string,
    triggerSource: DomainDnsJobRecord['triggerSource'],
    requestedBy?: string | null
  ): Promise<DomainDnsJobRecord>;
  updateDnsJob?(
    jobId: string,
    patch: { status: DomainDnsJobRecord['status']; resultCheckId?: string; errorMessage?: string }
  ): Promise<void>;
  getDnsJob?(orgId: string, domainId: string, jobId: string): Promise<DomainDnsJobRecord | null>;
  getDeliverabilityMetrics?(orgId: string, domainId: string, domainName: string): Promise<DomainDeliverabilityMetrics>;
  getHostingSummary?(orgId: string, domainId: string, domainName: string): Promise<DomainHostingSummary>;
  recordDomainAudit?(entry: {
    actorUserId: string | null;
    actorIp: string | null;
    organizationId: string;
    domainId: string;
    action: string;
    beforeState?: unknown;
    afterState?: unknown;
  }): Promise<void>;
  listDomainAuditEvents?(orgId: string, domainId: string): Promise<DomainAuditEvent[]>;
  deleteDomain?(
    orgId: string,
    domainId: string,
    confirmCleanup: boolean
  ): Promise<{
    deleted: boolean;
    blockingDependencies?: {
      mailboxCount: number;
      activeCampaignCount: number;
      recentMessagesCount: number;
    };
  }>;
}

export interface MtaDomainSyncClient {
  reloadDkim(): Promise<{ reloaded: number; activeSelectors: Record<string, string[]> } | null>;
  getDkimStatus(): Promise<{ nodeId: string; heloDomain: string; activeSelectors: Record<string, string[]> } | null>;
}

export function createHttpMtaSyncClient(controlUrl?: string, controlToken?: string): MtaDomainSyncClient {
  const base = controlUrl?.replace(/\/+$/, '');
  const headers: Record<string, string> = controlToken ? { Authorization: `Bearer ${controlToken}` } : {};

  async function requestJson<T>(method: 'GET' | 'POST', suffix: string): Promise<T | null> {
    if (!base) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(`${base}${suffix}`, { method, headers, signal: ctrl.signal });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    reloadDkim: () => requestJson('POST', '/control/dkim/reload'),
    getDkimStatus: () => requestJson('GET', '/control/dkim/status'),
  };
}

export class InMemoryDomainStore implements DomainStore {
  private readonly records = new Map<string, DomainRecord>();
  private readonly dkimKeys = new Map<string, StoredDkimKeyRecord[]>();
  private readonly dnsChecks = new Map<string, DomainDnsCheckHistoryItem[]>();
  private readonly dnsJobs = new Map<string, DomainDnsJobRecord>();
  private readonly audits = new Map<string, DomainAuditEvent[]>();

  async listDomains(organizationId: string): Promise<DomainRecord[]> {
    return [...this.records.values()].filter((d) => d.organizationId === organizationId);
  }

  async listAllDomains(): Promise<DomainRecord[]> {
    return [...this.records.values()];
  }

  async adminSetSuspended(
    domainId: string,
    isSuspended: boolean,
    suspensionReason: string | null
  ): Promise<DomainRecord | null> {
    const found = this.records.get(domainId);
    if (!found) return null;
    found.isSuspended = isSuspended;
    found.suspensionReason = isSuspended ? suspensionReason : null;
    return found;
  }

  async createDomain(input: {
    organizationId: string;
    domainName: string;
    sendingEnabled: boolean;
    hostingEnabled: boolean;
  }): Promise<DomainRecord> {
    const normalized = input.domainName.trim().toLowerCase();
    const duplicate = [...this.records.values()].find((d) => d.domainName === normalized);
    if (duplicate) {
      throw new AppError(409, 'DOMAIN_EXISTS', `Domain ${normalized} is already registered`);
    }
    const defaultSel = (process.env.DKIM_SELECTOR || 'mp1').trim().toLowerCase();
    const record: DomainRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      domainName: normalized,
      verificationToken: `mp-verify-${randomBytes(12).toString('hex')}`,
      ownershipVerifiedAt: null,
      sendingEnabled: input.sendingEnabled,
      hostingEnabled: input.hostingEnabled,
      isSuspended: false,
      suspensionReason: null,
      activeDkimSelector: defaultSel,
      dkimPolicy: 'required',
      customReturnPathDomain: null,
      customTrackingDomain: null,
      defaultSenderLocalPart: 'noreply',
      dmarcPolicy: 'none',
      dmarcRua: `mailto:dmarc@${normalized}`,
      dmarcRuf: null,
      dmarcPct: 100,
      dmarcAspf: 'r',
      dmarcAdkim: 'r',
      dailySendLimit: null,
      mtaStsMode: 'none',
      mtaStsMaxAge: 86400,
      tlsRptRua: null,
      bimiSelector: 'default',
      bimiLogoUrl: null,
      bimiVmcUrl: null,
      lastDnsCheckedAt: null,
      lastAuthPassedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.records.set(record.id, record);
    await this.ensureInitialDkimKey(record.id, normalized, defaultSel);
    return record;
  }

  async getDomain(organizationId: string, domainId: string): Promise<DomainRecord | null> {
    const found = this.records.get(domainId);
    if (!found || found.organizationId !== organizationId) return null;
    return found;
  }

  async markVerified(organizationId: string, domainId: string): Promise<DomainRecord | null> {
    const found = await this.getDomain(organizationId, domainId);
    if (!found) return null;
    found.ownershipVerifiedAt = found.ownershipVerifiedAt ?? new Date().toISOString();
    return found;
  }

  async regenerateVerificationToken(orgId: string, domainId: string): Promise<DomainRecord | null> {
    const found = await this.getDomain(orgId, domainId);
    if (!found) return null;
    found.verificationToken = `mp-verify-${randomBytes(12).toString('hex')}`;
    found.ownershipVerifiedAt = null;
    return found;
  }

  async updateSettings(
    organizationId: string,
    domainId: string,
    patch: DomainUpdatePatch
  ): Promise<DomainRecord | null> {
    const found = await this.getDomain(organizationId, domainId);
    if (!found) return null;
    Object.assign(found, patch);
    return found;
  }

  async listDkimKeys(domainId: string): Promise<StoredDkimKeyRecord[]> {
    return this.dkimKeys.get(domainId) ?? [];
  }

  async ensureInitialDkimKey(
    domainId: string,
    domainName: string,
    selector: string
  ): Promise<StoredDkimKeyRecord> {
    const existing = this.dkimKeys.get(domainId) ?? [];
    const active = existing.find((k) => k.status === 'active');
    if (active) return active;

    const generated = generateDomainDkimKeyPair(domainName, selector, 'rsa2048');
    const rec: StoredDkimKeyRecord = {
      id: randomUUID(),
      domainId,
      selector: generated.selector,
      algorithm: generated.algorithm,
      dnsRecordName: generated.dnsRecordName,
      publicKeyDnsTxt: generated.publicKeyDnsTxt,
      keyEncryptionVersion: generated.keyEncryptionVersion,
      status: 'active',
      rotatedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.dkimKeys.set(domainId, [...existing, rec]);
    return rec;
  }

  async rotateDkimKey(
    orgId: string,
    domainId: string,
    selector: string,
    algorithm: 'rsa2048' | 'ed25519'
  ): Promise<StoredDkimKeyRecord | null> {
    const dom = await this.getDomain(orgId, domainId);
    if (!dom) return null;
    const list = this.dkimKeys.get(domainId) ?? [];
    if (list.some((k) => k.selector === selector)) {
      throw new AppError(409, 'SELECTOR_EXISTS', `DKIM selector "${selector}" already exists on ${dom.domainName}`);
    }
    const now = new Date().toISOString();
    for (const k of list) {
      if (k.status === 'active') {
        k.status = 'retiring';
        k.rotatedAt = now;
      }
    }
    const generated = generateDomainDkimKeyPair(dom.domainName, selector, algorithm);
    const rec: StoredDkimKeyRecord = {
      id: randomUUID(),
      domainId,
      selector: generated.selector,
      algorithm: generated.algorithm,
      dnsRecordName: generated.dnsRecordName,
      publicKeyDnsTxt: generated.publicKeyDnsTxt,
      keyEncryptionVersion: generated.keyEncryptionVersion,
      status: 'active',
      rotatedAt: null,
      createdAt: now,
    };
    list.unshift(rec);
    this.dkimKeys.set(domainId, list);
    dom.activeDkimSelector = generated.selector;
    return rec;
  }

  async revokeDkimKey(orgId: string, domainId: string, keyId: string): Promise<boolean> {
    const dom = await this.getDomain(orgId, domainId);
    if (!dom) return false;
    const list = this.dkimKeys.get(domainId) ?? [];
    const target = list.find((k) => k.id === keyId);
    if (!target) return false;
    if (target.status === 'active') {
      throw new AppError(400, 'CANNOT_REVOKE_ACTIVE', 'Rotate to a new active DKIM selector before revoking this key');
    }
    target.status = 'revoked';
    return true;
  }

  async recordDnsCheckResult(
    domainId: string,
    report: FullDomainDnsDiagnostics
  ): Promise<DomainDnsCheckHistoryItem> {
    const dom = this.records.get(domainId);
    if (dom) {
      dom.lastDnsCheckedAt = report.checkedAt;
      if (report.ownershipMatched && !dom.ownershipVerifiedAt) {
        dom.ownershipVerifiedAt = report.checkedAt;
      }
      if (report.spfStatus === 'pass' && report.dkimStatus === 'pass') {
        dom.lastAuthPassedAt = report.checkedAt;
      }
    }
    const prevList = this.dnsChecks.get(domainId) ?? [];
    const changes = diffDnsSnapshots(prevList[0]?.records, report.records);
    const item: DomainDnsCheckHistoryItem = {
      id: randomUUID(),
      domainId,
      spfStatus: report.spfStatus,
      dkimStatus: report.dkimStatus,
      dmarcStatus: report.dmarcStatus,
      mxStatus: report.mxStatus,
      ptrStatus: report.ptrStatus,
      checkedAt: report.checkedAt,
      changes,
      records: report.records,
    };
    this.dnsChecks.set(domainId, [item, ...prevList].slice(0, 25));
    return item;
  }

  async listDnsCheckHistory(domainId: string, limit = 15): Promise<DomainDnsCheckHistoryItem[]> {
    return (this.dnsChecks.get(domainId) ?? []).slice(0, limit);
  }

  async enqueueDnsJob(
    orgId: string,
    domainId: string,
    triggerSource: DomainDnsJobRecord['triggerSource']
  ): Promise<DomainDnsJobRecord> {
    const job: DomainDnsJobRecord = {
      id: randomUUID(),
      organizationId: orgId,
      domainId,
      status: 'queued',
      triggerSource,
      resultCheckId: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };
    this.dnsJobs.set(job.id, job);
    return job;
  }

  async updateDnsJob(
    jobId: string,
    patch: { status: DomainDnsJobRecord['status']; resultCheckId?: string; errorMessage?: string }
  ): Promise<void> {
    const job = this.dnsJobs.get(jobId);
    if (!job) return;
    job.status = patch.status;
    if (patch.status === 'running') job.startedAt = new Date().toISOString();
    if (patch.status === 'completed' || patch.status === 'failed') job.completedAt = new Date().toISOString();
    if (patch.resultCheckId) job.resultCheckId = patch.resultCheckId;
    if (patch.errorMessage) job.errorMessage = patch.errorMessage;
  }

  async getDnsJob(orgId: string, domainId: string, jobId: string): Promise<DomainDnsJobRecord | null> {
    const job = this.dnsJobs.get(jobId);
    if (!job || job.organizationId !== orgId || job.domainId !== domainId) return null;
    return job;
  }

  async getDeliverabilityMetrics(_orgId: string, domainId: string): Promise<DomainDeliverabilityMetrics> {
    const dom = this.records.get(domainId);
    return {
      sent30d: 0,
      delivered30d: 0,
      deferred30d: 0,
      bounced30d: 0,
      complained30d: 0,
      bounceRatePct: 0,
      complaintRatePct: null,
      lastEmailActivityAt: null,
      lastAuthPassedAt: dom?.lastAuthPassedAt ?? null,
      recentFailures: [],
      reputationStatus: 'not_integrated',
      reputationNote: 'No external reputation feed (Google Postmaster / Microsoft SNDS) is integrated yet.',
    };
  }

  async getHostingSummary(): Promise<DomainHostingSummary> {
    return {
      mailboxCount: 0,
      activeMailboxCount: 0,
      catchAllCount: 0,
      totalUsedBytes: 0,
      totalQuotaBytes: 0,
      mailboxes: [],
      lastInboundAt: null,
      inboundErrors30d: 0,
    };
  }

  async recordDomainAudit(entry: {
    actorUserId: string | null;
    actorIp: string | null;
    organizationId: string;
    domainId: string;
    action: string;
    beforeState?: unknown;
    afterState?: unknown;
  }): Promise<void> {
    const list = this.audits.get(entry.domainId) ?? [];
    list.unshift({
      id: randomUUID(),
      actorUserId: entry.actorUserId ?? 'system',
      actorIp: entry.actorIp,
      action: entry.action,
      beforeState: entry.beforeState ?? null,
      afterState: entry.afterState ?? null,
      createdAt: new Date().toISOString(),
    });
    this.audits.set(entry.domainId, list.slice(0, 50));
  }

  async listDomainAuditEvents(_orgId: string, domainId: string): Promise<DomainAuditEvent[]> {
    return this.audits.get(domainId) ?? [];
  }

  async deleteDomain(orgId: string, domainId: string): Promise<{ deleted: boolean }> {
    const dom = await this.getDomain(orgId, domainId);
    if (!dom) return { deleted: false };
    this.records.delete(domainId);
    return { deleted: true };
  }
}

export function buildRequiredDnsRecords(
  domain: DomainRecord,
  dkimKeys: StoredDkimKeyRecord[] = []
) {
  const infra = getInfraDnsConfig();
  const spfMechanism = infra.spfIncludeDomain
    ? `include:${infra.spfIncludeDomain}`
    : infra.publicIp
      ? `ip4:${infra.publicIp}`
      : `a:${infra.heloDomain}`;
  const activeKey = dkimKeys.find((k) => k.status === 'active');
  const activeSel = activeKey?.selector ?? domain.activeDkimSelector ?? 'mp1';
  const expectedDkim = activeKey?.publicKeyDnsTxt ?? 'v=DKIM1; k=rsa; p=<generating>';

  const records = [
    {
      type: 'TXT',
      host: `_mailplat-verify.${domain.domainName}`,
      value: domain.verificationToken,
      purpose: 'Domain ownership verification',
    },
    {
      type: 'MX',
      host: domain.domainName,
      value: `10 ${infra.heloDomain}`,
      purpose: domain.hostingEnabled ? 'Inbound mailbox delivery (required)' : 'Inbound MX routing (for bounce/inbox hosting)',
    },
    {
      type: 'TXT',
      host: domain.customReturnPathDomain || domain.domainName,
      value: `v=spf1 ${spfMechanism} -all`,
      purpose: 'SPF sender authorization',
    },
    {
      type: 'TXT',
      host: activeKey?.dnsRecordName ?? `${activeSel}._domainkey.${domain.domainName}`,
      value: expectedDkim,
      purpose: `DKIM cryptographic signing (active selector: ${activeSel})`,
    },
    {
      type: 'TXT',
      host: `_dmarc.${domain.domainName}`,
      value: buildExpectedDmarcValue(domain),
      purpose: 'DMARC policy & reporting',
    },
  ];

  if (domain.customReturnPathDomain) {
    records.push({
      type: 'MX',
      host: domain.customReturnPathDomain,
      value: `10 ${infra.heloDomain}`,
      purpose: 'Custom Return-Path bounce reception',
    });
  }
  if (domain.customTrackingDomain) {
    records.push({
      type: 'CNAME',
      host: domain.customTrackingDomain,
      value: infra.trackingCnameTarget || infra.heloDomain,
      purpose: 'Custom open/click tracking CNAME',
    });
  }
  if (domain.mtaStsMode !== 'none') {
    records.push({
      type: 'TXT',
      host: `_mta-sts.${domain.domainName}`,
      value: `v=STSv1; id=${new Date().toISOString().slice(0, 10).replaceAll('-', '')}01`,
      purpose: `MTA-STS policy announcement (${domain.mtaStsMode})`,
    });
  }
  if (domain.tlsRptRua) {
    records.push({
      type: 'TXT',
      host: `_smtp._tls.${domain.domainName}`,
      value: `v=TLSRPTv1; rua=${domain.tlsRptRua}`,
      purpose: 'SMTP TLS Reporting (TLSRPT)',
    });
  }
  if (domain.bimiLogoUrl) {
    records.push({
      type: 'TXT',
      host: `${domain.bimiSelector || 'default'}._bimi.${domain.domainName}`,
      value: `v=BIMI1; l=${domain.bimiLogoUrl}${domain.bimiVmcUrl ? `; a=${domain.bimiVmcUrl}` : ''}`,
      purpose: 'BIMI brand indicator (optional)',
    });
  }
  return records;
}

function deriveDomainHealthSummary(
  domain: DomainRecord,
  latestCheck: DomainDnsCheckHistoryItem | undefined,
  mailboxCount: number
): DomainListItem {
  const spfStatus = latestCheck?.spfStatus ?? 'unchecked';
  const dkimStatus = latestCheck?.dkimStatus ?? 'unchecked';
  const dmarcStatus = latestCheck?.dmarcStatus ?? 'unchecked';
  const mxStatus = latestCheck?.mxStatus ?? 'unchecked';
  const ptrStatus = latestCheck?.ptrStatus ?? 'unchecked';

  let healthStatus: DomainHealthStatus;
  if (domain.isSuspended) {
    healthStatus = 'suspended';
  } else if (!domain.sendingEnabled && !domain.hostingEnabled) {
    healthStatus = 'disabled';
  } else if (!domain.ownershipVerifiedAt) {
    healthStatus = 'pending_verification';
  } else if (
    (domain.sendingEnabled && (spfStatus === 'fail' || dkimStatus === 'fail')) ||
    (domain.hostingEnabled && mxStatus === 'fail')
  ) {
    healthStatus = 'dns_misconfigured';
  } else if (
    spfStatus === 'unchecked' ||
    dkimStatus === 'unchecked' ||
    dmarcStatus !== 'pass' ||
    ptrStatus === 'fail'
  ) {
    healthStatus = 'auth_incomplete';
  } else {
    healthStatus = 'verified';
  }

  let warningsCount = 0;
  for (const s of [spfStatus, dkimStatus, dmarcStatus, mxStatus, ptrStatus]) {
    if (s === 'fail' || s === 'warn') warningsCount += 1;
  }

  return {
    ...domain,
    healthStatus,
    spfStatus,
    dkimStatus,
    dmarcStatus,
    mxStatus,
    ptrStatus,
    mailboxCount,
    warningsCount,
  };
}

function buildFallbackEvaluations(
  domain: DomainRecord,
  dkimKeys: StoredDkimKeyRecord[]
): DnsRecordEvaluation[] {
  return buildRequiredDnsRecords(domain, dkimKeys).map((r, i) => ({
    id: `${r.type.toLowerCase()}-${i}`,
    category: r.purpose.includes('ownership')
      ? 'ownership'
      : r.purpose.includes('SPF')
        ? 'spf'
        : r.purpose.includes('DKIM')
          ? 'dkim'
          : r.purpose.includes('DMARC')
            ? 'dmarc'
            : r.purpose.includes('Return-Path')
              ? 'return_path'
              : r.purpose.includes('tracking')
                ? 'cname'
                : r.purpose.includes('MTA-STS')
                  ? 'mta_sts'
                  : r.purpose.includes('TLS')
                    ? 'tls_rpt'
                    : r.purpose.includes('BIMI')
                      ? 'bimi'
                      : 'mx',
    type: r.type as DnsRecordEvaluation['type'],
    host: r.host,
    expected: r.value,
    detected: [],
    status: 'unchecked',
    required: !r.purpose.includes('optional'),
    propagationStatus: 'unchecked',
    resolver: 'not checked yet',
    error: null,
    remediation: 'Run DNS Diagnostics to check live DNS records.',
    checkedAt: null,
  }));
}

function buildDkimSummaries(
  _domain: DomainRecord,
  keys: StoredDkimKeyRecord[],
  latestCheck: DomainDnsCheckHistoryItem | undefined,
  mtaLoadedSelectors: string[],
  mtaReachable: boolean
): DkimKeySummary[] {
  return keys.map((k) => {
    const rec = latestCheck?.records.find((r) => r.id === `dkim-${k.selector}`);
    return {
      id: k.id,
      domainId: k.domainId,
      selector: k.selector,
      algorithm: k.algorithm,
      dnsRecordName: k.dnsRecordName,
      publicKeyDnsTxt: k.publicKeyDnsTxt,
      ...(k.keyEncryptionVersion !== undefined ? { keyEncryptionVersion: k.keyEncryptionVersion } : {}),
      status: k.status,
      dnsVerified: rec?.status === 'pass',
      mtaLoaded: mtaReachable && mtaLoadedSelectors.includes(k.selector),
      rotatedAt: k.rotatedAt,
      createdAt: k.createdAt,
    };
  });
}

function nextSelectorName(existing: StoredDkimKeyRecord[]): string {
  const used = new Set(existing.map((k) => k.selector));
  for (let i = 2; i < 100; i += 1) {
    const candidate = `mp${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `mp${Date.now().toString(36).slice(-4)}`;
}

export function createDomainsRouter(deps: {
  store: DomainStore;
  jwtSecret: string;
  dnsAdapter?: DnsLookupAdapter;
  mtaSync?: MtaDomainSyncClient;
}): Router {
  const router = Router();
  const auth = requireAuth(deps.jwtSecret);
  const dnsAdapter = deps.dnsAdapter ?? createNodeDnsAdapter(Number(process.env.DNS_CHECK_TIMEOUT_MS || 3500));
  const mtaSync = deps.mtaSync;

  async function executeDiagnosticsForDomain(
    domain: DomainRecord,
    triggerSource: DomainDnsJobRecord['triggerSource'],
    mtaLoadedSelectors?: string[]
  ): Promise<{ report: FullDomainDnsDiagnostics; historyItem: DomainDnsCheckHistoryItem | null; updatedDomain: DomainRecord }> {
    const keys = deps.store.listDkimKeys ? await deps.store.listDkimKeys(domain.id) : [];
    const report = await runFullDomainDiagnostics(
      {
        ...domain,
        dkimKeys: keys,
        mtaLoadedSelectors,
      },
      dnsAdapter,
      getInfraDnsConfig()
    );

    if (report.ownershipMatched && !domain.ownershipVerifiedAt) {
      await deps.store.markVerified(domain.organizationId, domain.id);
    }

    const historyItem = deps.store.recordDnsCheckResult
      ? await deps.store.recordDnsCheckResult(domain.id, report)
      : null;

    const updatedDomain = (await deps.store.getDomain(domain.organizationId, domain.id)) ?? domain;
    if (triggerSource === 'verify' && report.ownershipMatched) {
      await deps.store.recordDomainAudit?.({
        actorUserId: null,
        actorIp: null,
        organizationId: domain.organizationId,
        domainId: domain.id,
        action: 'domain.verified',
        afterState: { ownershipVerifiedAt: updatedDomain.ownershipVerifiedAt },
      });
    }
    return { report, historyItem, updatedDomain };
  }

  router.get('/domains', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const allDomains = await deps.store.listDomains(orgId);

    const enrichedAll = await Promise.all(
      allDomains.map(async (d) => {
        const [history, hosting] = await Promise.all([
          deps.store.listDnsCheckHistory ? deps.store.listDnsCheckHistory(d.id, 1) : Promise.resolve([]),
          deps.store.getHostingSummary ? deps.store.getHostingSummary(orgId, d.id, d.domainName) : Promise.resolve(null),
        ]);
        return deriveDomainHealthSummary(d, history[0], hosting?.mailboxCount ?? 0);
      })
    );

    const summary = {
      total: enrichedAll.length,
      verified: enrichedAll.filter((d) => Boolean(d.ownershipVerifiedAt)).length,
      dnsIssues: enrichedAll.filter(
        (d) => d.healthStatus === 'dns_misconfigured' || d.healthStatus === 'auth_incomplete'
      ).length,
      sendingEnabled: enrichedAll.filter((d) => d.sendingEnabled && !d.isSuspended).length,
      hostingEnabled: enrichedAll.filter((d) => d.hostingEnabled && !d.isSuspended).length,
    };

    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const healthFilter = typeof req.query.health === 'string' ? req.query.health : '';
    const verifiedFilter = typeof req.query.verified === 'string' ? req.query.verified : '';
    const roleFilter = typeof req.query.role === 'string' ? req.query.role : '';
    const sortBy = typeof req.query.sort === 'string' ? req.query.sort : 'recent';

    let filtered = enrichedAll.filter((d) => {
      if (search && !d.domainName.toLowerCase().includes(search)) return false;
      if (healthFilter && d.healthStatus !== healthFilter) return false;
      if (verifiedFilter === 'verified' && !d.ownershipVerifiedAt) return false;
      if (verifiedFilter === 'pending' && Boolean(d.ownershipVerifiedAt)) return false;
      if (roleFilter === 'sending' && !d.sendingEnabled) return false;
      if (roleFilter === 'hosting' && !d.hostingEnabled) return false;
      return true;
    });

    if (sortBy === 'name') {
      filtered = [...filtered].sort((a, b) => a.domainName.localeCompare(b.domainName));
    } else if (sortBy === 'health') {
      const rank: Record<DomainHealthStatus, number> = {
        suspended: 0,
        dns_misconfigured: 1,
        pending_verification: 2,
        auth_incomplete: 3,
        disabled: 4,
        verified: 5,
      };
      filtered = [...filtered].sort((a, b) => rank[a.healthStatus] - rank[b.healthStatus]);
    } else {
      filtered = [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    res.json({ domains: filtered, summary });
  });

  router.post('/domains', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const parsed = createDomainRequestSchema.parse(req.body);
    const domain = await deps.store.createDomain({
      organizationId: orgId,
      domainName: parsed.domainName,
      sendingEnabled: parsed.sendingEnabled,
      hostingEnabled: parsed.hostingEnabled,
    });
    const dkimKeys = deps.store.listDkimKeys ? await deps.store.listDkimKeys(domain.id) : [];
    await mtaSync?.reloadDkim().catch(() => null);
    await deps.store.recordDomainAudit?.({
      actorUserId: req.auth?.sub ?? null,
      actorIp: req.ip ?? null,
      organizationId: orgId,
      domainId: domain.id,
      action: 'domain.created',
      afterState: { domainName: domain.domainName, sendingEnabled: domain.sendingEnabled, hostingEnabled: domain.hostingEnabled },
    });
    res.status(201).json({ domain, dnsRecords: buildRequiredDnsRecords(domain, dkimKeys), dkimKeys });
  });

  router.get('/domains/:domainId', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const domain = await deps.store.getDomain(orgId, domainId);
    if (!domain) throw new AppError(404, 'NOT_FOUND', 'Domain not found');

    const defaultSel = domain.activeDkimSelector ?? (process.env.DKIM_SELECTOR || 'mp1');
    if (deps.store.ensureInitialDkimKey) {
      await deps.store.ensureInitialDkimKey(domain.id, domain.domainName, defaultSel);
    }

    const [dkimKeys, history, deliverability, hosting, auditEvents, mtaStatus] = await Promise.all([
      deps.store.listDkimKeys ? deps.store.listDkimKeys(domain.id) : Promise.resolve([]),
      deps.store.listDnsCheckHistory ? deps.store.listDnsCheckHistory(domain.id, 15) : Promise.resolve([]),
      deps.store.getDeliverabilityMetrics
        ? deps.store.getDeliverabilityMetrics(orgId, domain.id, domain.domainName)
        : Promise.resolve(null),
      deps.store.getHostingSummary
        ? deps.store.getHostingSummary(orgId, domain.id, domain.domainName)
        : Promise.resolve(null),
      deps.store.listDomainAuditEvents
        ? deps.store.listDomainAuditEvents(orgId, domain.id)
        : Promise.resolve([]),
      mtaSync ? mtaSync.getDkimStatus().catch(() => null) : Promise.resolve(null),
    ]);

    const latestCheck = history[0];
    const mtaLoadedSelectors = mtaStatus?.activeSelectors?.[domain.domainName.toLowerCase()] ?? [];
    const summaryItem = deriveDomainHealthSummary(domain, latestCheck, hosting?.mailboxCount ?? 0);
    const records = latestCheck?.records ?? buildFallbackEvaluations(domain, dkimKeys);
    const dkimSummaries = buildDkimSummaries(domain, dkimKeys, latestCheck, mtaLoadedSelectors, Boolean(mtaStatus));
    const infra = getInfraDnsConfig();

    const notifications: DomainNotification[] = [];
    if (domain.isSuspended) {
      notifications.push({
        id: 'suspended',
        severity: 'error',
        code: 'DOMAIN_SUSPENDED',
        title: 'Domain is suspended',
        message: domain.suspensionReason || 'Suspended by platform administrator.',
        recommendedAction: 'Contact platform operations to resolve suspension.',
        targetTab: 'overview',
      });
    }
    if (!domain.ownershipVerifiedAt) {
      notifications.push({
        id: 'verify-pending',
        severity: 'warning',
        code: 'OWNERSHIP_PENDING',
        title: 'Domain ownership verification required',
        message: `Publish TXT record _mailplat-verify.${domain.domainName} before enabling production sends.`,
        recommendedAction: 'Copy the verification TXT record and click Verify Ownership.',
        targetTab: 'dns',
      });
    }
    for (const r of records) {
      if ((r.status === 'fail' || r.status === 'warn') && r.remediation) {
        notifications.push({
          id: `rec-${r.id}`,
          severity: r.status === 'fail' ? 'error' : 'warning',
          code: `DNS_${r.category.toUpperCase()}_${r.status.toUpperCase()}`,
          title: `${r.type} ${r.host} (${r.status})`,
          message: r.remediation,
          recommendedAction: `Update ${r.type} record at ${r.host}.`,
          targetTab: r.category === 'mx' ? 'hosting' : r.category === 'ptr' ? 'deliverability' : 'dns',
        });
      }
    }

    res.json({
      domain: summaryItem,
      dnsRecords: buildRequiredDnsRecords(domain, dkimKeys),
      diagnostics: {
        checkedAt: latestCheck?.checkedAt ?? null,
        records,
      },
      dkimKeys: dkimSummaries,
      deliverability,
      hosting,
      history,
      auditEvents,
      notifications,
      infra: {
        heloDomain: infra.heloDomain,
        publicIp: infra.publicIp ?? null,
        spfIncludeDomain: infra.spfIncludeDomain ?? null,
        trackingCnameTarget: infra.trackingCnameTarget ?? null,
        mtaNodeId: mtaStatus?.nodeId ?? null,
        mtaLoadedSelectors,
      },
    });
  });

  router.post('/domains/:domainId/verify', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const domain = await deps.store.getDomain(orgId, domainId);
    if (!domain) throw new AppError(404, 'NOT_FOUND', 'Domain not found');

    if (deps.store.ensureInitialDkimKey) {
      await deps.store.ensureInitialDkimKey(domain.id, domain.domainName, domain.activeDkimSelector ?? 'mp1');
    }
    const mtaStatus = mtaSync ? await mtaSync.getDkimStatus().catch(() => null) : null;
    const mtaLoaded = mtaStatus?.activeSelectors?.[domain.domainName.toLowerCase()];
    const { report, updatedDomain } = await executeDiagnosticsForDomain(domain, 'verify', mtaLoaded);

    const ownershipRec = report.records.find((r) => r.id === 'ownership');
    res.json({
      domain: updatedDomain,
      verified: Boolean(updatedDomain.ownershipVerifiedAt && report.ownershipMatched),
      ownershipMatched: report.ownershipMatched,
      diagnostics: report,
      dnsRecords: buildRequiredDnsRecords(
        updatedDomain,
        deps.store.listDkimKeys ? await deps.store.listDkimKeys(updatedDomain.id) : []
      ),
      message: report.ownershipMatched
        ? 'Domain ownership verified via live DNS lookup'
        : ownershipRec?.remediation || 'Verification TXT record not detected in DNS yet',
    });
  });

  router.post('/domains/:domainId/diagnostics', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const domain = await deps.store.getDomain(orgId, domainId);
    if (!domain) throw new AppError(404, 'NOT_FOUND', 'Domain not found');

    const asyncMode = req.query.async === 'true' || (req.body as { async?: boolean } | undefined)?.async === true;
    const mtaStatus = mtaSync ? await mtaSync.getDkimStatus().catch(() => null) : null;
    const mtaLoaded = mtaStatus?.activeSelectors?.[domain.domainName.toLowerCase()];

    if (asyncMode && deps.store.enqueueDnsJob && deps.store.updateDnsJob) {
      const job = await deps.store.enqueueDnsJob(orgId, domain.id, 'manual', req.auth?.sub ?? null);
      setImmediate(() => {
        void (async () => {
          try {
            await deps.store.updateDnsJob!(job.id, { status: 'running' });
            const { historyItem } = await executeDiagnosticsForDomain(domain, 'manual', mtaLoaded);
            await deps.store.updateDnsJob!(job.id, {
              status: 'completed',
              ...(historyItem ? { resultCheckId: historyItem.id } : {}),
            });
          } catch (err) {
            await deps.store.updateDnsJob!(job.id, {
              status: 'failed',
              errorMessage: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      });
      return res.status(202).json({ job });
    }

    const job = deps.store.enqueueDnsJob
      ? await deps.store.enqueueDnsJob(orgId, domain.id, 'manual', req.auth?.sub ?? null)
      : null;
    if (job && deps.store.updateDnsJob) {
      await deps.store.updateDnsJob(job.id, { status: 'running' });
    }
    const { report, historyItem, updatedDomain } = await executeDiagnosticsForDomain(domain, 'manual', mtaLoaded);
    if (job && deps.store.updateDnsJob) {
      await deps.store.updateDnsJob(job.id, {
        status: 'completed',
        ...(historyItem ? { resultCheckId: historyItem.id } : {}),
      });
    }
    return res.json({ domain: updatedDomain, diagnostics: report, check: historyItem, job });
  });

  router.get('/domains/:domainId/diagnostics/:jobId', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    const jobId = String(req.params.jobId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    if (!deps.store.getDnsJob) throw new AppError(404, 'NOT_FOUND', 'DNS job not found');
    const job = await deps.store.getDnsJob(orgId, domainId, jobId);
    if (!job) throw new AppError(404, 'NOT_FOUND', 'DNS job not found');
    res.json({ job });
  });

  router.get('/domains/:domainId/history', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const domain = await deps.store.getDomain(orgId, domainId);
    if (!domain) throw new AppError(404, 'NOT_FOUND', 'Domain not found');
    const [history, auditEvents] = await Promise.all([
      deps.store.listDnsCheckHistory ? deps.store.listDnsCheckHistory(domainId, 30) : Promise.resolve([]),
      deps.store.listDomainAuditEvents ? deps.store.listDomainAuditEvents(orgId, domainId) : Promise.resolve([]),
    ]);
    res.json({ history, auditEvents });
  });

  router.post('/domains/:domainId/regenerate-token', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const existing = await deps.store.getDomain(orgId, domainId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Domain not found');
    const updated = deps.store.regenerateVerificationToken
      ? await deps.store.regenerateVerificationToken(orgId, domainId)
      : null;
    if (!updated) throw new AppError(404, 'NOT_FOUND', 'Domain not found');
    await deps.store.recordDomainAudit?.({
      actorUserId: req.auth?.sub ?? null,
      actorIp: req.ip ?? null,
      organizationId: orgId,
      domainId,
      action: 'domain.token_regenerated',
      beforeState: { verified: Boolean(existing.ownershipVerifiedAt) },
      afterState: { verified: false },
    });
    res.json({ domain: updated });
  });

  router.post('/domains/:domainId/dkim/rotate', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const existing = await deps.store.getDomain(orgId, domainId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Domain not found');
    if (!deps.store.rotateDkimKey) {
      throw new AppError(501, 'NOT_SUPPORTED', 'DKIM key rotation is not supported by store');
    }

    const parsed = rotateDkimSchema.parse(req.body ?? {});
    const existingKeys = deps.store.listDkimKeys ? await deps.store.listDkimKeys(domainId) : [];
    const selector = parsed.selector ?? nextSelectorName(existingKeys);

    const newKey = await deps.store.rotateDkimKey(orgId, domainId, selector, parsed.algorithm);
    if (!newKey) throw new AppError(404, 'NOT_FOUND', 'Domain not found');

    const syncResult = await mtaSync?.reloadDkim().catch(() => null);
    await deps.store.recordDomainAudit?.({
      actorUserId: req.auth?.sub ?? null,
      actorIp: req.ip ?? null,
      organizationId: orgId,
      domainId,
      action: 'domain.dkim_rotated',
      beforeState: { activeDkimSelector: existing.activeDkimSelector },
      afterState: { activeDkimSelector: newKey.selector, algorithm: newKey.algorithm },
    });

    const dkimKeys = deps.store.listDkimKeys ? await deps.store.listDkimKeys(domainId) : [newKey];
    res.status(201).json({ key: newKey, dkimKeys, mtaSynced: Boolean(syncResult) });
  });

  router.post('/domains/:domainId/dkim/:keyId/revoke', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    const keyId = String(req.params.keyId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    if (!deps.store.revokeDkimKey) {
      throw new AppError(501, 'NOT_SUPPORTED', 'DKIM key revocation is not supported');
    }
    const ok = await deps.store.revokeDkimKey(orgId, domainId, keyId);
    if (!ok) throw new AppError(404, 'NOT_FOUND', 'DKIM key not found');
    await mtaSync?.reloadDkim().catch(() => null);
    await deps.store.recordDomainAudit?.({
      actorUserId: req.auth?.sub ?? null,
      actorIp: req.ip ?? null,
      organizationId: orgId,
      domainId,
      action: 'domain.dkim_revoked',
      afterState: { keyId },
    });
    res.json({ revoked: true });
  });

  router.patch('/domains/:domainId', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const before = await deps.store.getDomain(orgId, domainId);
    if (!before) throw new AppError(404, 'NOT_FOUND', 'Domain not found');

    const patch = updateDomainSettingsSchema.parse(req.body);
    const domain = await deps.store.updateSettings(orgId, domainId, {
      ...(patch.hostingEnabled !== undefined ? { hostingEnabled: patch.hostingEnabled } : {}),
      ...(patch.sendingEnabled !== undefined ? { sendingEnabled: patch.sendingEnabled } : {}),
      ...(patch.dkimPolicy !== undefined ? { dkimPolicy: patch.dkimPolicy } : {}),
      ...(patch.defaultSenderLocalPart !== undefined ? { defaultSenderLocalPart: patch.defaultSenderLocalPart } : {}),
      ...(patch.customReturnPathDomain !== undefined ? { customReturnPathDomain: patch.customReturnPathDomain } : {}),
      ...(patch.customTrackingDomain !== undefined ? { customTrackingDomain: patch.customTrackingDomain } : {}),
      ...(patch.dailySendLimit !== undefined ? { dailySendLimit: patch.dailySendLimit } : {}),
      ...(patch.dmarcPolicy !== undefined ? { dmarcPolicy: patch.dmarcPolicy } : {}),
      ...(patch.dmarcRua !== undefined ? { dmarcRua: patch.dmarcRua || null } : {}),
      ...(patch.dmarcRuf !== undefined ? { dmarcRuf: patch.dmarcRuf || null } : {}),
      ...(patch.dmarcPct !== undefined ? { dmarcPct: patch.dmarcPct } : {}),
      ...(patch.dmarcAspf !== undefined ? { dmarcAspf: patch.dmarcAspf } : {}),
      ...(patch.dmarcAdkim !== undefined ? { dmarcAdkim: patch.dmarcAdkim } : {}),
      ...(patch.mtaStsMode !== undefined ? { mtaStsMode: patch.mtaStsMode } : {}),
      ...(patch.mtaStsMaxAge !== undefined ? { mtaStsMaxAge: patch.mtaStsMaxAge } : {}),
      ...(patch.tlsRptRua !== undefined ? { tlsRptRua: patch.tlsRptRua || null } : {}),
      ...(patch.bimiSelector !== undefined ? { bimiSelector: patch.bimiSelector } : {}),
      ...(patch.bimiLogoUrl !== undefined ? { bimiLogoUrl: patch.bimiLogoUrl || null } : {}),
      ...(patch.bimiVmcUrl !== undefined ? { bimiVmcUrl: patch.bimiVmcUrl || null } : {}),
    });
    if (!domain) throw new AppError(404, 'NOT_FOUND', 'Domain not found');

    await deps.store.recordDomainAudit?.({
      actorUserId: req.auth?.sub ?? null,
      actorIp: req.ip ?? null,
      organizationId: orgId,
      domainId,
      action: 'domain.settings_updated',
      beforeState: {
        sendingEnabled: before.sendingEnabled,
        hostingEnabled: before.hostingEnabled,
        dmarcPolicy: before.dmarcPolicy,
        customReturnPathDomain: before.customReturnPathDomain,
        customTrackingDomain: before.customTrackingDomain,
        mtaStsMode: before.mtaStsMode,
      },
      afterState: patch,
    });

    res.json({ domain });
  });

  router.delete('/domains/:domainId', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const domain = await deps.store.getDomain(orgId, domainId);
    if (!domain) throw new AppError(404, 'NOT_FOUND', 'Domain not found');

    const body = deleteDomainSchema.parse(req.body ?? {});
    if (body.confirmDomainName !== domain.domainName.toLowerCase()) {
      throw new AppError(400, 'CONFIRMATION_MISMATCH', `Type "${domain.domainName}" to confirm domain deletion`);
    }

    if (!deps.store.deleteDomain) {
      throw new AppError(501, 'NOT_SUPPORTED', 'Domain deletion is not supported');
    }

    const result = await deps.store.deleteDomain(orgId, domainId, body.confirmCleanup);
    if (!result.deleted && result.blockingDependencies) {
      return res.status(409).json({
        error: {
          code: 'DOMAIN_HAS_DEPENDENCIES',
          message:
            'Domain has active mailboxes, campaigns, or recent message records. Confirm cleanup explicitly to proceed.',
          dependencies: result.blockingDependencies,
        },
      });
    }

    await mtaSync?.reloadDkim().catch(() => null);
    await deps.store.recordDomainAudit?.({
      actorUserId: req.auth?.sub ?? null,
      actorIp: req.ip ?? null,
      organizationId: orgId,
      domainId,
      action: 'domain.deleted',
      beforeState: { domainName: domain.domainName },
    });

    return res.status(204).send();
  });

  return router;
}
