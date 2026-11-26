import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type {
  DnsCheckState,
  DnsRecordEvaluation,
  DomainDeliverabilityMetrics,
  DomainDnsCheckHistoryItem,
  DomainHostingSummary,
  EmailEventType,
  SuppressionReason,
} from '@mail/shared-types';
import type { Pool } from 'pg';
import { hashPasswordArgon2id, hashTokenSha256 } from '../auth/security.js';
import { AppError } from '../middleware/error-handler.js';
import {
  BILLING_PLANS,
  type AnalyticsStore,
  type BillingPlan,
  type DateRangePreset,
  type EmailEventRecord,
  type InvoiceRecord,
  type SubscriptionRecord,
  type TrackingTokenRecord,
} from '../routes/analytics.js';
import type { AuthStore, SessionRecord, UserAccount } from '../routes/auth.js';
import type {
  CampaignRecord,
  ContactRecord,
  MarketingStore,
  SuppressionRecord,
  TemplateRecord,
} from '../routes/campaigns.js';
import type {
  ApiKeyRecord,
  CredentialsStore,
  SmtpCredentialRecord,
} from '../routes/credentials.js';
import type {
  DomainAuditEvent,
  DomainDnsJobRecord,
  DomainRecord,
  DomainStore,
  DomainUpdatePatch,
  StoredDkimKeyRecord,
} from '../routes/domains.js';
import type {
  AliasRecord,
  ForwardingRuleRecord,
  MailboxRecord,
  MailboxStore,
} from '../routes/mailboxes.js';
import type {
  WebhookDeliveryLog,
  WebhookEndpointRecord,
  WebhookStore,
} from '../routes/webhooks.js';
import { generateDomainDkimKeyPair } from '../services/dkim-service.js';
import { diffDnsSnapshots, type FullDomainDnsDiagnostics } from '../services/dns-verifier.js';
import { uuidv7 } from '../utils/uuidv7.js';

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value ? iso(value) : null;
}

function deriveSecretKey(rawKey: string): Buffer {
  return createHash('sha256').update(rawKey).digest();
}

function encryptSecret(secret: string, encKey: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptStoredSecret(blob: Buffer, encKey: Buffer): string {
  if (blob.length < 28) {
    return blob.toString('utf8');
  }
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function slugifyOrg(name: string): string {
  const base = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 36);
  return `${base || 'org'}-${randomBytes(3).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// PgAuthStore
// ---------------------------------------------------------------------------

export class PgAuthStore implements AuthStore {
  constructor(private readonly pool: Pool) {}

  private mapUserRow(r: {
    id: string;
    email: string;
    full_name: string;
    password_hash: string;
    status: string;
    platform_role: string;
    org_id: string | null;
    org_role: string | null;
    mfa_enabled: boolean;
    mfa_totp_secret: string | null;
  }): UserAccount {
    return {
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      passwordHash: r.password_hash,
      status: r.status === 'suspended' ? 'suspended' : 'active',
      platformRole: r.platform_role as UserAccount['platformRole'],
      orgId: r.org_id,
      orgRole: (r.org_role as UserAccount['orgRole']) ?? null,
      mfaEnabled: r.mfa_enabled,
      totpSecret: r.mfa_totp_secret,
    };
  }

  async findUserByEmail(email: string): Promise<UserAccount | null> {
    const res = await this.pool.query(
      `SELECT u.id::text, u.email::text, u.full_name, u.password_hash, u.status, u.platform_role,
              u.mfa_enabled, u.mfa_totp_secret, m.organization_id::text AS org_id, m.role AS org_role
         FROM users u
         LEFT JOIN organization_members m ON m.user_id = u.id
        WHERE LOWER(u.email::text) = LOWER($1) AND u.status != 'deleted'
        ORDER BY m.created_at ASC NULLS LAST
        LIMIT 1`,
      [email]
    );
    const row = res.rows[0];
    return row ? this.mapUserRow(row) : null;
  }

  async findUserById(userId: string): Promise<UserAccount | null> {
    const res = await this.pool.query(
      `SELECT u.id::text, u.email::text, u.full_name, u.password_hash, u.status, u.platform_role,
              u.mfa_enabled, u.mfa_totp_secret, m.organization_id::text AS org_id, m.role AS org_role
         FROM users u
         LEFT JOIN organization_members m ON m.user_id = u.id
        WHERE u.id = $1 AND u.status != 'deleted'
        ORDER BY m.created_at ASC NULLS LAST
        LIMIT 1`,
      [userId]
    );
    const row = res.rows[0];
    return row ? this.mapUserRow(row) : null;
  }

  async listUsers(): Promise<UserAccount[]> {
    const res = await this.pool.query(
      `SELECT DISTINCT ON (u.id) u.id::text, u.email::text, u.full_name, u.password_hash, u.status,
              u.platform_role, u.mfa_enabled, u.mfa_totp_secret,
              m.organization_id::text AS org_id, m.role AS org_role
         FROM users u
         LEFT JOIN organization_members m ON m.user_id = u.id
        WHERE u.status != 'deleted'
        ORDER BY u.id, m.created_at ASC NULLS LAST`
    );
    return res.rows.map((r) => this.mapUserRow(r));
  }

  async updateUser(
    userId: string,
    patch: { status?: 'active' | 'suspended'; platformRole?: UserAccount['platformRole'] }
  ): Promise<UserAccount | null> {
    const current = await this.findUserById(userId);
    if (!current) return null;
    await this.pool.query(
      `UPDATE users SET status = COALESCE($2, status), platform_role = COALESCE($3, platform_role), updated_at = NOW() WHERE id = $1`,
      [userId, patch.status ?? null, patch.platformRole ?? null]
    );
    return this.findUserById(userId);
  }

  async setUserTotpSecret(userId: string, secret: string, enableMfa: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE users SET mfa_totp_secret = $2, mfa_enabled = $3, updated_at = NOW() WHERE id = $1`,
      [userId, secret, enableMfa]
    );
  }

  async seedSuperAdminFromBootstrap(input: {
    email: string;
    fullName: string;
    passwordHash: string;
    organizationName: string;
  }): Promise<{ user: UserAccount; orgId: string }> {
    const existing = await this.findUserByEmail(input.email);
    if (existing && existing.orgId) {
      return { user: existing, orgId: existing.orgId };
    }
    const orgId = uuidv7();
    const userId = existing?.id ?? uuidv7();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO organizations (id, name, slug, status, sending_mode, daily_send_limit, monthly_send_limit)
         VALUES ($1, $2, $3, 'active', 'live', 100000, 3000000)`,
        [orgId, input.organizationName, slugifyOrg(input.organizationName)]
      );
      if (!existing) {
        await client.query(
          `INSERT INTO users (id, email, password_hash, full_name, email_verified_at, mfa_enabled, status, platform_role)
           VALUES ($1, $2, $3, $4, NOW(), FALSE, 'active', 'super_admin')`,
          [userId, input.email.toLowerCase(), input.passwordHash, input.fullName]
        );
      } else {
        await client.query(
          `UPDATE users SET platform_role = 'super_admin', status = 'active' WHERE id = $1`,
          [userId]
        );
      }
      await client.query(
        `INSERT INTO organization_members (id, user_id, organization_id, role) VALUES ($1, $2, $3, 'owner')
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [uuidv7(), userId, orgId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    const created = await this.findUserById(userId);
    if (!created) throw new Error('Failed retrieving bootstrapped user');
    return { user: created, orgId };
  }

  async createUserAndOrg(input: {
    email: string;
    fullName: string;
    passwordHash: string;
    organizationName: string;
  }): Promise<UserAccount> {
    const userId = uuidv7();
    const orgId = uuidv7();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const dup = await client.query(
        `SELECT 1 FROM users WHERE LOWER(email::text) = LOWER($1) LIMIT 1`,
        [input.email]
      );
      if (dup.rowCount && dup.rowCount > 0) {
        throw new AppError(409, 'EMAIL_EXISTS', 'An account with that email already exists');
      }
      await client.query(
        `INSERT INTO organizations (id, name, slug, status, sending_mode)
         VALUES ($1, $2, $3, 'active', 'sandbox')`,
        [orgId, input.organizationName, slugifyOrg(input.organizationName)]
      );
      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, mfa_enabled, status, platform_role)
         VALUES ($1, $2, $3, $4, FALSE, 'active', 'none')`,
        [userId, input.email.toLowerCase(), input.passwordHash, input.fullName]
      );
      await client.query(
        `INSERT INTO organization_members (id, user_id, organization_id, role) VALUES ($1, $2, $3, 'owner')`,
        [uuidv7(), userId, orgId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return {
      id: userId,
      email: input.email.toLowerCase(),
      fullName: input.fullName,
      passwordHash: input.passwordHash,
      status: 'active',
      platformRole: 'none',
      orgId,
      orgRole: 'owner',
      mfaEnabled: false,
      totpSecret: null,
    };
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_sessions (id, user_id, app_surface, refresh_token_hash, token_family_id, mfa_verified_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), $8)`,
      [
        session.id,
        session.userId,
        session.appSurface,
        session.refreshTokenHash,
        session.tokenFamilyId,
        session.mfaVerified ? new Date() : null,
        session.expiresAt,
        session.revokedAt ? new Date(session.revokedAt) : null,
      ]
    );
  }

  async findSessionByHash(hash: string): Promise<SessionRecord | null> {
    const res = await this.pool.query(
      `SELECT id::text, user_id::text, app_surface, refresh_token_hash, token_family_id::text,
              mfa_verified_at, EXTRACT(EPOCH FROM expires_at) * 1000 AS expires_ms,
              EXTRACT(EPOCH FROM revoked_at) * 1000 AS revoked_ms
         FROM user_sessions
        WHERE refresh_token_hash = $1
        LIMIT 1`,
      [hash]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      appSurface: r.app_surface,
      refreshTokenHash: r.refresh_token_hash,
      tokenFamilyId: r.token_family_id,
      mfaVerified: Boolean(r.mfa_verified_at),
      expiresAt: Math.round(Number(r.expires_ms)),
      revokedAt: r.revoked_ms ? Math.round(Number(r.revoked_ms)) : null,
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1`,
      [sessionId]
    );
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.pool.query(
      `UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE token_family_id = $1`,
      [familyId]
    );
  }

  async revokeUserSessions(userId: string): Promise<number> {
    const res = await this.pool.query(
      `UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
    return res.rowCount ?? 0;
  }
}

