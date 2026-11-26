import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppDialog, Badge, Button, Card, EmptyState, Input } from '@mail/ui';
import { Edit2, Plus, Search, Sliders, Tag, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { invalidateAllTagDependents } from './TagSelector.js';

export function TagsSection({ onViewSubscribersWithTag }: { onViewSubscribersWithTag: (tagName: string) => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createColor, setCreateColor] = useState('#2563eb');
  const [editingTag, setEditingTag] = useState<{ id: string; name: string; description: string; color: string } | null>(null);
  const [deleteTagTarget, setDeleteTagTarget] = useState<{ id: string; name: string } | null>(null);

  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: () => api.listTags() });

  const createMutation = useMutation({
    mutationFn: () => api.createTag({ name: createName.trim(), description: createDesc.trim(), color: createColor }),
    onSuccess: async () => {
      toast.success('Tag created and synced globally');
      setCreateName('');
      setCreateDesc('');
      await invalidateAllTagDependents(qc);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create tag'),
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      api.updateTag(editingTag!.id, {
        name: editingTag!.name.trim(),
        description: editingTag!.description.trim(),
        color: editingTag!.color,
      }),
    onSuccess: async () => {
      toast.success('Tag renamed and synced across all views');
      setEditingTag(null);
      await invalidateAllTagDependents(qc);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update tag'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteTag(id),
    onSuccess: async () => {
      toast.success('Tag deleted (subscribers preserved)');
      setDeleteTagTarget(null);
      await invalidateAllTagDependents(qc);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete tag'),
  });

  const tags = tagsQuery.data?.tags ?? [];
  const filteredTags = tags.filter((t) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-text)]">Centralized Tag Management ({tags.length})</h3>
          <p className="text-xs text-[var(--color-text-muted)]">
            Single source of truth for tags across Subscribers, Broadcasts, Automations, Signup Forms, and Landing Pages.
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-[var(--color-text-muted)]" />
          <Input placeholder="Search tags..." className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <Card className="p-4 space-y-3">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Create Tag</h4>
        </div>
        <form
          className="grid gap-2.5 sm:grid-cols-12 items-end text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            if (!createName.trim()) return;
            createMutation.mutate();
          }}
        >
          <div className="sm:col-span-4 space-y-1">
            <label className="font-medium text-[var(--color-text)]">Tag Name</label>
            <Input placeholder="e.g. Newsletter, Customer" value={createName} onChange={(e) => setCreateName(e.target.value)} required />
          </div>
          <div className="sm:col-span-5 space-y-1">
            <label className="font-medium text-[var(--color-text)]">Description</label>
            <Input placeholder="Opted into weekly product digest" value={createDesc} onChange={(e) => setCreateDesc(e.target.value)} />
          </div>
          <div className="sm:col-span-1 space-y-1">
            <label className="font-medium text-[var(--color-text)]">Color</label>
            <input
              aria-label="Tag color"
              type="color"
              value={createColor}
              onChange={(e) => setCreateColor(e.target.value)}
              className="h-9 w-full rounded border border-[var(--color-border)] bg-transparent p-0.5 cursor-pointer"
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" className="w-full" disabled={!createName.trim() || createMutation.isPending}>
              <Plus className="h-3.5 w-3.5" /> Add Tag
            </Button>
          </div>
        </form>
      </Card>

      {filteredTags.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Tag className="h-5 w-5" />}
            title={tags.length === 0 ? 'No tags created yet' : 'No matching tags'}
            description={tags.length === 0 ? 'Create tags above to segment and trigger automations.' : 'Try adjusting your tag search filter.'}
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredTags.map((t) => (
            <Card key={t.id} className="p-4 flex flex-col justify-between gap-3 text-xs">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 font-semibold text-sm text-[var(--color-text)]">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                    {t.name}
                  </span>
                  <Badge tone="neutral">{t.subscriberCount} subscribers</Badge>
                </div>
                <p className="text-[var(--color-text-muted)] min-h-[16px]">{t.description || 'No description'}</p>
              </div>
              <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-2.5">
                <Button size="sm" variant="ghost" onClick={() => onViewSubscribersWithTag(t.name)}>
                  <Users className="h-3.5 w-3.5" /> View Subscribers
                </Button>
                <div className="flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Rename / Edit Tag"
                    aria-label={`Edit tag ${t.name}`}
                    onClick={() => setEditingTag({ id: t.id, name: t.name, description: t.description, color: t.color })}
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Delete Tag"
                    aria-label={`Delete tag ${t.name}`}
                    className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
                    onClick={() => setDeleteTagTarget({ id: t.id, name: t.name })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <AppDialog open={Boolean(editingTag)} onOpenChange={(o) => !o && setEditingTag(null)} title="Rename / Edit Tag">
        {editingTag && (
          <form
            className="space-y-3 text-xs"
            onSubmit={(e) => {
              e.preventDefault();
              updateMutation.mutate();
            }}
          >
            <div className="space-y-1">
              <label className="font-medium text-[var(--color-text)]">Tag Name</label>
              <Input value={editingTag.name} onChange={(e) => setEditingTag({ ...editingTag, name: e.target.value })} required />
            </div>
            <div className="space-y-1">
              <label className="font-medium text-[var(--color-text)]">Description</label>
              <Input value={editingTag.description} onChange={(e) => setEditingTag({ ...editingTag, description: e.target.value })} />
            </div>
            <div className="space-y-1">
              <label className="font-medium text-[var(--color-text)]">Color</label>
              <input
                type="color"
                value={editingTag.color}
                onChange={(e) => setEditingTag({ ...editingTag, color: e.target.value })}
                className="h-9 w-24 rounded border border-[var(--color-border)] bg-transparent p-0.5 cursor-pointer"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setEditingTag(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!editingTag.name.trim() || updateMutation.isPending}>
                {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </form>
        )}
      </AppDialog>

      <AppDialog
        open={Boolean(deleteTagTarget)}
        onOpenChange={(o) => !o && setDeleteTagTarget(null)}
        title={`Delete Tag "${deleteTagTarget?.name ?? ''}"?`}
      >
        <div className="space-y-3 text-xs">
          <p className="text-[var(--color-text-muted)]">
            Deleting a tag removes the label from tagged subscribers but <strong>never deletes the subscribers themselves</strong>.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteTagTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTagTarget && deleteMutation.mutate(deleteTagTarget.id)}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Tag'}
            </Button>
          </div>
        </div>
      </AppDialog>
    </div>
  );
}

export function CustomFieldsSection() {
  const qc = useQueryClient();
  const [fieldKey, setFieldKey] = useState('');
  const [label, setLabel] = useState('');
  const [fieldType, setFieldType] = useState<'text' | 'number' | 'date' | 'boolean'>('text');
  const [description, setDescription] = useState('');

  const fieldsQuery = useQuery({ queryKey: ['custom-fields'], queryFn: () => api.listCustomFields() });

  const createMutation = useMutation({
    mutationFn: () => api.createCustomField({ fieldKey: fieldKey.trim().toLowerCase(), label: label.trim(), fieldType, description: description.trim() }),
    onSuccess: async () => {
      toast.success('Custom field added');
      setFieldKey('');
      setLabel('');
      setDescription('');
      await qc.invalidateQueries({ queryKey: ['custom-fields'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create field'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteCustomField(id),
    onSuccess: async () => {
      toast.success('Custom field removed');
      await qc.invalidateQueries({ queryKey: ['custom-fields'] });
    },
  });

  const fields = fieldsQuery.data?.customFields ?? [];

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-text)]">Subscriber Custom Fields</h3>
          <p className="text-xs text-[var(--color-text-muted)]">
            Use custom fields in personalization tokens (e.g. <span className="font-mono">{'{{custom.company | fallback: "your team"}}'}</span>) and dynamic segments.
          </p>
        </div>
        <form
          className="grid gap-2.5 sm:grid-cols-12 items-end text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate();
          }}
        >
          <div className="sm:col-span-3 space-y-1">
            <label className="font-medium">Field Key</label>
            <Input placeholder="company_name" value={fieldKey} onChange={(e) => setFieldKey(e.target.value)} required />
          </div>
          <div className="sm:col-span-3 space-y-1">
            <label className="font-medium">Label</label>
            <Input placeholder="Company Name" value={label} onChange={(e) => setLabel(e.target.value)} required />
          </div>
          <div className="sm:col-span-2 space-y-1">
            <label className="font-medium">Type</label>
            <select
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2"
              value={fieldType}
              onChange={(e) => setFieldType(e.target.value as 'text' | 'number' | 'date' | 'boolean')}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="date">Date</option>
              <option value="boolean">Boolean</option>
            </select>
          </div>
          <div className="sm:col-span-2 space-y-1">
            <label className="font-medium">Description</label>
            <Input placeholder="Optional note" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" className="w-full" disabled={createMutation.isPending}>
              <Plus className="h-3.5 w-3.5" /> Add Field
            </Button>
          </div>
        </form>
      </Card>

      {fields.length === 0 ? (
        <Card>
          <EmptyState icon={<Sliders className="h-5 w-5" />} title="No custom fields defined" description="Define structured subscriber attributes for personalization and segmentation." />
        </Card>
      ) : (
        <Card className="divide-y divide-[var(--color-border)] text-xs">
          {fields.map((f) => (
            <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div>
                <div className="font-medium text-[var(--color-text)]">
                  {f.label} <Badge tone="neutral">{f.fieldType}</Badge>
                </div>
                <div className="font-mono text-[11px] text-[var(--color-text-muted)]">
                  Merge token: {`{{custom.${f.fieldKey} | fallback: ""}}`}
                </div>
              </div>
              <Button size="icon" variant="ghost" className="text-red-500" onClick={() => deleteMutation.mutate(f.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
