import type {
  EmailTemplateBlock,
  SegmentConditionGroup,
  SegmentConditionRule,
  SubscriberRecord,
} from '@mail/shared-types';

/**
 * Sanitizes HTML email content against script execution, event handlers, and javascript: URIs
 * while preserving safe email table layout markup and inline styles.
 */
export function sanitizeMarketingHtml(unsafeHtml: string): string {
  if (!unsafeHtml) return '';
  return unsafeHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<(?:iframe|object|embed|form|meta|base)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed|form)>/gi, '')
    .replace(/<(?:iframe|object|embed|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript|data:text\/html):[^"']*\2/gi, '$1=$2#$2');
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Compiles visual block-editor JSON into email-client-safe table/inline-styled HTML and plain text.
 */
export function compileBlocksToHtmlAndText(
  blocks: EmailTemplateBlock[],
  opts?: { subject?: string; previewText?: string; unsubscribePlaceholder?: boolean }
): { htmlBody: string; textBody: string } {
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  if (opts?.previewText) {
    htmlParts.push(
      `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(opts.previewText)}</div>`
    );
  }

  for (const block of blocks) {
    const p = block.props ?? {};
    switch (block.type) {
      case 'heading': {
        const text = String(p.text ?? 'Heading');
        const level = String(p.level ?? 'h2') === 'h1' ? 'h1' : 'h2';
        const fontSize = level === 'h1' ? '26px' : '20px';
        htmlParts.push(
          `<${level} style="margin:0 0 14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:${fontSize};line-height:1.3;color:#111827;">${escapeHtml(text)}</${level}>`
        );
        textParts.push(text.toUpperCase());
        break;
      }
      case 'text': {
        const text = String(p.text ?? '');
        const paras = text.split(/\n{2,}/);
        for (const para of paras) {
          const safe = escapeHtml(para).replaceAll('\n', '<br />');
          htmlParts.push(
            `<p style="margin:0 0 14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#374151;">${safe}</p>`
          );
          textParts.push(para);
        }
        break;
      }
      case 'image': {
        const src = String(p.src ?? '').trim();
        const alt = String(p.alt ?? 'Image');
        const href = String(p.href ?? '').trim();
        if (src && /^https?:\/\//i.test(src)) {
          const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" style="display:block;max-width:100%;height:auto;border-radius:6px;margin:0 auto 16px;" />`;
          htmlParts.push(
            href && /^https?:\/\//i.test(href)
              ? `<a href="${escapeHtml(href)}" style="text-decoration:none;">${img}</a>`
              : img
          );
          textParts.push(`[${alt}]${href ? ` (${href})` : ''}`);
        }
        break;
      }
      case 'button': {
        const label = String(p.label ?? 'Learn more');
        const url = /^https?:\/\//i.test(String(p.url ?? '')) ? String(p.url) : 'https://example.com';
        const bg = /^#[0-9a-fA-F]{6}$/.test(String(p.color ?? '')) ? String(p.color) : '#18181b';
        htmlParts.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0;"><tr><td style="border-radius:6px;background:${bg};"><a href="${escapeHtml(url)}" style="display:inline-block;padding:11px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a></td></tr></table>`
        );
        textParts.push(`${label}: ${url}`);
        break;
      }
      case 'divider': {
        htmlParts.push(`<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />`);
        textParts.push('---');
        break;
      }
      case 'columns': {
        const left = escapeHtml(String(p.leftText ?? 'Left column')).replaceAll('\n', '<br />');
        const right = escapeHtml(String(p.rightText ?? 'Right column')).replaceAll('\n', '<br />');
        htmlParts.push(
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;"><tr><td width="50%" valign="top" style="padding-right:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;color:#374151;">${left}</td><td width="50%" valign="top" style="padding-left:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;color:#374151;">${right}</td></tr></table>`
        );
        textParts.push(`${String(p.leftText ?? '')}\n${String(p.rightText ?? '')}`);
        break;
      }
      case 'social': {
        const linksRaw = Array.isArray(p.links) ? p.links : ['https://x.com', 'https://linkedin.com'];
        const anchors = linksRaw
          .map((u) => String(u).trim())
          .filter((u) => /^https?:\/\//i.test(u))
          .map(
            (u) =>
              `<a href="${escapeHtml(u)}" style="color:#2563eb;text-decoration:none;margin-right:12px;font-size:13px;">${escapeHtml(u.replace(/^https?:\/\/(?:www\.)?/i, '').split('/')[0] ?? u)}</a>`
          );
        if (anchors.length > 0) {
          htmlParts.push(`<div style="margin:14px 0;">${anchors.join('')}</div>`);
          textParts.push(linksRaw.join(' | '));
        }
        break;
      }
      case 'footer': {
        const company = String(p.company ?? 'FastConnect Sender');
        const address = String(p.address ?? '');
        const unsubLabel = String(p.unsubscribeText ?? 'Unsubscribe');
        htmlParts.push(
          `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;line-height:1.5;color:#6b7280;"><div>${escapeHtml(company)}${address ? ` &bull; ${escapeHtml(address)}` : ''}</div><div style="margin-top:6px;"><a href="{{unsubscribeUrl}}" style="color:#6b7280;text-decoration:underline;">${escapeHtml(unsubLabel)}</a></div></div>`
        );
        textParts.push(`${company}${address ? ` - ${address}` : ''}\n${unsubLabel}: {{unsubscribeUrl}}`);
        break;
      }
    }
  }

  const innerHtml = htmlParts.join('\n');
  const wrappedHtml = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f9fafb;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:28px;"><tr><td>${innerHtml}</td></tr></table></td></tr></table></body></html>`;

  return {
    htmlBody: sanitizeMarketingHtml(wrappedHtml),
    textBody: textParts.join('\n\n').trim() || opts?.subject || '',
  };
}

/**
 * Strips HTML tags cleanly into a plain-text fallback when a user supplies HTML without textBody.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h1|h2|h3|h4|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Renders personalization tokens including fallback values:
 * e.g. `{{firstName}}` or `{{firstName | fallback: "there"}}` or `{{attributes.company | default: "Team"}}`.
 */
export function renderPersonalizedContent(
  template: string,
  vars: Record<string, string | number | boolean | null | undefined>
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z0-9_.-]+)(?:\s*\|\s*(?:fallback|default)\s*:\s*(?:"([^"]*)"|'([^']*)'))?\s*\}\}/g,
    (_m, rawKey: string, dqFallback?: string, sqFallback?: string) => {
      const val = vars[rawKey];
      const strVal = val !== undefined && val !== null ? String(val).trim() : '';
      if (strVal.length > 0) return strVal;
      return dqFallback ?? sqFallback ?? '';
    }
  );
}