// ---------------------------------------------------------------------------
// PgDomainStore
// ---------------------------------------------------------------------------

export class PgDomainStore implements DomainStore {
  constructor(private readonly pool: Pool) {}

  private static readonly DOMAIN_COLS = `
    d.id::text, d.organization_id::text, d.domain_name::text, d.verification_token, d.ownership_verified_at,
    d.sending_enabled, d.hosting_enabled, d.is_suspended, d.suspension_reason,
    COALESCE((SELECT selector FROM dkim_keys k WHERE k.domain_id = d.id AND k.status = 'active' ORDER BY k.created_at DESC LIMIT 1), d.active_dkim_selector, 'mp1') AS active_selector,
    d.custom_return_path_domain::text, d.custom_tracking_domain::text, d.default_sender_local_part,
    d.dmarc_policy, d.dmarc_rua, d.dmarc_ruf, d.dmarc_pct, d.dmarc_aspf, d.dmarc_adkim,
    d.daily_send_limit, d.mta_sts_mode, d.mta_sts_max_age, d.tls_rpt_rua,
    d.bimi_selector, d.bimi_logo_url, d.bimi_vmc_url,
    d.last_dns_checked_at, d.last_auth_passed_at, d.created_at
  `;

  private mapDomain(r: Record<string, unknown>): DomainRecord {
    const policy = String(r.dmarc_policy ?? 'none');
    const mtaSts = String(r.mta_sts_mode ?? 'none');
    return {
      id: String(r.id),
      organizationId: String(r.organization_id),
      domainName: String(r.domain_name).toLowerCase(),
      verificationToken: String(r.verification_token),
      ownershipVerifiedAt: isoOrNull(r.ownership_verified_at as Date | string | null),
      sendingEnabled: Boolean(r.sending_enabled),
      hostingEnabled: Boolean(r.hosting_enabled),
      isSuspended: Boolean(r.is_suspended),
      suspensionReason: (r.suspension_reason as string | null) ?? null,
      activeDkimSelector: (r.active_selector as string | null) ?? 'mp1',
      customReturnPathDomain: (r.custom_return_path_domain as string | null)?.toLowerCase() ?? null,
      customTrackingDomain: (r.custom_tracking_domain as string | null)?.toLowerCase() ?? null,
      defaultSenderLocalPart: (r.default_sender_local_part as string | null) ?? null,
      dmarcPolicy: policy === 'quarantine' || policy === 'reject' ? policy : 'none',
      dmarcRua: (r.dmarc_rua as string | null) ?? null,
      dmarcRuf: (r.dmarc_ruf as string | null) ?? null,
      dmarcPct: typeof r.dmarc_pct === 'number' ? r.dmarc_pct : 100,
      dmarcAspf: r.dmarc_aspf === 's' ? 's' : 'r',
      dmarcAdkim: r.dmarc_adkim === 's' ? 's' : 'r',
      dailySendLimit: r.daily_send_limit !== null && r.daily_send_limit !== undefined ? Number(r.daily_send_limit) : null,
      mtaStsMode: mtaSts === 'testing' || mtaSts === 'enforce' ? mtaSts : 'none',
      mtaStsMaxAge: typeof r.mta_sts_max_age === 'number' ? r.mta_sts_max_age : 86400,
      tlsRptRua: (r.tls_rpt_rua as string | null) ?? null,
      bimiSelector: String(r.bimi_selector ?? 'default'),
      bimiLogoUrl: (r.bimi_logo_url as string | null) ?? null,
      bimiVmcUrl: (r.bimi_vmc_url as string | null) ?? null,
      lastDnsCheckedAt: isoOrNull(r.last_dns_checked_at as Date | string | null),
      lastAuthPassedAt: isoOrNull(r.last_auth_passed_at as Date | string | null),
      createdAt: iso(r.created_at as Date | string),
    };
  }

  async listDomains(organizationId: string): Promise<DomainRecord[]> {
    const res = await this.pool.query(
      `SELECT ${PgDomainStore.DOMAIN_COLS}
         FROM domains d
        WHERE d.organization_id = $1
        ORDER BY d.created_at DESC`,
      [organizationId]
    );
    return res.rows.map((r) => this.mapDomain(r));
  }

  async listAllDomains(): Promise<DomainRecord[]> {
    const res = await this.pool.query(
      `SELECT ${PgDomainStore.DOMAIN_COLS}
         FROM domains d
        ORDER BY d.created_at DESC`
    );
    return res.rows.map((r) => this.mapDomain(r));
  }

  async adminSetSuspended(
    domainId: string,
    isSuspended: boolean,
    suspensionReason: string | null
  ): Promise<DomainRecord | null> {
    const res = await this.pool.query(
      `UPDATE domains SET is_suspended = $2, suspension_reason = $3, updated_at = NOW() WHERE id = $1 RETURNING organization_id::text`,
      [domainId, isSuspended, isSuspended ? suspensionReason : null]
    );
    const orgId = res.rows[0]?.organization_id as string | undefined;
    if (!orgId) return null;
    return this.getDomain(orgId, domainId);
  }

  async createDomain(input: {
    organizationId: string;
    domainName: string;
    sendingEnabled: boolean;
    hostingEnabled: boolean;
  }): Promise<DomainRecord> {
    const normalized = input.domainName.trim().toLowerCase();
    const token = `mp-verify-${randomBytes(12).toString('hex')}`;
    const id = uuidv7();
    const defaultSel = (process.env.DKIM_SELECTOR || 'mp1').trim().toLowerCase();
    try {
      await this.pool.query(
        `INSERT INTO domains (id, organization_id, domain_name, verification_token, sending_enabled, hosting_enabled, active_dkim_selector, dmarc_rua)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, input.organizationId, normalized, token, input.sendingEnabled, input.hostingEnabled, defaultSel, `mailto:dmarc@${normalized}`]
      );
      await this.ensureInitialDkimKey(id, normalized, defaultSel);
      const created = await this.getDomain(input.organizationId, id);
      if (!created) throw new Error('Failed reading newly created domain');
      return created;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'DOMAIN_EXISTS', `Domain ${normalized} is already registered`);
      }
      throw err;
    }
  }

  async getDomain(organizationId: string, domainId: string): Promise<DomainRecord | null> {
    const res = await this.pool.query(
      `SELECT ${PgDomainStore.DOMAIN_COLS}
         FROM domains d
        WHERE d.organization_id = $1 AND d.id = $2
        LIMIT 1`,
      [organizationId, domainId]
    );
    return res.rows[0] ? this.mapDomain(res.rows[0]) : null;
  }

  async markVerified(organizationId: string, domainId: string): Promise<DomainRecord | null> {
    await this.pool.query(
      `UPDATE domains
          SET ownership_verified_at = COALESCE(ownership_verified_at, NOW()),
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, domainId]
    );
    return this.getDomain(organizationId, domainId);
  }

  async regenerateVerificationToken(orgId: string, domainId: string): Promise<DomainRecord | null> {
    const token = `mp-verify-${randomBytes(12).toString('hex')}`;
    await this.pool.query(
      `UPDATE domains
          SET verification_token = $3,
              ownership_verified_at = NULL,
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2`,
      [orgId, domainId, token]
    );
    return this.getDomain(orgId, domainId);
  }

