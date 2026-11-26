type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const REDACT_KEYS = new Set([
  'password',
  'passwordhash',
  'secret',
  'token',
  'authorization',
  'apikey',
  'privatekey',
]);

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactValue(v);
    }
    return out;
  }
  return value;
}

export class StructuredLogger {
  constructor(private readonly service: string) {}

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      message,
      ...(meta ? (redactValue(meta) as Record<string, unknown>) : {}),
    };
    const line = JSON.stringify(payload);
    if (level === 'error') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }
}
