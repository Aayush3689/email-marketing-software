import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(byteLength = 20): string {
  const bytes = randomBytes(byteLength);
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? '';
  }
  return output;
}

export function decodeBase32(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error('Invalid base32 character in TOTP secret');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpCode(secretBase32: string, timestampMs = Date.now(), stepSec = 30): string {
  const key = decodeBase32(secretBase32);
  const counter = BigInt(Math.floor(timestampMs / 1000 / stepSec));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter, 0);

  const hmac = createHmac('sha1', key).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);

  return String(code % 1_000_000).padStart(6, '0');
}

export function verifyTotpCode(
  secretBase32: string,
  code: string,
  timestampMs = Date.now(),
  windowSteps = 1
): boolean {
  const normalized = code.trim();
  if (!/^\d{6}$/.test(normalized)) return false;

  const incomingBuf = Buffer.from(normalized, 'utf8');
  for (let offset = -windowSteps; offset <= windowSteps; offset += 1) {
    const expected = generateTotpCode(secretBase32, timestampMs + offset * 30_000);
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (expectedBuf.length === incomingBuf.length && timingSafeEqual(expectedBuf, incomingBuf)) {
      return true;
    }
  }
  return false;
}

export function buildOtpAuthUri(accountEmail: string, issuer: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secretBase32)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
