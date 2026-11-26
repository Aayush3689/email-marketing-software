import { Badge, Button, Card, Input } from '@mail/ui';
import type { EmailBlockType, EmailTemplateBlock } from '@mail/shared-types';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Code2,
  Columns2,
  Eye,
  FileText,
  Heading2,
  Image,
  LayoutTemplate,
  Minus,
  Monitor,
  MousePointerClick,
  Share2,
  Smartphone,
  Sparkles,
  Trash2,
  Type,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';

export const DEFAULT_TEMPLATE_BLOCKS: EmailTemplateBlock[] = [
  {
    id: 'blk_heading_1',
    type: 'heading',
    props: { text: 'Welcome, {{firstName | fallback: "friend"}}', level: 'h1' },
  },
  {
    id: 'blk_text_1',
    type: 'text',
    props: {
      text: 'Thanks for subscribing to updates from our team. Here is what you can expect in your inbox each week.',
    },
  },
  {
    id: 'blk_button_1',
    type: 'button',
    props: { label: 'Read the latest issue', url: 'https://example.com', color: '#18181b' },
  },
  {
    id: 'blk_footer_1',
    type: 'footer',
    props: {
      company: 'FastConnect Sender',
      address: 'Sent to {{email}}',
      unsubscribeText: 'Unsubscribe anytime',
    },
  },
];

const MERGE_VARS = [
  { label: 'First Name (fallback)', token: '{{firstName | fallback: "there"}}' },
  { label: 'First Name', token: '{{firstName}}' },
  { label: 'Last Name', token: '{{lastName}}' },
  { label: 'Email', token: '{{email}}' },
  { label: 'Unsubscribe URL', token: '{{unsubscribeUrl}}' },
];

const BLOCK_PALETTE: Array<{ type: EmailBlockType; label: string; icon: typeof Heading2 }> = [
  { type: 'heading', label: 'Heading', icon: Heading2 },
  { type: 'text', label: 'Paragraph', icon: Type },
  { type: 'button', label: 'CTA Button', icon: MousePointerClick },
  { type: 'image', label: 'Image', icon: Image },
  { type: 'columns', label: '2 Columns', icon: Columns2 },
  { type: 'divider', label: 'Divider', icon: Minus },
  { type: 'social', label: 'Social Links', icon: Share2 },
  { type: 'footer', label: 'Footer + Unsub', icon: LayoutTemplate },
];

function escapeHtml(text: string): string {
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

function renderLocalPersonalization(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{\s*([a-zA-Z0-9_]+)(?:\s*\|\s*fallback:\s*["']([^"']*)["'])?\s*\}\}/g, (_m, key: string, fb?: string) => {
    const val = vars[key];
    if (val !== undefined && val !== '') return val;
    return fb ?? '';
  });
}

function createDefaultBlock(type: EmailBlockType): EmailTemplateBlock {
  const id = `blk_${type}_${Math.random().toString(36).slice(2, 8)}`;
  switch (type) {
    case 'heading':
      return { id, type, props: { text: 'Section heading', level: 'h2' } };
    case 'text':
      return { id, type, props: { text: 'Write your message here. Use {{firstName | fallback: "there"}} to personalize.' } };
    case 'image':
      return { id, type, props: { src: 'https://placehold.co/540x220/png?text=Banner+Image', alt: 'Newsletter banner', href: '' } };
    case 'button':
      return { id, type, props: { label: 'Call to Action', url: 'https://example.com', color: '#18181b' } };
    case 'divider':
      return { id, type, props: {} };
    case 'columns':
      return { id, type, props: { leftText: 'Left highlight details.', rightText: 'Right highlight details.' } };
    case 'social':
      return { id, type, props: { links: ['https://x.com', 'https://linkedin.com'] } };
    case 'footer':
      return {
        id,
        type,
        props: { company: 'FastConnect Sender', address: 'Your Postal Address', unsubscribeText: 'Unsubscribe' },
      };
  }
}

