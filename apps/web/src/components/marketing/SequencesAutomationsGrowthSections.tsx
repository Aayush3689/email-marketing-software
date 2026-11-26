import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppDialog, AppSwitch, Badge, Button, Card, EmptyState, Input, Skeleton } from '@mail/ui';
import type {
  AutomationEdge,
  AutomationNode,
  AutomationNodeType,
  AutomationTriggerType,
  EmailSequenceItem,
  GrowthFormItem,
  LandingPageItem,
  SequenceStepItem,
} from '@mail/shared-types';
import {
  Activity,
  ArrowRight,
  Copy,
  FileInput,
  Globe,
  ListOrdered,
  Play,
  Plus,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { stripHtmlToText } from './VisualEmailEditor.js';

// ============================================================================
// 1. EMAIL SEQUENCES (DRIP WORKFLOWS)
// ============================================================================

export function SequencesSection() {
  const qc = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [domainId, setDomainId] = useState('');
  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [allowReentry, setAllowReentry] = useState(false);
  const [exitOnUnsubscribe, setExitOnUnsubscribe] = useState(true);
  const [steps, setSteps] = useState<
    Array<Omit<SequenceStepItem, 'sequenceId' | 'blocksJson'> & { blocksJson?: SequenceStepItem['blocksJson'] }>
  >([]);

  const [enrollTarget, setEnrollTarget] = useState<EmailSequenceItem | null>(null);
  const [enrollSubscriberId, setEnrollSubscriberId] = useState('');

  const sequencesQuery = useQuery({ queryKey: ['sequences'], queryFn: () => api.listSequences() });
  const domainsQuery = useQuery({ queryKey: ['domains'], queryFn: () => api.listDomains() });
  const subscribersQuery = useQuery({
    queryKey: ['subscribers', 'enroll-picker'],
    queryFn: () => api.listSubscribers({ status: 'subscribed', pageSize: 100 }),
  });
  const enrollmentsQuery = useQuery({
    queryKey: ['sequence-enrollments', enrollTarget?.id],
    queryFn: () => api.listSequenceEnrollments(enrollTarget!.id),
    enabled: Boolean(enrollTarget),
  });

  const verifiedDomains = (domainsQuery.data?.domains ?? []).filter(
    (d) => Boolean(d.ownershipVerifiedAt) && d.sendingEnabled && !d.isSuspended
  );

  const openNew = () => {
    const dom = verifiedDomains[0];
    setEditingId(null);
    setName('');
    setDescription('');
    setDomainId(dom?.id ?? '');
    setFromName('');
    setFromEmail(dom ? `hello@${dom.domainName}` : '');
    setEnabled(false);
    setAllowReentry(false);
    setExitOnUnsubscribe(true);
    setSteps([
      {
        id: `step_${Date.now()}`,
        position: 1,
        delayDays: 0,
        delayHours: 0,
        subject: 'Welcome, {{firstName | fallback: "friend"}}!',
        previewText: '',
        htmlBody: '<p>Thanks for joining. Reply anytime!</p><p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>',
        textBody: 'Thanks for joining. Unsubscribe: {{unsubscribeUrl}}',
        enabled: true,
      },
    ]);
    setEditorOpen(true);
  };

  const openEdit = (seq: EmailSequenceItem) => {
    setEditingId(seq.id);
    setName(seq.name);
    setDescription(seq.description);
    setDomainId(seq.domainId ?? '');
    setFromName(seq.fromName);
    setFromEmail(seq.fromEmail ?? '');
    setEnabled(seq.enabled);
    setAllowReentry(seq.allowReentry);
    setExitOnUnsubscribe(seq.exitOnUnsubscribe);
    setSteps(seq.steps.map((s) => ({ ...s })));
    setEditorOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name,
        description,
        domainId: domainId || null,
        fromName,
        fromEmail: fromEmail || null,
        enabled,
        allowReentry,
        exitOnUnsubscribe,
        steps: steps.map((s, idx) => ({
          id: s.id,
          position: idx + 1,
          delayDays: Number(s.delayDays) || 0,
          delayHours: Number(s.delayHours) || 0,
          subject: s.subject,
          previewText: s.previewText,
          htmlBody: s.htmlBody,
          textBody: s.textBody || stripHtmlToText(s.htmlBody),
          enabled: s.enabled,
        })),
      };
      return editingId ? api.updateSequence(editingId, payload) : api.createSequence(payload);
    },
    onSuccess: () => {
      toast.success(editingId ? 'Sequence updated' : 'Sequence created');
      setEditorOpen(false);
      qc.invalidateQueries({ queryKey: ['sequences'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save sequence'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSequence(id),
    onSuccess: () => {
      toast.success('Sequence deleted');
      qc.invalidateQueries({ queryKey: ['sequences'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Delete failed'),
  });

  const enrollMutation = useMutation({
    mutationFn: ({ seqId, subId }: { seqId: string; subId: string }) => api.enrollInSequence(seqId, subId),
    onSuccess: () => {
      toast.success('Subscriber enrolled in sequence');
      setEnrollSubscriberId('');
      qc.invalidateQueries({ queryKey: ['sequence-enrollments', enrollTarget?.id] });
      qc.invalidateQueries({ queryKey: ['sequences'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Enrollment failed'),
  });

  const sequences = sequencesQuery.data?.sequences ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--fg-primary)]">Automated Email Sequences</h2>
          <p className="text-xs text-[var(--fg-muted)]">
            Multi-step drip series executed automatically on schedule by the background sequence processor.
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-1.5 h-4 w-4" /> New Sequence
        </Button>
      </div>

      {sequencesQuery.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : sequences.length === 0 ? (
        <EmptyState
          icon={<ListOrdered className="h-5 w-5" />}
          title="No email sequences yet"
          description="Create an onboarding or nurture series with custom day/hour delays between emails."
          action={
            <Button onClick={openNew}>
              <Plus className="mr-1.5 h-4 w-4" /> Create First Sequence
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {sequences.map((seq) => (
            <Card key={seq.id} className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--fg-primary)]">{seq.name}</h3>
                    <Badge tone={seq.enabled ? 'success' : 'neutral'}>
                      {seq.enabled ? 'Active' : 'Paused'}
                    </Badge>
                  </div>
                  <p className="text-xs text-[var(--fg-muted)] mt-0.5">
                    {seq.steps.length} step{seq.steps.length === 1 ? '' : 's'} • {seq.enrolledCount} active enrollment
                    {seq.enrolledCount === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => setEnrollTarget(seq)}>
                    Enrollments
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => openEdit(seq)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => deleteMutation.mutate(seq.id)}>
                    <Trash2 className="h-3.5 w-3.5 text-red-400" />
                  </Button>
                </div>
              </div>
              {seq.description && <p className="text-xs text-[var(--fg-secondary)]">{seq.description}</p>}
              <div className="space-y-1">
                {seq.steps.slice(0, 3).map((st) => (
                  <div
                    key={st.id}
                    className="flex items-center justify-between rounded bg-[var(--bg-subtle)] px-2.5 py-1 text-xs"
                  >
                    <span className="truncate font-medium text-[var(--fg-primary)]">
                      #{st.position}: {st.subject}
                    </span>
                    <span className="shrink-0 text-[var(--fg-muted)]">
                      +{st.delayDays}d {st.delayHours}h
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Sequence Editor Dialog */}
      <AppDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        title={editingId ? 'Edit Email Sequence' : 'Create Email Sequence'}
        maxWidthClass="max-w-3xl"
      >
        <div className="max-h-[78vh] overflow-y-auto space-y-4 pr-1">
          <p className="text-xs text-[var(--fg-muted)]">
            Configure sender identity, drip delays, and personalized step emails.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Sequence Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 5-Day Onboarding" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Verified Sending Domain</label>
              <select
                value={domainId}
                onChange={(e) => setDomainId(e.target.value)}
                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--fg-primary)]"
              >
                <option value="">Select domain...</option>
                {verifiedDomains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.domainName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">From Name</label>
              <Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="FastConnect Team" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">From Email</label>
              <Input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="hello@yourdomain.com" />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3 text-xs">
            <label className="flex items-center gap-2">
              <AppSwitch checked={enabled} onCheckedChange={setEnabled} />
              <span>Sequence Enabled</span>
            </label>
            <label className="flex items-center gap-2">
              <AppSwitch checked={allowReentry} onCheckedChange={setAllowReentry} />
              <span>Allow Re-entry</span>
            </label>
            <label className="flex items-center gap-2">
              <AppSwitch checked={exitOnUnsubscribe} onCheckedChange={setExitOnUnsubscribe} />
              <span>Exit on Unsubscribe</span>
            </label>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
                Sequence Emails ({steps.length})
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  setSteps((prev) => [
                    ...prev,
                    {
                      id: `step_${Date.now()}_${prev.length}`,
                      position: prev.length + 1,
                      delayDays: 2,
                      delayHours: 0,
                      subject: `Follow-up #${prev.length + 1}`,
                      previewText: '',
                      htmlBody: '<p>Follow-up content here.</p><p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>',
                      textBody: 'Follow-up content here. Unsubscribe: {{unsubscribeUrl}}',
                      enabled: true,
                    },
                  ])
                }
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add Email Step
              </Button>
            </div>

            {steps.map((st, idx) => (
              <Card key={st.id} className="p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[var(--fg-primary)]">Email #{idx + 1}</span>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs">
                      Days:
                      <input
                        type="number"
                        min={0}
                        value={st.delayDays}
                        onChange={(e) =>
                          setSteps((prev) =>
                            prev.map((x, i) => (i === idx ? { ...x, delayDays: Number(e.target.value) } : x))
                          )
                        }
                        className="w-16 rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-xs"
                      />
                    </label>
                    <label className="flex items-center gap-1 text-xs">
                      Hours:
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={st.delayHours}
                        onChange={(e) =>
                          setSteps((prev) =>
                            prev.map((x, i) => (i === idx ? { ...x, delayHours: Number(e.target.value) } : x))
                          )
                        }
                        className="w-16 rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-xs"
                      />
                    </label>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setSteps((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-400" />
                    </Button>
                  </div>
                </div>
                <Input
                  value={st.subject}
                  onChange={(e) =>
                    setSteps((prev) => prev.map((x, i) => (i === idx ? { ...x, subject: e.target.value } : x)))
                  }
                  placeholder="Step subject"
                />
                <textarea
                  rows={3}
                  value={st.htmlBody}
                  onChange={(e) =>
                    setSteps((prev) =>
                      prev.map((x, i) =>
                        i === idx ? { ...x, htmlBody: e.target.value, textBody: stripHtmlToText(e.target.value) } : x
                      )
                    )
                  }
                  className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] p-2 font-mono text-xs text-[var(--fg-primary)]"
                />
              </Card>
            ))}
          </div>

          <div className="flex justify-end gap-2 border-t border-[var(--border-subtle)] pt-3">
            <Button variant="secondary" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!name.trim() || steps.length === 0 || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
              {saveMutation.isPending ? 'Saving...' : 'Save Sequence'}
            </Button>
          </div>
        </div>
      </AppDialog>

      {/* Enrollments Drawer/Dialog */}
      <AppDialog
        open={Boolean(enrollTarget)}
        onOpenChange={(open) => {
          if (!open) setEnrollTarget(null);
        }}
        title={`Enrollments: ${enrollTarget?.name ?? ''}`}
      >
        <div className="space-y-4">
          <p className="text-xs text-[var(--fg-muted)]">
            Manually enroll a subscriber or inspect active progression.
          </p>
          <div className="flex gap-2">
            <select
              value={enrollSubscriberId}
              onChange={(e) => setEnrollSubscriberId(e.target.value)}
              className="flex-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--fg-primary)]"
            >
              <option value="">Select subscribed contact...</option>
              {(subscribersQuery.data?.subscribers ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.email} ({s.firstName} {s.lastName})
                </option>
              ))}
            </select>
            <Button
              disabled={!enrollSubscriberId || enrollMutation.isPending}
              onClick={() => enrollTarget && enrollMutation.mutate({ seqId: enrollTarget.id, subId: enrollSubscriberId })}
            >
              Enroll
            </Button>
          </div>

          <div className="max-h-64 overflow-y-auto space-y-1.5">
            {(enrollmentsQuery.data?.enrollments ?? []).length === 0 ? (
              <p className="text-xs text-[var(--fg-muted)]">No enrollments yet.</p>
            ) : (
              (enrollmentsQuery.data?.enrollments ?? []).map((en) => (
                <div
                  key={en.id}
                  className="flex items-center justify-between rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3 py-2 text-xs"
                >
                  <div>
                    <div className="font-medium text-[var(--fg-primary)]">{en.subscriberEmail}</div>
                    <div className="text-[11px] text-[var(--fg-muted)]">
                      Step index: {en.currentStepIndex} • Enrolled {new Date(en.enrolledAt).toLocaleString()}
                    </div>
                  </div>
                  <Badge tone={en.status === 'active' ? 'brand' : en.status === 'completed' ? 'success' : 'neutral'}>
                    {en.status}
                  </Badge>
                </div>
              ))
            )}
          </div>
        </div>
      </AppDialog>
    </div>
  );
}

// ============================================================================
// 2. VISUAL AUTOMATIONS BUILDER + ACTIVITY LOGS
// ============================================================================

const TRIGGER_OPTIONS: Array<{ value: AutomationTriggerType; label: string }> = [
  { value: 'tag_added', label: 'When a Tag is Added' },
  { value: 'form_submitted', label: 'When a Form is Submitted' },
  { value: 'landing_page_signup', label: 'Landing Page Signup' },
  { value: 'segment_joined', label: 'Subscriber Joins Segment' },
  { value: 'api_event', label: 'Custom API / Manual Trigger' },
];

const NODE_OPTIONS: Array<{ value: AutomationNodeType; label: string }> = [
  { value: 'condition', label: 'Condition (If / Else)' },
  { value: 'delay', label: 'Delay / Wait' },
  { value: 'action_add_tag', label: 'Action: Add Tag' },
  { value: 'action_remove_tag', label: 'Action: Remove Tag' },
  { value: 'action_subscribe_sequence', label: 'Action: Enroll Sequence' },
  { value: 'action_unsubscribe_sequence', label: 'Action: Exit Sequence' },
  { value: 'action_update_field', label: 'Action: Update Field' },
  { value: 'end', label: 'End Flow' },
];

export function AutomationsSection({ initialTab = 'builder' }: { initialTab?: 'builder' | 'activity' }) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTrigger, setNewTrigger] = useState<AutomationTriggerType>('tag_added');
  const [newTagName, setNewTagName] = useState('');
  const [testSubId, setTestSubId] = useState('');

  // Node editing modal state
  const [editNode, setEditNode] = useState<AutomationNode | null>(null);

  const automationsQuery = useQuery({ queryKey: ['automations'], queryFn: () => api.listAutomations() });
  const runsQuery = useQuery({
    queryKey: ['automation-runs', selectedId],
    queryFn: () => api.listAutomationRuns(selectedId ?? undefined),
  });
  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: () => api.listTags() });
  const sequencesQuery = useQuery({ queryKey: ['sequences'], queryFn: () => api.listSequences() });
  const subscribersQuery = useQuery({
    queryKey: ['subscribers', 'auto-test'],
    queryFn: () => api.listSubscribers({ pageSize: 100 }),
  });

  const automations = automationsQuery.data?.automations ?? [];
  const activeAutomation = automations.find((a) => a.id === selectedId) ?? automations[0] ?? null;

  const createMutation = useMutation({
    mutationFn: () => {
      const triggerNode: AutomationNode = {
        id: 'node_trigger',
        type: 'trigger',
        label: TRIGGER_OPTIONS.find((t) => t.value === newTrigger)?.label ?? 'Trigger',
        x: 60,
        y: 60,
        config: newTagName ? { tagName: newTagName } : {},
      };
      const actionNode: AutomationNode = {
        id: 'node_step_1',
        type: 'action_add_tag',
        label: 'Tag as Engaged',
        x: 300,
        y: 60,
        config: { tagName: 'engaged' },
      };
      const edge: AutomationEdge = { id: 'edge_1', source: 'node_trigger', target: 'node_step_1', branch: 'next' };
      return api.createAutomation({
        name: newName,
        description: '',
        status: 'draft',
        triggerType: newTrigger,
        triggerConfig: newTagName ? { tagName: newTagName } : {},
        nodes: [triggerNode, actionNode],
        edges: [edge],
      });
    },
    onSuccess: (res) => {
      toast.success('Visual automation created');
      setSelectedId(res.automation.id);
      setCreateOpen(false);
      setNewName('');
      qc.invalidateQueries({ queryKey: ['automations'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create automation'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => api.updateAutomation(id, patch),
    onSuccess: () => {
      toast.success('Automation updated');
      qc.invalidateQueries({ queryKey: ['automations'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Update failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteAutomation(id),
    onSuccess: () => {
      toast.success('Automation deleted');
      setSelectedId(null);
      qc.invalidateQueries({ queryKey: ['automations'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Delete failed'),
  });

  const triggerTestMutation = useMutation({
    mutationFn: ({ id, subId }: { id: string; subId: string }) => api.triggerAutomation(id, subId),
    onSuccess: () => {
      toast.success('Automation triggered for subscriber');
      qc.invalidateQueries({ queryKey: ['automation-runs'] });
      qc.invalidateQueries({ queryKey: ['automations'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Trigger failed'),
  });

  const addConnectedNode = (type: AutomationNodeType) => {
    if (!activeAutomation) return;
    const prevNode = activeAutomation.nodes[activeAutomation.nodes.length - 1];
    const newId = `node_${Date.now()}`;
    const newNode: AutomationNode = {
      id: newId,
      type,
      label: NODE_OPTIONS.find((n) => n.value === type)?.label ?? type,
      x: (prevNode?.x ?? 60) + 220,
      y: prevNode?.y ?? 60,
      config: type === 'delay' ? { delayMinutes: 60 } : {},
    };
    const nextNodes = [...activeAutomation.nodes, newNode];
    const nextEdges = prevNode
      ? [
          ...activeAutomation.edges,
          { id: `edge_${Date.now()}`, source: prevNode.id, target: newId, branch: 'next' as const },
        ]
      : activeAutomation.edges;
    updateMutation.mutate({
      id: activeAutomation.id,
      patch: { nodes: nextNodes, edges: nextEdges },
    });
  };

  const removeNode = (nodeId: string) => {
    if (!activeAutomation || nodeId === 'node_trigger') return;
    const nextNodes = activeAutomation.nodes.filter((n) => n.id !== nodeId);
    const nextEdges = activeAutomation.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
    updateMutation.mutate({
      id: activeAutomation.id,
      patch: { nodes: nextNodes, edges: nextEdges },
    });
  };

  if (initialTab === 'activity') {
    const runs = runsQuery.data?.runs ?? [];
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[var(--fg-primary)]">Automation Execution Activity</h2>
            <p className="text-xs text-[var(--fg-muted)]">
              Live and completed subscriber journeys executed by published automations.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => runsQuery.refetch()}>
            <Activity className="mr-1.5 h-3.5 w-3.5" /> Refresh Logs
          </Button>
        </div>

        {runs.length === 0 ? (
          <EmptyState
            icon={<Activity className="h-5 w-5" />}
            title="No automation runs yet"
            description="Publish an automation and enroll or trigger a subscriber to inspect step-by-step execution."
          />
        ) : (
          <div className="space-y-2">
            {runs.map((r) => (
              <Card key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-xs">
                <div>
                  <div className="font-medium text-[var(--fg-primary)]">{r.subscriberEmail}</div>
                  <div className="text-[var(--fg-muted)]">
                    Current Node: <code>{r.currentNodeId ?? 'completed'}</code> • Started{' '}
                    {new Date(r.startedAt).toLocaleString()}
                  </div>
                </div>
                <Badge tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'brand'}>
                  {r.status}
                </Badge>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--fg-primary)]">Visual Automation Workflows</h2>
          <p className="text-xs text-[var(--fg-muted)]">
            Connect triggers, delays, conditions, tags, and sequences in one visual flow executed asynchronously.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> New Visual Automation
        </Button>
      </div>

      {automationsQuery.isLoading ? (
        <Skeleton className="h-44 w-full" />
      ) : automations.length === 0 ? (
        <EmptyState
          icon={<Workflow className="h-5 w-5" />}
          title="No visual automations yet"
          description="Build trigger-to-action journeys when subscribers receive tags, submit forms, or trigger API events."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> Create First Automation
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          {/* Left selector list */}
          <div className="space-y-2">
            {automations.map((auto) => (
              <Card
                key={auto.id}
                onClick={() => setSelectedId(auto.id)}
                className={`cursor-pointer p-3 space-y-1 transition-colors ${
                  activeAutomation?.id === auto.id ? 'border-[var(--accent)] bg-[var(--bg-subtle)]' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[var(--fg-primary)] truncate">{auto.name}</span>
                  <Badge tone={auto.status === 'published' ? 'success' : auto.status === 'paused' ? 'warning' : 'neutral'}>
                    {auto.status}
                  </Badge>
                </div>
                <div className="text-[11px] text-[var(--fg-muted)]">
                  Trigger: {auto.triggerType} • Runs: {auto.runCount}
                </div>
              </Card>
            ))}
          </div>

          {/* Right visual canvas */}
          {activeAutomation && (
            <Card className="p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-3">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--fg-primary)]">{activeAutomation.name}</h3>
                  <p className="text-xs text-[var(--fg-muted)]">
                    Trigger: {activeAutomation.triggerType} • {activeAutomation.nodes.length} nodes
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={activeAutomation.status === 'published' ? 'secondary' : 'primary'}
                    onClick={() =>
                      updateMutation.mutate({
                        id: activeAutomation.id,
                        patch: { status: activeAutomation.status === 'published' ? 'paused' : 'published' },
                      })
                    }
                  >
                    {activeAutomation.status === 'published' ? 'Pause Workflow' : 'Publish Workflow'}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => deleteMutation.mutate(activeAutomation.id)}>
                    <Trash2 className="h-3.5 w-3.5 text-red-400" />
                  </Button>
                </div>
              </div>

              {/* Add Step Toolbar */}
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-2">
                <span className="text-[11px] font-medium text-[var(--fg-muted)] mr-1">Append step:</span>
                {NODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => addConnectedNode(opt.value)}
                    className="rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] font-medium text-[var(--fg-primary)] hover:border-[var(--accent)]"
                  >
                    + {opt.label}
                  </button>
                ))}
              </div>

              {/* Visual Connected Nodes */}
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-[var(--border-default)] bg-[var(--bg-subtle)] p-4 overflow-x-auto">
                {activeAutomation.nodes.map((node, index) => (
                  <div key={node.id} className="flex items-center gap-3">
                    <div
                      onClick={() => setEditNode(node)}
                      className="min-w-[180px] max-w-[220px] cursor-pointer rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 shadow-sm hover:border-[var(--accent)]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge tone={node.type === 'trigger' ? 'brand' : node.type === 'condition' ? 'warning' : 'neutral'}>
                          {node.type.replace('action_', '')}
                        </Badge>
                        {node.type !== 'trigger' && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeNode(node.id);
                            }}
                            className="text-red-400 hover:text-red-300"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                      <div className="mt-1.5 text-xs font-semibold text-[var(--fg-primary)]">{node.label}</div>
                      <div className="mt-1 text-[11px] text-[var(--fg-muted)] truncate">
                        {JSON.stringify(node.config) !== '{}' ? JSON.stringify(node.config) : 'Click to configure'}
                      </div>
                    </div>
                    {index < activeAutomation.nodes.length - 1 && (
                      <ArrowRight className="h-4 w-4 shrink-0 text-[var(--fg-muted)]" />
                    )}
                  </div>
                ))}
              </div>

              {/* Manual Trigger Test */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={testSubId}
                    onChange={(e) => setTestSubId(e.target.value)}
                    className="rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--fg-primary)]"
                  >
                    <option value="">Select subscriber to test trigger...</option>
                    {(subscribersQuery.data?.subscribers ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.email}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!testSubId || triggerTestMutation.isPending}
                    onClick={() => triggerTestMutation.mutate({ id: activeAutomation.id, subId: testSubId })}
                  >
                    <Play className="mr-1 h-3.5 w-3.5" /> Run Test
                  </Button>
                </div>
                <span className="text-[11px] text-[var(--fg-muted)]">Click any node box above to configure tag, sequence, or delay settings.</span>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Node Configuration Modal */}
      <AppDialog
        open={Boolean(editNode)}
        onOpenChange={(open) => {
          if (!open) setEditNode(null);
        }}
        title={`Configure ${editNode?.type ?? 'Node'}`}
      >
        {editNode && activeAutomation && (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Node Label</label>
              <Input
                value={editNode.label}
                onChange={(e) => setEditNode({ ...editNode, label: e.target.value })}
              />
            </div>

            {(editNode.type === 'action_add_tag' ||
              editNode.type === 'action_remove_tag' ||
              (editNode.type === 'trigger' && activeAutomation.triggerType === 'tag_added')) && (
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Tag Name</label>
                <Input
                  value={String(editNode.config.tagName ?? '')}
                  onChange={(e) =>
                    setEditNode({ ...editNode, config: { ...editNode.config, tagName: e.target.value } })
                  }
                  list="automation-tag-list"
                  placeholder="e.g. vip-customer"
                />
                <datalist id="automation-tag-list">
                  {(tagsQuery.data?.tags ?? []).map((t) => (
                    <option key={t.id} value={t.name} />
                  ))}
                </datalist>
              </div>
            )}

            {(editNode.type === 'action_subscribe_sequence' || editNode.type === 'action_unsubscribe_sequence') && (
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Target Sequence</label>
                <select
                  value={String(editNode.config.sequenceId ?? '')}
                  onChange={(e) =>
                    setEditNode({ ...editNode, config: { ...editNode.config, sequenceId: e.target.value } })
                  }
                  className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--fg-primary)]"
                >
                  <option value="">Select sequence...</option>
                  {(sequencesQuery.data?.sequences ?? []).map((sq) => (
                    <option key={sq.id} value={sq.id}>
                      {sq.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {editNode.type === 'delay' && (
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Wait Duration (Minutes)</label>
                <Input
                  type="number"
                  value={String(editNode.config.delayMinutes ?? 60)}
                  onChange={(e) =>
                    setEditNode({ ...editNode, config: { ...editNode.config, delayMinutes: Number(e.target.value) || 0 } })
                  }
                />
              </div>
            )}

            {editNode.type === 'action_update_field' && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  value={String(editNode.config.fieldKey ?? '')}
                  onChange={(e) =>
                    setEditNode({ ...editNode, config: { ...editNode.config, fieldKey: e.target.value } })
                  }
                  placeholder="Field key (e.g. plan)"
                />
                <Input
                  value={String(editNode.config.value ?? '')}
                  onChange={(e) =>
                    setEditNode({ ...editNode, config: { ...editNode.config, value: e.target.value } })
                  }
                  placeholder="Value"
                />
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setEditNode(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const nextNodes = activeAutomation.nodes.map((n) => (n.id === editNode.id ? editNode : n));
                  updateMutation.mutate({
                    id: activeAutomation.id,
                    patch: {
                      nodes: nextNodes,
                      ...(editNode.id === 'node_trigger' ? { triggerConfig: editNode.config } : {}),
                    },
                  });
                  setEditNode(null);
                }}
              >
                Apply Node Changes
              </Button>
            </div>
          </div>
        )}
      </AppDialog>

      {/* New Automation Dialog */}
      <AppDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New Visual Automation"
      >
        <div className="space-y-3">
          <p className="text-xs text-[var(--fg-muted)]">Choose how subscribers enter this automation.</p>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Automation Name</label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Welcome Sequence Trigger" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Entry Trigger</label>
            <select
              value={newTrigger}
              onChange={(e) => setNewTrigger(e.target.value as AutomationTriggerType)}
              className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--fg-primary)]"
            >
              {TRIGGER_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          {newTrigger === 'tag_added' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Trigger Tag Name (optional)</label>
              <Input value={newTagName} onChange={(e) => setNewTagName(e.target.value)} placeholder="e.g. newsletter" />
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!newName.trim() || createMutation.isPending} onClick={() => createMutation.mutate()}>
              Create Automation
            </Button>
          </div>
        </div>
      </AppDialog>
    </div>
  );
}

// ============================================================================
// 3. GROWTH: SIGNUP FORMS & LANDING PAGES
// ============================================================================

export function GrowthSection({ initialTab = 'forms' }: { initialTab?: 'forms' | 'landing-pages' }) {
  const qc = useQueryClient();

  // Form Modal
  const [formOpen, setFormOpen] = useState(false);
  const [formEditId, setFormEditId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<'inline' | 'popup' | 'embedded'>('inline');
  const [formTitle, setFormTitle] = useState('Join our newsletter');
  const [formDesc, setFormDesc] = useState('Get weekly updates straight to your inbox.');
  const [formBtn, setFormBtn] = useState('Subscribe');
  const [formConsent, setFormConsent] = useState('I agree to receive email updates and can unsubscribe anytime.');
  const [formDoubleOptIn, setFormDoubleOptIn] = useState(false);
  const [formPublished, setFormPublished] = useState(true);
  const [formTagIds, setFormTagIds] = useState<string[]>([]);

  // Landing Page Modal
  const [pageOpen, setPageOpen] = useState(false);
  const [pageEditId, setPageEditId] = useState<string | null>(null);
  const [pageSlug, setPageSlug] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [pageHeadline, setPageHeadline] = useState('Build better email campaigns');
  const [pageSubheadline, setPageSubheadline] = useState('Practical guides sent weekly. Zero spam.');
  const [pageBtn, setPageBtn] = useState('Join Free');
  const [pagePublished, setPagePublished] = useState(true);
  const [pageTagIds, setPageTagIds] = useState<string[]>([]);

  const formsQuery = useQuery({ queryKey: ['forms'], queryFn: () => api.listForms() });
  const pagesQuery = useQuery({ queryKey: ['landing-pages'], queryFn: () => api.listLandingPages() });
  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: () => api.listTags() });

  const tags = tagsQuery.data?.tags ?? [];

  const saveFormMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: formName,
        formType,
        title: formTitle,
        description: formDesc,
        buttonText: formBtn,
        successMessage: 'Thanks for subscribing!',
        consentText: formConsent,
        doubleOptIn: formDoubleOptIn,
        fields: [
          { key: 'firstName', label: 'First Name', required: false },
          { key: 'email', label: 'Email Address', required: true },
        ],
        tagIds: formTagIds,
        published: formPublished,
      };
      return formEditId ? api.updateForm(formEditId, payload) : api.createForm(payload);
    },
    onSuccess: () => {
      toast.success(formEditId ? 'Form updated' : 'Form created');
      setFormOpen(false);
      qc.invalidateQueries({ queryKey: ['forms'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save form'),
  });

  const deleteFormMutation = useMutation({
    mutationFn: (id: string) => api.deleteForm(id),
    onSuccess: () => {
      toast.success('Form deleted');
      qc.invalidateQueries({ queryKey: ['forms'] });
    },
  });

  const savePageMutation = useMutation({
    mutationFn: () => {
      const payload = {
        slug: pageSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        title: pageTitle || pageHeadline,
        headline: pageHeadline,
        subheadline: pageSubheadline,
        bodyHtml: '',
        buttonText: pageBtn,
        tagIds: pageTagIds,
        published: pagePublished,
      };
      return pageEditId ? api.updateLandingPage(pageEditId, payload) : api.createLandingPage(payload);
    },
    onSuccess: () => {
      toast.success(pageEditId ? 'Landing page updated' : 'Landing page created');
      setPageOpen(false);
      qc.invalidateQueries({ queryKey: ['landing-pages'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save landing page'),
  });

  const deletePageMutation = useMutation({
    mutationFn: (id: string) => api.deleteLandingPage(id),
    onSuccess: () => {
      toast.success('Landing page deleted');
      qc.invalidateQueries({ queryKey: ['landing-pages'] });
    },
  });

  const copyEmbedSnippet = (form: GrowthFormItem) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const snippet = `<form action="${origin}/v1/public/forms/${form.id}/submit" method="POST">\n  <input name="firstName" placeholder="First name" />\n  <input name="email" type="email" required placeholder="you@example.com" />\n  <label><input type="checkbox" name="consentAccepted" value="true" required /> ${form.consentText}</label>\n  <button type="submit">${form.buttonText}</button>\n</form>`;
    navigator.clipboard?.writeText(snippet);
    toast.success('HTML embed snippet copied');
  };

  if (initialTab === 'landing-pages') {
    const pages = pagesQuery.data?.landingPages ?? [];
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--fg-primary)]">Hosted Landing Pages</h2>
            <p className="text-xs text-[var(--fg-muted)]">
              Publish hosted opt-in pages served directly at <code>/v1/public/pages/:slug</code> with conversion tracking.
            </p>
          </div>
          <Button
            onClick={() => {
              setPageEditId(null);
              setPageSlug('');
              setPageTitle('');
              setPageHeadline('Join our newsletter');
              setPageSubheadline('Actionable tutorials delivered weekly.');
              setPageBtn('Subscribe Free');
              setPagePublished(true);
              setPageTagIds([]);
              setPageOpen(true);
            }}
          >
            <Plus className="mr-1.5 h-4 w-4" /> New Landing Page
          </Button>
        </div>

        {pagesQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : pages.length === 0 ? (
          <EmptyState
            icon={<Globe className="h-5 w-5" />}
            title="No landing pages yet"
            description="Create a hosted signup page with explicit consent capture and automatic tag assignment."
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {pages.map((pg: LandingPageItem) => {
              const publicPath = `/v1/public/pages/${pg.slug}`;
              return (
                <Card key={pg.id} className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-[var(--fg-primary)]">{pg.title}</h3>
                        <Badge tone={pg.published ? 'success' : 'neutral'}>
                          {pg.published ? 'Published' : 'Draft'}
                        </Badge>
                      </div>
                      <p className="text-xs font-mono text-[var(--fg-muted)] mt-0.5">{publicPath}</p>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          navigator.clipboard?.writeText(`${window.location.origin}${publicPath}`);
                          toast.success('Public landing page URL copied');
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setPageEditId(pg.id);
                          setPageSlug(pg.slug);
                          setPageTitle(pg.title);
                          setPageHeadline(pg.headline);
                          setPageSubheadline(pg.subheadline);
                          setPageBtn(pg.buttonText);
                          setPagePublished(pg.published);
                          setPageTagIds(pg.tagIds);
                          setPageOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => deletePageMutation.mutate(pg.id)}>
                        <Trash2 className="h-3.5 w-3.5 text-red-400" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex gap-4 text-xs text-[var(--fg-secondary)]">
                    <span>Views: {pg.viewsCount}</span>
                    <span>Signups: {pg.conversionCount}</span>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        <AppDialog
          open={pageOpen}
          onOpenChange={setPageOpen}
          title={pageEditId ? 'Edit Landing Page' : 'Create Landing Page'}
        >
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">URL Slug</label>
                <Input value={pageSlug} onChange={(e) => setPageSlug(e.target.value)} placeholder="early-access" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Page Title</label>
                <Input value={pageTitle} onChange={(e) => setPageTitle(e.target.value)} placeholder="Early Access" />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Headline</label>
              <Input value={pageHeadline} onChange={(e) => setPageHeadline(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Subheadline</label>
              <Input value={pageSubheadline} onChange={(e) => setPageSubheadline(e.target.value)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">CTA Button Text</label>
                <Input value={pageBtn} onChange={(e) => setPageBtn(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 pt-6 text-xs">
                <AppSwitch checked={pagePublished} onCheckedChange={setPagePublished} />
                <span>Published publicly</span>
              </label>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Assign Tags on Signup</label>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() =>
                      setPageTagIds((prev) => (prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id]))
                    }
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${
                      pageTagIds.includes(t.id)
                        ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]'
                        : 'border-[var(--border-default)]'
                    }`}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setPageOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={!pageSlug.trim() || !pageHeadline.trim() || savePageMutation.isPending}
                onClick={() => savePageMutation.mutate()}
              >
                Save Landing Page
              </Button>
            </div>
          </div>
        </AppDialog>
      </div>
    );
  }

  const forms = formsQuery.data?.forms ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--fg-primary)]">Signup Forms & Embeds</h2>
          <p className="text-xs text-[var(--fg-muted)]">
            Create inline/embedded forms with explicit consent checkboxes, tag assignment, and public submission URLs.
          </p>
        </div>
        <Button
          onClick={() => {
            setFormEditId(null);
            setFormName('');
            setFormType('inline');
            setFormTitle('Join our newsletter');
            setFormDesc('Get weekly updates straight to your inbox.');
            setFormBtn('Subscribe');
            setFormConsent('I agree to receive email updates and can unsubscribe anytime.');
            setFormDoubleOptIn(false);
            setFormPublished(true);
            setFormTagIds([]);
            setFormOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-4 w-4" /> New Signup Form
        </Button>
      </div>

      {formsQuery.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : forms.length === 0 ? (
        <EmptyState
          icon={<FileInput className="h-5 w-5" />}
          title="No signup forms yet"
          description="Create an embeddable form to grow your subscriber list and automatically apply tags or trigger automations."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {forms.map((f) => (
            <Card key={f.id} className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--fg-primary)]">{f.name}</h3>
                    <Badge tone={f.published ? 'success' : 'neutral'}>{f.published ? 'Active' : 'Draft'}</Badge>
                    <Badge tone="brand">{f.formType}</Badge>
                  </div>
                  <p className="text-xs text-[var(--fg-muted)] mt-0.5">
                    Submissions: {f.submissionCount} {f.doubleOptIn ? '• Double Opt-In' : ''}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="secondary" onClick={() => copyEmbedSnippet(f)} title="Copy HTML embed snippet">
                    <Copy className="mr-1 h-3.5 w-3.5" /> Embed
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setFormEditId(f.id);
                      setFormName(f.name);
                      setFormType(f.formType);
                      setFormTitle(f.title);
                      setFormDesc(f.description);
                      setFormBtn(f.buttonText);
                      setFormConsent(f.consentText);
                      setFormDoubleOptIn(f.doubleOptIn);
                      setFormPublished(f.published);
                      setFormTagIds(f.tagIds);
                      setFormOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => deleteFormMutation.mutate(f.id)}>
                    <Trash2 className="h-3.5 w-3.5 text-red-400" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <AppDialog open={formOpen} onOpenChange={setFormOpen} title={formEditId ? 'Edit Signup Form' : 'Create Signup Form'}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Form Name</label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Footer Newsletter Box" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Display Style</label>
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value as 'inline' | 'popup' | 'embedded')}
                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--fg-primary)]"
              >
                <option value="inline">Inline</option>
                <option value="embedded">Embedded</option>
                <option value="popup">Popup</option>
              </select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Title</label>
              <Input value={formTitle} onChange={(e) => setFormTitle(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Button Label</label>
              <Input value={formBtn} onChange={(e) => setFormBtn(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Explicit Consent Checkbox Text</label>
            <Input value={formConsent} onChange={(e) => setFormConsent(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-6 text-xs">
            <label className="flex items-center gap-2">
              <AppSwitch checked={formDoubleOptIn} onCheckedChange={setFormDoubleOptIn} />
              <span>Require Double Opt-In Confirmation</span>
            </label>
            <label className="flex items-center gap-2">
              <AppSwitch checked={formPublished} onCheckedChange={setFormPublished} />
              <span>Published</span>
            </label>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--fg-muted)]">Apply Tags on Submission</label>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() =>
                    setFormTagIds((prev) => (prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id]))
                  }
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${
                    formTagIds.includes(t.id)
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]'
                      : 'border-[var(--border-default)]'
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!formName.trim() || saveFormMutation.isPending} onClick={() => saveFormMutation.mutate()}>
              Save Form
            </Button>
          </div>
        </div>
      </AppDialog>
    </div>
  );
}
