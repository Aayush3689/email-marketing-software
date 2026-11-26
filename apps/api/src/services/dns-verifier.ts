import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import type {
  DnsCheckState,
  DnsRecordEvaluation,
  DomainHealthStatus,
  DomainNotification,
} from '@mail/shared-types';
import { extractNormalizedDkimPublicKeyBase64 } from './dkim-service.js';

export interface MxRecordValue {
  priority: number;
  exchange: string;
}

export interface DnsQueryResult<T> {
  records: T[];
  error: string | null;
}

export interface DnsLookupAdapter {
  resolveTxt(fqdn: string): Promise<DnsQueryResult<string>>;
  resolveMx(fqdn: string): Promise<DnsQueryResult<MxRecordValue>>;
  resolve4(fqdn: string): Promise<DnsQueryResult<string>>;
  resolve6(fqdn: string): Promise<DnsQueryResult<string>>;
  resolveCname(fqdn: string): Promise<DnsQueryResult<string>>;
  reverse(ip: string): Promise<DnsQueryResult<string>>;
  resolveTxtAt?(resolverIp: string, fqdn: string): Promise<DnsQueryResult<string>>;
  fetchMtaStsPolicy?(domain: string): Promise<{ ok: boolean; status: number | null; body: string | null; error: string | null }>;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatDnsError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'ENODATA' || e?.code === 'ENOTFOUND') return e.code;
  return e?.message ?? String(err);
}

function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::' || low === '::1') return true;
    if (low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) {
      return true;
    }
    return false;
  }
  return true;
}

