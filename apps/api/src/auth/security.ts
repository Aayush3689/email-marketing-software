import { createHash, randomBytes } from 'node:crypto';
import type { AppSurface, OrganizationRole, PlatformRole } from '@mail/shared-types';
import argon2 from 'argon2';
import type { NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { AppError } from '../middleware/error-handler.js';

export interface AccessTokenClaims {
  sub: string;
  email: string;
  platformRole: PlatformRole;
  orgId: string | null;
  orgRole: OrganizationRole | null;
  mfaVerified: boolean;
  appSurface?: AppSurface;
  authMethod?: 'jwt' | 'api_key';
  scopes?: string[];
}

export async function hashPasswordArgon2id(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyPasswordArgon2id(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(48).toString('base64url');
  const hash = hashTokenSha256(raw);
  return { raw, hash };
}

export function hashTokenSha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttlSeconds = 900
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const surface = claims.appSurface ?? 'web';
  return new SignJWT({
    email: claims.email,
    platformRole: claims.platformRole,
    orgId: claims.orgId,
    orgRole: claims.orgRole,
    mfaVerified: claims.mfaVerified,
    appSurface: surface,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setAudience(surface)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifyAccessToken(
  token: string,
  secret: string
): Promise<AccessTokenClaims> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
  if (!payload.sub || typeof payload.email !== 'string') {
    throw new AppError(401, 'INVALID_TOKEN', 'Malformed access token');
  }
  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  const surface = (typeof payload.appSurface === 'string'
    ? payload.appSurface
    : typeof aud === 'string'
      ? aud
      : 'web') as AppSurface;

  return {
    sub: payload.sub,
    email: payload.email,
    platformRole: (payload.platformRole as PlatformRole) ?? 'none',
    orgId: typeof payload.orgId === 'string' ? payload.orgId : null,
    orgRole: (payload.orgRole as OrganizationRole | null) ?? null,
    mfaVerified: Boolean(payload.mfaVerified),
    appSurface: surface,
    authMethod: 'jwt',
  };
}

declare global {
  namespace Express {
    interface Request {
      auth?: AccessTokenClaims;
    }
  }
}

export function requireAuth(jwtSecret: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('authorization');
    if (!header || !header.startsWith('Bearer ')) {
      next(new AppError(401, 'UNAUTHORIZED', 'Missing Bearer token'));
      return;
    }
    const token = header.slice(7).trim();
    try {
      req.auth = await verifyAccessToken(token, jwtSecret);
      next();
    } catch {
      next(new AppError(401, 'UNAUTHORIZED', 'Invalid or expired access token'));
    }
  };
}

export function requireOrgRole(allowedRoles: readonly OrganizationRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (!auth) {
      next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
      return;
    }
    if (auth.platformRole === 'super_admin') {
      next();
      return;
    }
    if (!auth.orgId || !auth.orgRole || !allowedRoles.includes(auth.orgRole)) {
      next(new AppError(403, 'FORBIDDEN', 'Insufficient organization permissions'));
      return;
    }
    next();
  };
}

export interface ApiKeyLookupResult {
  id: string;
  organizationId: string;
  scopes: string[];
  rateLimitRpm: number;
  revokedAt: string | null;
}

export interface ApiKeyAuthenticator {
  findActiveByHash(keyHash: string): Promise<ApiKeyLookupResult | null> | ApiKeyLookupResult | null;
  touchLastUsed?(id: string): Promise<void> | void;
}

export function requireAuthOrApiKey(deps: {
  jwtSecret?: string | undefined;
  apiKeys?: ApiKeyAuthenticator | undefined;
  requiredScope: string;
  allowedOrgRoles?: readonly OrganizationRole[];
}) {
  const rpmBuckets = new Map<string, { windowStartMs: number; count: number }>();

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('authorization');
    if (!header || !header.startsWith('Bearer ')) {
      next(new AppError(401, 'UNAUTHORIZED', 'Bearer token or mk_live_* API key required'));
      return;
    }

    const token = header.slice(7).trim();
    if (token.startsWith('mk_live_')) {
      if (!deps.apiKeys) {
        next(new AppError(401, 'UNAUTHORIZED', 'API key authentication not configured'));
        return;
      }
      const keyHash = hashTokenSha256(token);
      const keyRec = await deps.apiKeys.findActiveByHash(keyHash);
      if (!keyRec || keyRec.revokedAt !== null) {
        next(new AppError(401, 'INVALID_API_KEY', 'Invalid or revoked API key'));
        return;
      }
      if (!keyRec.scopes.includes(deps.requiredScope) && !keyRec.scopes.includes('*')) {
        next(new AppError(403, 'INSUFFICIENT_SCOPE', `API key lacks required scope: ${deps.requiredScope}`));
        return;
      }

      // Sliding 1-minute per-key rate limit window (with bounded cleanup)
      const now = Date.now();
      if (rpmBuckets.size > 50_000) rpmBuckets.clear();
      const bucket = rpmBuckets.get(keyRec.id);
      if (!bucket || now - bucket.windowStartMs >= 60_000) {
        rpmBuckets.set(keyRec.id, { windowStartMs: now, count: 1 });
      } else if (bucket.count >= keyRec.rateLimitRpm) {
        next(new AppError(429, 'RATE_LIMIT_EXCEEDED', 'API key per-minute rate limit exceeded'));
        return;
      } else {
        bucket.count += 1;
      }

      if (deps.apiKeys.touchLastUsed) {
        void Promise.resolve(deps.apiKeys.touchLastUsed(keyRec.id)).catch(() => undefined);
      }

      req.auth = {
        sub: `apikey:${keyRec.id}`,
        email: `apikey:${keyRec.id}`,
        platformRole: 'none',
        orgId: keyRec.organizationId,
        orgRole: 'developer',
        mfaVerified: false,
        appSurface: 'web',
        authMethod: 'api_key',
        scopes: keyRec.scopes,
      };
      next();
      return;
    }

    if (!deps.jwtSecret) {
      next(new AppError(401, 'UNAUTHORIZED', 'JWT authentication not configured'));
      return;
    }
    try {
      const claims = await verifyAccessToken(token, deps.jwtSecret);
      const allowedRoles = deps.allowedOrgRoles ?? ['owner', 'admin', 'developer'];
      if (
        claims.platformRole !== 'super_admin' &&
        (!claims.orgId || !claims.orgRole || !allowedRoles.includes(claims.orgRole))
      ) {
        next(new AppError(403, 'FORBIDDEN', 'Insufficient organization permissions'));
        return;
      }
      req.auth = claims;
      next();
    } catch {
      next(new AppError(401, 'UNAUTHORIZED', 'Invalid or expired access token'));
    }
  };
}

export function requireSuperAdmin() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (!auth) {
      next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
      return;
    }
    if (auth.platformRole !== 'super_admin' && auth.platformRole !== 'platform_operator') {
      next(new AppError(403, 'FORBIDDEN', 'Platform operator privileges required'));
      return;
    }
    if (auth.appSurface !== 'admin') {
      next(new AppError(403, 'FORBIDDEN', 'Admin surface session required'));
      return;
    }
    if (!auth.mfaVerified) {
      next(new AppError(403, 'MFA_REQUIRED', 'MFA verification required for admin access'));
      return;
    }
    next();
  };
}
