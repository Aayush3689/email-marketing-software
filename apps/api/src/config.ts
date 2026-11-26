import { z } from 'zod';

const PLACEHOLDER_SECRETS = [
  'replace_with_at_least_32_byte_random_access_secret',
  'replace_with_at_least_32_byte_random_refresh_secret',
  'dev_only_replace_with_32_byte_random_secret_access',
  'dev_only_replace_with_32_byte_random_secret_refresh',
  'replace_with_random_control_token',
  'ChangeThisStrongPassword123!',
];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).optional(),
  REDIS_PASSWORD: z.string().optional(),
  RABBITMQ_URL: z.string().min(1).optional(),
  RABBITMQ_MANAGEMENT_URL: z.string().min(1).optional(),
  RABBITMQ_USER: z.string().min(1).default('mailplat'),
  RABBITMQ_PASSWORD: z.string().min(1).default('change_me_local_dev_only'),
  MAIL_ENGINE_NODE_ID: z.string().min(1).default('mta-primary-1'),
  MAIL_ENGINE_CONTROL_URL: z.string().min(1).optional(),
  MAIL_ENGINE_CONTROL_TOKEN: z.string().min(1).optional(),
  MAIL_HELO_DOMAIN: z.string().min(3).default('mx1.fastconnect.in'),
  MAIL_PUBLIC_IP: z.string().min(3).optional(),
  SPF_INCLUDE_DOMAIN: z.string().min(3).optional(),
  TRACKING_CNAME_TARGET: z.string().min(3).optional(),
  DKIM_SELECTOR: z.string().min(1).default('mp1'),
  DKIM_KEK_HEX: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  DNS_CHECK_TIMEOUT_MS: z.coerce.number().int().min(500).max(15000).default(3500),
  PRIMARY_DOMAIN: z.string().min(3).optional(),
  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().min(10).optional(),
  ADMIN_BOOTSTRAP_ORG: z.string().min(2).default('Primary Organization'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
  ADMIN_CORS_ORIGINS: z.string().default('http://localhost:5175'),
  SPOOL_BACKEND: z.enum(['local', 's3']).default('local'),
  SPOOL_DIR: z.string().default('/var/spool/mailplat'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('mail-spool'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
});

export type ApiConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const cfg = envSchema.parse(env);
  if (cfg.NODE_ENV === 'production') {
    for (const [name, val] of [
      ['JWT_ACCESS_SECRET', cfg.JWT_ACCESS_SECRET],
      ['JWT_REFRESH_SECRET', cfg.JWT_REFRESH_SECRET],
      ['MAIL_ENGINE_CONTROL_TOKEN', cfg.MAIL_ENGINE_CONTROL_TOKEN],
      ['ADMIN_BOOTSTRAP_PASSWORD', cfg.ADMIN_BOOTSTRAP_PASSWORD],
    ] as const) {
      if (val && PLACEHOLDER_SECRETS.some((p) => val.includes(p))) {
        throw new Error(`${name} must not use placeholder values when NODE_ENV=production`);
      }
    }
  }
  return cfg;
}
