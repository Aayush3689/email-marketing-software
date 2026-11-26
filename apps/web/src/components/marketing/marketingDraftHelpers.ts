import type { AudienceSelectionSpec, EmailTemplateBlock } from '@mail/shared-types';

export interface BroadcastDraftPayload {
  domainId: string;
  templateId: string;
  name: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  subject: string;
  previewText: string;
  blocks: EmailTemplateBlock[];
  htmlBody: string;
  textBody: string;
  audienceSpec: AudienceSelectionSpec;
  deliveryChoice: 'draft' | 'now' | 'schedule';
  scheduledLocal: string;
  timezone: string;
  wizardStep: 1 | 2 | 3 | 4 | 5;
}

export type AutosaveState =
  | 'idle'
  | 'unsaved'
  | 'saving'
  | 'saved'
  | 'error'
  | 'offline'
  | 'conflict';

export interface StoredLocalRecovery {
  draft: BroadcastDraftPayload;
  serverUpdatedAt: string | null;
  dirty: boolean;
  savedLocallyAt: number;
}

export function getDraftRecoveryStorageKey(campaignId: string | null): string {
  return `fastconnect_broadcast_draft_${campaignId ?? 'new'}`;
}

export function readLocalDraftRecovery(campaignId: string | null): StoredLocalRecovery | null {
  try {
    const raw = globalThis.localStorage?.getItem(getDraftRecoveryStorageKey(campaignId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredLocalRecovery;
    if (!parsed || typeof parsed !== 'object' || !parsed.draft) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLocalDraftRecovery(campaignId: string | null, record: StoredLocalRecovery): void {
  try {
    globalThis.localStorage?.setItem(getDraftRecoveryStorageKey(campaignId), JSON.stringify(record));
  } catch {
    // Ignore storage quota or SSR absence errors cleanly
  }
}

export function clearLocalDraftRecovery(campaignId: string | null): void {
  try {
    globalThis.localStorage?.removeItem(getDraftRecoveryStorageKey(campaignId));
  } catch {
    // Ignore storage removal errors
  }
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function sanitizePreviewHtml(unsafeHtml: string): string {
  if (!unsafeHtml) return '';
  return unsafeHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<(?:iframe|object|embed|form|meta|base)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed|form)>/gi, '')
    .replace(/<(?:iframe|object|embed|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript|data:text\/html):[^"']*\2/gi, '$1=$2#$2');
}

export function stripHtmlToText(html: string): string {
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

export function compileClientBlocks(
  blocks: EmailTemplateBlock[],
  opts?: { subject?: string; previewText?: string }
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
        for (const para of text.split(/\n{2,}/)) {
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

  const wrappedHtml = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f9fafb;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:28px;"><tr><td>${htmlParts.join('\n')}</td></tr></table></td></tr></table></body></html>`;

  return {
    htmlBody: sanitizePreviewHtml(wrappedHtml),
    textBody: textParts.join('\n\n').trim() || opts?.subject || '',
  };
}

export function renderLocalPersonalization(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{\s*([a-zA-Z0-9_]+)(?:\s*\|\s*fallback:\s*["']([^"']*)["'])?\s*\}\}/g, (_m, key: string, fb?: string) => {
    const val = vars[key];
    if (val !== undefined && val !== '') return val;
    return fb ?? '';
  });
}