  async updateSettings(
    organizationId: string,
    domainId: string,
    patch: DomainUpdatePatch
  ): Promise<DomainRecord | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const vals: unknown[] = [organizationId, domainId];
    const addField = (col: string, val: unknown) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    };
    if (patch.sendingEnabled !== undefined) addField('sending_enabled', patch.sendingEnabled);
    if (patch.hostingEnabled !== undefined) addField('hosting_enabled', patch.hostingEnabled);
    if (patch.defaultSenderLocalPart !== undefined) addField('default_sender_local_part', patch.defaultSenderLocalPart || null);
    if (patch.customReturnPathDomain !== undefined) addField('custom_return_path_domain', patch.customReturnPathDomain);
    if (patch.customTrackingDomain !== undefined) addField('custom_tracking_domain', patch.customTrackingDomain);
    if (patch.dailySendLimit !== undefined) addField('daily_send_limit', patch.dailySendLimit);
    if (patch.dmarcPolicy !== undefined) addField('dmarc_policy', patch.dmarcPolicy);
    if (patch.dmarcRua !== undefined) addField('dmarc_rua', patch.dmarcRua);
    if (patch.dmarcRuf !== undefined) addField('dmarc_ruf', patch.dmarcRuf);
    if (patch.dmarcPct !== undefined) addField('dmarc_pct', patch.dmarcPct);
    if (patch.dmarcAspf !== undefined) addField('dmarc_aspf', patch.dmarcAspf);
    if (patch.dmarcAdkim !== undefined) addField('dmarc_adkim', patch.dmarcAdkim);
    if (patch.mtaStsMode !== undefined) addField('mta_sts_mode', patch.mtaStsMode);
    if (patch.mtaStsMaxAge !== undefined) addField('mta_sts_max_age', patch.mtaStsMaxAge);
    if (patch.tlsRptRua !== undefined) addField('tls_rpt_rua', patch.tlsRptRua);
    if (patch.bimiSelector !== undefined) addField('bimi_selector', patch.bimiSelector);
    if (patch.bimiLogoUrl !== undefined) addField('bimi_logo_url', patch.bimiLogoUrl);
    if (patch.bimiVmcUrl !== undefined) addField('bimi_vmc_url', patch.bimiVmcUrl);

    await this.pool.query(
      `UPDATE domains SET ${sets.join(', ')} WHERE organization_id = $1 AND id = $2`,
      vals
    );
    return this.getDomain(organizationId, domainId);
  }

  async listDkimKeys(domainId: string): Promise<StoredDkimKeyRecord[]> {
    const res = await this.pool.query(
      `SELECT k.id::text, k.domain_id::text, d.domain_name::text, k.selector, k.algorithm,
              k.public_key_dns_txt, k.status, k.rotated_at, k.created_at
         FROM dkim_keys k
         JOIN domains d ON d.id = k.domain_id
        WHERE k.domain_id = $1
        ORDER BY CASE k.status WHEN 'active' THEN 0 WHEN 'retiring' THEN 1 ELSE 2 END, k.created_at DESC`,
      [domainId]
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      domainId: String(r.domain_id),
      selector: String(r.selector),
      algorithm: r.algorithm === 'ed25519' ? 'ed25519' : 'rsa2048',
      dnsRecordName: `${String(r.selector)}._domainkey.${String(r.domain_name).toLowerCase()}`,
      publicKeyDnsTxt: String(r.public_key_dns_txt),
      status: r.status === 'retiring' || r.status === 'revoked' ? r.status : 'active',
      rotatedAt: isoOrNull(r.rotated_at as Date | string | null),
      createdAt: iso(r.created_at as Date | string),
    }));
  }

  async ensureInitialDkimKey(
    domainId: string,
    domainName: string,
    selector: string
  ): Promise<StoredDkimKeyRecord> {
    const existing = await this.listDkimKeys(domainId);
    const active = existing.find((k) => k.status === 'active');
    if (active) return active;

    const cleanSel = selector.trim().toLowerCase() || 'mp1';
    const generated = generateDomainDkimKeyPair(domainName, cleanSel, 'rsa2048');
    const id = uuidv7();
    await this.pool.query(
      `INSERT INTO dkim_keys (id, domain_id, selector, algorithm, public_key_dns_txt, encrypted_private_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       ON CONFLICT (domain_id, selector) DO NOTHING`,
      [id, domainId, generated.selector, generated.algorithm, generated.publicKeyDnsTxt, generated.encryptedPrivateKey]
    );
    const refreshed = await this.listDkimKeys(domainId);
    const activeAfter = refreshed.find((k) => k.status === 'active') ?? refreshed[0];
    if (!activeAfter) throw new Error('Failed persisting DKIM key');
    return activeAfter;
  }

  async rotateDkimKey(
    orgId: string,
    domainId: string,
    selector: string,
    algorithm: 'rsa2048' | 'ed25519'
  ): Promise<StoredDkimKeyRecord | null> {
    const dom = await this.getDomain(orgId, domainId);
    if (!dom) return null;
    const normSel = selector.trim().toLowerCase();
    const generated = generateDomainDkimKeyPair(dom.domainName, normSel, algorithm);
    const keyId = uuidv7();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const dup = await client.query(
        `SELECT 1 FROM dkim_keys WHERE domain_id = $1 AND selector = $2 LIMIT 1`,
        [domainId, normSel]
      );
      if ((dup.rowCount ?? 0) > 0) {
        throw new AppError(409, 'SELECTOR_EXISTS', `Selector "${normSel}" already exists on ${dom.domainName}`);
      }
      await client.query(
        `UPDATE dkim_keys SET status = 'retiring', rotated_at = NOW() WHERE domain_id = $1 AND status = 'active'`,
        [domainId]
      );
      await client.query(
        `INSERT INTO dkim_keys (id, domain_id, selector, algorithm, public_key_dns_txt, encrypted_private_key, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
        [keyId, domainId, generated.selector, generated.algorithm, generated.publicKeyDnsTxt, generated.encryptedPrivateKey]
      );
      await client.query(
        `UPDATE domains SET active_dkim_selector = $2, updated_at = NOW() WHERE id = $1`,
        [domainId, generated.selector]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const keys = await this.listDkimKeys(domainId);
    return keys.find((k) => k.id === keyId) ?? null;
  }

  async revokeDkimKey(orgId: string, domainId: string, keyId: string): Promise<boolean> {
    const dom = await this.getDomain(orgId, domainId);
    if (!dom) return false;
    const rowRes = await this.pool.query(
      `SELECT status FROM dkim_keys WHERE domain_id = $1 AND id = $2 LIMIT 1`,
      [domainId, keyId]
    );
    const row = rowRes.rows[0];
    if (!row) return false;
    if (row.status === 'active') {
      throw new AppError(400, 'CANNOT_REVOKE_ACTIVE', 'Rotate to a new active DKIM selector before revoking this key');
    }
    const res = await this.pool.query(
      `UPDATE dkim_keys SET status = 'revoked' WHERE domain_id = $1 AND id = $2`,
      [domainId, keyId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async recordDnsCheckResult(
    domainId: string,
    report: FullDomainDnsDiagnostics
  ): Promise<DomainDnsCheckHistoryItem> {
    const prev = await this.listDnsCheckHistory(domainId, 1);
    const changes = diffDnsSnapshots(prev[0]?.records, report.records);
    const id = uuidv7();
    const detailsPayload = {
      healthStatus: report.healthStatus,
      ownershipMatched: report.ownershipMatched,
      changes,
      records: report.records,
    };

    await this.pool.query(
      `INSERT INTO domain_dns_checks (id, domain_id, spf_status, dkim_status, dmarc_status, mx_status, ptr_status, details, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        id,
        domainId,
        report.spfStatus,
        report.dkimStatus,
        report.dmarcStatus,
        report.mxStatus,
        report.ptrStatus,
        JSON.stringify(detailsPayload),
        report.checkedAt,
      ]
    );

    await this.pool.query(
      `UPDATE domains
          SET last_dns_checked_at = $2,
              last_auth_passed_at = CASE WHEN $3 = 'pass' AND $4 = 'pass' THEN $2 ELSE last_auth_passed_at END,
              updated_at = NOW()
        WHERE id = $1`,
      [domainId, report.checkedAt, report.spfStatus, report.dkimStatus]
    );

    return {
      id,
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
  }

  async listDnsCheckHistory(domainId: string, limit = 15): Promise<DomainDnsCheckHistoryItem[]> {
    const res = await this.pool.query(
      `SELECT id::text, domain_id::text, spf_status, dkim_status, dmarc_status, mx_status, ptr_status, details, checked_at
         FROM domain_dns_checks
        WHERE domain_id = $1
        ORDER BY checked_at DESC
        LIMIT $2`,
      [domainId, limit]
    );
    return res.rows.map((r) => {
      const details = (r.details ?? {}) as { changes?: string[]; records?: DnsRecordEvaluation[] };
      return {
        id: String(r.id),
        domainId: String(r.domain_id),
        spfStatus: r.spf_status as DnsCheckState,
        dkimStatus: r.dkim_status as DnsCheckState,
        dmarcStatus: r.dmarc_status as DnsCheckState,
        mxStatus: r.mx_status as DnsCheckState,
        ptrStatus: r.ptr_status as DnsCheckState,
        checkedAt: iso(r.checked_at as Date | string),
        changes: Array.isArray(details.changes) ? details.changes : [],
        records: Array.isArray(details.records) ? details.records : [],
      };
    });
  }

  async enqueueDnsJob(
    orgId: string,
    domainId: string,
    triggerSource: DomainDnsJobRecord['triggerSource'],
    requestedBy?: string | null
  ): Promise<DomainDnsJobRecord> {
    const id = uuidv7();
    const uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const reqUser = requestedBy && uuidRx.test(requestedBy) ? requestedBy : null;
    const res = await this.pool.query(
      `INSERT INTO domain_dns_jobs (id, organization_id, domain_id, status, trigger_source, requested_by)
       VALUES ($1, $2, $3, 'queued', $4, $5)
       RETURNING created_at`,
      [id, orgId, domainId, triggerSource, reqUser]
    );
    return {
      id,
      organizationId: orgId,
      domainId,
      status: 'queued',
      triggerSource,
      resultCheckId: null,
      errorMessage: null,
      createdAt: iso(res.rows[0].created_at as Date | string),
      startedAt: null,
      completedAt: null,
    };
  }

  async updateDnsJob(
    jobId: string,
    patch: { status: DomainDnsJobRecord['status']; resultCheckId?: string; errorMessage?: string }
  ): Promise<void> {
    await this.pool.query(
      `UPDATE domain_dns_jobs
          SET status = $2,
              started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, NOW()) ELSE started_at END,
              completed_at = CASE WHEN $2 IN ('completed', 'failed') THEN NOW() ELSE completed_at END,
              result_check_id = COALESCE($3, result_check_id),
              error_message = COALESCE($4, error_message)
        WHERE id = $1`,
      [jobId, patch.status, patch.resultCheckId ?? null, patch.errorMessage ?? null]
    );
  }

  async getDnsJob(orgId: string, domainId: string, jobId: string): Promise<DomainDnsJobRecord | null> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, domain_id::text, status, trigger_source,
              result_check_id::text, error_message, created_at, started_at, completed_at
         FROM domain_dns_jobs
        WHERE organization_id = $1 AND domain_id = $2 AND id = $3
        LIMIT 1`,
      [orgId, domainId, jobId]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      organizationId: String(r.organization_id),
      domainId: String(r.domain_id),
      status: r.status as DomainDnsJobRecord['status'],
      triggerSource: r.trigger_source as DomainDnsJobRecord['triggerSource'],
      resultCheckId: (r.result_check_id as string | null) ?? null,
      errorMessage: (r.error_message as string | null) ?? null,
      createdAt: iso(r.created_at as Date | string),
      startedAt: isoOrNull(r.started_at as Date | string | null),
      completedAt: isoOrNull(r.completed_at as Date | string | null),
    };
  }

  async getDeliverabilityMetrics(
    orgId: string,
    domainId: string,
    domainName: string
  ): Promise<DomainDeliverabilityMetrics> {
    const dom = await this.getDomain(orgId, domainId);
    const statsRes = await this.pool.query(
      `SELECT
          COUNT(*) FILTER (WHERE m.direction = 'outbound') AS sent_total,
          COUNT(*) FILTER (WHERE mr.state = 'accepted_remote') AS delivered_total,
          COUNT(*) FILTER (WHERE mr.state = 'deferred') AS deferred_total,
          COUNT(*) FILTER (WHERE mr.state = 'bounced') AS bounced_total,
          MAX(m.created_at) AS last_activity
         FROM messages m
         LEFT JOIN message_recipients mr ON mr.message_id = m.id
        WHERE m.organization_id = $1
          AND (m.domain_id = $2 OR LOWER(SPLIT_PART(m.envelope_from::text, '@', 2)) = LOWER($3))
          AND m.created_at >= NOW() - INTERVAL '30 days'`,
      [orgId, domainId, domainName]
    );

    const compRes = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt
         FROM suppression_entries
        WHERE organization_id = $1 AND reason = 'complaint' AND created_at >= NOW() - INTERVAL '30 days'`,
      [orgId]
    );

    const failRes = await this.pool.query(
      `SELECT mr.recipient_email::text, da.smtp_code, da.enhanced_code, da.smtp_response, da.attempted_at
         FROM delivery_attempts da
         JOIN message_recipients mr ON mr.id = da.message_recipient_id
         JOIN messages m ON m.id = da.message_id
        WHERE m.organization_id = $1
          AND (m.domain_id = $2 OR LOWER(SPLIT_PART(m.envelope_from::text, '@', 2)) = LOWER($3))
          AND da.outcome IN ('bounced', 'deferred', 'rejected', 'network_error')
        ORDER BY da.attempted_at DESC
        LIMIT 10`,
      [orgId, domainId, domainName]
    );

    const s = statsRes.rows[0] ?? {};
    const sent = Number(s.sent_total ?? 0);
    const delivered = Number(s.delivered_total ?? 0);
    const deferred = Number(s.deferred_total ?? 0);
    const bounced = Number(s.bounced_total ?? 0);
    const complained = Number(compRes.rows[0]?.cnt ?? 0);
    const bounceRatePct = sent > 0 ? Number(((bounced / sent) * 100).toFixed(2)) : 0;

    return {
      sent30d: sent,
      delivered30d: delivered,
      deferred30d: deferred,
      bounced30d: bounced,
      complained30d: complained,
      bounceRatePct,
      complaintRatePct: sent > 0 ? Number(((complained / sent) * 100).toFixed(2)) : null,
      lastEmailActivityAt: isoOrNull(s.last_activity as Date | string | null),
      lastAuthPassedAt: dom?.lastAuthPassedAt ?? null,
      recentFailures: failRes.rows.map((r) => ({
        recipientEmail: String(r.recipient_email),
        smtpCode: r.smtp_code !== null && r.smtp_code !== undefined ? Number(r.smtp_code) : null,
        enhancedCode: (r.enhanced_code as string | null) ?? null,
        smtpResponse: (r.smtp_response as string | null) ?? null,
        attemptedAt: iso(r.attempted_at as Date | string),
      })),
      reputationStatus: 'not_integrated',
      reputationNote: 'No third-party reputation feed (Google Postmaster / Microsoft SNDS) is integrated.',
    };
  }

  async getHostingSummary(
    orgId: string,
    domainId: string,
    domainName: string
  ): Promise<DomainHostingSummary> {
    const mbRes = await this.pool.query(
      `SELECT id::text, email_address::text, display_name, status, used_bytes, quota_bytes, is_catch_all
         FROM mailboxes
        WHERE organization_id = $1 AND domain_id = $2
        ORDER BY created_at DESC`,
      [orgId, domainId]
    );
    const inbRes = await this.pool.query(
      `SELECT MAX(created_at) AS last_inbound,
              COUNT(*) FILTER (WHERE state IN ('bounced', 'rejected')) AS err_cnt
         FROM messages
        WHERE organization_id = $1
          AND direction = 'inbound'
          AND (domain_id = $2 OR LOWER(envelope_from::text) LIKE '%@' || LOWER($3))
          AND created_at >= NOW() - INTERVAL '30 days'`,
      [orgId, domainId, domainName]
    );

    const mailboxes = mbRes.rows.map((r) => ({
      id: String(r.id),
      emailAddress: String(r.email_address),
      displayName: String(r.display_name ?? ''),
      status: (r.status === 'suspended' ? 'suspended' : 'active') as 'active' | 'suspended',
      usedBytes: Number(r.used_bytes ?? 0),
      quotaBytes: Number(r.quota_bytes ?? 0),
      isCatchAll: Boolean(r.is_catch_all),
    }));

    return {
      mailboxCount: mailboxes.length,
      activeMailboxCount: mailboxes.filter((m) => m.status === 'active').length,
      catchAllCount: mailboxes.filter((m) => m.isCatchAll).length,
      totalUsedBytes: mailboxes.reduce((a, b) => a + b.usedBytes, 0),
      totalQuotaBytes: mailboxes.reduce((a, b) => a + b.quotaBytes, 0),
      mailboxes,
      lastInboundAt: isoOrNull(inbRes.rows[0]?.last_inbound as Date | string | null),
      inboundErrors30d: Number(inbRes.rows[0]?.err_cnt ?? 0),
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
    const uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const actorUuid = entry.actorUserId && uuidRx.test(entry.actorUserId) ? entry.actorUserId : null;
    await this.pool
      .query(
        `INSERT INTO audit_logs (id, actor_user_id, actor_ip, organization_id, action, resource_type, resource_id, before_state, after_state)
         VALUES ($1, $2, $3, $4, $5, 'domain', $6, $7::jsonb, $8::jsonb)`,
        [
          uuidv7(),
          actorUuid,
          entry.actorIp,
          entry.organizationId,
          entry.action,
          entry.domainId,
          entry.beforeState !== undefined ? JSON.stringify(entry.beforeState) : null,
          entry.afterState !== undefined ? JSON.stringify(entry.afterState) : null,
        ]
      )
      .catch(() => undefined);
  }

  async listDomainAuditEvents(orgId: string, domainId: string): Promise<DomainAuditEvent[]> {
    const res = await this.pool.query(
      `SELECT a.id::text, COALESCE(u.email::text, a.actor_user_id::text, 'system') AS actor,
              a.actor_ip::text, a.action, a.before_state, a.after_state, a.created_at
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.organization_id = $1 AND a.resource_type = 'domain' AND a.resource_id = $2
        ORDER BY a.created_at DESC
        LIMIT 50`,
      [orgId, domainId]
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      actorUserId: String(r.actor ?? 'system'),
      actorIp: (r.actor_ip as string | null) ?? null,
      action: String(r.action),
      beforeState: r.before_state ?? null,
      afterState: r.after_state ?? null,
      createdAt: iso(r.created_at as Date | string),
    }));
  }

  async deleteDomain(
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
  }> {
    const depRes = await this.pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM mailboxes WHERE organization_id = $1 AND domain_id = $2) AS mb_cnt,
         (SELECT COUNT(*)::int FROM campaigns WHERE organization_id = $1 AND domain_id = $2 AND status IN ('draft', 'scheduled', 'running', 'paused')) AS camp_cnt,
         (SELECT COUNT(*)::int FROM messages WHERE organization_id = $1 AND domain_id = $2 AND state IN ('created', 'queued', 'processing', 'deferred')) AS msg_cnt`,
      [orgId, domainId]
    );
    const deps = depRes.rows[0] ?? {};
    const mailboxCount = Number(deps.mb_cnt ?? 0);
    const activeCampaignCount = Number(deps.camp_cnt ?? 0);
    const recentMessagesCount = Number(deps.msg_cnt ?? 0);

    if (!confirmCleanup && (mailboxCount > 0 || activeCampaignCount > 0 || recentMessagesCount > 0)) {
      return {
        deleted: false,
        blockingDependencies: { mailboxCount, activeCampaignCount, recentMessagesCount },
      };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE messages
            SET domain_id = NULL,
                campaign_id = CASE
                  WHEN campaign_id IN (SELECT id FROM campaigns WHERE organization_id = $1 AND domain_id = $2)
                    THEN NULL
                  ELSE campaign_id
                END
          WHERE organization_id = $1
            AND (domain_id = $2 OR campaign_id IN (SELECT id FROM campaigns WHERE organization_id = $1 AND domain_id = $2))`,
        [orgId, domainId]
      );
      await client.query(`DELETE FROM campaigns WHERE organization_id = $1 AND domain_id = $2`, [orgId, domainId]);
      const del = await client.query(`DELETE FROM domains WHERE organization_id = $1 AND id = $2`, [orgId, domainId]);
      await client.query('COMMIT');
      return { deleted: (del.rowCount ?? 0) > 0 };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