export function createNodeDnsAdapter(timeoutMs = 3500): DnsLookupAdapter {
  const sys = new Resolver();

  const runTxt = async (resolver: Resolver, fqdn: string): Promise<DnsQueryResult<string>> => {
    try {
      const chunks = await withTimeout(resolver.resolveTxt(fqdn), timeoutMs, `TXT ${fqdn}`);
      return { records: chunks.map((parts) => parts.join('')), error: null };
    } catch (err) {
      const msg = formatDnsError(err);
      return { records: [], error: msg === 'ENODATA' || msg === 'ENOTFOUND' ? null : msg };
    }
  };

  return {
    resolveTxt: (fqdn) => runTxt(sys, fqdn),
    resolveTxtAt: async (resolverIp, fqdn) => {
      const custom = new Resolver();
      custom.setServers([resolverIp]);
      return runTxt(custom, fqdn);
    },
    resolveMx: async (fqdn) => {
      try {
        const res = await withTimeout(sys.resolveMx(fqdn), timeoutMs, `MX ${fqdn}`);
        return {
          records: res
            .map((r) => ({ priority: r.priority, exchange: r.exchange.replace(/\.$/, '').toLowerCase() }))
            .sort((a, b) => a.priority - b.priority),
          error: null,
        };
      } catch (err) {
        const msg = formatDnsError(err);
        return { records: [], error: msg === 'ENODATA' || msg === 'ENOTFOUND' ? null : msg };
      }
    },
    resolve4: async (fqdn) => {
      try {
        const res = await withTimeout(sys.resolve4(fqdn), timeoutMs, `A ${fqdn}`);
        return { records: res, error: null };
      } catch (err) {
        const msg = formatDnsError(err);
        return { records: [], error: msg === 'ENODATA' || msg === 'ENOTFOUND' ? null : msg };
      }
    },
    resolve6: async (fqdn) => {
      try {
        const res = await withTimeout(sys.resolve6(fqdn), timeoutMs, `AAAA ${fqdn}`);
        return { records: res, error: null };
      } catch (err) {
        const msg = formatDnsError(err);
        return { records: [], error: msg === 'ENODATA' || msg === 'ENOTFOUND' ? null : msg };
      }
    },
    resolveCname: async (fqdn) => {
      try {
        const res = await withTimeout(sys.resolveCname(fqdn), timeoutMs, `CNAME ${fqdn}`);
        return { records: res.map((h) => h.replace(/\.$/, '').toLowerCase()), error: null };
      } catch (err) {
        const msg = formatDnsError(err);
        return { records: [], error: msg === 'ENODATA' || msg === 'ENOTFOUND' ? null : msg };
      }
    },
    reverse: async (ip) => {
      try {
        const res = await withTimeout(sys.reverse(ip), timeoutMs, `PTR ${ip}`);
        return { records: res.map((h) => h.replace(/\.$/, '').toLowerCase()), error: null };
      } catch (err) {
        const msg = formatDnsError(err);
        return { records: [], error: msg === 'ENODATA' || msg === 'ENOTFOUND' ? null : msg };
      }
    },
    fetchMtaStsPolicy: async (domain) => {
      const host = `mta-sts.${domain}`;
      try {
        const ips = await withTimeout(sys.resolve4(host), timeoutMs, `A ${host}`).catch(() => []);
        if (ips.length === 0 || ips.some((ip) => isPrivateOrReservedIp(ip))) {
          return { ok: false, status: null, body: null, error: 'mta-sts host does not resolve to a public IPv4 address' };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(`https://${host}/.well-known/mta-sts.txt`, {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
          });
          const body = await res.text();
          return { ok: res.ok, status: res.status, body: body.slice(0, 4096), error: res.ok ? null : `HTTP ${res.status}` };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        return { ok: false, status: null, body: null, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export interface InfraDnsConfig {
  heloDomain: string;
  publicIp?: string | undefined;
  spfIncludeDomain?: string | undefined;
  trackingCnameTarget?: string | undefined;
}

export function getInfraDnsConfig(): InfraDnsConfig {
  return {
    heloDomain: (process.env.MAIL_HELO_DOMAIN || 'mx1.fastconnect.in').trim().toLowerCase(),
    publicIp: process.env.MAIL_PUBLIC_IP?.trim() || undefined,
    spfIncludeDomain: process.env.SPF_INCLUDE_DOMAIN?.trim().toLowerCase() || undefined,
    trackingCnameTarget:
      process.env.TRACKING_CNAME_TARGET?.trim().toLowerCase() ||
      (process.env.PRIMARY_DOMAIN ? `api.${process.env.PRIMARY_DOMAIN.trim().toLowerCase()}` : undefined),
  };
}

export interface SpfEvaluation {
  status: DnsCheckState;
  records: string[];
  lookupCount: number;
  authorizesInfra: boolean;
  duplicateFound: boolean;
  remediation: string;
}

export function evaluateSpfRecords(
  domain: string,
  txtRecords: string[],
  infra: InfraDnsConfig,
  resolvedHeloIps: string[] = []
): SpfEvaluation {
  const spfRecords = txtRecords.filter((r) => /^v=spf1(?:\s|$)/i.test(r.trim()));
  const expectedToken = infra.spfIncludeDomain
    ? `include:${infra.spfIncludeDomain}`
    : infra.publicIp
      ? `ip4:${infra.publicIp}`
      : `a:${infra.heloDomain}`;

  if (spfRecords.length === 0) {
    return {
      status: 'fail',
      records: [],
      lookupCount: 0,
      authorizesInfra: false,
      duplicateFound: false,
      remediation: `No SPF record found. Publish TXT on ${domain}: "v=spf1 ${expectedToken} -all"`,
    };
  }

  if (spfRecords.length > 1) {
    return {
      status: 'fail',
      records: spfRecords,
      lookupCount: 0,
      authorizesInfra: false,
      duplicateFound: true,
      remediation: `Multiple SPF records detected (${spfRecords.length}). RFC 7208 permits only one v=spf1 record — merge them into a single TXT record.`,
    };
  }

  const raw = spfRecords[0]!;
  const tokens = raw.trim().split(/\s+/);
  const validMechanismRx =
    /^(?:v=spf1|[+\-~?]?(?:all|ip4:[0-9./]+|ip6:[0-9a-fA-F:/]+|include:[^\s]+|a(?::[^\s/]+)?(?:\/\d+)?|mx(?::[^\s/]+)?(?:\/\d+)?|ptr(?::[^\s]+)?|exists:[^\s]+)|redirect=[^\s]+|exp=[^\s]+)$/i;

  const invalidTokens = tokens.filter((t) => !validMechanismRx.test(t));
  if (invalidTokens.length > 0) {
    return {
      status: 'fail',
      records: spfRecords,
      lookupCount: 0,
      authorizesInfra: false,
      duplicateFound: false,
      remediation: `Invalid SPF syntax token(s): ${invalidTokens.join(', ')}. Fix malformed mechanisms in your TXT record.`,
    };
  }

  let lookupCount = 0;
  for (const tok of tokens.slice(1)) {
    const clean = tok.replace(/^[+\-~?]/, '').toLowerCase();
    if (
      clean === 'a' ||
      clean.startsWith('a:') ||
      clean.startsWith('a/') ||
      clean === 'mx' ||
      clean.startsWith('mx:') ||
      clean.startsWith('mx/') ||
      clean.startsWith('include:') ||
      clean === 'ptr' ||
      clean.startsWith('ptr:') ||
      clean.startsWith('exists:') ||
      clean.startsWith('redirect=')
    ) {
      lookupCount += 1;
    }
  }

  const candidateIps = new Set<string>([
    ...(infra.publicIp ? [infra.publicIp] : []),
    ...resolvedHeloIps,
  ]);

  let authorizesInfra = false;
  for (const tok of tokens.slice(1)) {
    const low = tok.replace(/^[+\-~?]/, '').toLowerCase();
    if (infra.spfIncludeDomain && low === `include:${infra.spfIncludeDomain}`) {
      authorizesInfra = true;
    }
    if (low === `include:${infra.heloDomain}` || low === `a:${infra.heloDomain}`) {
      authorizesInfra = true;
    }
    if (low.startsWith('ip4:') || low.startsWith('ip6:')) {
      const cidr = low.slice(4);
      const baseIp = cidr.split('/')[0] ?? '';
      if (candidateIps.has(baseIp)) {
        authorizesInfra = true;
      }
    }
  }

  if (lookupCount > 10) {
    return {
      status: 'fail',
      records: spfRecords,
      lookupCount,
      authorizesInfra,
      duplicateFound: false,
      remediation: `SPF exceeds the RFC 7208 limit of 10 DNS lookups (${lookupCount} found). Flatten or remove unused include/mx/a mechanisms.`,
    };
  }

  if (!authorizesInfra) {
    return {
      status: 'fail',
      records: spfRecords,
      lookupCount,
      authorizesInfra: false,
      duplicateFound: false,
      remediation: `SPF record does not authorize FastConnect sending infrastructure (${expectedToken}). Add "${expectedToken}" to your SPF record.`,
    };
  }

  if (tokens.some((t) => t.toLowerCase() === '+all')) {
    return {
      status: 'warn',
      records: spfRecords,
      lookupCount,
      authorizesInfra,
      duplicateFound: false,
      remediation: 'SPF uses "+all", which allows any server to spoof your domain. Replace with "~all" or "-all".',
    };
  }

  if (lookupCount >= 8) {
    return {
      status: 'warn',
      records: spfRecords,
      lookupCount,
      authorizesInfra,
      duplicateFound: false,
      remediation: `SPF uses ${lookupCount}/10 DNS lookups (approaching the RFC 7208 limit). Avoid adding more include statements.`,
    };
  }

  return {
    status: 'pass',
    records: spfRecords,
    lookupCount,
    authorizesInfra: true,
    duplicateFound: false,
    remediation: '',
  };
}

export interface DmarcEvaluation {
  status: DnsCheckState;
  records: string[];
  policy: string | null;
  pct: number;
  aspf: 'r' | 's';
  adkim: 'r' | 's';
  rua: string | null;
  remediation: string;
}

export function evaluateDmarcRecords(
  domain: string,
  txtRecords: string[],
  authReady: { spfPass: boolean; dkimPass: boolean }
): DmarcEvaluation {
  const dmarcRecords = txtRecords.filter((r) => /^v=dmarc1(?:\s|;|$)/i.test(r.trim()));
  if (dmarcRecords.length === 0) {
    return {
      status: 'warn',
      records: [],
      policy: null,
      pct: 100,
      aspf: 'r',
      adkim: 'r',
      rua: null,
      remediation: `No DMARC record found at _dmarc.${domain}. Publish: "v=DMARC1; p=none; rua=mailto:dmarc@${domain}"`,
    };
  }

  if (dmarcRecords.length > 1) {
    return {
      status: 'fail',
      records: dmarcRecords,
      policy: null,
      pct: 100,
      aspf: 'r',
      adkim: 'r',
      rua: null,
      remediation: `Multiple DMARC records found at _dmarc.${domain} (${dmarcRecords.length}). RFC 7489 requires exactly one DMARC TXT record.`,
    };
  }

  const tags = new Map<string, string>();
  for (const part of dmarcRecords[0]!.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    tags.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }

  const policy = (tags.get('p') ?? '').toLowerCase();
  if (!['none', 'quarantine', 'reject'].includes(policy)) {
    return {
      status: 'fail',
      records: dmarcRecords,
      policy: policy || null,
      pct: 100,
      aspf: 'r',
      adkim: 'r',
      rua: tags.get('rua') ?? null,
      remediation: `DMARC record is missing a valid p= tag (none, quarantine, or reject).`,
    };
  }

  const pct = tags.has('pct') ? Number(tags.get('pct')) : 100;
  const aspf = (tags.get('aspf')?.toLowerCase() === 's' ? 's' : 'r') as 'r' | 's';
  const adkim = (tags.get('adkim')?.toLowerCase() === 's' ? 's' : 'r') as 'r' | 's';
  const rua = tags.get('rua') ?? null;

  if ((policy === 'quarantine' || policy === 'reject') && (!authReady.spfPass || !authReady.dkimPass)) {
    return {
      status: 'warn',
      records: dmarcRecords,
      policy,
      pct: Number.isFinite(pct) ? pct : 100,
      aspf,
      adkim,
      rua,
      remediation: `DMARC is enforcing p=${policy} while ${!authReady.dkimPass && !authReady.spfPass ? 'SPF and DKIM are' : !authReady.dkimPass ? 'DKIM is' : 'SPF is'} failing. Legitimate mail may be quarantined/rejected until alignment passes.`,
    };
  }

  if (policy === 'none') {
    return {
      status: 'warn',
      records: dmarcRecords,
      policy,
      pct: Number.isFinite(pct) ? pct : 100,
      aspf,
      adkim,
      rua,
      remediation: 'DMARC is in monitoring mode (p=none). Advance to p=quarantine or p=reject once SPF & DKIM pass consistently.',
    };
  }

  return {
    status: 'pass',
    records: dmarcRecords,
    policy,
    pct: Number.isFinite(pct) ? pct : 100,
    aspf,
    adkim,
    rua,
    remediation: '',
  };
}

export interface DomainAuditInput {
  domainName: string;
  verificationToken: string;
  ownershipVerifiedAt: string | null;
  sendingEnabled: boolean;
  hostingEnabled: boolean;
  isSuspended: boolean;
  activeDkimSelector: string | null;
  dkimKeys: Array<{
    id: string;
    selector: string;
    algorithm: 'rsa2048' | 'ed25519';
    dnsRecordName: string;
    publicKeyDnsTxt: string;
    status: 'active' | 'retiring' | 'revoked';
  }>;
  customReturnPathDomain: string | null;
  customTrackingDomain: string | null;
  dmarcPolicy: 'none' | 'quarantine' | 'reject';
  dmarcRua: string | null;
  dmarcRuf: string | null;
  dmarcPct: number;
  dmarcAspf: 'r' | 's';
  dmarcAdkim: 'r' | 's';
  mtaStsMode: 'none' | 'testing' | 'enforce';
  mtaStsMaxAge: number;
  tlsRptRua: string | null;
  bimiSelector: string;
  bimiLogoUrl: string | null;
  bimiVmcUrl: string | null;
  mtaLoadedSelectors?: string[] | undefined;
}

export interface FullDomainDnsDiagnostics {
  checkedAt: string;
  ownershipMatched: boolean;
  healthStatus: DomainHealthStatus;
  spfStatus: DnsCheckState;
  dkimStatus: DnsCheckState;
  dmarcStatus: DnsCheckState;
  mxStatus: DnsCheckState;
  ptrStatus: DnsCheckState;
  records: DnsRecordEvaluation[];
  verifiedDkimSelectors: string[];
  notifications: DomainNotification[];
}

export function buildExpectedDmarcValue(input: {
  domainName: string;
  dmarcPolicy: 'none' | 'quarantine' | 'reject';
  dmarcRua: string | null;
  dmarcRuf: string | null;
  dmarcPct: number;
  dmarcAspf: 'r' | 's';
  dmarcAdkim: 'r' | 's';
}): string {
  const parts = [`v=DMARC1`, `p=${input.dmarcPolicy}`];
  if (input.dmarcPct < 100) parts.push(`pct=${input.dmarcPct}`);
  if (input.dmarcAdkim === 's') parts.push('adkim=s');
  if (input.dmarcAspf === 's') parts.push('aspf=s');
  parts.push(`rua=${input.dmarcRua || `mailto:dmarc@${input.domainName}`}`);
  if (input.dmarcRuf) parts.push(`ruf=${input.dmarcRuf}`);
  return parts.join('; ');
}

export async function runFullDomainDiagnostics(
  input: DomainAuditInput,
  adapter: DnsLookupAdapter = createNodeDnsAdapter(Number(process.env.DNS_CHECK_TIMEOUT_MS || 3500)),
  infra: InfraDnsConfig = getInfraDnsConfig()
): Promise<FullDomainDnsDiagnostics> {
  const checkedAt = new Date().toISOString();
  const domain = input.domainName.toLowerCase();
  const verifyHost = `_mailplat-verify.${domain}`;
  const activeSel = input.activeDkimSelector || 'mp1';

  const [
    verifyTxtRes,
    apexTxtRes,
    mxRes,
    aRes,
    aaaaRes,
    heloARes,
    dmarcTxtRes,
    publicVerifyTxtRes,
    mtaStsTxtRes,
    tlsRptTxtRes,
    bimiTxtRes,
  ] = await Promise.all([
    adapter.resolveTxt(verifyHost),
    adapter.resolveTxt(domain),
    adapter.resolveMx(domain),
    adapter.resolve4(domain),
    adapter.resolve6(domain),
    adapter.resolve4(infra.heloDomain),
    adapter.resolveTxt(`_dmarc.${domain}`),
    adapter.resolveTxtAt ? adapter.resolveTxtAt('8.8.8.8', verifyHost).catch(() => null) : Promise.resolve(null),
    adapter.resolveTxt(`_mta-sts.${domain}`),
    adapter.resolveTxt(`_smtp._tls.${domain}`),
    adapter.resolveTxt(`${input.bimiSelector || 'default'}._bimi.${domain}`),
  ]);

  // 1. Ownership verification
  const sysVerifyMatched =
    verifyTxtRes.records.some((r) => r.includes(input.verificationToken)) ||
    apexTxtRes.records.some((r) => r.includes(input.verificationToken));
  const pubVerifyMatched =
    publicVerifyTxtRes?.records.some((r) => r.includes(input.verificationToken)) ?? sysVerifyMatched;
  const ownershipMatched = sysVerifyMatched;
  const ownershipStatus: DnsCheckState = ownershipMatched
    ? 'pass'
    : input.ownershipVerifiedAt
      ? 'warn'
      : 'fail';
  const ownershipPropagation: DnsRecordEvaluation['propagationStatus'] = ownershipMatched
    ? pubVerifyMatched
      ? 'propagated'
      : 'partial'
    : pubVerifyMatched
      ? 'partial'
      : verifyTxtRes.error
        ? 'error'
        : 'not_found';

  const records: DnsRecordEvaluation[] = [
    {
      id: 'ownership',
      category: 'ownership',
      type: 'TXT',
      host: verifyHost,
      expected: input.verificationToken,
      detected: verifyTxtRes.records,
      status: ownershipStatus,
      required: true,
      propagationStatus: ownershipPropagation,
      resolver: publicVerifyTxtRes ? 'system + 8.8.8.8' : 'system',
      error: verifyTxtRes.error,
      remediation: ownershipMatched
        ? ''
        : `Publish TXT record at ${verifyHost} with value "${input.verificationToken}" and allow DNS propagation.`,
      checkedAt,
    },
  ];

  // 2. SPF (apex + optional custom Return-Path)
  const spfTargetHost = input.customReturnPathDomain || domain;
  const spfRes =
    spfTargetHost === domain ? apexTxtRes : await adapter.resolveTxt(spfTargetHost);
  const spfEval = evaluateSpfRecords(spfTargetHost, spfRes.records, infra, heloARes.records);
  const expectedSpfToken = infra.spfIncludeDomain
    ? `include:${infra.spfIncludeDomain}`
    : infra.publicIp
      ? `ip4:${infra.publicIp}`
      : `a:${infra.heloDomain}`;

  records.push({
    id: 'spf',
    category: 'spf',
    type: 'TXT',
    host: spfTargetHost,
    expected: `v=spf1 ${expectedSpfToken} -all`,
    detected: spfEval.records.length > 0 ? spfEval.records : spfRes.records.filter((r) => r.toLowerCase().includes('spf')),
    status: spfEval.status,
    required: input.sendingEnabled,
    propagationStatus: spfEval.records.length > 0 ? 'propagated' : spfRes.error ? 'error' : 'not_found',
    resolver: 'system',
    error: spfRes.error,
    remediation: spfEval.remediation,
    checkedAt,
  });

  // 3. DKIM (check active + retiring keys)
  const nonRevokedKeys = input.dkimKeys.filter((k) => k.status !== 'revoked');
  const keysToCheck =
    nonRevokedKeys.length > 0
      ? nonRevokedKeys
      : [
          {
            id: 'expected-default',
            selector: activeSel,
            algorithm: 'rsa2048' as const,
            dnsRecordName: `${activeSel}._domainkey.${domain}`,
            publicKeyDnsTxt: 'v=DKIM1; k=rsa; p=<provisioned-on-key-generation>',
            status: 'active' as const,
          },
        ];

  const verifiedDkimSelectors: string[] = [];
  let activeDkimStatus: DnsCheckState = 'fail';

  const dkimLookups = await Promise.all(
    keysToCheck.map(async (k) => ({ key: k, txt: await adapter.resolveTxt(k.dnsRecordName) }))
  );

  for (const { key, txt } of dkimLookups) {
    const expectedNorm = extractNormalizedDkimPublicKeyBase64(key.publicKeyDnsTxt);
    const parsedRecords = txt.records.map((raw) => ({
      raw,
      parsed: extractNormalizedDkimPublicKeyBase64(raw),
    }));
    const validParsed = parsedRecords.filter((p) => p.parsed.validSyntax && p.parsed.canonicalPkcs1Base64);
    const distinctKeys = new Set(validParsed.map((p) => p.parsed.canonicalPkcs1Base64!));

    let matched = false;
    let errorDetail = txt.error;
    let remediation = '';

    if (txt.error) {
      const isTimeout = txt.error.toLowerCase().includes('timed out');
      errorDetail = isTimeout ? `DNS lookup timeout: ${txt.error}` : `DNS resolver failure: ${txt.error}`;
      remediation = isTimeout
        ? `DNS query timed out for ${key.dnsRecordName}. Retry verification or inspect authoritative nameservers.`
        : `DNS resolver error checking ${key.dnsRecordName}: ${txt.error}`;
    } else if (txt.records.length === 0) {
      remediation = `Record missing: publish TXT record at ${key.dnsRecordName} with value "${key.publicKeyDnsTxt}" (no spaces inside p=).`;
    } else if (validParsed.length === 0) {
      remediation = `Invalid DKIM TXT format at ${key.dnsRecordName}: found TXT record(s) without a valid v=DKIM1; p= RSA/Ed25519 public key.`;
    } else if (distinctKeys.size > 1 || (validParsed.length > 0 && validParsed.length < parsedRecords.length)) {
      remediation = `Multiple conflicting DKIM TXT records found at ${key.dnsRecordName}. Remove stale records so only one matching key remains.`;
    } else {
      const onlyKey = validParsed[0]!;
      const detectedCanonical = onlyKey.parsed.canonicalPkcs1Base64;
      if (expectedNorm.canonicalPkcs1Base64 && detectedCanonical === expectedNorm.canonicalPkcs1Base64) {
        matched = true;
      } else if (
        txt.records.length === 1 &&
        txt.records[0]!.replace(/\s+/g, '') === key.publicKeyDnsTxt.replace(/\s+/g, '')
      ) {
        matched = true;
      } else {
        const expFp = expectedNorm.sha256Fingerprint ? expectedNorm.sha256Fingerprint.slice(0, 16) : 'unknown';
        const detFp = onlyKey.parsed.sha256Fingerprint ? onlyKey.parsed.sha256Fingerprint.slice(0, 16) : 'unknown';
        remediation = `Wrong public key at ${key.dnsRecordName}: DNS key sha256:${detFp}... does not match active DB key sha256:${expFp}.... Update DNS TXT to match the active key.`;
      }
    }

    if (matched) verifiedDkimSelectors.push(key.selector);

    const status: DnsCheckState = matched ? 'pass' : key.status === 'active' ? 'fail' : 'warn';
    if (key.status === 'active') activeDkimStatus = status;

    records.push({
      id: `dkim-${key.selector}`,
      category: 'dkim',
      type: 'TXT',
      host: key.dnsRecordName,
      expected: key.publicKeyDnsTxt,
      detected: txt.records,
      status,
      required: key.status === 'active' && input.sendingEnabled,
      propagationStatus: txt.records.length > 0 ? 'propagated' : txt.error ? 'error' : 'not_found',
      resolver: 'system',
      error: errorDetail,
      remediation,
      checkedAt,
    });
  }

  // 4. DMARC
  const dmarcEval = evaluateDmarcRecords(domain, dmarcTxtRes.records, {
    spfPass: spfEval.status === 'pass',
    dkimPass: activeDkimStatus === 'pass',
  });
  records.push({
    id: 'dmarc',
    category: 'dmarc',
    type: 'TXT',
    host: `_dmarc.${domain}`,
    expected: buildExpectedDmarcValue(input),
    detected: dmarcEval.records,
    status: dmarcEval.status,
    required: false,
    propagationStatus: dmarcEval.records.length > 0 ? 'propagated' : dmarcTxtRes.error ? 'error' : 'not_found',
    resolver: 'system',
    error: dmarcTxtRes.error,
    remediation: dmarcEval.remediation,
    checkedAt,
  });

  // 5. MX + Target A/AAAA resolution
  const mxExpected = `10 ${infra.heloDomain}`;
  const mxTargets = mxRes.records.map((r) => `${r.priority} ${r.exchange}`);
  const mxMatchesInfra = mxRes.records.some((r) => r.exchange === infra.heloDomain);
  const mxTargetIps = mxRes.records[0] ? await adapter.resolve4(mxRes.records[0].exchange) : { records: [], error: null };
  let mxStatus: DnsCheckState;
  let mxRemediation = '';

  if (mxRes.records.length === 0) {
    mxStatus = input.hostingEnabled ? 'fail' : 'warn';
    mxRemediation = input.hostingEnabled
      ? `Inbound hosting is enabled, but no MX records were found for ${domain}. Publish MX "${mxExpected}".`
      : `No MX record found for ${domain}. Required only if you enable inbound mailbox hosting.`;
  } else if (!mxMatchesInfra) {
    mxStatus = input.hostingEnabled ? 'fail' : 'warn';
    mxRemediation = `MX points to ${mxTargets.join(', ')} instead of ${infra.heloDomain}. Update MX to "${mxExpected}" to route inbound mail to FastConnect.`;
  } else if (mxTargetIps.records.length === 0) {
    mxStatus = 'fail';
    mxRemediation = `MX target ${infra.heloDomain} has no A record in DNS.`;
  } else {
    mxStatus = 'pass';
  }

  records.push({
    id: 'mx',
    category: 'mx',
    type: 'MX',
    host: domain,
    expected: mxExpected,
    detected: mxTargets,
    status: mxStatus,
    required: input.hostingEnabled,
    propagationStatus: mxRes.records.length > 0 ? 'propagated' : mxRes.error ? 'error' : 'not_found',
    resolver: 'system',
    error: mxRes.error,
    remediation: mxRemediation,
    checkedAt,
  });

  // 6. A, AAAA, and PTR
  const ptrTargetIp = infra.publicIp || heloARes.records[0];
  const ptrRes = ptrTargetIp ? await adapter.reverse(ptrTargetIp) : { records: [], error: null };
  const ptrMatched = ptrRes.records.some((h) => h === infra.heloDomain);
  const ptrStatus: DnsCheckState = !ptrTargetIp
    ? 'warn'
    : ptrMatched
      ? 'pass'
      : 'fail';

  records.push({
    id: 'a',
    category: 'a',
    type: 'A',
    host: infra.heloDomain,
    expected: infra.publicIp ?? 'Valid IPv4 address for mail host',
    detected: heloARes.records,
    status: heloARes.records.length > 0 && (!infra.publicIp || heloARes.records.includes(infra.publicIp)) ? 'pass' : 'fail',
    required: true,
    propagationStatus: heloARes.records.length > 0 ? 'propagated' : 'not_found',
    resolver: 'system',
    error: heloARes.error,
    remediation: heloARes.records.length > 0 ? '' : `Publish an A record for ${infra.heloDomain}.`,
    checkedAt,
  });

  records.push({
    id: 'domain-a',
    category: 'a',
    type: 'A',
    host: domain,
    expected: 'IPv4 A record (optional for mail-only subdomains)',
    detected: aRes.records,
    status: aRes.records.length > 0 ? 'pass' : 'warn',
    required: false,
    propagationStatus: aRes.records.length > 0 ? 'propagated' : 'not_found',
    resolver: 'system',
    error: aRes.error,
    remediation: aRes.records.length > 0 ? '' : `No A record found on ${domain} (optional unless hosting web/root services).`,
    checkedAt,
  });

  records.push({
    id: 'aaaa',
    category: 'aaaa',
    type: 'AAAA',
    host: domain,
    expected: 'IPv6 AAAA record (optional)',
    detected: aaaaRes.records,
    status: 'pass',
    required: false,
    propagationStatus: aaaaRes.records.length > 0 ? 'propagated' : 'not_found',
    resolver: 'system',
    error: aaaaRes.error,
    remediation: '',
    checkedAt,
  });

  records.push({
    id: 'ptr',
    category: 'ptr',
    type: 'PTR',
    host: ptrTargetIp ?? infra.heloDomain,
    expected: infra.heloDomain,
    detected: ptrRes.records,
    status: ptrStatus,
    required: false,
    propagationStatus: ptrRes.records.length > 0 ? 'propagated' : ptrRes.error ? 'error' : 'not_found',
    resolver: 'system',
    error: ptrRes.error,
    remediation: ptrMatched
      ? ''
      : `Set reverse DNS (PTR) for ${ptrTargetIp ?? 'your sending IP'} to ${infra.heloDomain} with your cloud provider.`,
    checkedAt,
  });

  // 7. Custom Return-Path MX (when configured)
  if (input.customReturnPathDomain) {
    const rpMx = await adapter.resolveMx(input.customReturnPathDomain);
    const rpOk = rpMx.records.some((r) => r.exchange === infra.heloDomain);
    records.push({
      id: 'return-path-mx',
      category: 'return_path',
      type: 'MX',
      host: input.customReturnPathDomain,
      expected: `10 ${infra.heloDomain}`,
      detected: rpMx.records.map((r) => `${r.priority} ${r.exchange}`),
      status: rpOk ? 'pass' : 'fail',
      required: true,
      propagationStatus: rpMx.records.length > 0 ? 'propagated' : 'not_found',
      resolver: 'system',
      error: rpMx.error,
      remediation: rpOk
        ? ''
        : `Publish MX "${`10 ${infra.heloDomain}`}" on custom Return-Path domain ${input.customReturnPathDomain} to receive DSN bounces.`,
      checkedAt,
    });
  }

  // 8. Custom Tracking Domain CNAME (when configured)
  if (input.customTrackingDomain) {
    const cnameRes = await adapter.resolveCname(input.customTrackingDomain);
    const expectedCname = infra.trackingCnameTarget || infra.heloDomain;
    const cnameOk = cnameRes.records.includes(expectedCname);
    records.push({
      id: 'tracking-cname',
      category: 'cname',
      type: 'CNAME',
      host: input.customTrackingDomain,
      expected: expectedCname,
      detected: cnameRes.records,
      status: cnameOk ? 'pass' : 'fail',
      required: false,
      propagationStatus: cnameRes.records.length > 0 ? 'propagated' : 'not_found',
      resolver: 'system',
      error: cnameRes.error,
      remediation: cnameOk ? '' : `Create CNAME ${input.customTrackingDomain} -> ${expectedCname}.`,
      checkedAt,
    });
  }

  // 9. MTA-STS (when enabled or already published)
  if (input.mtaStsMode !== 'none' || mtaStsTxtRes.records.length > 0) {
    const hasStsTxt = mtaStsTxtRes.records.some((r) => /^v=STSv1;/i.test(r.trim()));
    const policyFetch = adapter.fetchMtaStsPolicy
      ? await adapter.fetchMtaStsPolicy(domain)
      : { ok: false, status: null, body: null, error: 'HTTP probe disabled' };
    const policyValid = Boolean(
      hasStsTxt &&
        policyFetch.ok &&
        policyFetch.body &&
        /version:\s*STSv1/i.test(policyFetch.body) &&
        new RegExp(`mode:\\s*${input.mtaStsMode === 'none' ? '(testing|enforce|none)' : input.mtaStsMode}`, 'i').test(policyFetch.body)
    );
    records.push({
      id: 'mta-sts',
      category: 'mta_sts',
      type: 'TXT',
      host: `_mta-sts.${domain}`,
      expected: `v=STSv1; id=${checkedAt.slice(0, 10).replaceAll('-', '')}01`,
      detected: [
        ...mtaStsTxtRes.records,
        ...(policyFetch.body ? [`https://mta-sts.${domain}/.well-known/mta-sts.txt (${policyFetch.status})`] : []),
      ],
      status: policyValid ? 'pass' : hasStsTxt ? 'warn' : 'fail',
      required: false,
      propagationStatus: hasStsTxt ? 'propagated' : 'not_found',
      resolver: 'system + https',
      error: mtaStsTxtRes.error ?? policyFetch.error,
      remediation: policyValid
        ? ''
        : `Publish _mta-sts.${domain} TXT ("v=STSv1; id=...") and serve HTTPS policy at https://mta-sts.${domain}/.well-known/mta-sts.txt.`,
      checkedAt,
    });
  }

  // 10. TLS-RPT
  if (input.tlsRptRua || tlsRptTxtRes.records.length > 0) {
    const tlsRptOk = tlsRptTxtRes.records.some((r) => /^v=TLSRPTv1;\s*rua=/i.test(r.trim()));
    records.push({
      id: 'tls-rpt',
      category: 'tls_rpt',
      type: 'TXT',
      host: `_smtp._tls.${domain}`,
      expected: `v=TLSRPTv1; rua=${input.tlsRptRua || `mailto:tlsrpt@${domain}`}`,
      detected: tlsRptTxtRes.records,
      status: tlsRptOk ? 'pass' : 'warn',
      required: false,
      propagationStatus: tlsRptTxtRes.records.length > 0 ? 'propagated' : 'not_found',
      resolver: 'system',
      error: tlsRptTxtRes.error,
      remediation: tlsRptOk ? '' : `Publish TXT at _smtp._tls.${domain} with "v=TLSRPTv1; rua=${input.tlsRptRua || `mailto:tlsrpt@${domain}`}".`,
      checkedAt,
    });
  }

  // 11. BIMI (strictly optional, requires DMARC enforcement at pct=100)
  if (input.bimiLogoUrl || bimiTxtRes.records.length > 0) {
    const bimiSel = input.bimiSelector || 'default';
    const bimiHost = `${bimiSel}._bimi.${domain}`;
    const bimiExpected = `v=BIMI1; l=${input.bimiLogoUrl ?? ''}${input.bimiVmcUrl ? `; a=${input.bimiVmcUrl}` : ''}`;
    const hasBimiTxt = bimiTxtRes.records.some((r) => /^v=BIMI1;\s*l=https:\/\//i.test(r.trim()));
    const dmarcEnforcedForBimi =
      (dmarcEval.policy === 'quarantine' || dmarcEval.policy === 'reject') && dmarcEval.pct === 100;

    records.push({
      id: 'bimi',
      category: 'bimi',
      type: 'TXT',
      host: bimiHost,
      expected: bimiExpected,
      detected: bimiTxtRes.records,
      status: hasBimiTxt && dmarcEnforcedForBimi ? 'pass' : 'warn',
      required: false,
      propagationStatus: bimiTxtRes.records.length > 0 ? 'propagated' : 'not_found',
      resolver: 'system',
      error: bimiTxtRes.error,
      remediation: !dmarcEnforcedForBimi
        ? 'BIMI requires DMARC p=quarantine or p=reject at pct=100 before mailbox providers display your SVG logo.'
        : hasBimiTxt
          ? ''
          : `Publish TXT at ${bimiHost} with "${bimiExpected}".`,
      checkedAt,
    });
  }

  // Overall health status
  let healthStatus: DomainHealthStatus;
  if (input.isSuspended) {
    healthStatus = 'suspended';
  } else if (!input.sendingEnabled && !input.hostingEnabled) {
    healthStatus = 'disabled';
  } else if (!input.ownershipVerifiedAt && !ownershipMatched) {
    healthStatus = 'pending_verification';
  } else if (
    (input.sendingEnabled && (spfEval.status === 'fail' || activeDkimStatus === 'fail')) ||
    (input.hostingEnabled && mxStatus === 'fail')
  ) {
    healthStatus = 'dns_misconfigured';
  } else if (
    dmarcEval.status !== 'pass' ||
    ptrStatus === 'fail' ||
    (!ownershipMatched && Boolean(input.ownershipVerifiedAt))
  ) {
    healthStatus = 'auth_incomplete';
  } else {
    healthStatus = 'verified';
  }

  // Actionable notifications
  const notifications: DomainNotification[] = [];
  if (input.isSuspended) {
    notifications.push({
      id: 'notif-suspended',
      severity: 'error',
      code: 'DOMAIN_SUSPENDED',
      title: 'Domain is suspended',
      message: 'Platform administrators have suspended sending and inbound hosting for this domain.',
      recommendedAction: 'Contact platform operations in Admin Console to review and clear suspension.',
      targetTab: 'overview',
    });
  }
  if (!ownershipMatched && !input.ownershipVerifiedAt) {
    notifications.push({
      id: 'notif-ownership',
      severity: 'warning',
      code: 'OWNERSHIP_PENDING',
      title: 'Domain ownership verification pending',
      message: `TXT record ${verifyHost} has not been verified in live DNS yet.`,
      recommendedAction: `Add TXT ${verifyHost} = "${input.verificationToken}" and click Verify Ownership.`,
      targetTab: 'dns',
    });
  }
  if (spfEval.duplicateFound) {
    notifications.push({
      id: 'notif-spf-dup',
      severity: 'error',
      code: 'SPF_DUPLICATE',
      title: 'Multiple SPF records detected',
      message: `${spfEval.records.length} v=spf1 records exist on ${spfTargetHost}, causing RFC 7208 PermError.`,
      recommendedAction: 'Merge all mechanisms into a single v=spf1 TXT record.',
      targetTab: 'dns',
    });
  } else if (spfEval.status === 'fail') {
    notifications.push({
      id: 'notif-spf-fail',
      severity: 'error',
      code: 'SPF_INVALID_OR_MISSING',
      title: spfEval.records.length === 0 ? 'SPF record is missing' : 'SPF record does not authorize FastConnect',
      message: spfEval.remediation,
      recommendedAction: `Update ${spfTargetHost} TXT to include ${expectedSpfToken}.`,
      targetTab: 'dns',
    });
  }
  if (activeDkimStatus === 'fail') {
    notifications.push({
      id: 'notif-dkim-mismatch',
      severity: 'error',
      code: 'DKIM_DNS_MISMATCH',
      title: 'Published DKIM record missing or does not match active selector',
      message: `Selector "${activeSel}" is not matched at ${activeSel}._domainkey.${domain}.`,
      recommendedAction: `Publish the exact RSA public key TXT at ${activeSel}._domainkey.${domain}.`,
      targetTab: 'dns',
    });
  }
  if (
    input.mtaLoadedSelectors &&
    input.sendingEnabled &&
    !input.mtaLoadedSelectors.includes(activeSel)
  ) {
    notifications.push({
      id: 'notif-mta-desync',
      severity: 'warning',
      code: 'MTA_SELECTOR_DESYNC',
      title: 'Rust MTA does not have the active DKIM selector loaded',
      message: `Expected active selector "${activeSel}" in Rust mail-engine, currently loaded: ${input.mtaLoadedSelectors.join(', ') || 'none'}.`,
      recommendedAction: 'Trigger DKIM selector sync or rotate DKIM key to reload the MTA keyring.',
      targetTab: 'deliverability',
    });
  }
  if (dmarcEval.records.length === 0) {
    notifications.push({
      id: 'notif-dmarc-missing',
      severity: 'warning',
      code: 'DMARC_MISSING',
      title: 'DMARC record is missing',
      message: `No DMARC policy published at _dmarc.${domain}. Mailbox providers increasingly require DMARC.`,
      recommendedAction: `Publish _dmarc.${domain} starting with p=none and rua reporting.`,
      targetTab: 'dns',
    });
  } else if (dmarcEval.status === 'warn') {
    notifications.push({
      id: 'notif-dmarc-warn',
      severity: 'warning',
      code: 'DMARC_ADVISORY',
      title: `DMARC policy notice (p=${dmarcEval.policy ?? 'unknown'})`,
      message: dmarcEval.remediation,
      recommendedAction: 'Review SPF & DKIM alignment before advancing DMARC enforcement.',
      targetTab: 'dns',
    });
  }
  if (input.hostingEnabled && mxStatus === 'fail') {
    notifications.push({
      id: 'notif-mx-fail',
      severity: 'error',
      code: 'MX_MISCONFIGURED',
      title: 'Inbound MX record points to an unexpected destination',
      message: mxRemediation,
      recommendedAction: `Set MX on ${domain} to "${mxExpected}".`,
      targetTab: 'hosting',
    });
  }
  if (ptrStatus === 'fail') {
    notifications.push({
      id: 'notif-ptr-fail',
      severity: 'warning',
      code: 'PTR_MISMATCH',
      title: 'Reverse DNS (PTR) mismatch',
      message: `Sending IP ${ptrTargetIp} resolves to "${ptrRes.records.join(', ') || 'none'}" instead of "${infra.heloDomain}".`,
      recommendedAction: `Update Elastic IP / server reverse DNS to ${infra.heloDomain}.`,
      targetTab: 'deliverability',
    });
  }

  return {
    checkedAt,
    ownershipMatched,
    healthStatus,
    spfStatus: spfEval.status,
    dkimStatus: activeDkimStatus,
    dmarcStatus: dmarcEval.status,
    mxStatus,
    ptrStatus,
    records,
    verifiedDkimSelectors,
    notifications,
  };
}

export function diffDnsSnapshots(
  prev: DnsRecordEvaluation[] | undefined,
  next: DnsRecordEvaluation[]
): string[] {
  if (!prev || prev.length === 0) {
    return ['Initial DNS snapshot recorded'];
  }
  const prevMap = new Map(prev.map((r) => [r.id, r]));
  const changes: string[] = [];
  for (const r of next) {
    const old = prevMap.get(r.id);
    if (!old) {
      changes.push(`Added check ${r.type} ${r.host} (${r.status})`);
      continue;
    }
    if (old.status !== r.status) {
      changes.push(`${r.type} ${r.host} status: ${old.status} -> ${r.status}`);
    }
    const oldDet = [...old.detected].sort().join('|');
    const newDet = [...r.detected].sort().join('|');
    if (oldDet !== newDet) {
      changes.push(`${r.type} ${r.host} records updated (${r.detected.length} value(s))`);
    }
  }
  return changes.length > 0 ? changes : ['No DNS record changes detected'];
}
