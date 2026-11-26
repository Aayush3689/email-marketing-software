import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';

const DEFAULT_DEV_KEK_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export interface DkimKekRing {
  activeVersion: number;
  keys: Map<number, Buffer>;
}

function validateKekHex(hexRaw: string, versionLabel: string, isProd: boolean): Buffer {
  const raw = hexRaw.trim();
  if (!raw) {
    throw new Error(`Missing DKIM KEK (${versionLabel})`);
  }
  if (isProd && raw.toLowerCase() === DEFAULT_DEV_KEK_HEX) {
    throw new Error(`${versionLabel} must not use the default development key in production`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${versionLabel} must be exactly 64 hex characters (32 bytes)`);
  }
  return Buffer.from(raw, 'hex');
}

/**
 * Resolves all configured versioned DKIM Key Encryption Keys from environment variables:
 * - `DKIM_KEK_HEX` -> version 1 (if `DKIM_KEK_V1_HEX` is not explicitly set)
 * - `DKIM_KEK_V<N>_HEX` for any `N >= 1`
 * - `DKIM_KEK_KEYS` formatted as `1:<64hex>,2:<64hex>`
 * - `DKIM_KEK_ACTIVE_VERSION` (defaults to highest configured version)
 */
export function resolveDkimKekRing(env: NodeJS.ProcessEnv = process.env): DkimKekRing {
  const isProd = env.NODE_ENV === 'production';
  const rawByVersion = new Map<number, string>();

  if (env.DKIM_KEK_HEX?.trim()) {
    rawByVersion.set(1, env.DKIM_KEK_HEX.trim());
  }

  if (env.DKIM_KEK_KEYS?.trim()) {
    for (const entry of env.DKIM_KEK_KEYS.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(':');
      if (idx <= 0) {
        throw new Error('Invalid DKIM_KEK_KEYS format; expected "<version>:<64-hex>"');
      }
      const verRaw = trimmed.slice(0, idx).trim().replace(/^v/i, '');
      const ver = Number(verRaw);
      if (!Number.isInteger(ver) || ver < 1) {
        throw new Error(`Invalid KEK version "${verRaw}" in DKIM_KEK_KEYS`);
      }
      rawByVersion.set(ver, trimmed.slice(idx + 1).trim());
    }
  }

  for (const [k, v] of Object.entries(env)) {
    const match = /^DKIM_KEK_V(\d+)_HEX$/.exec(k);
    if (match && v?.trim()) {
      const ver = Number(match[1]);
      if (Number.isInteger(ver) && ver >= 1) {
        rawByVersion.set(ver, v.trim());
      }
    }
  }

  if (rawByVersion.size === 0) {
    if (isProd) {
      throw new Error('DKIM_KEK_HEX or DKIM_KEK_KEYS is required in production');
    }
    rawByVersion.set(1, DEFAULT_DEV_KEK_HEX);
  }

  const keys = new Map<number, Buffer>();
  let highestVersion = 1;
  for (const [ver, hexVal] of rawByVersion.entries()) {
    keys.set(ver, validateKekHex(hexVal, `DKIM_KEK_V${ver}`, isProd));
    if (ver > highestVersion) highestVersion = ver;
  }

  let activeVersion = highestVersion;
  if (env.DKIM_KEK_ACTIVE_VERSION?.trim()) {
    const parsedActive = Number(env.DKIM_KEK_ACTIVE_VERSION.trim());
    if (!Number.isInteger(parsedActive) || !keys.has(parsedActive)) {
      throw new Error(`DKIM_KEK_ACTIVE_VERSION=${env.DKIM_KEK_ACTIVE_VERSION} does not reference a loaded KEK version`);
    }
    activeVersion = parsedActive;
  }

  return { activeVersion, keys };
}

export function resolveDkimKek(hexOverride?: string): Buffer {
  if (hexOverride !== undefined) {
    return validateKekHex(hexOverride, 'DKIM_KEK_HEX', process.env.NODE_ENV === 'production');
  }
  const ring = resolveDkimKekRing();
  const active = ring.keys.get(ring.activeVersion);
  if (!active) {
    throw new Error('Active DKIM KEK missing from ring');
  }
  return active;
}

/**
 * Encrypts DER private key bytes using AES-256-GCM (`nonce_12B || ciphertext || tag_16B`),
 * matching `crates/dkim/src/lib.rs::encrypt_private_key`.
 */
export function encryptDkimPrivateKey(kek: Buffer, privateDer: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const ciphertext = Buffer.concat([cipher.update(privateDer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]);
}

/**
 * Encrypts using the active version of a `DkimKekRing`, returning both ciphertext and version tag.
 */
export function encryptDkimPrivateKeyVersioned(
  ring: DkimKekRing,
  privateDer: Buffer
): { keyEncryptionVersion: number; encryptedPrivateKey: Buffer } {
  const kek = ring.keys.get(ring.activeVersion);
  if (!kek) {
    throw new Error(`Missing KEK for activeVersion=${ring.activeVersion}`);
  }
  return {
    keyEncryptionVersion: ring.activeVersion,
    encryptedPrivateKey: encryptDkimPrivateKey(kek, privateDer),
  };
}

/**
 * Decrypts AES-256-GCM DKIM private key payload (`nonce_12B || ciphertext || tag_16B`)
 * without exposing plaintext outside caller scope.
 */
export function decryptDkimPrivateKey(kek: Buffer, encrypted: Buffer): Buffer {
  if (encrypted.length <= 28) {
    throw new Error('Encrypted DKIM key payload is malformed');
  }
  const iv = encrypted.subarray(0, 12);
  const tag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(12, encrypted.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function decryptDkimPrivateKeyVersioned(
  ring: DkimKekRing,
  keyEncryptionVersion: number,
  encrypted: Buffer
): Buffer {
  const kek = ring.keys.get(keyEncryptionVersion);
  if (!kek) {
    throw new Error(`Missing KEK for key_encryption_version=${keyEncryptionVersion}`);
  }
  return decryptDkimPrivateKey(kek, encrypted);
}

/**
 * Re-encrypts an encrypted DKIM private key from `fromVersion` to `targetVersion` (defaults to `ring.activeVersion`).
 */
export function reencryptDkimPrivateKey(
  ring: DkimKekRing,
  fromVersion: number,
  encrypted: Buffer,
  targetVersion: number = ring.activeVersion
): { keyEncryptionVersion: number; encryptedPrivateKey: Buffer } {
  const targetKek = ring.keys.get(targetVersion);
  if (!targetKek) {
    throw new Error(`Missing target KEK version=${targetVersion}`);
  }
  const plain = decryptDkimPrivateKeyVersioned(ring, fromVersion, encrypted);
  try {
    return {
      keyEncryptionVersion: targetVersion,
      encryptedPrivateKey: encryptDkimPrivateKey(targetKek, plain),
    };
  } finally {
    plain.fill(0);
  }
}

/**
 * Decrypts an encrypted private key cleanly inside memory, derives the exact DNS TXT string (`v=DKIM1; k=...; p=...`),
 * and zeros plaintext key bytes immediately so DB public keys and KEK rotations can be verified safely.
 */
export function derivePublicKeyDnsTxtFromEncrypted(
  ring: DkimKekRing,
  keyEncryptionVersion: number,
  algorithm: 'rsa2048' | 'ed25519',
  encrypted: Buffer
): string {
  const plain = decryptDkimPrivateKeyVersioned(ring, keyEncryptionVersion, encrypted);
  try {
    if (algorithm === 'rsa2048') {
      const priv = createPrivateKey({ key: plain, format: 'der', type: 'pkcs1' });
      const pubDer = createPublicKey(priv).export({ format: 'der', type: 'pkcs1' });
      return `v=DKIM1; k=rsa; p=${Buffer.from(pubDer).toString('base64')}`;
    }
    const priv = createPrivateKey({ key: plain, format: 'der', type: 'pkcs8' });
    const spki = Buffer.from(createPublicKey(priv).export({ format: 'der', type: 'spki' }));
    const rawPub = spki.length === 44 ? spki.subarray(12) : spki;
    return `v=DKIM1; k=ed25519; p=${rawPub.toString('base64')}`;
  } finally {
    plain.fill(0);
  }
}

export interface GeneratedDkimKeyMaterial {
  selector: string;
  algorithm: 'rsa2048' | 'ed25519';
  dnsRecordName: string;
  publicKeyDnsTxt: string;
  encryptedPrivateKey: Buffer;
  keyEncryptionVersion: number;
}

/**
 * Authoritative DKIM keypair generator formatted identically to Rust `mail-auth` (`DkimKeyPair`):
 * - `rsa2048`: PKCS#1 DER private/public key (`v=DKIM1; k=rsa; p=...`)
 * - `ed25519`: PKCS#8 DER private key + 32-byte raw Ed25519 public key (`v=DKIM1; k=ed25519; p=...`)
 */
export function generateDomainDkimKeyPair(
  domain: string,
  selector: string,
  algorithm: 'rsa2048' | 'ed25519' = 'rsa2048',
  kekOrRing: Buffer | DkimKekRing = resolveDkimKekRing()
): GeneratedDkimKeyMaterial {
  const normDomain = domain.trim().toLowerCase();
  const normSelector = selector.trim().toLowerCase();
  if (!normDomain || !normSelector) {
    throw new Error('Domain and selector are required for DKIM key generation');
  }

  let publicBase64: string;
  let privateDer: Buffer;

  if (algorithm === 'rsa2048') {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'der' },
      privateKeyEncoding: { type: 'pkcs1', format: 'der' },
    });
    publicBase64 = Buffer.from(publicKey).toString('base64');
    privateDer = Buffer.from(privateKey);
  } else {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const spki = Buffer.from(publicKey);
    const rawPub = spki.length === 44 ? spki.subarray(12) : spki;
    publicBase64 = rawPub.toString('base64');
    privateDer = Buffer.from(privateKey);
  }

  const publicKeyDnsTxt = `v=DKIM1; k=${algorithm === 'rsa2048' ? 'rsa' : 'ed25519'}; p=${publicBase64}`;
  try {
    const { keyEncryptionVersion, encryptedPrivateKey } = Buffer.isBuffer(kekOrRing)
      ? { keyEncryptionVersion: 1, encryptedPrivateKey: encryptDkimPrivateKey(kekOrRing, privateDer) }
      : encryptDkimPrivateKeyVersioned(kekOrRing, privateDer);

    return {
      selector: normSelector,
      algorithm,
      dnsRecordName: `${normSelector}._domainkey.${normDomain}`,
      publicKeyDnsTxt,
      encryptedPrivateKey,
      keyEncryptionVersion,
    };
  } finally {
    privateDer.fill(0);
  }
}

/**
 * Extracts normalized `p=` base64 material from a DKIM TXT value, converting SPKI RSA
 * public keys to PKCS#1 base64 if needed so both SPKI and PKCS#1 published DNS keys compare cleanly.
 */
export function extractNormalizedDkimPublicKeyBase64(txt: string): {
  validSyntax: boolean;
  keyType: string | null;
  pValue: string | null;
  canonicalPkcs1Base64: string | null;
  sha256Fingerprint: string | null;
} {
  const compact = txt.replace(/\s+/g, '');
  const parts = compact
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);

  const tags = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    tags.set(part.slice(0, eq).toLowerCase(), part.slice(eq + 1));
  }

  const version = tags.get('v');
  const pValue = tags.get('p') ?? null;
  const keyType = (tags.get('k') ?? 'rsa').toLowerCase();

  if ((version && version.toUpperCase() !== 'DKIM1') || !pValue) {
    return { validSyntax: false, keyType, pValue, canonicalPkcs1Base64: null, sha256Fingerprint: null };
  }

  if (keyType === 'rsa') {
    try {
      const der = Buffer.from(pValue, 'base64');
      let pubKeyObj;
      try {
        pubKeyObj = createPublicKey({ key: der, format: 'der', type: 'spki' });
      } catch {
        pubKeyObj = createPublicKey({ key: der, format: 'der', type: 'pkcs1' });
      }
      const pkcs1 = pubKeyObj.export({ format: 'der', type: 'pkcs1' });
      const canonical = Buffer.from(pkcs1).toString('base64');
      return {
        validSyntax: true,
        keyType,
        pValue,
        canonicalPkcs1Base64: canonical,
        sha256Fingerprint: createHash('sha256').update(canonical).digest('hex'),
      };
    } catch {
      return { validSyntax: false, keyType, pValue, canonicalPkcs1Base64: null, sha256Fingerprint: null };
    }
  }

  return {
    validSyntax: true,
    keyType,
    pValue,
    canonicalPkcs1Base64: pValue,
    sha256Fingerprint: createHash('sha256').update(pValue).digest('hex'),
  };
}