// ---------------------------------------------------------------------------
// PgMailboxStore
// ---------------------------------------------------------------------------

export class PgMailboxStore implements MailboxStore {
  constructor(private readonly pool: Pool) {}

  private async ensureDefaultMailboxServer(): Promise<string> {
    const existing = await this.pool.query(`SELECT id::text FROM mailbox_servers LIMIT 1`);
    if (existing.rows[0]?.id) {
      return existing.rows[0].id as string;
    }
    const id = uuidv7();
    const host = process.env.DOVECOT_LMTP_HOST || 'dovecot';
    const lmtpPort = Number(process.env.DOVECOT_LMTP_PORT || 24);
    const imapPort = Number(process.env.DOVECOT_IMAP_PORT || 143);
    const inserted = await this.pool.query(
      `INSERT INTO mailbox_servers (id, name, lmtp_host, lmtp_port, imap_host, imap_port, storage_path, status)
       VALUES ($1, 'dovecot-default', $2, $3, $2, $4, '/var/vmail', 'active')
       ON CONFLICT (name) DO UPDATE SET lmtp_host = EXCLUDED.lmtp_host
       RETURNING id::text`,
      [id, host, lmtpPort, imapPort]
    );
    return inserted.rows[0].id as string;
  }

  async listMailboxes(organizationId: string): Promise<MailboxRecord[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, domain_id::text, server_id::text,
              local_part::text, email_address::text, display_name, quota_bytes, used_bytes,
              status, is_catch_all, created_at
         FROM mailboxes
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      [organizationId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      domainId: r.domain_id,
      serverId: r.server_id,
      localPart: r.local_part,
      emailAddress: r.email_address,
      displayName: r.display_name,
      quotaBytes: Number(r.quota_bytes),
      usedBytes: Number(r.used_bytes),
      status: r.status,
      isCatchAll: r.is_catch_all,
      createdAt: iso(r.created_at),
    }));
  }

  async createMailbox(input: {
    organizationId: string;
    domainId: string;
    domainName: string;
    localPart: string;
    passwordHash: string;
    displayName: string;
    quotaBytes: number;
    isCatchAll: boolean;
  }): Promise<MailboxRecord> {
    const serverId = await this.ensureDefaultMailboxServer();
    const emailAddress = `${input.localPart.toLowerCase()}@${input.domainName.toLowerCase()}`;
    const id = uuidv7();
    try {
      const res = await this.pool.query(
        `INSERT INTO mailboxes (id, organization_id, domain_id, server_id, local_part, email_address, password_hash, display_name, quota_bytes, is_catch_all)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id::text, organization_id::text, domain_id::text, server_id::text,
                   local_part::text, email_address::text, display_name, quota_bytes, used_bytes,
                   status, is_catch_all, created_at`,
        [
          id,
          input.organizationId,
          input.domainId,
          serverId,
          input.localPart.toLowerCase(),
          emailAddress,
          input.passwordHash,
          input.displayName,
          input.quotaBytes,
          input.isCatchAll,
        ]
      );
      const r = res.rows[0];
      return {
        id: r.id,
        organizationId: r.organization_id,
        domainId: r.domain_id,
        serverId: r.server_id,
        localPart: r.local_part,
        emailAddress: r.email_address,
        displayName: r.display_name,
        quotaBytes: Number(r.quota_bytes),
        usedBytes: Number(r.used_bytes),
        status: r.status,
        isCatchAll: r.is_catch_all,
        createdAt: iso(r.created_at),
      };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'MAILBOX_EXISTS', `Mailbox ${emailAddress} already exists`);
      }
      throw err;
    }
  }

  async updateMailbox(
    organizationId: string,
    mailboxId: string,
    patch: { status?: 'active' | 'suspended'; quotaBytes?: number; isCatchAll?: boolean; passwordHash?: string }
  ): Promise<MailboxRecord | null> {
    const res = await this.pool.query(
      `UPDATE mailboxes
          SET status = COALESCE($3, status),
              quota_bytes = COALESCE($4, quota_bytes),
              is_catch_all = COALESCE($5, is_catch_all),
              password_hash = COALESCE($6, password_hash),
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text, organization_id::text, domain_id::text, server_id::text,
                 local_part::text, email_address::text, display_name, quota_bytes, used_bytes,
                 status, is_catch_all, created_at`,
      [
        organizationId,
        mailboxId,
        patch.status ?? null,
        patch.quotaBytes ?? null,
        patch.isCatchAll ?? null,
        patch.passwordHash ?? null,
      ]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      organizationId: r.organization_id,
      domainId: r.domain_id,
      serverId: r.server_id,
      localPart: r.local_part,
      emailAddress: r.email_address,
      displayName: r.display_name,
      quotaBytes: Number(r.quota_bytes),
      usedBytes: Number(r.used_bytes),
      status: r.status,
      isCatchAll: r.is_catch_all,
      createdAt: iso(r.created_at),
    };
  }

  async deleteMailbox(organizationId: string, mailboxId: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM mailboxes WHERE organization_id = $1 AND id = $2`,
      [organizationId, mailboxId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listAliases(organizationId: string): Promise<AliasRecord[]> {
    const res = await this.pool.query(
      `SELECT a.id::text, d.organization_id::text, a.domain_id::text, a.source_address::text,
              a.destination_addresses, a.is_active
         FROM mailbox_aliases a
         JOIN domains d ON d.id = a.domain_id
        WHERE d.organization_id = $1
        ORDER BY a.created_at DESC`,
      [organizationId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      domainId: r.domain_id,
      sourceAddress: r.source_address,
      destinationAddresses: r.destination_addresses ?? [],
      isActive: r.is_active,
    }));
  }

  async createAlias(input: {
    organizationId: string;
    domainId: string;
    sourceAddress: string;
    destinationAddresses: string[];
  }): Promise<AliasRecord> {
    const id = uuidv7();
    const src = input.sourceAddress.trim().toLowerCase();
    const dests = input.destinationAddresses.map((d) => d.trim().toLowerCase());
    await this.pool.query(
      `INSERT INTO mailbox_aliases (id, domain_id, source_address, destination_addresses, is_active)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [id, input.domainId, src, dests]
    );
    return {
      id,
      organizationId: input.organizationId,
      domainId: input.domainId,
      sourceAddress: src,
      destinationAddresses: dests,
      isActive: true,
    };
  }

  async listForwardingRules(organizationId: string, mailboxId: string): Promise<ForwardingRuleRecord[]> {
    const res = await this.pool.query(
      `SELECT f.id::text, m.organization_id::text, f.mailbox_id::text, f.forward_to_address::text,
              f.keep_local_copy, f.is_active
         FROM mailbox_forwarding_rules f
         JOIN mailboxes m ON m.id = f.mailbox_id
        WHERE m.organization_id = $1 AND f.mailbox_id = $2
        ORDER BY f.created_at DESC`,
      [organizationId, mailboxId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      mailboxId: r.mailbox_id,
      forwardToAddress: r.forward_to_address,
      keepLocalCopy: r.keep_local_copy,
      isActive: r.is_active,
    }));
  }

  async createForwardingRule(input: {
    organizationId: string;
    mailboxId: string;
    forwardToAddress: string;
    keepLocalCopy: boolean;
  }): Promise<ForwardingRuleRecord> {
    const id = uuidv7();
    const fwd = input.forwardToAddress.trim().toLowerCase();
    await this.pool.query(
      `INSERT INTO mailbox_forwarding_rules (id, mailbox_id, forward_to_address, keep_local_copy, is_active)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [id, input.mailboxId, fwd, input.keepLocalCopy]
    );
    return {
      id,
      organizationId: input.organizationId,
      mailboxId: input.mailboxId,
      forwardToAddress: fwd,
      keepLocalCopy: input.keepLocalCopy,
      isActive: true,
    };
  }
}

// ---------------------------------------------------------------------------
// PgCredentialsStore
// ---------------------------------------------------------------------------

export class PgCredentialsStore implements CredentialsStore {
  constructor(private readonly pool: Pool) {}

  async listApiKeys(orgId: string): Promise<Omit<ApiKeyRecord, 'keyHash'>[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, name, key_prefix, scopes, rate_limit_rpm, last_used_at, revoked_at, created_at
         FROM api_keys
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      [orgId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      name: r.name,
      keyPrefix: r.key_prefix,
      scopes: r.scopes ?? [],
      rateLimitRpm: Number(r.rate_limit_rpm),
      lastUsedAt: isoOrNull(r.last_used_at),
      revokedAt: isoOrNull(r.revoked_at),
      createdAt: iso(r.created_at),
    }));
  }

  async createApiKey(orgId: string, name: string, scopes: string[], rateLimitRpm: number) {
    const rawKey = `mk_live_${randomBytes(24).toString('base64url')}`;
    const keyHash = hashTokenSha256(rawKey);
    const id = uuidv7();
    const prefix = rawKey.slice(0, 14);
    const res = await this.pool.query(
      `INSERT INTO api_keys (id, organization_id, name, key_prefix, key_hash, scopes, rate_limit_rpm)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text, organization_id::text, name, key_prefix, scopes, rate_limit_rpm, last_used_at, revoked_at, created_at`,
      [id, orgId, name, prefix, keyHash, scopes, rateLimitRpm]
    );
    const r = res.rows[0];
    return {
      apiKey: {
        id: r.id,
        organizationId: r.organization_id,
        name: r.name,
        keyPrefix: r.key_prefix,
        scopes: r.scopes ?? [],
        rateLimitRpm: Number(r.rate_limit_rpm),
        lastUsedAt: isoOrNull(r.last_used_at),
        revokedAt: isoOrNull(r.revoked_at),
        createdAt: iso(r.created_at),
      },
      secret: rawKey,
    };
  }

  async rotateApiKey(orgId: string, id: string) {
    const existing = await this.pool.query(
      `SELECT name, scopes, rate_limit_rpm FROM api_keys WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL LIMIT 1`,
      [orgId, id]
    );
    const row = existing.rows[0];
    if (!row) return null;
    await this.pool.query(`UPDATE api_keys SET revoked_at = NOW() WHERE id = $1`, [id]);
    return this.createApiKey(orgId, row.name, row.scopes ?? [], Number(row.rate_limit_rpm));
  }

  async revokeApiKey(orgId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE api_keys SET revoked_at = NOW() WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [orgId, id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async findActiveByHash(keyHash: string) {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, scopes, rate_limit_rpm, revoked_at
         FROM api_keys
        WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1`,
      [keyHash]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id as string,
      organizationId: r.organization_id as string,
      scopes: (r.scopes ?? []) as string[],
      rateLimitRpm: Number(r.rate_limit_rpm),
      revokedAt: isoOrNull(r.revoked_at),
    };
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.pool.query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [id]);
  }

  async listSmtpCredentials(orgId: string): Promise<Omit<SmtpCredentialRecord, 'passwordHash'>[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, domain_id::text, username, allowed_sender_patterns,
              max_rate_per_min, last_used_at, failed_auth_count, revoked_at, created_at
         FROM smtp_credentials
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      [orgId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      domainId: r.domain_id ?? null,
      username: r.username,
      allowedSenderPatterns: r.allowed_sender_patterns ?? [],
      maxRatePerMin: Number(r.max_rate_per_min),
      lastUsedAt: isoOrNull(r.last_used_at),
      failedAuthCount: Number(r.failed_auth_count),
      revokedAt: isoOrNull(r.revoked_at),
      createdAt: iso(r.created_at),
    }));
  }

  async createSmtpCredential(input: {
    organizationId: string;
    domainId: string | null;
    allowedSenderPatterns: string[];
    maxRatePerMin: number;
  }) {
    const username = `smtp_${randomBytes(6).toString('hex')}`;
    const rawPassword = randomBytes(24).toString('base64url');
    const passwordHash = await hashPasswordArgon2id(rawPassword);
    const id = uuidv7();
    const res = await this.pool.query(
      `INSERT INTO smtp_credentials (id, organization_id, domain_id, username, password_hash, allowed_sender_patterns, max_rate_per_min)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text, organization_id::text, domain_id::text, username, allowed_sender_patterns,
                 max_rate_per_min, last_used_at, failed_auth_count, revoked_at, created_at`,
      [
        id,
        input.organizationId,
        input.domainId,
        username,
        passwordHash,
        input.allowedSenderPatterns,
        input.maxRatePerMin,
      ]
    );
    const r = res.rows[0];
    return {
      credential: {
        id: r.id,
        organizationId: r.organization_id,
        domainId: r.domain_id ?? null,
        username: r.username,
        allowedSenderPatterns: r.allowed_sender_patterns ?? [],
        maxRatePerMin: Number(r.max_rate_per_min),
        lastUsedAt: isoOrNull(r.last_used_at),
        failedAuthCount: Number(r.failed_auth_count),
        revokedAt: isoOrNull(r.revoked_at),
        createdAt: iso(r.created_at),
      },
      secretPassword: rawPassword,
    };
  }

  async rotateSmtpCredential(orgId: string, id: string) {
    const existing = await this.pool.query(
      `SELECT id::text, organization_id::text, domain_id::text, username, allowed_sender_patterns,
              max_rate_per_min, last_used_at, failed_auth_count, revoked_at, created_at
         FROM smtp_credentials
        WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL
        LIMIT 1`,
      [orgId, id]
    );
    const r = existing.rows[0];
    if (!r) return null;
    const rawPassword = randomBytes(24).toString('base64url');
    const passwordHash = await hashPasswordArgon2id(rawPassword);
    await this.pool.query(`UPDATE smtp_credentials SET password_hash = $2 WHERE id = $1`, [
      id,
      passwordHash,
    ]);
    return {
      credential: {
        id: r.id,
        organizationId: r.organization_id,
        domainId: r.domain_id ?? null,
        username: r.username,
        allowedSenderPatterns: r.allowed_sender_patterns ?? [],
        maxRatePerMin: Number(r.max_rate_per_min),
        lastUsedAt: isoOrNull(r.last_used_at),
        failedAuthCount: Number(r.failed_auth_count),
        revokedAt: isoOrNull(r.revoked_at),
        createdAt: iso(r.created_at),
      },
      secretPassword: rawPassword,
    };
  }

  async revokeSmtpCredential(orgId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE smtp_credentials SET revoked_at = NOW() WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [orgId, id]
    );
    return (res.rowCount ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------
// PgMarketingStore
// ---------------------------------------------------------------------------

export class PgMarketingStore implements MarketingStore {
  constructor(private readonly pool: Pool) {}

  async listTemplates(orgId: string): Promise<TemplateRecord[]> {
    const tRes = await this.pool.query(
      `SELECT id::text, organization_id::text, name, category, active_version, created_at
         FROM templates
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      [orgId]
    );
    const templates: TemplateRecord[] = [];
    for (const t of tRes.rows) {
      const vRes = await this.pool.query(
        `SELECT version_number, subject, html_body, text_body, created_at
           FROM template_versions
          WHERE template_id = $1
          ORDER BY version_number ASC`,
        [t.id]
      );
      templates.push({
        id: t.id,
        organizationId: t.organization_id,
        name: t.name,
        category: t.category,
        activeVersion: Number(t.active_version),
        versions: vRes.rows.map((v) => ({
          versionNumber: Number(v.version_number),
          subject: v.subject,
          htmlBody: v.html_body,
          textBody: v.text_body,
          createdAt: iso(v.created_at),
        })),
        createdAt: iso(t.created_at),
      });
    }
    return templates;
  }

  async createTemplate(input: {
    organizationId: string;
    name: string;
    category: string;
    subject: string;
    htmlBody: string;
    textBody: string;
  }): Promise<TemplateRecord> {
    const id = uuidv7();
    const versionId = uuidv7();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO templates (id, organization_id, name, category, active_version)
         VALUES ($1, $2, $3, $4, 1)`,
        [id, input.organizationId, input.name, input.category]
      );
      await client.query(
        `INSERT INTO template_versions (id, template_id, version_number, subject, html_body, text_body)
         VALUES ($1, $2, 1, $3, $4, $5)`,
        [versionId, id, input.subject, input.htmlBody, input.textBody]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    const now = new Date().toISOString();
    return {
      id,
      organizationId: input.organizationId,
      name: input.name,
      category: input.category,
      activeVersion: 1,
      versions: [
        {
          versionNumber: 1,
          subject: input.subject,
          htmlBody: input.htmlBody,
          textBody: input.textBody,
          createdAt: now,
        },
      ],
      createdAt: now,
    };
  }

  async duplicateTemplate(orgId: string, id: string): Promise<TemplateRecord | null> {
    const all = await this.listTemplates(orgId);
    const orig = all.find((t) => t.id === id);
    if (!orig) return null;
    const latest = orig.versions[orig.versions.length - 1];
    return this.createTemplate({
      organizationId: orgId,
      name: `${orig.name} (Copy)`,
      category: orig.category,
      subject: latest?.subject ?? '',
      htmlBody: latest?.htmlBody ?? '',
      textBody: latest?.textBody ?? '',
    });
  }

  async listContacts(orgId: string, tag?: string): Promise<ContactRecord[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, email::text, first_name, last_name, tags,
              consent_source, consented_at, unsubscribed_at
         FROM contacts
        WHERE organization_id = $1
          AND ($2::text IS NULL OR $2 = ANY(tags))
        ORDER BY created_at DESC`,
      [orgId, tag ?? null]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      email: r.email,
      firstName: r.first_name ?? '',
      lastName: r.last_name ?? '',
      tags: r.tags ?? [],
      consentSource: r.consent_source,
      consentedAt: iso(r.consented_at),
      unsubscribedAt: isoOrNull(r.unsubscribed_at),
    }));
  }

  async importContacts(
    orgId: string,
    rows: Array<{
      email: string;
      firstName?: string | undefined;
      lastName?: string | undefined;
      tags?: string[] | undefined;
      consentSource: string;
    }>
  ): Promise<{ imported: number; skippedSuppressed: number }> {
    const suppressedSet = new Set(
      (await this.listSuppressions(orgId)).map((s) => s.email.toLowerCase())
    );
    let imported = 0;
    let skippedSuppressed = 0;

    for (const row of rows) {
      const lower = row.email.trim().toLowerCase();
      if (suppressedSet.has(lower)) {
        skippedSuppressed += 1;
        continue;
      }
      await this.pool.query(
        `INSERT INTO contacts (id, organization_id, email, first_name, last_name, tags, consent_source, consented_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (organization_id, email) DO UPDATE
           SET first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
               last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
               tags = EXCLUDED.tags`,
        [
          uuidv7(),
          orgId,
          lower,
          row.firstName ?? '',
          row.lastName ?? '',
          row.tags ?? [],
          row.consentSource,
        ]
      );
      imported += 1;
    }

    return { imported, skippedSuppressed };
  }

  async listCampaigns(orgId: string): Promise<CampaignRecord[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, domain_id::text, template_version_id::text, name,
              status, timezone, scheduled_at, target_filter, stats_cache, created_at
         FROM campaigns
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      [orgId]
    );
    return res.rows.map((r) => {
      const tf = (r.target_filter ?? {}) as { templateId?: string; tagFilter?: string | null };
      const sc = (r.stats_cache ?? {}) as { targetCount?: number; sentCount?: number };
      return {
        id: r.id,
        organizationId: r.organization_id,
        domainId: r.domain_id,
        templateId: tf.templateId ?? r.template_version_id ?? '',
        name: r.name,
        status: r.status,
        timezone: r.timezone,
        scheduledAt: isoOrNull(r.scheduled_at),
        tagFilter: tf.tagFilter ?? null,
        targetCount: Number(sc.targetCount ?? 0),
        sentCount: Number(sc.sentCount ?? 0),
        createdAt: iso(r.created_at),
      };
    });
  }

  async createCampaign(input: {
    organizationId: string;
    domainId: string;
    templateId: string;
    name: string;
    timezone: string;
    scheduledAt: string | null;
    tagFilter: string | null;
  }): Promise<CampaignRecord> {
    const uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRx.test(input.domainId)) {
      throw new AppError(400, 'INVALID_DOMAIN', 'Select a valid registered sending domain');
    }
    if (!uuidRx.test(input.templateId)) {
      throw new AppError(400, 'INVALID_TEMPLATE', 'Select a valid saved template');
    }
    const domCheck = await this.pool.query(
      `SELECT 1 FROM domains WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [input.organizationId, input.domainId]
    );
    if ((domCheck.rowCount ?? 0) === 0) {
      throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Selected domain does not belong to your organization');
    }
    const tvRes = await this.pool.query(
      `SELECT tv.id::text
         FROM template_versions tv
         JOIN templates t ON t.id = tv.template_id
        WHERE t.organization_id = $1 AND t.id = $2
        ORDER BY tv.version_number DESC
        LIMIT 1`,
      [input.organizationId, input.templateId]
    );
    const tvId = (tvRes.rows[0]?.id as string | undefined) ?? null;

    const countRes = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM contacts c
        WHERE c.organization_id = $1
          AND c.unsubscribed_at IS NULL
          AND ($2::text IS NULL OR $2 = ANY(c.tags))
          AND NOT EXISTS (
            SELECT 1 FROM suppression_entries s
             WHERE (s.organization_id = $1 OR s.organization_id IS NULL)
               AND LOWER(s.email::text) = LOWER(c.email::text)
          )`,
      [input.organizationId, input.tagFilter]
    );
    const targetCount = Number(countRes.rows[0]?.cnt ?? 0);
    const status: CampaignRecord['status'] = input.scheduledAt ? 'scheduled' : 'draft';
    const id = uuidv7();
    const res = await this.pool.query(
      `INSERT INTO campaigns (id, organization_id, domain_id, template_version_id, name, status, timezone, scheduled_at, target_filter, stats_cache)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING created_at`,
      [
        id,
        input.organizationId,
        input.domainId,
        tvId,
        input.name,
        status,
        input.timezone,
        input.scheduledAt,
        JSON.stringify({ templateId: input.templateId, tagFilter: input.tagFilter }),
        JSON.stringify({ targetCount, sentCount: 0 }),
      ]
    );

    return {
      id,
      organizationId: input.organizationId,
      domainId: input.domainId,
      templateId: input.templateId,
      name: input.name,
      status,
      timezone: input.timezone,
      scheduledAt: input.scheduledAt,
      tagFilter: input.tagFilter,
      targetCount,
      sentCount: 0,
      createdAt: iso(res.rows[0].created_at),
    };
  }

  async transitionCampaign(
    orgId: string,
    id: string,
    status: CampaignRecord['status']
  ): Promise<CampaignRecord | null> {
    const res = await this.pool.query(
      `UPDATE campaigns SET status = $3, updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text`,
      [orgId, id, status]
    );
    if ((res.rowCount ?? 0) === 0) return null;
    const all = await this.listCampaigns(orgId);
    return all.find((c) => c.id === id) ?? null;
  }

  async markCampaignDispatched(orgId: string, id: string, sentCount: number): Promise<CampaignRecord | null> {
    const res = await this.pool.query(
      `UPDATE campaigns
          SET status = 'completed',
              stats_cache = jsonb_set(
                COALESCE(stats_cache, '{}'::jsonb),
                '{sentCount}',
                to_jsonb(COALESCE((stats_cache->>'sentCount')::int, 0) + $3)
              ),
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text`,
      [orgId, id, sentCount]
    );
    if ((res.rowCount ?? 0) === 0) return null;
    const all = await this.listCampaigns(orgId);
    return all.find((c) => c.id === id) ?? null;
  }

  async listSuppressions(orgId: string): Promise<SuppressionRecord[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, email::text, reason, created_at
         FROM suppression_entries
        WHERE organization_id = $1 OR organization_id IS NULL
        ORDER BY created_at DESC`,
      [orgId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id ?? orgId,
      email: r.email,
      reason: r.reason as SuppressionReason,
      createdAt: iso(r.created_at),
    }));
  }

  async addSuppression(
    orgId: string,
    email: string,
    reason: SuppressionReason
  ): Promise<SuppressionRecord> {
    const lower = email.trim().toLowerCase();
    const res = await this.pool.query(
      `INSERT INTO suppression_entries (id, organization_id, email, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::UUID), email)
       DO UPDATE SET reason = EXCLUDED.reason
       RETURNING id::text, organization_id::text, email::text, reason, created_at`,
      [uuidv7(), orgId, lower, reason]
    );
    await this.pool.query(
      `UPDATE contacts SET unsubscribed_at = COALESCE(unsubscribed_at, NOW())
        WHERE organization_id = $1 AND LOWER(email::text) = $2`,
      [orgId, lower]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      organizationId: r.organization_id,
      email: r.email,
      reason: r.reason as SuppressionReason,
      createdAt: iso(r.created_at),
    };
  }

  async removeSuppression(orgId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM suppression_entries WHERE organization_id = $1 AND id = $2`,
      [orgId, id]
    );
    return (res.rowCount ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------
// PgWebhookStore
// ---------------------------------------------------------------------------

export class PgWebhookStore implements WebhookStore {
  private readonly encKey: Buffer;

  constructor(
    private readonly pool: Pool,
    encryptionKeyMaterial: string
  ) {
    this.encKey = deriveSecretKey(encryptionKeyMaterial);
  }

  async listEndpoints(orgId: string): Promise<Omit<WebhookEndpointRecord, 'signingSecret'>[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, url, encrypted_signing_secret, event_types, is_active, created_at
         FROM webhooks
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      [orgId]
    );
    return res.rows.map((r) => {
      const secret = decryptStoredSecret(r.encrypted_signing_secret as Buffer, this.encKey);
      return {
        id: r.id,
        organizationId: r.organization_id,
        url: r.url,
        secretPrefix: secret.slice(0, 12),
        eventTypes: (r.event_types ?? []) as EmailEventType[],
        isActive: r.is_active,
        createdAt: iso(r.created_at),
      };
    });
  }

  async createEndpoint(orgId: string, url: string, eventTypes: EmailEventType[]) {
    const signingSecret = `whsec_${randomBytes(24).toString('base64url')}`;
    const encrypted = encryptSecret(signingSecret, this.encKey);
    const id = uuidv7();
    const res = await this.pool.query(
      `INSERT INTO webhooks (id, organization_id, url, encrypted_signing_secret, event_types, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING created_at`,
      [id, orgId, url, encrypted, eventTypes]
    );
    return {
      webhook: {
        id,
        organizationId: orgId,
        url,
        secretPrefix: signingSecret.slice(0, 12),
        eventTypes,
        isActive: true,
        createdAt: iso(res.rows[0].created_at),
      },
      signingSecret,
    };
  }

  async rotateSecret(orgId: string, id: string) {
    const existing = await this.pool.query(
      `SELECT id::text, organization_id::text, url, event_types, is_active, created_at
         FROM webhooks WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [orgId, id]
    );
    const r = existing.rows[0];
    if (!r) return null;
    const signingSecret = `whsec_${randomBytes(24).toString('base64url')}`;
    const encrypted = encryptSecret(signingSecret, this.encKey);
    await this.pool.query(
      `UPDATE webhooks SET encrypted_signing_secret = $2, previous_secret_expires_at = NOW() + INTERVAL '24 hours' WHERE id = $1`,
      [id, encrypted]
    );
    return {
      webhook: {
        id: r.id,
        organizationId: r.organization_id,
        url: r.url,
        secretPrefix: signingSecret.slice(0, 12),
        eventTypes: (r.event_types ?? []) as EmailEventType[],
        isActive: r.is_active,
        createdAt: iso(r.created_at),
      },
      signingSecret,
    };
  }

  async listDeliveries(orgId: string): Promise<WebhookDeliveryLog[]> {
    const res = await this.pool.query(
      `SELECT id::text, webhook_id::text, organization_id::text, event_type, attempt_count, http_status, status, created_at
         FROM webhook_delivery_logs
        WHERE organization_id = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [orgId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      webhookId: r.webhook_id,
      organizationId: r.organization_id,
      eventType: r.event_type as EmailEventType,
      attemptCount: Number(r.attempt_count),
      httpStatus: r.http_status !== null ? Number(r.http_status) : null,
      status: r.status,
      createdAt: iso(r.created_at),
    }));
  }

  async recordDelivery(log: WebhookDeliveryLog): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_delivery_logs (id, organization_id, webhook_id, event_type, url, status, http_status, attempt_count)
       SELECT $1, $2, $3, $4, w.url, $5, $6, $7 FROM webhooks w WHERE w.id = $3`,
      [log.id, log.organizationId, log.webhookId, log.eventType, log.status, log.httpStatus, log.attemptCount]
    );
  }
}

