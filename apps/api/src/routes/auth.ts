import { randomUUID } from 'node:crypto';
import type { AppSurface, OrganizationRole, PlatformRole } from '@mail/shared-types';
import { emailAddressSchema } from '@mail/validation';
import { Router } from 'express';
import { z } from 'zod';
import {
  generateRefreshToken,
  hashPasswordArgon2id,
  hashTokenSha256,
  requireAuth,
  signAccessToken,
  verifyPasswordArgon2id,
} from '../auth/security.js';
import { buildOtpAuthUri, generateTotpSecret, verifyTotpCode } from '../auth/totp.js';
import { AppError } from '../middleware/error-handler.js';
import { uuidv7 } from '../utils/uuidv7.js';

export interface UserAccount {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string;
  status: 'active' | 'suspended';
  platformRole: PlatformRole;
  orgId: string | null;
  orgRole: OrganizationRole | null;
  mfaEnabled: boolean;
  totpSecret?: string | null;
  lastTotpStep?: number | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  appSurface: AppSurface;
  refreshTokenHash: string;
  tokenFamilyId: string;
  mfaVerified: boolean;
  expiresAt: number;
  revokedAt: number | null;
}

export interface AuthStore {
  findUserByEmail(email: string): Promise<UserAccount | null>;
  findUserById(userId: string): Promise<UserAccount | null>;
  listUsers?(): Promise<UserAccount[]>;
  updateUser?(
    userId: string,
    patch: { status?: 'active' | 'suspended'; platformRole?: PlatformRole }
  ): Promise<UserAccount | null>;
  setUserTotpSecret?(userId: string, secret: string, enableMfa: boolean): Promise<void>;
  createUserAndOrg(input: {
    email: string;
    fullName: string;
    passwordHash: string;
    organizationName: string;
  }): Promise<UserAccount>;
  createSession(session: SessionRecord): Promise<void>;
  findSessionByHash(hash: string): Promise<SessionRecord | null>;
  revokeSession(sessionId: string): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;
  revokeUserSessions?(userId: string): Promise<number>;
}

export class InMemoryAuthStore implements AuthStore {
  private readonly users = new Map<string, UserAccount>();
  private readonly sessions = new Map<string, SessionRecord>();

  seedUser(user: UserAccount): void {
    this.users.set(user.id, user);
  }

  async findUserByEmail(email: string): Promise<UserAccount | null> {
    const lower = email.toLowerCase();
    return [...this.users.values()].find((u) => u.email.toLowerCase() === lower) ?? null;
  }

  async findUserById(userId: string): Promise<UserAccount | null> {
    return this.users.get(userId) ?? null;
  }

  async listUsers(): Promise<UserAccount[]> {
    return [...this.users.values()];
  }

  async updateUser(
    userId: string,
    patch: { status?: 'active' | 'suspended'; platformRole?: PlatformRole }
  ): Promise<UserAccount | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    if (patch.status !== undefined) user.status = patch.status;
    if (patch.platformRole !== undefined) user.platformRole = patch.platformRole;
    return user;
  }

  async setUserTotpSecret(userId: string, secret: string, enableMfa: boolean): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;
    user.totpSecret = secret;
    if (enableMfa) {
      user.mfaEnabled = true;
    }
  }

  async createUserAndOrg(input: {
    email: string;
    fullName: string;
    passwordHash: string;
    organizationName: string;
  }): Promise<UserAccount> {
    if (await this.findUserByEmail(input.email)) {
      throw new AppError(409, 'EMAIL_EXISTS', 'Account with this email already exists');
    }
    const user: UserAccount = {
      id: randomUUID(),
      email: input.email.toLowerCase(),
      fullName: input.fullName,
      passwordHash: input.passwordHash,
      status: 'active',
      platformRole: 'none',
      orgId: randomUUID(),
      orgRole: 'owner',
      mfaEnabled: false,
    };
    this.users.set(user.id, user);
    return user;
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async findSessionByHash(hash: string): Promise<SessionRecord | null> {
    return [...this.sessions.values()].find((s) => s.refreshTokenHash === hash) ?? null;
  }

  async revokeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.revokedAt = Date.now();
  }

  async revokeFamily(familyId: string): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.tokenFamilyId === familyId && s.revokedAt === null) {
        s.revokedAt = Date.now();
      }
    }
  }

  async revokeUserSessions(userId: string): Promise<number> {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.userId === userId && s.revokedAt === null) {
        s.revokedAt = Date.now();
        count += 1;
      }
    }
    return count;
  }
}

const registerSchema = z.object({
  email: emailAddressSchema,
  password: z.string().min(10).max(128),
  fullName: z.string().min(2).max(100),
  organizationName: z.string().min(2).max(100),
});

const loginSchema = z.object({
  email: emailAddressSchema,
  password: z.string().min(1).max(128),
  appSurface: z.enum(['web', 'mail', 'admin']).default('web'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20),
});

