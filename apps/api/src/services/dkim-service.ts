import { createCipheriv, createDecipheriv, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';

const DEFAULT_DEV_KEK_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export function resolveDkimKek(hexOverride?: string): Buffer {
  const raw = (hexOverride ?? process.env.DKIM_KEK_HEX ?? '').trim();
  const isProd = process.env.NODE_ENV === 'production';
  if (!raw) {
    if (isProd) {
      throw new Error('DKIM_KEK_HEX is required in production');
    }
    return Buffer.from(DEFAULT_DEV_KEK_HEX, 'hex');
  }
  if (isProd && raw === DEFAULT_DEV_KEK_HEX) {
    throw new Error('DKIM_KEK_HEX must not use the default development key in production');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('DKIM_KEK_HEX must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(raw, 'hex');
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
 * Decrypts AES-256-GCM DKIM private key payload (`nonce_12B || ciphertext || tag_16B`)
 * for verification/key-matching tests without ever exposing it over API responses.
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

export interface GeneratedDkimKeyMaterial {
  selector: string;
  algorithm: 'rsa2048' | 'ed25519';
  dnsRecordName: string;
  publicKeyDnsTxt: string;
  encryptedPrivateKey: Buffer;
}

/**
 * Generates a domain DKIM keypair formatted identically to Rust `mail-auth` (`DkimKeyPair`):
 * - `rsa2048`: PKCS#1 DER for private and public key (`v=DKIM1; k=rsa; p=...`)
 * - `ed25519`: PKCS#8 DER private key and raw 32-byte Ed25519 public key (`v=DKIM1; k=ed25519; p=...`)
 */
export function generateDomainDkimKeyPair(
  domain: string,
  selector: string,
  algorithm: 'rsa2048' | 'ed25519' = 'rsa2048',
  kek: Buffer = resolveDkimKek()
): GeneratedDkimKeyMaterial {
  const normDomain = domain.trim().toLowerCase();
  const normSelector = selector.trim().toLowerCase();

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
    // Ed25519 SPKI DER is 12-byte ASN.1 header + 32-byte raw public key
    const rawPub = spki.length === 44 ? spki.subarray(12) : spki;
    publicBase64 = rawPub.toString('base64');
    privateDer = Buffer.from(privateKey);
  }

  const publicKeyDnsTxt = `v=DKIM1; k=${algorithm === 'rsa2048' ? 'rsa' : 'ed25519'}; p=${publicBase64}`;
  const encryptedPrivateKey = encryptDkimPrivateKey(kek, privateDer);
  privateDer.fill(0);

  return {
    selector: normSelector,
    algorithm,
    dnsRecordName: `${normSelector}._domainkey.${normDomain}`,
    publicKeyDnsTxt,
    encryptedPrivateKey,
  };
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
    return { validSyntax: false, keyType, pValue, canonicalPkcs1Base64: null };
  }

  if (keyType === 'rsa') {
    try {
      const der = Buffer.from(pValue, 'base64');
      // Try parsing as SPKI first, fallback to PKCS#1
      let pubKeyObj;
      try {
        pubKeyObj = createPublicKey({ key: der, format: 'der', type: 'spki' });
      } catch {
        pubKeyObj = createPublicKey({ key: der, format: 'der', type: 'pkcs1' });
      }
      const pkcs1 = pubKeyObj.export({ format: 'der', type: 'pkcs1' });
      return {
        validSyntax: true,
        keyType,
        pValue,
        canonicalPkcs1Base64: Buffer.from(pkcs1).toString('base64'),
      };
    } catch {
      return { validSyntax: false, keyType, pValue, canonicalPkcs1Base64: null };
    }
  }

  return {
    validSyntax: true,
    keyType,
    pValue,
    canonicalPkcs1Base64: pValue,
  };
}