export function buildSubscriberVarMap(
  sub: Pick<SubscriberRecord, 'email' | 'firstName' | 'lastName' | 'attributes'>,
  extra?: Record<string, string>
): Record<string, string> {
  const vars: Record<string, string> = {
    email: sub.email,
    firstName: sub.firstName || '',
    lastName: sub.lastName || '',
    fullName: [sub.firstName, sub.lastName].filter(Boolean).join(' ').trim(),
    ...(extra ?? {}),
  };
  for (const [k, v] of Object.entries(sub.attributes ?? {})) {
    if (v !== null && v !== undefined) {
      vars[k] = String(v);
      vars[`attributes.${k}`] = String(v);
      vars[`custom.${k}`] = String(v);
    }
  }
  return vars;
}

/**
 * Injects tracked click redirects, open pixel, and RFC 8058 unsubscribe URLs into rendered marketing email HTML & text.
 */
export async function instrumentTrackedEmail(params: {
  baseUrl: string;
  organizationId: string;
  messageId: string;
  recipientEmail: string;
  campaignId?: string | undefined;
  domainId?: string | undefined;
  subscriberId?: string | undefined;
  htmlBody: string;
  textBody: string;
  createTrackingToken: (input: {
    organizationId: string;
    messageId: string;
    recipientEmail: string;
    kind: 'open' | 'click' | 'unsubscribe';
    targetUrl?: string;
    campaignId?: string;
    domainId?: string;
    subscriberId?: string;
  }) => Promise<{ token: string }>;
}): Promise<{
  html: string;
  text: string;
  unsubscribeUrl: string;
  headers: Record<string, string>;
}> {
  const base = params.baseUrl.replace(/\/+$/, '');
  const unsub = await params.createTrackingToken({
    organizationId: params.organizationId,
    messageId: params.messageId,
    recipientEmail: params.recipientEmail,
    kind: 'unsubscribe',
    ...(params.campaignId ? { campaignId: params.campaignId } : {}),
    ...(params.domainId ? { domainId: params.domainId } : {}),
    ...(params.subscriberId ? { subscriberId: params.subscriberId } : {}),
  });
  const unsubscribeUrl = `${base}/v1/unsubscribe/${encodeURIComponent(unsub.token)}`;

  const openTok = await params.createTrackingToken({
    organizationId: params.organizationId,
    messageId: params.messageId,
    recipientEmail: params.recipientEmail,
    kind: 'open',
    ...(params.campaignId ? { campaignId: params.campaignId } : {}),
    ...(params.domainId ? { domainId: params.domainId } : {}),
    ...(params.subscriberId ? { subscriberId: params.subscriberId } : {}),
  });
  const openPixel = `<img src="${base}/v1/t/o/${encodeURIComponent(openTok.token)}" alt="" width="1" height="1" style="display:block;border:0;width:1px;height:1px;" />`;

  let html = sanitizeMarketingHtml(params.htmlBody).replaceAll('{{unsubscribeUrl}}', unsubscribeUrl);
  let text = (params.textBody || htmlToPlainText(html)).replaceAll('{{unsubscribeUrl}}', unsubscribeUrl);

  // Replace tracked links sequentially (preserving unsubscribe URL untouched)
  const linkMatches = [...html.matchAll(/href=(["'])(https?:\/\/[^"']+)\1/gi)];
  const cache = new Map<string, string>();
  for (const match of linkMatches) {
    const rawHref = match[2]!;
    if (rawHref === unsubscribeUrl || rawHref.includes('/v1/unsubscribe/')) continue;
    if (!cache.has(rawHref)) {
      const tok = await params.createTrackingToken({
        organizationId: params.organizationId,
        messageId: params.messageId,
        recipientEmail: params.recipientEmail,
        kind: 'click',
        targetUrl: rawHref,
        ...(params.campaignId ? { campaignId: params.campaignId } : {}),
        ...(params.domainId ? { domainId: params.domainId } : {}),
        ...(params.subscriberId ? { subscriberId: params.subscriberId } : {}),
      });
      cache.set(rawHref, `${base}/v1/t/c/${encodeURIComponent(tok.token)}`);
    }
  }
  for (const [orig, tracked] of cache.entries()) {
    html = html.replaceAll(`href="${orig}"`, `href="${tracked}"`).replaceAll(`href='${orig}'`, `href='${tracked}'`);
  }

  if (!html.includes(unsubscribeUrl)) {
    html += `<div style="margin-top:20px;font-size:12px;color:#6b7280;text-align:center;">Don't want these emails? <a href="${unsubscribeUrl}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a></div>`;
  }
  if (!text.includes(unsubscribeUrl)) {
    text += `\n\nUnsubscribe: ${unsubscribeUrl}`;
  }

  html = html.includes('</body>') ? html.replace('</body>', `${openPixel}</body>`) : `${html}${openPixel}`;

  return {
    html,
    text,
    unsubscribeUrl,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

export interface ActivityLookup {
  openedCampaignIdsByEmail: Map<string, Set<string>>;
  clickedEmails: Set<string>;
  openedAnyEmails: Set<string>;
  lastEngagedByEmail: Map<string, Date>;
}

/**
 * Dynamically evaluates a Segment condition tree against an individual SubscriberRecord.
 * Never duplicates contacts; works uniformly in memory and as an exact filter after DB pre-filter.
 */
export function evaluateSegmentNode(
  node: SegmentConditionRule | SegmentConditionGroup,
  sub: SubscriberRecord,
  activity?: ActivityLookup
): boolean {
  if (node.kind === 'group') {
    if (node.rules.length === 0) return true;
    return node.matchType === 'any'
      ? node.rules.some((r) => evaluateSegmentNode(r, sub, activity))
      : node.rules.every((r) => evaluateSegmentNode(r, sub, activity));
  }

  const emailLower = sub.email.toLowerCase();
  const tagSet = new Set(sub.tags.map((t) => t.toLowerCase()));
  const op = node.operator;
  const field = node.field;
  const rawExpected = node.value;
  const expectedStr = Array.isArray(rawExpected)
    ? rawExpected.join(',').toLowerCase()
    : rawExpected !== undefined
      ? String(rawExpected).toLowerCase()
      : '';

  if (op === 'has_tag') {
    return tagSet.has(expectedStr);
  }
  if (op === 'not_has_tag') {
    return !tagSet.has(expectedStr);
  }
  if (op === 'has_any_tag') {
    const targets = Array.isArray(rawExpected) ? rawExpected : expectedStr.split(',').map((s) => s.trim());
    return targets.some((t) => t && tagSet.has(t.toLowerCase()));
  }
  if (op === 'has_all_tags') {
    const targets = Array.isArray(rawExpected) ? rawExpected : expectedStr.split(',').map((s) => s.trim());
    return targets.filter(Boolean).every((t) => tagSet.has(t.toLowerCase()));
  }

  if (op === 'opened_broadcast') {
    if (!expectedStr) return activity?.openedAnyEmails.has(emailLower) ?? false;
    return activity?.openedCampaignIdsByEmail.get(emailLower)?.has(expectedStr) ?? false;
  }
  if (op === 'not_opened_broadcast') {
    if (!expectedStr) return !(activity?.openedAnyEmails.has(emailLower) ?? false);
    return !(activity?.openedCampaignIdsByEmail.get(emailLower)?.has(expectedStr) ?? false);
  }
  if (op === 'clicked_link') {
    return activity?.clickedEmails.has(emailLower) ?? false;
  }
  if (op === 'not_clicked_link') {
    return !(activity?.clickedEmails.has(emailLower) ?? false);
  }

  let actualVal: unknown;
  if (field === 'email') actualVal = sub.email;
  else if (field === 'firstName') actualVal = sub.firstName;
  else if (field === 'lastName') actualVal = sub.lastName;
  else if (field === 'status') actualVal = sub.status;
  else if (field === 'consentSource' || field === 'signupSource') actualVal = sub.consentSource;
  else if (field === 'createdAt' || field === 'signupDate') actualVal = sub.createdAt;
  else if (field === 'updatedAt') actualVal = sub.updatedAt ?? sub.createdAt;
  else if (field === 'lastActivityAt' || field === 'lastEngagementDate') {
    actualVal = activity?.lastEngagedByEmail.get(emailLower)?.toISOString() ?? sub.lastActivityAt;
  } else if (field === 'engagementScore') {
    actualVal = sub.engagementScore;
  } else if (field.startsWith('custom.')) {
    actualVal = sub.attributes?.[field.slice(7)];
  } else {
    actualVal = sub.attributes?.[field];
  }

  const actualStr = actualVal !== undefined && actualVal !== null ? String(actualVal).toLowerCase() : '';

  switch (op) {
    case 'equals':
      return actualStr === expectedStr;
    case 'not_equals':
      return actualStr !== expectedStr;
    case 'contains':
      return actualStr.includes(expectedStr);
    case 'not_contains':
      return !actualStr.includes(expectedStr);
    case 'starts_with':
      return actualStr.startsWith(expectedStr);
    case 'is_empty':
      return actualStr.trim().length === 0;
    case 'is_not_empty':
      return actualStr.trim().length > 0;
    case 'gt':
      return Number(actualVal) > Number(rawExpected);
    case 'lt':
      return Number(actualVal) < Number(rawExpected);
    case 'before': {
      const a = Date.parse(String(actualVal ?? ''));
      const b = Date.parse(String(rawExpected ?? ''));
      return !Number.isNaN(a) && !Number.isNaN(b) && a < b;
    }
    case 'after': {
      const a = Date.parse(String(actualVal ?? ''));
      const b = Date.parse(String(rawExpected ?? ''));
      return !Number.isNaN(a) && !Number.isNaN(b) && a > b;
    }
    case 'in_last_days': {
      const a = Date.parse(String(actualVal ?? ''));
      const days = Number(rawExpected ?? 30);
      if (Number.isNaN(a) || Number.isNaN(days)) return false;
      return Date.now() - a <= days * 86_400_000;
    }
    default:
      return false;
  }
}

export function evaluateSegmentForSubscriber(
  matchType: 'all' | 'any',
  conditions: Array<SegmentConditionRule | SegmentConditionGroup>,
  sub: SubscriberRecord,
  activity?: ActivityLookup
): boolean {
  if (conditions.length === 0) return true;
  return matchType === 'any'
    ? conditions.some((c) => evaluateSegmentNode(c, sub, activity))
    : conditions.every((c) => evaluateSegmentNode(c, sub, activity));
}

/**
 * RFC 4180 compliant CSV parser handling quoted fields, escaped quotes, and multiline values.
 */
export function parseCsvMatrix(csvText: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const text = csvText.replace(/^\uFEFF/, '');

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(field.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some((c) => c.length > 0)) rows.push(row);
  }

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0]!;
  return { headers, rows: rows.slice(1) };
}