export function createAuthRouter(deps: {
  store: AuthStore;
  jwtSecret: string;
}): Router {
  const router = Router();
  const loginFailures = new Map<string, { count: number; lockedUntil: number }>();
  const mfaFailures = new Map<string, { count: number; lockedUntil: number }>();

  const pruneOldFailures = (map: Map<string, { count: number; lockedUntil: number }>) => {
    if (map.size > 20_000) {
      const now = Date.now();
      for (const [k, v] of map) {
        if (v.lockedUntil > 0 && v.lockedUntil < now) map.delete(k);
      }
      if (map.size > 20_000) map.clear();
    }
  };

  router.post('/auth/register', async (req, res) => {
    const parsed = registerSchema.parse(req.body);
    const passwordHash = await hashPasswordArgon2id(parsed.password);
    const user = await deps.store.createUserAndOrg({
      email: parsed.email,
      fullName: parsed.fullName,
      passwordHash,
      organizationName: parsed.organizationName,
    });

    const refresh = generateRefreshToken();
    const familyId = uuidv7();
    await deps.store.createSession({
      id: uuidv7(),
      userId: user.id,
      appSurface: 'web',
      refreshTokenHash: refresh.hash,
      tokenFamilyId: familyId,
      mfaVerified: false,
      expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
      revokedAt: null,
    });

    const accessToken = await signAccessToken(
      {
        sub: user.id,
        email: user.email,
        platformRole: user.platformRole,
        orgId: user.orgId,
        orgRole: user.orgRole,
        mfaVerified: false,
        appSurface: 'web',
      },
      deps.jwtSecret
    );

    res.status(201).json({
      accessToken,
      refreshToken: refresh.raw,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        orgId: user.orgId,
        orgRole: user.orgRole,
      },
    });
  });

  router.post('/auth/login', async (req, res) => {
    const parsed = loginSchema.parse(req.body);
    pruneOldFailures(loginFailures);
    const ipKey = `${req.ip ?? 'unknown'}:${parsed.email.toLowerCase()}`;
    const lock = loginFailures.get(ipKey);
    if (lock && lock.lockedUntil > Date.now()) {
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed login attempts; try again later');
    }

    const user = await deps.store.findUserByEmail(parsed.email);
    const valid = user ? await verifyPasswordArgon2id(user.passwordHash, parsed.password) : false;

    if (!user || !valid || user.status !== 'active') {
      const prev = loginFailures.get(ipKey) ?? { count: 0, lockedUntil: 0 };
      const nextCount = prev.count + 1;
      loginFailures.set(ipKey, {
        count: nextCount,
        lockedUntil: nextCount >= 5 ? Date.now() + 60_000 : 0,
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    loginFailures.delete(ipKey);

    const refresh = generateRefreshToken();
    const familyId = uuidv7();
    // Never grant MFA-verified sessions via password alone for platform operators or MFA-enrolled accounts.
    const mfaVerified =
      !user.mfaEnabled && user.platformRole === 'none' && parsed.appSurface !== 'admin';
    await deps.store.createSession({
      id: uuidv7(),
      userId: user.id,
      appSurface: parsed.appSurface,
      refreshTokenHash: refresh.hash,
      tokenFamilyId: familyId,
      mfaVerified,
      expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
      revokedAt: null,
    });

    const accessToken = await signAccessToken(
      {
        sub: user.id,
        email: user.email,
        platformRole: user.platformRole,
        orgId: user.orgId,
        orgRole: user.orgRole,
        mfaVerified,
        appSurface: parsed.appSurface,
      },
      deps.jwtSecret
    );

    res.json({
      accessToken,
      refreshToken: refresh.raw,
      mfaRequired: user.platformRole !== 'none' || user.mfaEnabled,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        platformRole: user.platformRole,
        orgId: user.orgId,
        orgRole: user.orgRole,
      },
    });
  });

  router.post('/auth/logout', async (req, res) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (parsed.success) {
      const hash = hashTokenSha256(parsed.data.refreshToken);
      const existing = await deps.store.findSessionByHash(hash);
      if (existing) {
        await deps.store.revokeFamily(existing.tokenFamilyId);
      }
    }
    res.status(204).send();
  });

  router.post('/auth/refresh', async (req, res) => {
    const parsed = refreshSchema.parse(req.body);
    const incomingHash = hashTokenSha256(parsed.refreshToken);
    const existing = await deps.store.findSessionByHash(incomingHash);

    if (!existing) {
      throw new AppError(401, 'INVALID_REFRESH', 'Invalid refresh token');
    }
    if (existing.revokedAt !== null) {
      // Refresh-token reuse detected -> revoke entire token family
      await deps.store.revokeFamily(existing.tokenFamilyId);
      throw new AppError(401, 'TOKEN_REUSE_DETECTED', 'Refresh token reuse detected; session revoked');
    }
    if (existing.expiresAt <= Date.now()) {
      throw new AppError(401, 'REFRESH_EXPIRED', 'Refresh token expired');
    }

    const user = await deps.store.findUserById(existing.userId);
    if (!user || user.status !== 'active') {
      throw new AppError(401, 'UNAUTHORIZED', 'Account inactive');
    }

    await deps.store.revokeSession(existing.id);
    const nextRefresh = generateRefreshToken();
    await deps.store.createSession({
      id: uuidv7(),
      userId: user.id,
      appSurface: existing.appSurface,
      refreshTokenHash: nextRefresh.hash,
      tokenFamilyId: existing.tokenFamilyId,
      mfaVerified: existing.mfaVerified,
      expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
      revokedAt: null,
    });

    const accessToken = await signAccessToken(
      {
        sub: user.id,
        email: user.email,
        platformRole: user.platformRole,
        orgId: user.orgId,
        orgRole: user.orgRole,
        mfaVerified: existing.mfaVerified,
        appSurface: existing.appSurface,
      },
      deps.jwtSecret
    );

    res.json({ accessToken, refreshToken: nextRefresh.raw });
  });

  router.get('/auth/me', requireAuth(deps.jwtSecret), async (req, res) => {
    const user = await deps.store.findUserById(req.auth!.sub);
    res.json({
      auth: req.auth,
      user: user
        ? {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            platformRole: user.platformRole,
            orgId: user.orgId,
            orgRole: user.orgRole,
            mfaEnabled: user.mfaEnabled,
          }
        : null,
    });
  });

  router.post('/auth/mfa/enroll', requireAuth(deps.jwtSecret), async (req, res) => {
    const user = await deps.store.findUserById(req.auth!.sub);
    if (!user || user.status !== 'active') {
      throw new AppError(401, 'UNAUTHORIZED', 'Account inactive');
    }
    if (user.mfaEnabled && !req.auth?.mfaVerified) {
      throw new AppError(
        403,
        'MFA_ALREADY_ENABLED',
        'Verify your active MFA factor before re-enrolling'
      );
    }
    const secret = generateTotpSecret();
    if (deps.store.setUserTotpSecret) {
      await deps.store.setUserTotpSecret(user.id, secret, false);
    } else {
      user.totpSecret = secret;
    }
    res.json({
      secret,
      otpauthUri: buildOtpAuthUri(user.email, 'MailForge Admin', secret),
      mfaEnabled: user.mfaEnabled,
    });
  });

  router.post('/auth/mfa/verify', requireAuth(deps.jwtSecret), async (req, res) => {
    const body = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter 6-digit TOTP code') }).parse(req.body);
    pruneOldFailures(mfaFailures);
    const mfaKey = req.auth!.sub;
    const mfaLock = mfaFailures.get(mfaKey);
    if (mfaLock && mfaLock.lockedUntil > Date.now()) {
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many invalid TOTP attempts; try again later');
    }

    const user = await deps.store.findUserById(req.auth!.sub);
    if (!user || user.status !== 'active') {
      throw new AppError(401, 'UNAUTHORIZED', 'Account inactive');
    }
    if (!user.totpSecret) {
      throw new AppError(400, 'MFA_NOT_ENROLLED', 'Enroll TOTP MFA before verifying');
    }

    const nowMs = Date.now();
    const currentStep = Math.floor(nowMs / 1000 / 30);
    if (!verifyTotpCode(user.totpSecret, body.code, nowMs)) {
      const prev = mfaFailures.get(mfaKey) ?? { count: 0, lockedUntil: 0 };
      const nextCount = prev.count + 1;
      mfaFailures.set(mfaKey, {
        count: nextCount,
        lockedUntil: nextCount >= 5 ? nowMs + 300_000 : 0,
      });
      throw new AppError(401, 'INVALID_MFA_CODE', 'Invalid or expired TOTP verification code');
    }
    if (user.lastTotpStep !== undefined && user.lastTotpStep !== null && user.lastTotpStep >= currentStep) {
      throw new AppError(401, 'TOTP_REPLAYED', 'This TOTP code has already been used; wait for the next code');
    }

    mfaFailures.delete(mfaKey);
    user.lastTotpStep = currentStep;

    if (deps.store.setUserTotpSecret) {
      await deps.store.setUserTotpSecret(user.id, user.totpSecret, true);
    } else {
      user.mfaEnabled = true;
    }

    const targetSurface = req.auth?.appSurface ?? 'admin';
    const refresh = generateRefreshToken();
    await deps.store.createSession({
      id: uuidv7(),
      userId: user.id,
      appSurface: targetSurface,
      refreshTokenHash: refresh.hash,
      tokenFamilyId: uuidv7(),
      mfaVerified: true,
      expiresAt: Date.now() + 8 * 3600 * 1000,
      revokedAt: null,
    });

    const accessToken = await signAccessToken(
      {
        sub: user.id,
        email: user.email,
        platformRole: user.platformRole,
        orgId: user.orgId,
        orgRole: user.orgRole,
        mfaVerified: true,
        appSurface: targetSurface,
      },
      deps.jwtSecret,
      900
    );

    res.json({
      accessToken,
      refreshToken: refresh.raw,
      mfaVerified: true,
    });
  });

  return router;
}
