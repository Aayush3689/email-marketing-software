import { z } from 'zod';

export const emailAddressSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email('Invalid email address');

export const domainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'Invalid domain name'
  );

const noCrlf = (val: string) => !/[\r\n\0]/.test(val);

export const sendEmailRequestSchema = z
  .object({
    from: emailAddressSchema,
    to: z.array(emailAddressSchema).min(1).max(50),
    cc: z.array(emailAddressSchema).max(50).optional(),
    bcc: z.array(emailAddressSchema).max(50).optional(),
    replyTo: emailAddressSchema.optional(),
    domainId: z.string().min(1).max(128).optional(),
    subject: z
      .string()
      .min(1)
      .max(998)
      .refine(noCrlf, 'Subject must not contain newline or null control characters'),
    html: z.string().max(2_000_000).optional(),
    text: z.string().max(2_000_000).optional(),
    headers: z
      .record(
        z.string().max(128).refine(noCrlf, 'Header name contains invalid control characters'),
        z.string().max(998).refine(noCrlf, 'Header value contains invalid control characters')
      )
      .optional(),
    idempotencyKey: z.string().min(8).max(128).optional(),
    trackOpens: z.boolean().optional(),
    trackClicks: z.boolean().optional(),
  })
  .refine((data) => Boolean(data.html || data.text), {
    message: 'Either html or text body is required',
  });

export type SendEmailRequest = z.infer<typeof sendEmailRequestSchema>;

export const createDomainRequestSchema = z.object({
  domainName: domainNameSchema,
  hostingEnabled: z.boolean().default(false),
  sendingEnabled: z.boolean().default(true),
});

export type CreateDomainRequest = z.infer<typeof createDomainRequestSchema>;

export const dkimSelectorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Invalid DKIM selector');

export const rotateDkimSchema = z.object({
  selector: dkimSelectorSchema.optional(),
  algorithm: z.enum(['rsa2048', 'ed25519']).default('rsa2048'),
});

const safeReportUriSchema = z
  .string()
  .trim()
  .max(320)
  .refine(
    (v) => v === '' || /^(mailto:[^\s,;]+|https:\/\/[^\s,;]+)$/i.test(v),
    'Report URI must be mailto:address or https:// URL'
  );

const safeHttpsUrlSchema = z
  .string()
  .trim()
  .max(512)
  .refine((v) => v === '' || /^https:\/\/[^\s]+$/i.test(v), 'Must be a valid https:// URL');

export const updateDomainSettingsSchema = z.object({
  hostingEnabled: z.boolean().optional(),
  sendingEnabled: z.boolean().optional(),
  defaultSenderLocalPart: z
    .string()
    .trim()
    .max(64)
    .regex(/^[a-zA-Z0-9._+-]*$/, 'Invalid local-part')
    .nullable()
    .optional(),
  customReturnPathDomain: domainNameSchema.nullable().optional(),
  customTrackingDomain: domainNameSchema.nullable().optional(),
  dailySendLimit: z.number().int().min(0).max(10_000_000).nullable().optional(),
  dmarcPolicy: z.enum(['none', 'quarantine', 'reject']).optional(),
  dmarcRua: safeReportUriSchema.nullable().optional(),
  dmarcRuf: safeReportUriSchema.nullable().optional(),
  dmarcPct: z.number().int().min(0).max(100).optional(),
  dmarcAspf: z.enum(['r', 's']).optional(),
  dmarcAdkim: z.enum(['r', 's']).optional(),
  mtaStsMode: z.enum(['none', 'testing', 'enforce']).optional(),
  mtaStsMaxAge: z.number().int().min(60).max(31_557_600).optional(),
  tlsRptRua: safeReportUriSchema.nullable().optional(),
  bimiSelector: dkimSelectorSchema.optional(),
  bimiLogoUrl: safeHttpsUrlSchema.nullable().optional(),
  bimiVmcUrl: safeHttpsUrlSchema.nullable().optional(),
  dkimPolicy: z.enum(['required', 'optional']).optional(),
});

export type UpdateDomainSettingsRequest = z.infer<typeof updateDomainSettingsSchema>;

export const deleteDomainSchema = z.object({
  confirmDomainName: z.string().trim().toLowerCase().min(3).max(253),
  confirmCleanup: z.boolean().default(false),
});

export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(300).default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563eb'),
});

export const createCustomFieldSchema = z.object({
  fieldKey: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'Field key must start with a letter and use lowercase letters, numbers, or underscores'),
  label: z.string().trim().min(1).max(80),
  fieldType: z.enum(['text', 'number', 'date', 'boolean']).default('text'),
  description: z.string().trim().max(300).default(''),
});

export const segmentConditionSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(64),
    kind: z.enum(['rule', 'group']),
    field: z.string().optional(),
    operator: z.string().optional(),
    value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
    matchType: z.enum(['all', 'any']).optional(),
    rules: z.array(segmentConditionSchema).optional(),
  })
);

export const saveSegmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).default(''),
  matchType: z.enum(['all', 'any']).default('all'),
  conditions: z.array(segmentConditionSchema).max(50).default([]),
});

export const upsertSubscriberSchema = z.object({
  email: emailAddressSchema,
  firstName: z.string().trim().max(120).default(''),
  lastName: z.string().trim().max(120).default(''),
  status: z.enum(['subscribed', 'unsubscribed', 'pending_confirmation']).default('subscribed'),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  consentSource: z.string().trim().min(2).max(200),
  consentedAt: z.string().datetime().optional(),
});

export const audienceSelectionSchema = z.object({
  mode: z.enum(['all', 'filtered']).default('all'),
  includeTagIds: z.array(z.string()).default([]),
  includeTags: z.array(z.string()).default([]),
  includeSegmentIds: z.array(z.string()).default([]),
  subscriberIds: z.array(z.string()).default([]),
  excludeTagIds: z.array(z.string()).default([]),
  excludeTags: z.array(z.string()).default([]),
  excludeSegmentIds: z.array(z.string()).default([]),
});