// ---------------------------------------------------------------------------
// PgAnalyticsStore
// ---------------------------------------------------------------------------

export class PgAnalyticsStore implements AnalyticsStore {
  constructor(private readonly pool: Pool) {}

  private resolveSqlWindow(range: DateRangePreset, from?: string, to?: string): { start: Date; end: Date } {
    const now = new Date();
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (range === 'today') return { start: startOfToday, end: now };
    if (range === 'yesterday') {
      return { start: new Date(startOfToday.getTime() - 86_400_000), end: startOfToday };
    }
    if (range === '7d') return { start: new Date(now.getTime() - 7 * 86_400_000), end: now };
    if (range === 'custom' && from && to) {
      return { start: new Date(from), end: new Date(to) };
    }
    return { start: new Date(now.getTime() - 30 * 86_400_000), end: now };
  }

  async recordEvent(input: {
    organizationId: string;
    messageId: string;
    recipientEmail: string;
    eventType: EmailEventType;
    domain: string;
    latencyMs?: number;
    campaignId?: string | null;
    detail?: string | null;
    createdAt?: string;
  }): Promise<EmailEventRecord> {
    const id = uuidv7();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const dbMessageId = uuidRx.test(input.messageId) ? input.messageId : uuidv7();
    await this.pool.query(
      `INSERT INTO email_events (id, organization_id, message_id, event_type, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        input.organizationId,
        dbMessageId,
        input.eventType,
        JSON.stringify({
          recipientEmail: input.recipientEmail.toLowerCase(),
          domain: input.domain.toLowerCase(),
          latencyMs: input.latencyMs ?? 0,
          campaignId: input.campaignId ?? null,
          detail: input.detail ?? null,
        }),
        createdAt,
      ]
    );
    return {
      id,
      organizationId: input.organizationId,
      messageId: input.messageId,
      recipientEmail: input.recipientEmail.toLowerCase(),
      eventType: input.eventType,
      domain: input.domain.toLowerCase(),
      latencyMs: input.latencyMs ?? 0,
      campaignId: input.campaignId ?? null,
      detail: input.detail ?? null,
      createdAt,
    };
  }

  async createTrackingToken(input: {
    organizationId: string;
    messageId: string;
    recipientEmail: string;
    kind: 'open' | 'click' | 'unsubscribe';
    targetUrl?: string | null;
  }): Promise<TrackingTokenRecord> {
    const token = randomBytes(18).toString('base64url');
    const createdAt = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO tracking_tokens (token, organization_id, message_id, recipient_email, kind, target_url, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        token,
        input.organizationId,
        input.messageId,
        input.recipientEmail.toLowerCase(),
        input.kind,
        input.targetUrl ?? null,
        createdAt,
      ]
    );
    return {
      token,
      organizationId: input.organizationId,
      messageId: input.messageId,
      recipientEmail: input.recipientEmail.toLowerCase(),
      kind: input.kind,
      targetUrl: input.targetUrl ?? null,
      createdAt,
    };
  }

  async getTrackingToken(token: string): Promise<TrackingTokenRecord | null> {
    const res = await this.pool.query(
      `SELECT token, organization_id::text, message_id::text, recipient_email::text, kind, target_url, created_at
         FROM tracking_tokens WHERE token = $1 LIMIT 1`,
      [token]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      token: r.token,
      organizationId: r.organization_id,
      messageId: r.message_id,
      recipientEmail: r.recipient_email,
      kind: r.kind,
      targetUrl: r.target_url ?? null,
      createdAt: iso(r.created_at),
    };
  }

  async queryEvents(
    orgId: string,
    opts: {
      range: DateRangePreset;
      from?: string;
      to?: string;
      eventType?: EmailEventType;
      recipient?: string;
    }
  ): Promise<EmailEventRecord[]> {
    const { start, end } = this.resolveSqlWindow(opts.range, opts.from, opts.to);
    const res = await this.pool.query(
      `SELECT e.id::text, e.organization_id::text, e.message_id::text, e.event_type, e.metadata, e.occurred_at,
              r.recipient_email::text AS rcpt_email
         FROM email_events e
         LEFT JOIN message_recipients r ON r.id = e.message_recipient_id
        WHERE e.organization_id = $1
          AND e.occurred_at >= $2
          AND e.occurred_at <= $3
          AND ($4::text IS NULL OR e.event_type = $4)
          AND ($5::text IS NULL OR LOWER(COALESCE(r.recipient_email::text, e.metadata->>'recipientEmail', '')) LIKE $5)
        ORDER BY e.occurred_at DESC
        LIMIT 500`,
      [
        orgId,
        start,
        end,
        opts.eventType ?? null,
        opts.recipient ? `%${opts.recipient.toLowerCase()}%` : null,
      ]
    );
    return res.rows.map((r) => {
      const m = (r.metadata ?? {}) as Record<string, unknown>;
      const email = (r.rcpt_email as string | null) ?? String(m.recipientEmail ?? 'unknown');
      return {
        id: r.id,
        organizationId: r.organization_id,
        messageId: r.message_id,
        recipientEmail: email,
        eventType: r.event_type as EmailEventType,
        domain: String(m.domain ?? email.split('@')[1] ?? 'unknown'),
        latencyMs: Number(m.latencyMs ?? m.durationMs ?? 0),
        campaignId: m.campaignId ? String(m.campaignId) : null,
        detail: m.detail ? String(m.detail) : null,
        createdAt: iso(r.occurred_at),
      };
    });
  }

  async getOverview(orgId: string, opts: { range: DateRangePreset; from?: string; to?: string }) {
    const filtered = await this.queryEvents(orgId, opts);
    const counts: Record<EmailEventType, number> = {
      accepted: 0,
      delivered: 0,
      deferred: 0,
      bounced: 0,
      rejected: 0,
      complained: 0,
      unsubscribed: 0,
      opened: 0,
      clicked: 0,
    };
    const byDay = new Map<
      string,
      { date: string; accepted: number; delivered: number; bounced: number; opened: number; clicked: number }
    >();
    let latencyTotal = 0;
    let latencyCount = 0;

    for (const ev of filtered) {
      counts[ev.eventType] = (counts[ev.eventType] ?? 0) + 1;
      if (ev.latencyMs > 0) {
        latencyTotal += ev.latencyMs;
        latencyCount += 1;
      }

      const dayKey = ev.createdAt.slice(0, 10);
      const bucket = byDay.get(dayKey) ?? {
        date: dayKey,
        accepted: 0,
        delivered: 0,
        bounced: 0,
        opened: 0,
        clicked: 0,
      };
      if (
        ev.eventType === 'accepted' ||
        ev.eventType === 'delivered' ||
        ev.eventType === 'bounced' ||
        ev.eventType === 'opened' ||
        ev.eventType === 'clicked'
      ) {
        bucket[ev.eventType] += 1;
      }
      byDay.set(dayKey, bucket);
    }

    const baseVolume = Math.max(counts.accepted, counts.delivered + counts.bounced + counts.deferred, 0);
    const deliveryRate = baseVolume > 0 ? Number(((counts.delivered / baseVolume) * 100).toFixed(2)) : 0;
    const bounceRate = baseVolume > 0 ? Number(((counts.bounced / baseVolume) * 100).toFixed(2)) : 0;
    const openRate = counts.delivered > 0 ? Number(((counts.opened / counts.delivered) * 100).toFixed(2)) : 0;
    const clickRate = counts.delivered > 0 ? Number(((counts.clicked / counts.delivered) * 100).toFixed(2)) : 0;
    const avgLatencyMs = latencyCount > 0 ? Math.round(latencyTotal / latencyCount) : 0;
    const series = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

    return {
      range: opts.range,
      totalEvents: filtered.length,
      counts,
      rates: {
        deliveryRate,
        bounceRate,
        openRate,
        clickRate,
      },
      avgLatencyMs,
      series,
    };
  }

  async exportCsv(
    orgId: string,
    opts: { range: DateRangePreset; from?: string; to?: string; eventType?: EmailEventType; recipient?: string }
  ): Promise<string> {
    const rows = await this.queryEvents(orgId, opts);
    const lines = ['id,createdAt,eventType,recipientEmail,domain,messageId,latencyMs,detail'];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          r.createdAt,
          r.eventType,
          r.recipientEmail,
          r.domain,
          r.messageId,
          String(r.latencyMs),
          JSON.stringify(r.detail ?? ''),
        ].join(',')
      );
    }
    return lines.join('\n');
  }

  private toDbPlanSlug(planId: BillingPlan['id']): string {
    if (planId === 'growth') return 'professional';
    if (planId === 'scale') return 'business';
    return planId;
  }

  private fromDbPlanSlug(slug: string | undefined): BillingPlan['id'] {
    if (slug === 'professional') return 'growth';
    if (slug === 'business') return 'scale';
    if (slug === 'starter' || slug === 'enterprise') return slug;
    return 'growth';
  }

  async getSubscription(orgId: string): Promise<{
    subscription: SubscriptionRecord;
    plan: BillingPlan;
    monthlyEmailsSent: number;
  }> {
    const res = await this.pool.query(
      `SELECT p.slug AS plan_slug, s.status, s.current_period_start, s.current_period_end
         FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.organization_id = $1
        LIMIT 1`,
      [orgId]
    );
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);

    const row = res.rows[0];
    const planCode = this.fromDbPlanSlug(row?.plan_slug as string | undefined);
    const plan = BILLING_PLANS.find((p) => p.id === planCode) ?? BILLING_PLANS[1]!;

    const cntRes = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM messages WHERE organization_id = $1 AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC')`,
      [orgId]
    );
    return {
      subscription: {
        organizationId: orgId,
        planId: plan.id,
        status: (row?.status as SubscriptionRecord['status'] | undefined) ?? 'active',
        currentPeriodStart: row ? iso(row.current_period_start) : start.toISOString(),
        currentPeriodEnd: row ? iso(row.current_period_end) : end.toISOString(),
      },
      plan,
      monthlyEmailsSent: Number(cntRes.rows[0]?.cnt ?? 0),
    };
  }

