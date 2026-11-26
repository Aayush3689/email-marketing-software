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
