import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, Input } from '@mail/ui';
import type { SegmentConditionRule, SegmentRuleOperator, SubscriberRecord } from '@mail/shared-types';
import { Filter, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useCentralTags } from './TagSelector.js';

const FIELD_OPTIONS = [
  { value: 'tags', label: 'Tag Membership' },
  { value: 'status', label: 'Subscription Status' },
  { value: 'email', label: 'Email Address' },
  { value: 'firstName', label: 'First Name' },
  { value: 'lastName', label: 'Last Name' },
  { value: 'consentSource', label: 'Signup / Consent Source' },
  { value: 'createdAt', label: 'Signup Date' },
  { value: 'lastActivityAt', label: 'Last Engagement Date' },
  { value: 'engagementScore', label: 'Engagement Score' },
  { value: 'emailActivity', label: 'Email Open / Click Activity' },
];

const OPERATOR_OPTIONS: Array<{ value: SegmentRuleOperator; label: string }> = [
  { value: 'has_tag', label: 'Has tag' },
  { value: 'not_has_tag', label: 'Does not have tag' },
  { value: 'has_any_tag', label: 'Has any of tags (comma-sep)' },
  { value: 'has_all_tags', label: 'Has all tags (comma-sep)' },
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Does not equal' },
  { value: 'contains', label: 'Contains' },
  { value: 'opened_broadcast', label: 'Opened a broadcast (or blank for any)' },
  { value: 'not_opened_broadcast', label: 'Did not open broadcast' },
  { value: 'clicked_link', label: 'Clicked any link' },
  { value: 'not_clicked_link', label: 'Did not click link' },
  { value: 'in_last_days', label: 'Within last N days' },
  { value: 'gt', label: 'Greater than' },
  { value: 'lt', label: 'Less than' },
  { value: 'is_empty', label: 'Is empty' },
  { value: 'is_not_empty', label: 'Is not empty' },
];

function newRule(): SegmentConditionRule {
  return {
    id: crypto.randomUUID(),
    kind: 'rule',
    field: 'tags',
    operator: 'has_tag',
    value: '',
  };
}

