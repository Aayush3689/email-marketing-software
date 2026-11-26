import { useQuery } from '@tanstack/react-query';
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
import {
  compileClientBlocks,
  renderLocalPersonalization,
  sanitizePreviewHtml,
  stripHtmlToText,
} from './marketingDraftHelpers.js';

export { compileClientBlocks, sanitizePreviewHtml, stripHtmlToText };

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

const BASE_MERGE_VARS = [
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

  const customFieldsQuery = useQuery({
    queryKey: ['custom-fields'],
    queryFn: () => api.listCustomFields(),
  });

  const mergeVars = useMemo(() => {
    const customVars = (customFieldsQuery.data?.customFields ?? []).map((cf) => ({
      label: cf.label,
      token: `{{${cf.fieldKey}}}`,
    }));
    return [...BASE_MERGE_VARS, ...customVars];
  }, [customFieldsQuery.data?.customFields]);

  const sampleVars = useMemo(() => {
    const base: Record<string, string> = {
      firstName: sampleFirst,
      lastName: sampleLast,
      email: sampleEmail,
      unsubscribeUrl: 'https://fastconnect.local/v1/unsubscribe/sample-preview',
    };
    for (const cf of customFieldsQuery.data?.customFields ?? []) {
      base[cf.fieldKey] = `[${cf.label}]`;
    }
    return base;
  }, [customFieldsQuery.data?.customFields, sampleEmail, sampleFirst, sampleLast]);

  const renderedPreviewHtml = useMemo(
    () => renderLocalPersonalization(sanitizePreviewHtml(htmlBody), sampleVars),
    [htmlBody, sampleVars]
  );

  const renderedSubject = useMemo(() => renderLocalPersonalization(subject, sampleVars), [sampleVars, subject]);

  const hasUnsubscribeLink = /\{\{\s*unsubscribeUrl\s*\}\}|unsubscribe/i.test(htmlBody);
  const hasPlainText = textBody.trim().length > 0;
  const imageBlocksMissingAlt = blocks.filter(
    (b) => b.type === 'image' && !String(b.props.alt ?? '').trim()
  ).length;

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
        toast.success(`Inserted ${token} into ${active.type} block`);
        return;
      }
      if (active.type === 'footer') {
        updateBlockProp(active.id, 'address', `${String(active.props.address ?? '')} ${token}`.trim());
        toast.success(`Inserted ${token} into footer`);
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
    <div className="space-y-4">
      {/* Subject & Preheader */}
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">Subject Line</label>
          <Input
            value={subject}
            onChange={(e) => onChange({ subject: e.target.value })}
            placeholder='e.g. Welcome to our newsletter, {{firstName | fallback: "friend"}}'
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">Preview Text (Preheader)</label>
          <Input
            value={previewText}
            onChange={(e) => onChange({ previewText: e.target.value })}
            placeholder="Shown next to the subject line in most inboxes"
          />
        </div>
      </div>

      {/* Mode Switcher Tabs + Personalization Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2">
        <div className="flex items-center gap-1 rounded-md bg-[var(--color-surface)] p-0.5 border border-[var(--color-border)]">
          <button
            type="button"
            onClick={() => setEditorMode('blocks')}
            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
              editorMode === 'blocks'
                ? 'bg-[var(--color-accent)] text-[var(--color-accent-fg)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            <LayoutTemplate className="h-3.5 w-3.5" /> Visual Blocks
          </button>
          <button
            type="button"
            onClick={() => setEditorMode('html')}
            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
              editorMode === 'html'
                ? 'bg-[var(--color-accent)] text-[var(--color-accent-fg)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            <Code2 className="h-3.5 w-3.5" /> HTML Source
          </button>
          <button
            type="button"
            onClick={() => setEditorMode('text')}
            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
              editorMode === 'text'
                ? 'bg-[var(--color-accent)] text-[var(--color-accent-fg)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            <FileText className="h-3.5 w-3.5" /> Plain Text
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-[var(--color-text-muted)]">Personalize:</span>
          {mergeVars.map((v) => (
            <button
              key={v.token}
              type="button"
              onClick={() => insertMergeVarIntoBlock(v.token)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text)] hover:border-[var(--color-brand)] transition-colors cursor-pointer"
            >
              + {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Warnings Banner */}
      {(!hasUnsubscribeLink || !hasPlainText || imageBlocksMissingAlt > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
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
                  className="underline font-medium cursor-pointer"
                  onClick={() => onChange({ textBody: stripHtmlToText(htmlBody) })}
                >
                  Auto-generate from HTML
                </button>
              </span>
            )}
            {imageBlocksMissingAlt > 0 && (
              <span>{imageBlocksMissingAlt} image block(s) missing alt text for accessibility.</span>
            )}
          </div>
        </div>
      )}

      {/* Main Two-Panel Workspace */}
      <div className={`grid gap-5 items-start ${compact ? 'lg:grid-cols-2' : 'xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]'}`}>
        {/* Left: Content & Block Inspector */}
        <Card className="p-4 space-y-4">
          {editorMode === 'blocks' && (
            <>
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  Add Content Block
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {BLOCK_PALETTE.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Button key={item.type} type="button" size="sm" variant="secondary" onClick={() => addBlock(item.type)}>
                        <Icon className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
                        {item.label}
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                {blocks.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-xs text-[var(--color-text-muted)]">
                    No content blocks yet. Add blocks above or{' '}
                    <button
                      type="button"
                      className="underline text-[var(--color-brand)] cursor-pointer"
                      onClick={() => syncFromBlocks(DEFAULT_TEMPLATE_BLOCKS)}
                    >
                      load starter layout
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
                            ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]/50 ring-1 ring-[var(--color-brand)]/40'
                            : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <Badge tone={active ? 'brand' : 'neutral'}>{block.type}</Badge>
                            <span className="truncate text-xs text-[var(--color-text)]">
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
                          <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              disabled={index === 0}
                              onClick={() => moveBlock(index, -1)}
                              title="Move block up"
                              aria-label="Move block up"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              disabled={index === blocks.length - 1}
                              onClick={() => moveBlock(index, 1)}
                              title="Move block down"
                              aria-label="Move block down"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => removeBlock(block.id)}
                              title="Delete block"
                              aria-label="Delete block"
                              className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {selectedBlock && (
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                      Properties — {selectedBlock.type}
                    </span>
                  </div>
                  {selectedBlock.type === 'heading' && (
                    <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
                      <Input
                        value={String(selectedBlock.props.text ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'text', e.target.value)}
                        placeholder="Heading text"
                      />
                      <select
                        value={String(selectedBlock.props.level ?? 'h2')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'level', e.target.value)}
                        className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)]"
                      >
                        <option value="h1">H1 (26px)</option>
                        <option value="h2">H2 (20px)</option>
                      </select>
                    </div>
                  )}
                  {selectedBlock.type === 'text' && (
                    <textarea
                      rows={5}
                      value={String(selectedBlock.props.text ?? '')}
                      onChange={(e) => updateBlockProp(selectedBlock.id, 'text', e.target.value)}
                      className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-brand)] focus:outline-none"
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
                        rows={4}
                        value={String(selectedBlock.props.leftText ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'leftText', e.target.value)}
                        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs text-[var(--color-text)] focus:border-[var(--color-brand)] focus:outline-none"
                        placeholder="Left column"
                      />
                      <textarea
                        rows={4}
                        value={String(selectedBlock.props.rightText ?? '')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'rightText', e.target.value)}
                        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs text-[var(--color-text)] focus:border-[var(--color-brand)] focus:outline-none"
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
                        placeholder="Postal address or reason"
                      />
                      <Input
                        value={String(selectedBlock.props.unsubscribeText ?? 'Unsubscribe')}
                        onChange={(e) => updateBlockProp(selectedBlock.id, 'unsubscribeText', e.target.value)}
                        placeholder="Unsubscribe label"
                      />
                    </div>
                  )}
                  {selectedBlock.type === 'divider' && (
                    <p className="text-xs text-[var(--color-text-muted)]">Horizontal 1px divider separator.</p>
                  )}
                </div>
              )}
            </>
          )}

          {editorMode === 'html' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-[var(--color-text-muted)]">
                  Email HTML Source (sanitized automatically on save and send)
                </p>
                <Button size="sm" variant="secondary" onClick={() => onChange({ textBody: stripHtmlToText(htmlBody) })}>
                  Sync Plain Text
                </Button>
              </div>
              <textarea
                rows={18}
                value={htmlBody}
                onChange={(e) => onChange({ htmlBody: e.target.value })}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 font-mono text-xs text-[var(--color-text)] focus:border-[var(--color-brand)] focus:outline-none"
                placeholder="<html>...</html>"
              />
            </div>
          )}

          {editorMode === 'text' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-[var(--color-text-muted)]">
                  Multipart Plain-Text Fallback (improves deliverability & text-only readers)
                </p>
                <Button size="sm" variant="secondary" onClick={() => onChange({ textBody: stripHtmlToText(htmlBody) })}>
                  Generate from HTML
                </Button>
              </div>
              <textarea
                rows={18}
                value={textBody}
                onChange={(e) => onChange({ textBody: e.target.value })}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 font-mono text-xs text-[var(--color-text)] focus:border-[var(--color-brand)] focus:outline-none"
                placeholder="Plain text email body..."
              />
            </div>
          )}
        </Card>

        {/* Right: Sanitized Desktop/Mobile Preview */}
        <Card className="p-4 space-y-3 xl:sticky xl:top-20">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-[var(--color-text-muted)]" />
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                Live Inbox Preview
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant={previewDevice === 'desktop' ? 'primary' : 'ghost'}
                onClick={() => setPreviewDevice('desktop')}
              >
                <Monitor className="h-3.5 w-3.5" /> Desktop
              </Button>
              <Button
                type="button"
                size="sm"
                variant={previewDevice === 'mobile' ? 'primary' : 'ghost'}
                onClick={() => setPreviewDevice('mobile')}
              >
                <Smartphone className="h-3.5 w-3.5" /> Mobile
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={verifyingServer}
                onClick={handleServerRenderCheck}
              >
                <Sparkles className="h-3.5 w-3.5" /> {verifyingServer ? 'Checking...' : 'Validate'}
              </Button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-2">
            <Input
              value={sampleFirst}
              onChange={(e) => setSampleFirst(e.target.value)}
              placeholder="Sample firstName"
              className="text-xs h-8"
            />
            <Input
              value={sampleLast}
              onChange={(e) => setSampleLast(e.target.value)}
              placeholder="Sample lastName"
              className="text-xs h-8"
            />
            <Input
              value={sampleEmail}
              onChange={(e) => setSampleEmail(e.target.value)}
              placeholder="Sample email"
              className="text-xs h-8"
            />
          </div>

          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs">
            <div className="font-medium text-[var(--color-text)]">
              Subject: <span className="font-normal">{renderedSubject || '(no subject)'}</span>
            </div>
            {previewText && (
              <div className="text-[var(--color-text-muted)] truncate">
                Preheader: {renderLocalPersonalization(previewText, sampleVars)}
              </div>
            )}
          </div>

          <div className="flex justify-center rounded-lg border border-[var(--color-border)] bg-zinc-100 dark:bg-zinc-900 p-3">
            <iframe
              title="Email Render Preview"
              sandbox=""
              srcDoc={renderedPreviewHtml || '<p style="font-family:sans-serif;color:#666;padding:16px;">No HTML content yet.</p>'}
              style={{
                width: previewDevice === 'mobile' ? '375px' : '100%',
                maxWidth: '640px',
                height: '460px',
                border: '1px solid #e4e4e7',
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