  async upgradePlan(orgId: string, planId: BillingPlan['id']) {
    const plan = BILLING_PLANS.find((p) => p.id === planId);
    if (!plan) {
      throw new AppError(404, 'PLAN_NOT_FOUND', 'Billing plan not found');
    }
    const dbSlug = this.toDbPlanSlug(planId);
    const planRow = await this.pool.query(`SELECT id::text FROM plans WHERE slug = $1 LIMIT 1`, [dbSlug]);
    let dbPlanId = planRow.rows[0]?.id as string | undefined;
    if (!dbPlanId) {
      dbPlanId = uuidv7();
      await this.pool.query(
        `INSERT INTO plans (id, slug, name, monthly_price_cents, annual_price_cents, included_emails, max_domains, max_mailboxes, max_storage_gb)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 50)`,
        [
          dbPlanId,
          dbSlug,
          plan.name,
          plan.monthlyPriceUsd * 100,
          plan.monthlyPriceUsd * 1000,
          plan.includedEmailsPerMonth,
          plan.maxDomains,
          plan.maxMailboxes,
        ]
      );
    }

    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);

    const updated = await this.pool.query(
      `UPDATE subscriptions SET plan_id = $2, status = 'active' WHERE organization_id = $1`,
      [orgId, dbPlanId]
    );
    if ((updated.rowCount ?? 0) === 0) {
      await this.pool.query(
        `INSERT INTO subscriptions (id, organization_id, plan_id, billing_cycle, status, current_period_start, current_period_end)
         VALUES ($1, $2, $3, 'monthly', 'active', $4, $5)`,
        [uuidv7(), orgId, dbPlanId, start, end]
      );
    }

