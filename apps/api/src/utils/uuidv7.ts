import { randomBytes } from 'node:crypto';

/**
 * Generates an RFC 9562 monotonic UUIDv7 string for B-tree locality in PostgreSQL.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const nowMs = BigInt(Date.now());

  // 48-bit big-endian Unix millisecond timestamp
  bytes[0] = Number((nowMs >> 40n) & 0xffn);
  bytes[1] = Number((nowMs >> 32n) & 0xffn);
  bytes[2] = Number((nowMs >> 24n) & 0xffn);
  bytes[3] = Number((nowMs >> 16n) & 0xffn);
  bytes[4] = Number((nowMs >> 8n) & 0xffn);
  bytes[5] = Number(nowMs & 0xffn);

  // Version 7 (0b0111xxxx)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // Variant RFC 4122 (0b10xxxxxx)
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