export function VisualEmailEditor({
  subject,
  previewText,
  blocks,
  htmlBody,
  textBody,
  onChange,
  compact = false,
}: {
  subject: string;
  previewText: string;
  blocks: EmailTemplateBlock[];
  htmlBody: string;
  textBody: string;
  onChange: (next: {
    subject?: string;
    previewText?: string;
    blocks?: EmailTemplateBlock[];
    htmlBody?: string;
    textBody?: string;
  }) => void;
  compact?: boolean;
}) {
  const [editorMode, setEditorMode] = useState<'blocks' | 'html' | 'text'>(
    blocks.length > 0 || !htmlBody ? 'blocks' : 'html'
  );
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(blocks[0]?.id ?? null);
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [sampleFirst, setSampleFirst] = useState('Aarav');
  const [sampleLast, setSampleLast] = useState('Mehta');
  const [sampleEmail, setSampleEmail] = useState('aarav@example.com');
  const [verifyingServer, setVerifyingServer] = useState(false);

  const sampleVars = useMemo(
    () => ({
      firstName: sampleFirst,
      lastName: sampleLast,
      email: sampleEmail,
      unsubscribeUrl: 'https://fastconnect.local/v1/unsubscribe/sample-preview',
    }),
    [sampleEmail, sampleFirst, sampleLast]
  );

  const renderedPreviewHtml = useMemo(
    () => renderLocalPersonalization(sanitizePreviewHtml(htmlBody), sampleVars),
    [htmlBody, sampleVars]
  );

  const renderedSubject = useMemo(() => renderLocalPersonalization(subject, sampleVars), [sampleVars, subject]);

  const hasUnsubscribeLink = /\{\{\s*unsubscribeUrl\s*\}\}|unsubscribe/i.test(htmlBody);
  const hasPlainText = textBody.trim().length > 0;

  const syncFromBlocks = (nextBlocks: EmailTemplateBlock[]) => {
    const compiled = compileClientBlocks(nextBlocks, {
      ...(subject ? { subject } : {}),
      ...(previewText ? { previewText } : {}),
    });
    onChange({
      blocks: nextBlocks,
      htmlBody: compiled.htmlBody,
      textBody: compiled.textBody,
    });
  };

  const addBlock = (type: EmailBlockType) => {
    const blk = createDefaultBlock(type);
    const next = [...blocks, blk];
    setSelectedBlockId(blk.id);
    syncFromBlocks(next);
  };

  const moveBlock = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    const current = next[index];
    const swap = next[target];
    if (!current || !swap) return;
    next[index] = swap;
    next[target] = current;
    syncFromBlocks(next);
  };

  const removeBlock = (id: string) => {
    const next = blocks.filter((b) => b.id !== id);
    if (selectedBlockId === id) setSelectedBlockId(next[0]?.id ?? null);
    syncFromBlocks(next);
  };

  const updateBlockProp = (id: string, key: string, value: string | string[]) => {
    const next = blocks.map((b) => (b.id === id ? { ...b, props: { ...b.props, [key]: value } } : b));
    syncFromBlocks(next);
  };

  const insertMergeVarIntoBlock = (token: string) => {
    const active = blocks.find((b) => b.id === selectedBlockId);
    if (editorMode === 'blocks' && active) {
      if (active.type === 'text' || active.type === 'heading') {
        updateBlockProp(active.id, 'text', `${String(active.props.text ?? '')} ${token}`.trim());
        return;
      }
      if (active.type === 'footer') {
        updateBlockProp(active.id, 'address', `${String(active.props.address ?? '')} ${token}`.trim());
        return;
      }
    }
    onChange({ subject: `${subject} ${token}`.trim() });
    toast.success(`Inserted ${token} into subject`);
  };

  const handleServerRenderCheck = async () => {
    setVerifyingServer(true);
    try {
      if (editorMode === 'blocks' && blocks.length > 0) {
        const res = await api.renderTemplateBlocks({
          blocksJson: blocks,
          ...(subject ? { subject } : {}),
          ...(previewText ? { previewText } : {}),
        });
        onChange({ htmlBody: res.htmlBody, textBody: res.textBody });
        toast.success('Compiled and sanitized via API renderer');
      } else {
        const res = await api.previewTemplate({ subject, htmlBody, variables: sampleVars });
        onChange({ htmlBody: res.htmlBody });
        toast.success('Verified HTML sanitization & merge variables');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Preview check failed');
    } finally {
      setVerifyingServer(false);
    }
  };

  const selectedBlock = blocks.find((b) => b.id === selectedBlockId) ?? blocks[0] ?? null;

  return (
    <div className="space-y-3">
      {/* Subject & Preheader */}
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Subject Line</label>
          <Input
            value={subject}
            onChange={(e) => onChange({ subject: e.target.value })}
            placeholder='e.g. Welcome to our newsletter, {{firstName | fallback: "friend"}}'
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Preview Text (Preheader)</label>
          <Input
            value={previewText}
            onChange={(e) => onChange({ previewText: e.target.value })}
            placeholder="Shown next to the subject line in most inboxes"
          />
        </div>
      </div>

      {/* Mode Switcher + Personalization Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={editorMode === 'blocks' ? 'primary' : 'secondary'}
            onClick={() => setEditorMode('blocks')}
          >
            <LayoutTemplate className="mr-1 h-3.5 w-3.5" /> Visual Blocks
          </Button>
          <Button
            size="sm"
            variant={editorMode === 'html' ? 'primary' : 'secondary'}
            onClick={() => setEditorMode('html')}
          >
            <Code2 className="mr-1 h-3.5 w-3.5" /> HTML Source
          </Button>
          <Button
            size="sm"
            variant={editorMode === 'text' ? 'primary' : 'secondary'}
            onClick={() => setEditorMode('text')}
          >
            <FileText className="mr-1 h-3.5 w-3.5" /> Plain Text
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-[var(--fg-muted)]">Insert variable:</span>
          {MERGE_VARS.map((v) => (
            <button
              key={v.token}
              type="button"
              onClick={() => insertMergeVarIntoBlock(v.token)}
              className="rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--fg-primary)] hover:border-[var(--accent)]"
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Warnings Banner */}
      {(!hasUnsubscribeLink || !hasPlainText) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="flex flex-wrap items-center gap-3">
            {!hasUnsubscribeLink && (
              <span>Missing unsubscribe link (`{'{{unsubscribeUrl}}'}`) — add a Footer block for deliverability compliance.</span>
            )}
            {!hasPlainText && (
              <span>
                Plain-text fallback is empty.{' '}
                <button
                  type="button"
                  className="underline font-medium"
                  onClick={() => onChange({ textBody: stripHtmlToText(htmlBody) })}
                >
                  Auto-generate from HTML
                </button>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Main Split Workspace */}
      <div className={`grid gap-4 ${compact ? 'lg:grid-cols-2' : 'xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]'}`}>
        {/* Left: Editor Pane */}
        <Card className="p-3 space-y-3">
          {editorMode === 'blocks' && (
            <>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
                  Add Content Block
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {BLOCK_PALETTE.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.type}
                        type="button"
                        onClick={() => addBlock(item.type)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-subtle)] px-2.5 py-1.5 text-xs font-medium text-[var(--fg-primary)] hover:border-[var(--accent)]"
                      >
                        <Icon className="h-3.5 w-3.5 text-[var(--fg-muted)]" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                {blocks.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[var(--border-default)] p-6 text-center text-xs text-[var(--fg-muted)]">
                    No blocks yet. Add a Heading, Paragraph, CTA Button, or Footer block above, or{' '}
                    <button
                      type="button"
                      className="underline text-[var(--fg-primary)]"
                      onClick={() => syncFromBlocks(DEFAULT_TEMPLATE_BLOCKS)}
                    >
                      load starter blocks
                    </button>
                    .
                  </div>
                ) : (
                  blocks.map((block, index) => {
                    const active = selectedBlock?.id === block.id;
                    return (
                      <div
                        key={block.id}
                        onClick={() => setSelectedBlockId(block.id)}
                        className={`cursor-pointer rounded-lg border p-2.5 transition-colors ${
                          active
                            ? 'border-[var(--accent)] bg-[var(--bg-subtle)]'
                            : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-default)]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <Badge tone="neutral">{block.type}</Badge>
                            <span className="truncate text-xs text-[var(--fg-secondary)]">
                              {String(
                                block.props.text ??
                                  block.props.label ??
                                  block.props.alt ??
                                  block.props.company ??
                                  block.props.leftText ??
                                  block.type
                              )}
                            </span>
                          </div>
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              disabled={index === 0}
                              onClick={() => moveBlock(index, -1)}
                              className="rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] disabled:opacity-30"
                              title="Move up"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={index === blocks.length - 1}
                              onClick={() => moveBlock(index, 1)}
                              className="rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] disabled:opacity-30"
                              title="Move down"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeBlock(block.id)}
                              className="rounded p-1 text-red-400 hover:bg-red-500/10"
                              title="Delete block"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Selected Block Inspector */}
              {selectedBlock && (
                <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
                      Edit {selectedBlock.type} Block
                    </span>
                  </div>
                  {selectedBlock.type === 'heading' && (
                    <div className="grid gap-2 sm:grid-cols-[1fr_110px]">
                      <Input
                        value={String(selectedBlock.props.text ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'text', e.target.value)}
                        placeholder="Heading text"
                      />
                      <select
                        value={String(selectedBlock.props.level ?? 'h2')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'level', e.target.value)}
                        className="rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1.5 text-xs text-[var(--fg-primary)]"
                      >
                        <option value="h1">H1 (26px)</option>
                        <option value="h2">H2 (20px)</option>
                      </select>
                    </div>
                  )}
                  {selectedBlock.type === 'text' && (
                    <textarea
                      rows={4}
                      value={String(selectedBlock.props.text ?? '')}
                      onChange={(e) => updateBlockProp(selectedBlock.id, 'text', e.target.value)}
                      className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] p-2.5 text-sm text-[var(--fg-primary)]"
                      placeholder="Write paragraph text..."
                    />
                  )}
                  {selectedBlock.type === 'button' && (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Input
                        value={String(selectedBlock.props.label ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'label', e.target.value)}
                        placeholder="Button label"
                      />
                      <Input
                        value={String(selectedBlock.props.url ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'url', e.target.value)}
                        placeholder="https://..."
                      />
                      <Input
                        value={String(selectedBlock.props.color ?? '#18181b')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'color', e.target.value)}
                        placeholder="#18181b"
                      />
                    </div>
                  )}
                  {selectedBlock.type === 'image' && (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Input
                        value={String(selectedBlock.props.src ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'src', e.target.value)}
                        placeholder="https://image-url..."
                      />
                      <Input
                        value={String(selectedBlock.props.alt ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'alt', e.target.value)}
                        placeholder="Alt description"
                      />
                      <Input
                        value={String(selectedBlock.props.href ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'href', e.target.value)}
                        placeholder="Link URL (optional)"
                      />
                    </div>
                  )}
                  {selectedBlock.type === 'columns' && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <textarea
                        rows={3}
                        value={String(selectedBlock.props.leftText ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'leftText', e.target.value)}
                        className="rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] p-2 text-xs text-[var(--fg-primary)]"
                        placeholder="Left column"
                      />
                      <textarea
                        rows={3}
                        value={String(selectedBlock.props.rightText ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'rightText', e.target.value)}
                        className="rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] p-2 text-xs text-[var(--fg-primary)]"
                        placeholder="Right column"
                      />
                    </div>
                  )}
                  {selectedBlock.type === 'social' && (
                    <Input
                      value={Array.isArray(selectedBlock.props.links) ? selectedBlock.props.links.join(', ') : ''}
                      onChange={(e) =>
                        updateBlockProp(
                          selectedBlock.id,
                          'links',
                          e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean)
                        )
                      }
                      placeholder="https://x.com/..., https://linkedin.com/..."
                    />
                  )}
                  {selectedBlock.type === 'footer' && (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Input
                        value={String(selectedBlock.props.company ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'company', e.target.value)}
                        placeholder="Sender / Company Name"
                      />
                      <Input
                        value={String(selectedBlock.props.address ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'address', e.target.value)}
                        placeholder="Postal address or why subscribed"
                      />
                      <Input
                        value={String(selectedBlock.props.unsubscribeText ?? 'Unsubscribe')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'unsubscribeText', e.target.value)}
                        placeholder="Unsubscribe link label"
                      />
                    </div>
                  )}
                  {selectedBlock.type === 'divider' && (
                    <p className="text-xs text-[var(--fg-muted)]">Horizontal 1px divider line.</p>
                  )}
                </div>
              )}
            </>
          )}

          {editorMode === 'html' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-[var(--fg-muted)]">
                  Email HTML Source (automatically sanitized on save and send)
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onChange({ textBody: stripHtmlToText(htmlBody) })}
                >
                  Sync Plain Text
                </Button>
              </div>
              <textarea
                rows={18}
                value={htmlBody}
                onChange={(e) => onChange({ htmlBody: e.target.value })}
                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 font-mono text-xs text-[var(--fg-primary)]"
                placeholder="<html>...</html>"
              />
            </div>
          )}

          {editorMode === 'text' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-[var(--fg-muted)]">
                  Multipart Plain-Text Version (improves spam filtering & text-only clients)
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onChange({ textBody: stripHtmlToText(htmlBody) })}
                >
                  Generate from HTML
                </Button>
              </div>
              <textarea
                rows={18}
                value={textBody}
                onChange={(e) => onChange({ textBody: e.target.value })}
                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 font-mono text-xs text-[var(--fg-primary)]"
                placeholder="Plain text email body..."
              />
            </div>
          )}
        </Card>

        {/* Right: Sanitized Desktop/Mobile Preview */}
        <Card className="p-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-[var(--fg-muted)]" />
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
                Live Inbox Preview
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant={previewDevice === 'desktop' ? 'primary' : 'secondary'}
                onClick={() => setPreviewDevice('desktop')}
              >
                <Monitor className="mr-1 h-3.5 w-3.5" /> Desktop
              </Button>
              <Button
                size="sm"
                variant={previewDevice === 'mobile' ? 'primary' : 'secondary'}
                onClick={() => setPreviewDevice('mobile')}
              >
                <Smartphone className="mr-1 h-3.5 w-3.5" /> Mobile
              </Button>
              <Button size="sm" variant="secondary" disabled={verifyingServer} onClick={handleServerRenderCheck}>
                <Sparkles className="mr-1 h-3.5 w-3.5" /> {verifyingServer ? 'Checking...' : 'Validate'}
              </Button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-2">
            <Input
              value={sampleFirst}
              onChange={(e) => setSampleFirst(e.target.value)}
              placeholder="Sample firstName"
              className="text-xs"
            />
            <Input
              value={sampleLast}
              onChange={(e) => setSampleLast(e.target.value)}
              placeholder="Sample lastName"
              className="text-xs"
            />
            <Input
              value={sampleEmail}
              onChange={(e) => setSampleEmail(e.target.value)}
              placeholder="Sample email"
              className="text-xs"
            />
          </div>

          <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3 py-2 text-xs">
            <div className="font-medium text-[var(--fg-primary)]">
              Subject: <span className="font-normal">{renderedSubject || '(no subject)'}</span>
            </div>
            {previewText && (
              <div className="text-[var(--fg-muted)] truncate">
                Preheader: {renderLocalPersonalization(previewText, sampleVars)}
              </div>
            )}
          </div>

          <div className="flex justify-center rounded-lg border border-[var(--border-subtle)] bg-zinc-100 p-3">
            <iframe
              title="Email Render Preview"
              sandbox=""
              srcDoc={renderedPreviewHtml || '<p style="font-family:sans-serif;color:#666;padding:16px;">No HTML content yet.</p>'}
              style={{
                width: previewDevice === 'mobile' ? '375px' : '100%',
                maxWidth: '640px',
                height: '380px',
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                background: '#ffffff',
              }}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