    const invId = uuidv7();
    await this.pool.query(
      `INSERT INTO invoices (id, organization_id, amount_cents, currency, status, paid_at)
       VALUES ($1, $2, $3, 'USD', 'paid', NOW())`,
      [invId, orgId, plan.monthlyPriceUsd * 100]
    );
    const invoice: InvoiceRecord = {
      id: invId,
      organizationId: orgId,
      planId: plan.id,
      amountUsd: plan.monthlyPriceUsd,
      status: 'paid',
      issuedAt: new Date().toISOString(),
      periodLabel: new Date().toISOString().slice(0, 7),
    };
    const subSummary = await this.getSubscription(orgId);
    return { ...subSummary, invoice };
  }

  async listInvoices(orgId: string): Promise<InvoiceRecord[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, amount_cents, status, issued_at
         FROM invoices WHERE organization_id = $1 ORDER BY issued_at DESC LIMIT 50`,
      [orgId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      planId: 'growth',
      amountUsd: Math.round(Number(r.amount_cents) / 100),
      status: r.status === 'paid' ? 'paid' : 'open',
      issuedAt: iso(r.issued_at),
      periodLabel: iso(r.issued_at).slice(0, 7),
    }));
  }

  async getGlobalStats() {
    const res = await this.pool.query<{ event_type: EmailEventType; cnt: string }>(
      `SELECT event_type, COUNT(*)::text AS cnt
         FROM email_events
        WHERE occurred_at >= NOW() - INTERVAL '30 days'
        GROUP BY event_type`
    );
    const counts: Record<EmailEventType, number> = {
      accepted: 0,
      delivered: 0,
      deferred: 0,
      bounced: 0,
      rejected: 0,
      complained: 0,
      unsubscribed: 0,
      opened: 0,
      clicked: 0,
    };
    let totalEvents = 0;
    for (const r of res.rows) {
      const n = Number(r.cnt);
      counts[r.event_type] = n;
      totalEvents += n;
    }
    return { totalEvents, counts, avgLatencyMs: 0 };
  }
}