export function SegmentsBuilderSection() {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [matchType, setMatchType] = useState<'all' | 'any'>('all');
  const [rules, setRules] = useState<SegmentConditionRule[]>([newRule()]);
  const [previewData, setPreviewData] = useState<{ count: number; sample: SubscriberRecord[] } | null>(null);

  const segmentsQuery = useQuery({ queryKey: ['segments'], queryFn: () => api.listSegments() });
  const customFieldsQuery = useQuery({ queryKey: ['custom-fields'], queryFn: () => api.listCustomFields() });
  const { tags: centralTags } = useCentralTags();

  const previewMutation = useMutation({
    mutationFn: () => api.previewSegment({ matchType, conditions: rules }),
    onSuccess: (res) => setPreviewData(res),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Preview failed'),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      editingId
        ? api.updateSegment(editingId, { name: name.trim(), description: description.trim(), matchType, conditions: rules })
        : api.createSegment({ name: name.trim(), description: description.trim(), matchType, conditions: rules }),
    onSuccess: async () => {
      toast.success(editingId ? 'Segment updated' : 'Dynamic segment saved');
      setEditingId(null);
      setName('');
      setDescription('');
      setRules([newRule()]);
      setPreviewData(null);
      await qc.invalidateQueries({ queryKey: ['segments'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save segment'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSegment(id),
    onSuccess: async () => {
      toast.success('Segment deleted');
      await qc.invalidateQueries({ queryKey: ['segments'] });
    },
  });

  const segments = segmentsQuery.data?.segments ?? [];
  const customFields = customFieldsQuery.data?.customFields ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-12 items-start">
      {/* Builder */}
      <Card className="p-4 space-y-4 lg:col-span-7 text-xs">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text)]">
              {editingId ? 'Edit Dynamic Segment' : 'Visual Dynamic Segment Builder'}
            </h3>
            <p className="text-[var(--color-text-muted)]">
              Segments dynamically filter your single audience using live rules — never duplicating subscribers.
            </p>
          </div>
          {editingId && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditingId(null);
                setName('');
                setDescription('');
                setRules([newRule()]);
              }}
            >
              New Segment
            </Button>
          )}
        </div>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            saveMutation.mutate();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="font-medium">Segment Name *</label>
              <Input placeholder="Engaged Newsletter Readers" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <label className="font-medium">Match Logic</label>
              <select
                className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5"
                value={matchType}
                onChange={(e) => setMatchType(e.target.value as 'all' | 'any')}
              >
                <option value="all">Match ALL conditions (AND)</option>
                <option value="any">Match ANY condition (OR)</option>
              </select>
            </div>
          </div>

          <Input placeholder="Optional segment description..." value={description} onChange={(e) => setDescription(e.target.value)} />

          <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3 bg-[var(--color-surface-muted)]/30">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Conditions</span>
              <Button type="button" size="sm" variant="secondary" onClick={() => setRules((r) => [...r, newRule()])}>
                <Plus className="h-3.5 w-3.5" /> Add Condition
              </Button>
            </div>

            {rules.map((rule, idx) => (
              <div key={rule.id} className="grid gap-2 sm:grid-cols-12 items-center">
                <div className="sm:col-span-4">
                  <select
                    className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2"
                    value={rule.field}
                    onChange={(e) =>
                      setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, field: e.target.value } : r)))
                    }
                  >
                    {FIELD_OPTIONS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                    {customFields.map((cf) => (
                      <option key={cf.id} value={`custom.${cf.fieldKey}`}>
                        Custom: {cf.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-4">
                  <select
                    className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2"
                    value={rule.operator}
                    onChange={(e) =>
                      setRules((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, operator: e.target.value as SegmentRuleOperator } : r))
                      )
                    }
                  >
                    {OPERATOR_OPTIONS.map((op) => (
                      <option key={op.value} value={op.value}>
                        {op.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-3">
                  {rule.field === 'tags' && (rule.operator === 'has_tag' || rule.operator === 'not_has_tag') && centralTags.length > 0 ? (
                    <select
                      aria-label="Segment tag filter"
                      className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[var(--color-text)]"
                      value={String(rule.value ?? '')}
                      onChange={(e) =>
                        setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))
                      }
                    >
                      <option value="">Select tag...</option>
                      {centralTags.map((t) => (
                        <option key={t.id} value={t.name}>
                          {t.name} ({t.subscriberCount})
                        </option>
                      ))}
                      {Boolean(rule.value) && !centralTags.some((t) => t.name === String(rule.value)) && (
                        <option value={String(rule.value)}>{String(rule.value)}</option>
                      )}
                    </select>
                  ) : (
                    <Input
                      placeholder={rule.field === 'tags' ? 'Comma-separated tag names...' : 'Value...'}
                      value={Array.isArray(rule.value) ? rule.value.join(',') : String(rule.value ?? '')}
                      onChange={(e) =>
                        setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))
                      }
                    />
                  )}
                </div>

                <div className="sm:col-span-1 flex justify-end">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={rules.length <= 1}
                    onClick={() => setRules((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-red-500" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending}>
              <RefreshCw className={`h-3.5 w-3.5 ${previewMutation.isPending ? 'animate-spin' : ''}`} />
              Preview Matching Subscribers
            </Button>
            <Button type="submit" size="sm" disabled={saveMutation.isPending || !name.trim()}>
              <Save className="h-3.5 w-3.5" />
              {editingId ? 'Update Segment' : 'Save Segment'}
            </Button>
          </div>
        </form>

        {previewData && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-1.5">
            <div className="font-semibold text-emerald-700 dark:text-emerald-300">
              Live Preview: {previewData.count} matching subscriber(s)
            </div>
            {previewData.sample.slice(0, 5).map((s) => (
              <div key={s.id} className="font-mono text-[11px]">
                {s.email} {s.tags.length > 0 ? `(${s.tags.join(', ')})` : ''}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Saved Segments List */}
      <Card className="p-4 space-y-3 lg:col-span-5 text-xs">
        <h3 className="text-sm font-semibold text-[var(--color-text)]">Saved Segments ({segments.length})</h3>
        {segments.length === 0 ? (
          <EmptyState icon={<Filter className="h-5 w-5" />} title="No saved segments" description="Build reusable dynamic audiences for your broadcasts and filters." />
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {segments.map((s) => (
              <div key={s.id} className="py-2.5 flex items-start justify-between gap-2">
                <div className="space-y-1">
                  <div className="font-semibold text-[var(--color-text)] flex items-center gap-2">
                    <span>{s.name}</span>
                    <Badge tone="brand">{s.subscriberCount ?? 0} matching</Badge>
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    Match {s.matchType.toUpperCase()} • {s.conditions.length} condition(s)
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setEditingId(s.id);
                      setName(s.name);
                      setDescription(s.description);
                      setMatchType(s.matchType);
                      setRules((s.conditions.filter((c) => c.kind === 'rule') as SegmentConditionRule[]) || [newRule()]);
                    }}
                  >
                    Edit
                  </Button>
                  <Button size="icon" variant="ghost" className="text-red-500" onClick={() => deleteMutation.mutate(s.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
