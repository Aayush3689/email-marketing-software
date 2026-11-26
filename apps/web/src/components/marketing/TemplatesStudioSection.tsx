import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppDialog, Badge, Button, Card, EmptyState, Input, Skeleton } from '@mail/ui';
import type { EmailTemplateBlock } from '@mail/shared-types';
import { Archive, Copy, FileCode2, Pencil, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, type TemplateItem } from '../../lib/api.js';
import {
  compileClientBlocks,
  DEFAULT_TEMPLATE_BLOCKS,
  VisualEmailEditor,
} from './VisualEmailEditor.js';

function getActiveVersion(tpl: TemplateItem) {
  return (
    tpl.versions.find((v) => v.versionNumber === tpl.activeVersion) ??
    tpl.versions[tpl.versions.length - 1] ?? {
      versionNumber: tpl.activeVersion ?? 1,
      subject: '',
      previewText: '',
      htmlBody: '',
      textBody: '',
      blocksJson: [],
      createdAt: tpl.createdAt,
    }
  );
}

export function TemplatesStudioSection() {
  const qc = useQueryClient();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState('');

  // Editor Dialog state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<'newsletter' | 'onboarding' | 'product' | 'transactional' | 'custom'>('newsletter');
  const [description, setDescription] = useState('');
  const [subject, setSubject] = useState('A quick update, {{firstName | fallback: "there"}}');
  const [previewText, setPreviewText] = useState('');
  const [blocks, setBlocks] = useState<EmailTemplateBlock[]>(DEFAULT_TEMPLATE_BLOCKS);
  const [htmlBody, setHtmlBody] = useState(() => compileClientBlocks(DEFAULT_TEMPLATE_BLOCKS).htmlBody);
  const [textBody, setTextBody] = useState(() => compileClientBlocks(DEFAULT_TEMPLATE_BLOCKS).textBody);

  const [deleteTarget, setDeleteTarget] = useState<TemplateItem | null>(null);

  const templatesQuery = useQuery({
    queryKey: ['templates', includeArchived],
    queryFn: () => api.listTemplates(includeArchived),
  });

  const openNewTemplate = () => {
    setEditingId(null);
    setName('');
    setCategory('newsletter');
    setDescription('');
    setSubject('A quick update, {{firstName | fallback: "there"}}');
    setPreviewText('');
    setBlocks(DEFAULT_TEMPLATE_BLOCKS);
    const compiled = compileClientBlocks(DEFAULT_TEMPLATE_BLOCKS);
    setHtmlBody(compiled.htmlBody);
    setTextBody(compiled.textBody);
    setEditorOpen(true);
  };

  const openEditTemplate = (tpl: TemplateItem) => {
    const ver = getActiveVersion(tpl);
    setEditingId(tpl.id);
    setName(tpl.name);
    const cat = tpl.category as 'newsletter' | 'onboarding' | 'product' | 'transactional' | 'custom';
    setCategory(['newsletter', 'onboarding', 'product', 'transactional', 'custom'].includes(cat) ? cat : 'newsletter');
    setDescription(tpl.description ?? '');
    setSubject(ver.subject);
    setPreviewText(ver.previewText ?? '');
    setBlocks(ver.blocksJson ?? []);
    setHtmlBody(ver.htmlBody);
    setTextBody(ver.textBody);
    setEditorOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      if (editingId) {
        return api.updateTemplate(editingId, {
          name,
          category,
          description,
          subject,
          previewText,
          htmlBody,
          textBody,
          blocksJson: blocks,
        });
      }
      return api.createTemplate({
        name,
        category,
        ...(description ? { description } : {}),
        subject,
        ...(previewText ? { previewText } : {}),
        htmlBody,
        textBody,
        ...(blocks.length > 0 ? { blocksJson: blocks } : {}),
      });
    },
    onSuccess: () => {
      toast.success(editingId ? 'Template updated (new version saved)' : 'Template created');
      setEditorOpen(false);
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save template'),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: string) => api.duplicateTemplate(id),
    onSuccess: () => {
      toast.success('Template duplicated');
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Duplicate failed'),
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => api.updateTemplate(id, { archived }),
    onSuccess: (_res, vars) => {
      toast.success(vars.archived ? 'Template archived' : 'Template restored');
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Archive toggle failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteTemplate(id),
    onSuccess: () => {
      toast.success('Template deleted');
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Delete failed'),
  });

  const templates = (templatesQuery.data?.templates ?? []).filter((t) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    const ver = getActiveVersion(t);
    return (
      t.name.toLowerCase().includes(q) ||
      ver.subject.toLowerCase().includes(q) ||
      (t.category ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-[var(--color-text-muted)]" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates..."
              className="pl-8"
            />
          </div>
          <Button
            size="sm"
            variant={includeArchived ? 'primary' : 'secondary'}
            onClick={() => setIncludeArchived((v) => !v)}
          >
            <Archive className="h-3.5 w-3.5" />
            {includeArchived ? 'Showing Archived' : 'Show Archived'}
          </Button>
        </div>

        <Button onClick={openNewTemplate}>
          <Plus className="h-4 w-4" /> New Email Template
        </Button>
      </div>

      {templatesQuery.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-44 w-full" />
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          icon={<FileCode2 className="h-5 w-5" />}
          title="No email templates yet"
          description="Create reusable visual or HTML email templates with personalization variables and plain-text fallbacks."
          action={
            <Button onClick={openNewTemplate}>
              <Plus className="h-4 w-4" /> Create First Template
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((tpl) => {
            const ver = getActiveVersion(tpl);
            const isArchived = Boolean(tpl.archivedAt);
            return (
              <Card key={tpl.id} className="flex flex-col justify-between p-4 space-y-3">
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-[var(--color-text)]">{tpl.name}</h3>
                      <p className="text-xs text-[var(--color-text-muted)] mt-0.5 line-clamp-1">{ver.subject}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge tone="neutral">v{tpl.activeVersion}</Badge>
                      {isArchived && <Badge tone="warning">Archived</Badge>}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="brand">{tpl.category || 'newsletter'}</Badge>
                    {(ver.blocksJson?.length ?? 0) > 0 ? (
                      <Badge tone="success">{ver.blocksJson?.length} blocks</Badge>
                    ) : (
                      <Badge tone="neutral">Custom HTML</Badge>
                    )}
                  </div>
                  {tpl.description && (
                    <p className="text-xs text-[var(--color-text-muted)] line-clamp-2">{tpl.description}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
                  <span className="text-[11px] text-[var(--color-text-muted)]">
                    Updated {new Date(tpl.updatedAt ?? tpl.createdAt).toLocaleDateString()}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="secondary" onClick={() => openEditTemplate(tpl)}>
                      <Pencil className="h-3 w-3" /> Edit
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => duplicateMutation.mutate(tpl.id)}
                      title="Duplicate template"
                      aria-label={`Duplicate ${tpl.name}`}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => archiveMutation.mutate({ id: tpl.id, archived: !isArchived })}
                      title={isArchived ? 'Restore template' : 'Archive template'}
                      aria-label={isArchived ? `Restore ${tpl.name}` : `Archive ${tpl.name}`}
                    >
                      {isArchived ? <RotateCcw className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setDeleteTarget(tpl)}
                      title="Delete template"
                      aria-label={`Delete ${tpl.name}`}
                      className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <AppDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        title={editingId ? 'Edit Email Template' : 'Create Email Template'}
        maxWidthClass="max-w-5xl"
      >
        <div className="max-h-[82vh] overflow-y-auto space-y-4 pr-1">
          <p className="text-xs text-[var(--color-text-muted)]">
            Build with structured email blocks or edit sanitized HTML + plain-text directly.
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">Template Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Weekly Product Digest"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">Category</label>
              <select
                value={category}
                onChange={(e) =>
                  setCategory(
                    e.target.value as 'newsletter' | 'onboarding' | 'product' | 'transactional' | 'custom'
                  )
                }
                className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)]"
              >
                <option value="newsletter">Newsletter</option>
                <option value="onboarding">Onboarding</option>
                <option value="product">Product Update</option>
                <option value="transactional">Transactional</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">Notes / Description</label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Internal description (optional)"
              />
            </div>
          </div>

          <VisualEmailEditor
            subject={subject}
            previewText={previewText}
            blocks={blocks}
            htmlBody={htmlBody}
            textBody={textBody}
            onChange={(patch) => {
              if (patch.subject !== undefined) setSubject(patch.subject);
              if (patch.previewText !== undefined) setPreviewText(patch.previewText);
              if (patch.blocks !== undefined) setBlocks(patch.blocks);
              if (patch.htmlBody !== undefined) setHtmlBody(patch.htmlBody);
              if (patch.textBody !== undefined) setTextBody(patch.textBody);
            }}
          />

          <div className="flex justify-end gap-2 border-t border-[var(--color-border)] pt-3">
            <Button variant="secondary" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!name.trim() || !subject.trim() || !htmlBody.trim() || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? 'Saving...' : editingId ? 'Save New Version' : 'Create Template'}
            </Button>
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete Template"
      >
        <div className="space-y-3">
          <p className="text-xs text-[var(--color-text-muted)]">
            Are you sure you want to permanently delete &ldquo;{deleteTarget?.name ?? ''}&rdquo;?
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Permanently'}
            </Button>
          </div>
        </div>
      </AppDialog>
    </div>
  );
}
